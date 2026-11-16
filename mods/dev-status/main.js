import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, agents, theme, run, window, keys, exec, checking, shared, layout } from "herdr";
import { cli, glabHosts, remoteOf, forgeOf, openUrl } from "./forge.js";

// Where the person is working: the focused pane's folder, else the space's.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, branch: space?.branch ?? null };
}

// GitHub Actions and GitLab pipelines, in the same few words.
const CI = {
  success: "passed", completed: "passed", failed: "failed", failure: "failed", cancelled: "canceled", canceled: "canceled",
  timed_out: "failed", action_required: "blocked", manual: "manual", skipped: "skipped",
};

export default class DevStatus extends View {
  init(_props, cx) {
    this.git = null; this.ci = null; this.gen = 0;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(30000, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    const loc = location(), gen = ++this.gen;
    this.context = JSON.stringify(loc);
    if (!loc.cwd) { this.git = null; this.ci = null; return; }
    cx.spawn(async (cx) => {
      try {
        const g = (args) => exec("git", ["--no-optional-locks", ...args], { cwd: loc.cwd, on: loc.on, timeout: 10000 });
        const b = await g(["branch", "--show-current"]);
        if (b.code !== 0) { if (gen === this.gen) { this.git = null; this.ci = null; cx.notify(); } return; }
        const branch = b.stdout.trim();
        const counts = await g(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
        const [behind, ahead] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];
        if (gen !== this.gen) return;
        this.git = { branch, ahead, behind, upstream: counts.code === 0 };
        cx.notify();
        this.ci = branch ? await this.pipeline(loc, branch) : null;
      } catch { this.ci = null; }
      if (gen === this.gen) cx.notify();
    });
  }

  async pipeline(loc, branch) {
    const remote = await remoteOf(loc.cwd, loc.on);
    this.hosts ??= await glabHosts();
    const forge = forgeOf(remote?.host, this.hosts);
    if (forge === "github") {
      const args = ["api", `repos/${remote.path}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`];
      if (remote.host !== "github.com") args.push("--hostname", remote.host);
      const r = (await cli("gh", args)).workflow_runs?.[0];
      if (!r) return null;
      const state = r.status !== "completed" ? "running" : CI[r.conclusion] ?? r.conclusion;
      return { state, url: r.html_url, name: r.name };
    }
    if (forge === "gitlab") {
      const r = (await cli("glab", ["api", `projects/${encodeURIComponent(remote.path)}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`, "--hostname", remote.host]))?.[0];
      if (!r) return null;
      const state = ["running", "pending", "created", "preparing", "waiting_for_resource", "scheduled"].includes(r.status) ? "running" : CI[r.status] ?? r.status;
      return { state, url: r.web_url, name: "pipeline" };
    }
    return null;
  }

  runButton(t) {
    const find = (n) => n?.id === "run-dock" ? n : (n?.children ?? []).map(find).find(Boolean);
    const dock = find(layout());
    if (!dock) return div();
    const open = !dock.hidden, live = Number(shared("run.live") ?? 0);
    return h_flex().id("run-toggle").h(20).px(7).gap(5).items_center().rounded(0).cursor_pointer()
      .bg(open ? t.selected : t.chrome).text_color(open ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click(() => run("layout.toggle", { id: "run-dock" }))
      .child(div().text_size(9).child("▶")).child("Run")
      .when(live > 0, (e) => e.child(div().px(4).rounded(0).text_size(10).bg(t.working + "26").text_color(t.working).child(String(live))));
  }

  // The palette key as actually bound, not a hardcoded one.
  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render(cx) {
    if (!checking() && JSON.stringify(location()) !== this.context) this.refresh(cx);
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    const g = this.git, ci = this.ci;
    const ciColor = ci?.state === "passed" ? t.ansi2 : ci?.state === "failed" ? t.ansi1 : ci?.state === "running" ? t.working : t.dim;
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(g?.branch), (el) => el.child(h_flex().gap(6).items_center()
        .child(label("branch", g.branch))
        .when(g.ahead > 0, (e) => e.child(div().text_color(t.ansi2).child(`↑${g.ahead}`)))
        .when(g.behind > 0, (e) => e.child(div().text_color(t.blocked).child(`↓${g.behind}`)))
        .when(!g.upstream, (e) => e.child(div().text_color(t.dim).child("no upstream")))))
      .when(Boolean(ci), (el) => el.child(h_flex().id("ci").gap(6).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click(() => openUrl(ci.url))
        .child(ci.state === "running"
          ? div().text_size(12).frames(["▖", "▘", "▝", "▗"], 140).text_color(ciColor)
          : div().size(7).rounded(0).bg(ciColor))
        .child(`CI ${ci.state}`)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(0).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(this.runButton(t))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint()));
  }
}
