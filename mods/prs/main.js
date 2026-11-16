import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar } from "gpui-base";
import { spaces, panes, focused, theme, checking } from "herdr";
import { cli, glabHosts, remoteOf, forgeOf, openUrl, ago } from "./forge.js";

// Where the person is working: the focused pane's folder, else the space's.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

const enc = encodeURIComponent;

const fromGithub = (p, me, repo) => ({
  forge: "github", url: p.url, ref: `#${p.number}`, title: p.title, draft: p.isDraft,
  repo: repo ?? p.repository?.nameWithOwner, author: p.author?.login, branch: p.headRefName, updated: p.updatedAt,
  mine: p.author?.login === me, review: (p.reviewRequests ?? []).some((r) => r.login === me),
});

const fromGitlab = (m, me) => ({
  forge: "gitlab", url: m.web_url, ref: `!${m.iid}`, title: m.title, draft: m.draft,
  repo: m.references?.full?.replace(/!\d+$/, ""), author: m.author?.username, branch: m.source_branch, updated: m.updated_at,
  mine: m.author?.username === me, review: (m.reviewers ?? []).some((r) => r.username === me),
});

export default class Prs extends View {
  init(_props, cx) {
    this.scope = "repo";
    try { this.scope = localStorage.getItem("scope") === "all" ? "all" : "repo"; } catch {}
    this.items = []; this.errors = []; this.repo = null; this.gen = 0; this.me = {};
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(120000, (cx) => this.refresh(cx));
  }

  setScope(scope, cx) {
    if (scope === this.scope) return;
    this.scope = scope; this.items = []; this.errors = [];
    try { localStorage.setItem("scope", scope); } catch {}
    this.refresh(cx);
  }

  // Who the person is on each forge, asked once per host.
  async whoami(forge, host) {
    const k = `${forge}:${host}`;
    if (!(k in this.me)) {
      this.me[k] = forge === "github"
        ? (await cli("gh", ["api", "user"])).login
        : (await cli("glab", ["api", "user", "--hostname", host])).username;
    }
    return this.me[k];
  }

  async loadRepo(loc) {
    const remote = loc.cwd ? await remoteOf(loc.cwd, loc.on) : null;
    this.hosts ??= await glabHosts();
    const forge = forgeOf(remote?.host, this.hosts);
    this.repo = remote && forge ? { ...remote, forge } : null;
    if (!remote) throw new Error("This folder has no git remote");
    if (!forge) throw new Error(`Unsupported host: ${remote.host}`);
    const me = await this.whoami(forge, remote.host);
    if (forge === "github") {
      const list = await cli("gh", ["pr", "list", "-R", remote.host === "github.com" ? remote.path : `${remote.host}/${remote.path}`, "--state", "open", "-L", "50",
        "--json", "number,title,author,isDraft,url,updatedAt,reviewRequests,headRefName"]);
      return list.map((p) => fromGithub(p, me, remote.path));
    }
    const list = await cli("glab", ["api", `projects/${enc(remote.path)}/merge_requests?state=opened&per_page=50`, "--hostname", remote.host]);
    return list.map((m) => fromGitlab(m, me));
  }

  async loadAll() {
    this.hosts ??= await glabHosts();
    const jobs = [], errors = [];
    const fields = "number,title,author,isDraft,url,updatedAt,repository";
    jobs.push((async () => {
      const me = await this.whoami("github", "github.com");
      const [mine, review] = await Promise.all([
        cli("gh", ["search", "prs", "--author=@me", "--state=open", "-L", "50", "--json", fields]),
        cli("gh", ["search", "prs", "--review-requested=@me", "--state=open", "-L", "50", "--json", fields]),
      ]);
      return [...mine.map((p) => fromGithub(p, me)), ...review.map((p) => ({ ...fromGithub(p, me), review: true }))];
    })().catch((e) => { errors.push(`GitHub: ${e.message}`); return []; }));
    for (const host of this.hosts) jobs.push((async () => {
      const me = await this.whoami("gitlab", host);
      const [mine, review] = await Promise.all([
        cli("glab", ["api", "merge_requests?scope=created_by_me&state=opened&per_page=50", "--hostname", host]),
        cli("glab", ["api", `merge_requests?scope=all&state=opened&reviewer_username=${enc(me)}&per_page=50`, "--hostname", host]),
      ]);
      return [...mine.map((m) => fromGitlab(m, me)), ...review.map((m) => ({ ...fromGitlab(m, me), review: true }))];
    })().catch((e) => { errors.push(`${host}: ${e.message}`); return []; }));
    const seen = new Map();
    for (const it of (await Promise.all(jobs)).flat()) {
      const old = seen.get(it.url);
      seen.set(it.url, old ? { ...old, review: old.review || it.review } : it);
    }
    return { items: [...seen.values()], errors };
  }

