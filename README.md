# Herdr: my setup

The `dev-workspace` layout (pixel-art style, gruvbox theme), keys, settings and personal mods for the Herdr app.

## What's here

- `layouts/dev-workspace.json`: the layout
- `themes/gruvbox.json`, `settings.json`, `keys.json`
- `fonts/`: Departure Mono (OFL) for the UI
- `mods/`: `prs` (GitHub and GitLab PRs/MRs), `run` (script dock), `dev-tabs`, `dev-status`, `px-*` (square-cornered clones of Herdr's mods)

## Restore on another machine

With Herdr installed and started at least once:

```sh
cd ~/.config/herdr-app
git init
git remote add origin <repo-url>
git fetch origin
git checkout -f -B main origin/main   # overwrites tracked files only
herdr-app do layout.switch --name dev-workspace
```

The PRs panel needs `gh` and/or `glab` logged in.

## New mods

Name a mod `dev-*` or `px-*` to track it automatically; otherwise add it to `.gitignore`.
