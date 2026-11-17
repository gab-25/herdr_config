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
    this.groups = []; this.dir = null; this.infos = {}; this.asking = new Set();
    try { this.runs = JSON.parse(localStorage.getItem("runs") ?? "{}") ?? {}; } catch { this.runs = {}; }
    if (checking()) return;
    this.load(cx);
  }

  // Exit status of a finished run, as the chip shows it.
  outcome(st) {
    if (st.killed) return { status: "stopped", color: "yellow" };
    if (st.code === undefined || st.code === null) return { status: "finished", color: "green" };
    return st.code === 0 ? { status: "exit 0", color: "green" } : { status: `exit ${st.code}`, color: "red" };
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

  // What the core says about a run's address: { label, exit, live }, or "gone".
  ask(addr, cx) {
    if (this.asking.has(addr)) return;
    this.asking.add(addr);
    cx.spawn(async (cx) => {
      const r = await hc(["get", addr, "--json"]).catch(() => null);
      let info = "gone";
      try {
        if (r?.code === 0) {
          const j = JSON.parse(r.stdout);
          info = { label: j.labels?.["herdr.run"] ?? null, exit: j.exit_code ?? null, live: j.state !== "finished",
            killed: j.state === "finished" && (j.reason === "killed" || j.signal != null) };
        }
      } catch {}
      this.asking.delete(addr);
      this.infos[addr] = info;
      cx.notify();
    });
  }

  // The core can hand a dead run's address to another terminal (after a reboot):
  // an address is this run only while it carries this run's label.
  ours(addr, cmd) {
    const info = this.infos[addr];
    return Boolean(info) && info !== "gone" && info.label === cmd;
  }

  drop(k, addr) {
    if (this.runs[k] !== addr) return;
    delete this.runs[k]; delete this.infos[addr]; this.save();
  }

  // live | finished | null. Nothing shows until the core confirms the label.
  state(item, cx) {
    const k = this.key(item), addr = this.runs[k];
    if (!addr || checking()) return null;
    const t = terminals().find((x) => x.address === addr);
    const live = Boolean(t) && (t.state ?? "live") !== "finished";
    const info = this.infos[addr];
    // Ask when the core hasn't answered yet, and again for the exit code once a live run ends.
    if (info === undefined || (info !== "gone" && info.live && !live)) this.ask(addr, cx);
    if (!info) return null;
    if (!this.ours(addr, item.cmd)) { this.drop(k, addr); return null; }
    return live ? { addr, live: true } : { addr, live: false, code: info.live ? undefined : info.exit, killed: !info.live && info.killed };
  }

  start(item, cx) {
    const k = this.key(item), old = this.runs[k], dir = this.dir, on = this.on;
    cx.spawn(async (cx) => {
      // Remove the previous finished run, once the core confirms it's still this run's terminal.
      if (old && this.infos[old] === undefined) {
        const g = await hc(["get", old, "--json"]).catch(() => null);
        try { if (g?.code === 0 && JSON.parse(g.stdout).labels?.["herdr.run"] === item.cmd) await hc(["rm", old]).catch(() => null); } catch {}
      } else if (old && this.ours(old, item.cmd)) await hc(["rm", old]).catch(() => null);
      const args = ["run", "--json", "--bg", "--no-parent", "--cwd", dir, "--label", `herdr.run=${item.cmd}`];
      if (on) args.push("--on", on);
      const r = await hc([...args, "--", "bash", "-lic", item.cmd]).catch((e) => ({ code: 1, stderr: String(e) }));
      try {
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim());
        const addr = JSON.parse(r.stdout).address;
        this.runs[k] = on && !addr.includes("/") ? `${on}/${addr}` : addr;
        this.save(); this.error = null;
      } catch (e) { this.error = `${item.name}: ${e.message || "hc run failed"}`; cx.notify(); return; }
      cx.notify();
      // Show it in a pane below the focused one (a new tab when no pane has focus). The app learns
      // about a new terminal a moment after the core starts it, and terminal.keep fails before that.
      const addr = this.runs[k];
      for (let i = 0; i < 50 && !terminals().some((x) => x.address === addr); i++) await cx.sleep(100);
      run("terminal.keep", focused()?.pane ? { terminal: addr, place: "down" } : { terminal: addr });
    });
  }

  // terminal.kill only reaches terminals with a pane in a space; runs have none, so ask the core.
  stopRun(addr, cx) {
    cx.spawn(async (cx) => {
      const r = await hc(["kill", addr]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) this.error = `stop ${addr}: ${(r.stderr || r.stdout || "").trim() || "hc kill failed"}`;
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
    const out = st && !st.live ? this.outcome(st) : null, failed = out?.color === "red";
    const color = out?.color === "red" ? t.ansi1 : out?.color === "yellow" ? t.ansi3 : t.ansi2;
    const dot = !st ? null : st.live
      ? div().text_size(11).frames(["▖", "▘", "▝", "▗"], 140).text_color(t.working)
      : div().size(7).rounded(0).bg(color);
    const icon = (id, glyph, title, fn) => div().id(id).size(18).flex().items_center().justify_center().rounded(0).text_size(10)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }).tooltip(title).child(glyph);
    const id = `run-${item.cmd}`;
    return h_flex().id(id).flex_none().h(26).pl(9).pr(st ? 3 : 9).gap(6).items_center().rounded(0).when(!st, (e) => e.cursor_pointer())
      .border_1().border_color(st?.live ? t.working + "80" : failed ? t.ansi1 + "80" : t.border)
      .bg(st ? t.raised : t.background).hover((s) => s.bg(t.hover))
      // Not started: start it in a pane. Started: nothing (■ stops it, ↻ runs it again, ✕ clears it).
      .on_click((_e, cx) => { if (!st) this.start(item, cx); })
      .when(Boolean(dot), (e) => e.child(dot))
      .child(div().text_size(12).text_color(st ? t.foreground : t.muted).child(item.name))
      .when(failed, (e) => e.child(div().text_size(10).text_color(t.ansi1).child(String(st.code))))
      .when(out?.color === "yellow", (e) => e.child(div().text_size(10).text_color(t.ansi3).child("stopped")))
      .when(Boolean(st?.live), (e) => e
        .child(icon(`${id}-stop`, "■", "Stop", (cx) => this.stopRun(st.addr, cx))))
      .when(Boolean(st) && !st?.live, (e) => e
        .child(icon(`${id}-again`, "↻", "Run again", (cx) => this.start(item, cx)))
        .child(icon(`${id}-x`, "✕", "Clear", (cx) => this.forget(item, st, cx))));
  }

  // A live run from another folder: its folder and command, with stop.
  otherChip(r, t) {
    const stop = (_e, cx) => cx.stop_propagation(), id = `other-${r.k}`;
    const folder = (r.on ? `${r.on}:` : "") + (r.dir.split("/").filter(Boolean).pop() ?? r.dir);
    const icon = (iid, glyph, fn) => div().id(iid).size(18).flex().items_center().justify_center().rounded(0).text_size(10)
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }).child(glyph);
    return h_flex().id(id).flex_none().h(26).pl(9).pr(3).gap(6).items_center().rounded(0)
      .border_1().border_color(t.working + "80").bg(t.raised).hover((s) => s.bg(t.hover))
      .tooltip(`${r.dir}\n${r.cmd}`)
      .child(div().text_size(11).frames(["▖", "▘", "▝", "▗"], 140).text_color(t.working))
      .child(div().max_w(200).truncate().text_size(11).text_color(t.dim).child(folder))
      .child(div().text_size(12).text_color(t.foreground).child(r.cmd))
      .child(icon(`${id}-stop`, "■", (cx) => this.stopRun(r.addr, cx)));
  }

  render(cx) {
    if (!checking() && JSON.stringify(location()) !== this.context) this.load(cx);
    const t = theme();
    const running = this.groups.flatMap((g) => g.items).filter((i) => this.state(i, cx)?.live).length;
    // Every run this dock started, in any folder: the status bar shows the count.
    // Runs in other folders are checked too, so the count never includes a reused address.
    const liveRuns = checking() ? [] : Object.entries(this.runs).map(([k, addr]) => {
      if (this.infos[addr] === undefined) this.ask(addr, cx);
      const [on, dir, ...rest] = k.split("|");
      return { k, addr, on: on || null, dir, cmd: rest.join("|") };
    }).filter((r) => this.ours(r.addr, r.cmd) && terminals().some((x) => x.address === r.addr && (x.state ?? "live") !== "finished"));
    const live = liveRuns.length;
    // Live runs started from other folders: listed below, so the count never points nowhere.
    const elsewhere = liveRuns.filter((r) => r.dir !== this.dir || r.on !== (this.on ?? null));
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
          .child(this.loading ? "Looking for scripts…" : "Nothing to run here: no package.json, Makefile, compose file or justfile")))
        .when(elsewhere.length > 0, (e) => e.child(h_flex().flex_none().px(12).gap(10).items_center()
          .child(div().w(56).flex_none().text_size(11).text_color(t.dim).child("other"))
          .child(h_flex().id("run-row-elsewhere").flex_1().min_w(0).gap(6).overflow_x_scroll()
            .children(elsewhere.map((r) => this.otherChip(r, t)))))));
  }
}
