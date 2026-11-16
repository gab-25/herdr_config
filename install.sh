#!/usr/bin/env sh
# Installs this Herdr setup into the Herdr app's home folder.
# Usage:  curl -fsSL https://raw.githubusercontent.com/gab-25/herdr_config/main/install.sh | sh
#    or:  sh install.sh   (from a clone of the repo)
set -eu

REPO_URL="${HERDR_SETUP_REPO:-https://github.com/gab-25/herdr_config.git}"
DIR="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

say() { printf '%s\n' "$*"; }
die() { say "error: $*" >&2; exit 1; }

command -v git >/dev/null || die "git is not installed"

if [ -d "$DIR/.git" ]; then
  say "$DIR is already a git repo: update it with  git -C \"$DIR\" pull"
  exit 0
fi

# Run from a clone: use it. Piped through sh ($0 is then the shell, not a file):
# fetch the repo into a temp folder that goes away at the end.
SRC=""
[ -f "$0" ] && SRC=$(cd "$(dirname "$0")" && pwd)
if [ -z "$SRC" ] || [ ! -d "$SRC/.git" ]; then
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  git clone -q "$REPO_URL" "$TMP/repo" || die "cannot clone $REPO_URL"
  SRC="$TMP/repo"
fi
[ "$SRC" = "$DIR" ] && die "clone the repo somewhere else first, e.g. /tmp/herdr-setup"
command -v herdr-app >/dev/null || say "warning: herdr-app not found; install Herdr and start it once"

mkdir -p "$DIR"

# Back up every tracked file that already exists there and differs.
BACKUP="$DIR/.backup-$(date +%Y%m%d-%H%M%S)"
git -C "$SRC" ls-files | while IFS= read -r f; do
  if [ -f "$DIR/$f" ] && ! cmp -s "$SRC/$f" "$DIR/$f"; then
    mkdir -p "$BACKUP/$(dirname "$f")"
    cp -p "$DIR/$f" "$BACKUP/$f"
  fi
done
[ -d "$BACKUP" ] && say "backed up overwritten files to $BACKUP"

# Turn the Herdr home into the clone: same history, same upstream.
cp -R "$SRC/.git" "$DIR/.git"
git -C "$DIR" reset -q --hard
git -C "$DIR" status --short --branch | head -1

# Herdr hot-reloads the files; show the layout if a window is running.
if command -v herdr-app >/dev/null && herdr-app status >/dev/null 2>&1; then
  herdr-app do layout.switch --name dev-workspace >/dev/null && say "switched to the dev-workspace layout"
else
  say "start Herdr, then pick dev-workspace with ctrl-shift-l"
fi

# The PRs panel and the CI status need these CLIs logged in.
for cli in gh glab; do
  if ! command -v "$cli" >/dev/null; then say "note: $cli not installed (PRs panel skips that forge)"
  elif ! "$cli" auth status >/dev/null 2>&1; then say "note: $cli not logged in: run  $cli auth login"
  fi
done

[ -n "${TMP:-}" ] && say "done." || say "done. You can delete $SRC"
