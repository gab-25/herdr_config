import { exec, home, window } from "herdr";

// A git remote (ssh, scp-like or https) → { host, path }.
export function parseRemote(url) {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i.exec((url ?? "").trim());
  return m ? { host: m[1].toLowerCase(), path: m[2].replace(/^\/+/, "") } : null;
}

// Which CLI speaks to a host: gh for GitHub, glab for any host glab is logged in to.
export function forgeOf(host, glabHosts) {
  if (!host) return null;
  if (host === "github.com") return "github";
  if (glabHosts.includes(host) || host.includes("gitlab")) return "gitlab";
  return null;
}

// The app's PATH may lack Homebrew/Linuxbrew: find a CLI once, by its full path.
const found = new Map();
export function which(cmd) {
  if (!found.has(cmd)) found.set(cmd, (async () => {
    const dirs = ["/home/linuxbrew/.linuxbrew/bin", `${home()}/.linuxbrew/bin`, "/opt/homebrew/bin", "/usr/local/bin", `${home()}/.local/bin`, "/usr/bin"];
    for (const d of dirs) {
      const r = await exec("test", ["-x", `${d}/${cmd}`]).catch(() => null);
      if (r?.code === 0) return `${d}/${cmd}`;
    }
    const r = await exec("bash", ["-lc", `command -v ${cmd}`], { cwd: home() }).catch(() => null);
    return r?.code === 0 && r.stdout.trim() ? r.stdout.trim().split("\n").pop() : cmd;
  })());
  return found.get(cmd);
}

// Runs a CLI here (gh and glab are installed on this computer), parses its JSON.
export async function cli(cmd, args) {
  const r = await exec(await which(cmd), args, { cwd: home(), timeout: 25000 });
  if (r.code !== 0) throw new Error(((r.stderr || r.stdout).trim().split("\n")[0]) || `${cmd} failed`);
  return JSON.parse(r.stdout || "null");
}

export async function glabHosts() {
  const r = await exec(await which("glab"), ["auth", "status"], { cwd: home(), timeout: 15000 }).catch(() => null);
  if (!r) return [];
  return (r.stdout + "\n" + r.stderr).split("\n").filter((l) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(l.trim()) && !/^\s/.test(l)).map((l) => l.trim().toLowerCase());
}

// The git remote of a folder, on the machine it lives on.
export async function remoteOf(cwd, on) {
  const r = await exec("git", ["remote", "get-url", "origin"], { cwd, on, timeout: 10000 }).catch(() => null);
  return r && r.code === 0 ? parseRemote(r.stdout) : null;
}

export function openUrl(url) {
  const p = window()?.platform;
  if (p === "macos") return exec("open", [url]);
  if (p === "windows") return exec("cmd", ["/c", "start", "", url]);
  return exec("xdg-open", [url]);
}

export function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / 86400 / 30)}mo`;
}
