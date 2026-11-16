# Herdr: my setup

The `dev-workspace` layout (pixel-art style, gruvbox theme), keys, settings and personal mods for the Herdr app.

## What's here

- `layouts/dev-workspace.json`: the layout
- `themes/gruvbox.json`, `settings.json`, `keys.json`
- `fonts/`: Departure Mono (OFL) for the UI
- `mods/`: `prs` (GitHub and GitLab PRs/MRs), `run` (script dock), `dev-tabs`, `dev-status`, `px-*` (square-cornered clones of Herdr's mods)

## Install on another machine

Install Herdr and start it once, then:

```sh
curl -fsSL https://raw.githubusercontent.com/gab-25/herdr_config/main/install.sh | sh
```

Or from a clone: `git clone https://github.com/gab-25/herdr_config.git /tmp/herdr-setup && sh /tmp/herdr-setup/install.sh`.

The script turns `~/.config/herdr-app` (or `$HERDR_APP_HOME`) into a clone of this repo,
tracking `origin/main`. Files it overwrites (e.g. that machine's `keys.json`) are copied
to `.backup-<time>/` first; Herdr's own files are left alone. If Herdr is running it
switches to `dev-workspace`, and it tells you if `gh` or `glab` still needs `auth login`
(the PRs panel and the CI status use them).

Update later with `git -C ~/.config/herdr-app pull`: Herdr reloads the files live.

## New mods

Name a mod `dev-*` or `px-*` to track it automatically; otherwise add it to `.gitignore`.
