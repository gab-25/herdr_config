import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, terminals, theme, run, exec, hc, readTextFile, checking, shared, setShared } from "herdr";

// Where the person is working: the focused pane's folder, else the space's.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

const COMPOSE = /^(docker-)?compose([-.][\w-]+)?\.ya?ml$/;
const quote = (s) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

// Make targets a person would type: not special (.PHONY), not patterns, not variables.
function makeTargets(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9][\w./-]*)\s*:(?![=:])/.exec(line);
    if (m && !m[1].includes("%") && !out.includes(m[1])) out.push(m[1]);
  }
  return out.slice(0, 40);
}

// What a folder can run: package.json scripts, Makefile targets, compose files, just recipes.
async function discover(dir, on) {
  const ls = await exec("ls", ["-1", dir], { on, timeout: 10000 });
  if (ls.code !== 0) return [];
  const names = ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const read = (f) => readTextFile(`${dir}/${f}`, { on }).catch(() => null);
  const groups = [];
  if (names.includes("package.json")) {
    try {
      const scripts = Object.keys(JSON.parse(await read("package.json") ?? "{}").scripts ?? {});
      const pm = names.includes("pnpm-lock.yaml") ? "pnpm" : names.includes("yarn.lock") ? "yarn" : names.some((n) => n.startsWith("bun.lock")) ? "bun" : "npm";
      if (scripts.length) groups.push({ kind: pm, items: scripts.map((s) => ({ name: s, cmd: `${pm} run ${quote(s)}` })) });
    } catch {}
  }
  const makefile = names.find((n) => ["Makefile", "makefile", "GNUmakefile"].includes(n));
  if (makefile) {
    const targets = makeTargets(await read(makefile) ?? "");
    if (targets.length) groups.push({ kind: "make", items: targets.map((t) => ({ name: t, cmd: `make ${quote(t)}` })) });
  }
  const composes = names.filter((n) => COMPOSE.test(n)).sort((a, b) => a.length - b.length);
  if (composes.length) {
    const items = [];
    for (const f of composes) {
      const variant = f.replace(/^(docker-)?compose[-.]?/, "").replace(/\.ya?ml$/, "");
      const base = `docker compose -f ${quote(f)}`, tag = variant ? ` ${variant}` : "";
      items.push({ name: `up${tag}`, cmd: `${base} up` }, { name: `down${tag}`, cmd: `${base} down` }, { name: `logs${tag}`, cmd: `${base} logs -f --tail 200` });
    }
    groups.push({ kind: "compose", items });
  }
  if (names.some((n) => n.toLowerCase() === "justfile" || n === ".justfile")) {
    const r = await exec("bash", ["-lc", "just --summary"], { cwd: dir, on, timeout: 10000 }).catch(() => null);
    const recipes = r?.code === 0 ? r.stdout.trim().split(/\s+/).filter(Boolean) : [];
    if (recipes.length) groups.push({ kind: "just", items: recipes.map((t) => ({ name: t, cmd: `just ${quote(t)}` })) });
  }
  return groups;
}

export default class RunDock extends View {
  init(_props, cx) {
    this.groups = []; this.dir = null; this.exits = {};
    try { this.runs = JSON.parse(localStorage.getItem("runs") ?? "{}") ?? {}; } catch { this.runs = {}; }
    if (checking()) return;
    this.load(cx);
  }

  save() { try { localStorage.setItem("runs", JSON.stringify(this.runs)); } catch {} }