  refresh(cx) {
    if (checking()) return;
    const gen = ++this.gen, loc = location(), scope = this.scope;
    this.context = JSON.stringify(loc);
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const r = scope === "all" ? await this.loadAll() : { items: await this.loadRepo(loc), errors: [] };
        if (gen !== this.gen) return;
        this.items = r.items.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
        this.errors = r.errors;
      } catch (e) {
        if (gen !== this.gen) return;
        this.items = []; this.errors = [e.message ?? String(e)];
      } finally {
        if (gen === this.gen) { this.loading = false; cx.notify(); }
      }
    });
    cx.notify();
  }

  row(it, t) {
    const badge = it.forge === "github" ? ["GH", t.ansi5] : ["GL", t.ansi3];
    const meta = [this.scope === "all" ? it.repo : null, it.author, it.branch].filter(Boolean).join(" · ");
    return h_flex().id(`pr-${it.url}`).flex_none().px(8).py(6).gap(8).items_start().rounded(0).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => openUrl(it.url))
      .child(div().mt(1).w(20).flex_none().text_center().rounded(0).text_size(9).font_semibold().bg(badge[1] + "26").text_color(badge[1]).child(badge[0]))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).min_w(0)
          .child(div().flex_none().text_color(t.dim).child(it.ref))
          .child(div().flex_1().min_w(0).truncate().text_color(it.draft ? t.muted : t.foreground).child(it.title)))
        .child(h_flex().gap(6).text_size(11).text_color(t.dim).min_w(0)
          .when(it.draft, (e) => e.child(div().px(4).rounded(0).border_1().border_color(t.border).child("Draft")))
          .child(div().flex_1().min_w(0).truncate().child(meta))
          .child(div().flex_none().child(ago(it.updated)))));
  }

  section(title, list, t) {
    if (!list.length) return [];
    return [h_flex().flex_none().px(8).pt(10).pb(4).gap(6).text_size(11).font_semibold().text_color(t.muted)
      .child(title).child(div().text_color(t.dim).child(String(list.length))), ...list.map((it) => this.row(it, t))];
  }

  render(cx) {
    if (!checking() && this.scope === "repo" && JSON.stringify(location()) !== this.context) this.refresh(cx);
    const t = theme();
    const review = this.items.filter((i) => i.review && !i.mine);
    const mine = this.items.filter((i) => i.mine);
    const other = this.items.filter((i) => !i.mine && !i.review);
    const tab = (id, label) => div().id(`scope-${id}`).h(22).px(9).flex().items_center().rounded(0).text_size(11.5).cursor_pointer()
      .bg(this.scope === id ? t.raised : t.background).text_color(this.scope === id ? t.foreground : t.muted)
      .on_click((_e, cx) => this.setScope(id, cx)).child(label);
    const rows = [
      ...this.section("To review", review, t),
      ...this.section("Mine", mine, t),
      ...this.section("Others", other, t),
    ];
    const empty = this.loading ? "Loading…" : this.errors.length ? null : this.scope === "repo" ? "No open PRs/MRs in this repo" : "No open PRs/MRs";
    return v_flex().id("prs").size_full().min_h(0).rounded(0).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/prs/pr.svg").size(14).text_color(t.muted))
        .child(div().font_semibold().child("Pull requests"))
        .child(div().flex_1())
        .child(h_flex().p(2).gap(2).rounded(0).border_1().border_color(t.border).child(tab("repo", "Repo")).child(tab("all", "All")))
        .child(div().id("prs-refresh").size(24).flex().items_center().justify_center().rounded(0).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.refresh(cx))
          .child(this.loading ? svg("mods/prs/refresh.svg").size(13).spin(900) : svg("mods/prs/refresh.svg").size(13))))
      .when(this.scope === "repo" && Boolean(this.repo), (e) => e.child(h_flex().flex_none().px(14).py(6).gap(6).text_size(11).text_color(t.dim).border_b(1).border_color(t.border)
        .child(div().child(this.repo.forge === "github" ? "GitHub" : "GitLab")).child(div().truncate().text_color(t.muted).child(this.repo.path))))
      .when(this.errors.length > 0, (e) => e.child(v_flex().flex_none().px(14).py(6).gap(2).text_size(11).text_color(t.ansi1)
        .children(this.errors.map((m) => div().child(m)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("prs-list").absolute().inset_0().overflow_y_scroll().px(6).pb(8)
          .children(rows)
          .when(!rows.length && Boolean(empty), (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
        .child(Scrollbar.vertical("prs-list").absolute().inset_0()));
  }
}
