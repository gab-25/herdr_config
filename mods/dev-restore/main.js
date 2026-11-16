import { View } from "gpui-kit";
import { spaces, panes, hc, notify, nextCommand, checking } from "herdr";

// Tab name → what to start again in that tab when herdr-core comes back after a
// restart (a reboot): the core then gives every lost terminal a bare shell.
const RESTORE = { claude: "claude --continue", lazygit: "lazygit", nvim: "nvim" };
const SHELLS = ["bash", "zsh", "fish", "sh", "dash", "ksh", "nu", "pwsh", "xonsh"];

// The same core run, allowing for a few seconds of clock rounding in uptime.
const sameCore = (a, b) =>
  typeof a === "object" && a.id === b.id && a.pid === b.pid && Math.abs(a.start - b.start) < 60000;

const wait = (cx, ms) => new Promise((done) => cx.timer.after(ms, () => done()));

export default class DevRestore extends View {
  init(_props, cx) {
    if (checking()) return;
    cx.spawn(async (cx) => {
      const core = await this.coreStart();
      let seen = null;
      try { seen = JSON.parse(localStorage.getItem("core") ?? "null"); } catch {}
      if (core) try { localStorage.setItem("core", JSON.stringify(core)); } catch {}
      // The first time this runs there is nothing to compare with: only remember the core.
      if (core && seen && !sameCore(seen, core)) await this.restore(cx);
    });
    // "dev-restore.run" (a key, or herdr-app do) restores now, without a core restart.
    cx.spawn(async (cx) => {
      for (;;) { if (await nextCommand() === "run") await this.restore(cx); }
    });
  }

  // One core run: its id, pid and start time (a pid alone can repeat after a reboot).
  async coreStart() {
    const r = await hc(["server", "status"]).catch(() => null);
    try {
      const s = JSON.parse(r.stdout);
      return { id: s.core?.id ?? null, pid: s.pid, start: Date.now() - s.uptime_ms };
    } catch { return null; }
  }

  // Right after start the app may not have this machine's layout yet, and a lost
  // terminal's shell may still be loading: try again until every tab is handled.
  async restore(cx) {
    const handled = new Set();
    const done = [];
    for (let i = 0; i < 45; i++) {
      let pending = !panes().some((p) => p.terminal);
      for (const space of spaces().filter((s) => !s.machine)) {
        for (const tab of space.tabs.filter((t) => t.named && !handled.has(t.id))) {
          const cmd = RESTORE[tab.name.trim().toLowerCase()];
          if (!cmd) continue;
          const pane = panes().find((p) => p.tab === tab.id && p.terminal);
          if (!pane) { pending = true; continue; }
          const r = await hc(["get", pane.terminal, "--json"]).catch(() => null);
          let fg = null;
          try { fg = JSON.parse(r.stdout).foreground?.name ?? null; } catch {}
          if (!fg) { pending = true; continue; }
          handled.add(tab.id);
          // Only a bare shell: never type into a program the person already started.
          if (!SHELLS.includes(fg)) continue;
          const sent = await hc(["send", pane.terminal, cmd]).catch(() => null);
          if (sent?.code === 0) done.push(`${space.name} / ${tab.name}`);
        }
      }
      if (!pending && i >= 2) break;
      await wait(cx, 2000);
    }
    if (done.length) notify({ title: `Restored ${done.length} tab${done.length > 1 ? "s" : ""}`, body: done.join("\n"), level: "info" });
  }

  render() { return ""; }
}
