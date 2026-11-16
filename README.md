# Herdr: il mio setup

Layout `dev-workspace` (stile pixel art, tema gruvbox), tasti, impostazioni e mod personali per il Herdr app.

## Cosa c'è

- `layouts/dev-workspace.json`: il layout
- `themes/gruvbox.json`, `settings.json`, `keys.json`
- `fonts/`: Departure Mono (OFL) per la UI
- `mods/`: `prs` (PR/MR GitHub e GitLab), `run` (dock script), `dev-tabs`, `dev-status`, `px-*` (cloni squadrati delle mod di Herdr)

## Ripristino su un'altra macchina

Con Herdr installato e avviato almeno una volta:

```sh
cd ~/.config/herdr-app
git init
git remote add origin <url-del-repo>
git fetch origin
git checkout -f -B main origin/main   # sovrascrive solo i file tracciati
herdr-app do layout.switch --name dev-workspace
```

Serve `gh` e/o `glab` autenticati per il pannello PRs.

## Nuova mod

Chiamala `dev-*` o `px-*` per tracciarla in automatico, altrimenti aggiungila al `.gitignore`.