  // The project folder: the focused folder if it has something to run, else its git root.
  load(cx) {
    const loc = location();
    this.context = JSON.stringify(loc);
    if (!loc.cwd) { this.groups = []; this.dir = null; return; }
    const context = this.context;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        let dir = loc.cwd, groups = await discover(dir, loc.on);
        if (!groups.length) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: loc.cwd, on: loc.on, timeout: 10000 });
          if (top.code === 0 && top.stdout.trim() !== dir) { dir = top.stdout.trim(); groups = await discover(dir, loc.on); }
        }
        if (context !== this.context) return;
        this.dir = dir; this.on = loc.on; this.groups = groups; this.error = null;
      } catch (e) { if (context === this.context) { this.groups = []; this.error = String(e.message ?? e); } }
      finally { if (context === this.context) { this.loading = false; cx.notify(); } }
    });
  }

  key(item) { return `${this.on ?? ""}|${this.dir}|${item.cmd}`; }

  // live | finished | null, from the core's terminals; exit codes asked once.
  state(item, cx) {
    const addr = this.runs[this.key(item)];
    if (!addr || checking()) return null;
    const t = terminals().find((x) => x.address === addr);
    if (t && (t.state ?? "live") !== "finished") return { addr, live: true };
    if (!(addr in this.exits)) {
      this.exits[addr] = undefined;
      cx.spawn(async (cx) => {
        const r = await hc(["get", addr, "--json"]).catch(() => null);
        let code = null;
        try { code = r?.code === 0 ? JSON.parse(r.stdout).exit_code ?? null : "gone"; } catch { code = "gone"; }
        this.exits[addr] = code;
        cx.notify();
      });
    }
    if (this.exits[addr] === "gone") return null;
    return { addr, live: false, code: this.exits[addr] };
  }

  start(item, cx) {
    const k = this.key(item), old = this.runs[k], dir = this.dir, on = this.on;
    cx.spawn(async (cx) => {
      if (old) await hc(["rm", old]).catch(() => null);
      const args = ["run", "--json", "--bg", "--no-parent", "--cwd", dir, "--label", `herdr.run=${item.cmd}`];
      if (on) args.push("--on", on);
      const r = await hc([...args, "--", "bash", "-lic", item.cmd]).catch((e) => ({ code: 1, stderr: String(e) }));
      try {
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim());
        const addr = JSON.parse(r.stdout).address;
        this.runs[k] = on && !addr.includes("/") ? `${on}/${addr}` : addr;
        this.save(); this.error = null;
      } catch (e) { this.error = `${item.name}: ${e.message || "hc run failed"}`; }
      cx.notify();
    });
  }

  forget(item, st, cx) {
    delete this.runs[this.key(item)]; this.save();
    cx.spawn(async (cx) => { await hc(["rm", st.addr]).catch(() => null); cx.notify(); });
    cx.notify();
  }

  chip(item, t, cx) {
    const st = this.state(item, cx), stop = (_e, cx) => cx.stop_propagation();
    const failed = st && !st.live && st.code !== 0 && st.code !== null && st.code !== undefined;
    const dot = !st ? null : st.live
      ? div().text_size(11).frames(["▖", "▘", "▝", "▗"], 140).text_color(t.working)
      : div().size(7).rounded(0).bg(failed ? t.ansi1 : t.ansi2);
    const icon = (id, glyph, title, fn) => div().id(id).size(18).flex().items_center().justify_center().rounded(0).text_size(10)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }).child(glyph);
    const id = `run-${item.cmd}`;
    return h_flex().id(id).flex_none().h(26).pl(9).pr(st ? 3 : 9).gap(6).items_center().rounded(0).cursor_pointer()
      .border_1().border_color(st?.live ? t.working + "80" : failed ? t.ansi1 + "80" : t.border)
      .bg(st ? t.raised : t.background).hover((s) => s.bg(t.hover))
      // Not running: start it. Running or ended: look at its output.
      .on_click((_e, cx) => st ? run("terminal.peek", { terminal: st.addr }) : this.start(item, cx))
      .when(Boolean(dot), (e) => e.child(dot))
      .child(div().text_size(12).text_color(st ? t.foreground : t.muted).child(item.name))
      .when(Boolean(st) && !st?.live && st?.code !== null && st?.code !== undefined && failed, (e) => e.child(div().text_size(10).text_color(t.ansi1).child(String(st.code))))
      .when(Boolean(st?.live), (e) => e
        .child(icon(`${id}-pane`, "⤓", "pane", () => run("terminal.keep", { terminal: st.addr, place: "down" })))
        .child(icon(`${id}-stop`, "■", "stop", () => run("terminal.kill", { terminal: st.addr }))))
      .when(Boolean(st) && !st?.live, (e) => e
        .child(icon(`${id}-again`, "↻", "again", (cx) => this.start(item, cx)))
        .child(icon(`${id}-x`, "✕", "clear", (cx) => this.forget(item, st, cx))));
  }

  render(cx) {
    if (!checking() && JSON.stringify(location()) !== this.context) this.load(cx);
    const t = theme();
    const running = this.groups.flatMap((g) => g.items).filter((i) => this.state(i, cx)?.live).length;
    // Every run this dock started, in any folder: the status bar shows the count.
    const live = Object.values(this.runs).filter((a) => terminals().some((x) => x.address === a && (x.state ?? "live") !== "finished")).length;
    if (!checking() && shared("run.live") !== live) setShared("run.live", live);
    const folder = this.dir ? this.dir.split("/").filter(Boolean).pop() : null;
    return v_flex().id("run-dock").size_full().min_h(0).rounded(0).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(12.5).child("Run"))
        .when(Boolean(folder), (e) => e.child(div().text_color(t.dim).truncate().child(folder)))
        .when(running > 0, (e) => e.child(div().px(5).rounded(0).text_size(10).bg(t.working + "26").text_color(t.working).child(`${running} running`)))
        .child(div().flex_1())
        .when(Boolean(this.error), (e) => e.child(div().max_w(420).truncate().text_size(11).text_color(t.ansi1).child(this.error)))
        .child(div().id("run-reload").size(22).flex().items_center().justify_center().rounded(0).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.load(cx)).child("↻"))
        .child(div().id("run-hide").size(22).flex().items_center().justify_center().rounded(0).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => run("layout.hide", { id: "run-dock" }))
          .child(svg("mods/pane/close.svg").size(11))))
      .child(v_flex().id("run-groups").flex_1().min_h(0).overflow_y_scroll().py(6).gap(6)
        .children(this.groups.map((g) => h_flex().flex_none().px(12).gap(10).items_center()
          .child(div().w(56).flex_none().text_size(11).text_color(t.dim).child(g.kind))
          .child(h_flex().id(`run-row-${g.kind}`).flex_1().min_w(0).gap(6).overflow_x_scroll().children(g.items.map((i) => this.chip(i, t, cx))))))
        .when(!this.groups.length, (e) => e.child(div().px(12).py(4).text_color(t.dim)
          .child(this.loading ? "Looking for scripts…" : "Nothing to run here: no package.json, Makefile, compose file or justfile"))));
  }
}
