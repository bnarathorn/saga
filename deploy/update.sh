#!/usr/bin/env bash
#
# Deploy a commit from a developer checkout into the systemd production install.
#
# The production tree at /opt/saga is owned by an unprivileged service account that
# has no GitHub credentials, and the repository is private, so `git pull` and
# `git clone` both fail there with "could not read Username". This script moves the
# commit as a git bundle instead: a file the service account can read, carrying the
# same objects a fetch would have.
#
# Run it as a user that may sudo, from anywhere:
#
#   deploy/update.sh                 # deploy `main` from this checkout
#   deploy/update.sh v0.2.0          # deploy a tag or a branch other than main
#   deploy/update.sh main --force    # rebuild and restart even if already deployed
#   deploy/update.sh --rebuild       # rebuild whatever the target has checked out,
#                                    # moving no commits — this is the rollback path
#
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
SOURCE_REPO=${SAGA_SOURCE_REPO:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)}
TARGET=${SAGA_TARGET:-/opt/saga}
SERVICE_USER=${SAGA_SERVICE_USER:-saga}
WEB_ROOT=${SAGA_WEB_ROOT:-/var/www/saga-app}
WEB_OWNER=${SAGA_WEB_OWNER:-www-data:www-data}
ORIGIN=${SAGA_ORIGIN:-https://home-203.duckdns.org:8443}
# The service account's home *is* the deploy directory, so a build that inherits it
# writes `.cache/` and `.npm/` into the checkout. Keep the build's home outside, and
# keep it across runs so corepack does not re-download pnpm every deploy.
BUILD_HOME=${SAGA_BUILD_HOME:-/var/tmp/saga-build-home}

REF=main
FORCE=
REBUILD=
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --rebuild) REBUILD=1 ;;
    -*) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
    *) REF=$arg ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

as_service() { sudo -u "$SERVICE_USER" env HOME="$BUILD_HOME" "$@"; }
target_git() { as_service git -C "$TARGET" "$@"; }

[ -d "$TARGET/.git" ] || die "$TARGET is not a git checkout"
command -v rsync >/dev/null || die "rsync is required"

OLD_SHA=$(target_git rev-parse HEAD)

if [ -n "$REBUILD" ]; then
  say "Rebuilding $TARGET at $OLD_SHA — no commits will be moved"
  NEW_SHA=$OLD_SHA
else
  say "Resolving $REF in $SOURCE_REPO"
  # A bundle carries named refs, not bare object ids, so the ref has to be one.
  git -C "$SOURCE_REPO" rev-parse --verify --quiet "refs/heads/$REF" >/dev/null ||
    git -C "$SOURCE_REPO" rev-parse --verify --quiet "refs/tags/$REF" >/dev/null ||
    die "$REF is not a branch or tag in $SOURCE_REPO — deploy a named ref, not a commit id"
  NEW_SHA=$(git -C "$SOURCE_REPO" rev-parse "$REF^{commit}")
  target_git symbolic-ref --quiet HEAD >/dev/null ||
    die "$TARGET has a detached HEAD — check out a branch there first, or pass --rebuild"
  printf '  deployed: %s\n  wanted:   %s\n' "$OLD_SHA" "$NEW_SHA"

  if [ "$OLD_SHA" = "$NEW_SHA" ] && [ -z "$FORCE" ]; then
    say "Already at $NEW_SHA — nothing to do (pass --force to rebuild anyway)"
    exit 0
  fi
fi

# A dirty production tree means someone edited the server in place. Refuse rather
# than silently discarding it: a fast-forward would fail halfway through anyway.
if [ -n "$(target_git status --porcelain --untracked-files=no)" ]; then
  target_git status --short --untracked-files=no
  die "$TARGET has uncommitted tracked changes — resolve them before deploying"
fi

if [ "$OLD_SHA" != "$NEW_SHA" ]; then
  say "Bundling $OLD_SHA..$NEW_SHA"
  BUNDLE=$(mktemp /tmp/saga-deploy-XXXXXX.bundle)
  trap 'rm -f "$BUNDLE"' EXIT
  # Incremental when the deployed commit is an ancestor, whole history when it is
  # not (a first deploy, or a branch that was rewritten).
  if git -C "$SOURCE_REPO" merge-base --is-ancestor "$OLD_SHA" "$NEW_SHA" 2>/dev/null; then
    git -C "$SOURCE_REPO" bundle create "$BUNDLE" "$OLD_SHA..$REF"
  else
    git -C "$SOURCE_REPO" bundle create "$BUNDLE" "$REF"
  fi
  chmod 644 "$BUNDLE"  # the service account has to read it

  say "Fast-forwarding $TARGET"
  target_git fetch "$BUNDLE" "$REF:refs/deploy/incoming"
  target_git merge --ff-only refs/deploy/incoming
  target_git update-ref -d refs/deploy/incoming
fi

say "Installing dependencies"
sudo install -d -o "$SERVICE_USER" -m 755 "$BUILD_HOME"
as_service pnpm -C "$TARGET" install --frozen-lockfile

# `build` is tsc -b + the web bundle + the CLI bundle. The CLI bundle stamps itself
# with the commit it was built from, which is what `saga update` compares against.
say "Building"
as_service pnpm -C "$TARGET" build

say "Publishing $WEB_ROOT"
sudo rsync -a --delete "$TARGET/apps/web/dist/" "$WEB_ROOT/"
sudo chown -R "$WEB_OWNER" "$WEB_ROOT"

# Migrations first: the new server code may depend on the new schema, and
# saga-migrate is a one-shot that runs them under the production environment file.
say "Restarting services"
sudo systemctl restart saga-migrate
sudo systemctl restart saga-api saga-worker

say "Verifying"
sudo systemctl is-active saga-api saga-worker
SHORT=$(target_git rev-parse --short=10 HEAD)
# `systemctl restart` returns once the process exists, not once it is listening, so
# the first request after it can still be nginx's 502. Poll rather than conclude.
SERVED=
for _ in $(seq 30); do
  SERVED=$(curl -fsS -k "$ORIGIN/api/cli/saga" 2>/dev/null | grep -ao '0\.1\.0+g[a-z0-9.]*' | head -1 || true)
  [ -n "$SERVED" ] && break
  sleep 1
done
printf '  served CLI build: %s\n' "${SERVED:-<unreadable>}"
case "$SERVED" in
  *"g$SHORT"*) ;;
  *) die "the API is not serving a CLI built from $SHORT — check: journalctl -u saga-api -n 50" ;;
esac

say "Deployed $NEW_SHA"
if [ "$OLD_SHA" != "$NEW_SHA" ]; then
  # Going backwards is not a fast-forward, so a rollback resets the branch and then
  # rebuilds it in place; the old objects are still in the target's object store.
  printf 'Roll back with:\n  sudo -u %s git -C %s reset --hard %s\n  %s --rebuild\n' \
    "$SERVICE_USER" "$TARGET" "$OLD_SHA" "$SCRIPT_PATH"
fi
