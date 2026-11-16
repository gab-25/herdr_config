import { View } from "gpui-kit";
import { spaces, panes, hc, notify, nextCommand, checking } from "herdr";

// Tab name → what to start again in that tab when herdr-core comes back after a
// restart (a reboot): the core then gives every lost terminal a bare shell.
const RESTORE = { claude: "claude --continue", lazygit: "lazygit", nvim: "nvim" };
const SHELLS = ["bash", "zsh", "fish", "sh", "dash", "ksh", "nu", "pwsh", "xonsh"];

const wait = (cx, ms) => new Promise((done) => cx.timer.after(ms, () => done()));

export default class DevRestore extends View {
  init(_props, cx) {
    if (checking()) return;
    cx.spawn(async (cx) => {
      const core = await this.coreStart();
      let seen = null;
      try { seen = localStorage.getItem("core"); localStorage.setItem("core", core ?? seen ?? ""); } catch {}
      // The first time this runs there is nothing to compare with: only remember the core.
      if (core && seen && seen !== core) await this.restore(cx);
    });
    // "dev-restore.run" (a key, or herdr-app do) restores now, without a core restart.
    cx.spawn(async (cx) => {
      for (;;) { if (await nextCommand() === "run") await this.restore(cx); }
    });
  }

  // One id per core run: its pid and start minute (a pid alone can repeat after a reboot).
  async coreStart() {
    const r = await hc(["server", "status"]).catch(() => null);
    try {
      const s = JSON.parse(r.stdout);
      return `${s.core?.id}:${s.pid}:${Math.round((Date.now() - s.uptime_ms) / 60000)}`;
    } catch { return null; }
  }

  async restore(cx) {
    // The app reads this machine's layout shortly after start.
    for (let i = 0; i < 15 && !spaces().length; i++) await wait(cx, 1000);
    const done = [];
    for (const space of spaces().filter((s) => !s.machine)) {
      for (const tab of space.tabs.filter((t) => t.named)) {
        const cmd = RESTORE[tab.name.trim().toLowerCase()];
        const pane = cmd && panes().find((p) => p.tab === tab.id && p.terminal);
        if (!pane) continue;
        const r = await hc(["get", pane.terminal, "--json"]).catch(() => null);
        let fg = null;
        try { fg = JSON.parse(r.stdout).foreground?.name ?? null; } catch {}
        // Only a bare shell: never type into a program the person already started.
        if (!SHELLS.includes(fg)) continue;
        const sent = await hc(["send", pane.terminal, cmd]).catch(() => null);
        if (sent?.code === 0) done.push(`${space.name} / ${tab.name}`);
      }
    }
    if (done.length) notify({ title: `Restored ${done.length} tab${done.length > 1 ? "s" : ""}`, body: done.join("\n"), level: "info" });
  }

  render() { return ""; }
}
