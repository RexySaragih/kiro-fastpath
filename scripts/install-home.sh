#!/usr/bin/env bash
# Install FastPath into FASTPATH_HOME (default ~/fastpath) from a release zip or checkout.
#
# Usage:
#   bash scripts/install-home.sh /path/to/fastpath-0.3.0-darwin-arm64.zip
#   bash scripts/install-home.sh /path/to/existing/fastpath/checkout
#   FASTPATH_HOME=/opt/fastpath bash scripts/install-home.sh ./dist-release/fastpath-*.zip
#
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

SRC="${1:-}"
[[ -n "$SRC" ]] || die "usage: $0 <release.zip|checkout-dir>"

FASTPATH_HOME="${FASTPATH_HOME:-$HOME/fastpath}"
FASTPATH_HOME="$(cd "$(dirname "$FASTPATH_HOME")" && pwd)/$(basename "$FASTPATH_HOME")"
mkdir -p "$(dirname "$FASTPATH_HOME")"

command -v node >/dev/null || die "node >= 20 required"
command -v npm >/dev/null || die "npm required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node >= 20 required (found $(node -v))"

TMP=""
cleanup() { [[ -n "$TMP" && -d "$TMP" ]] && rm -rf "$TMP"; }
trap cleanup EXIT

if [[ -f "$SRC" && "$SRC" == *.zip ]]; then
  command -v unzip >/dev/null || die "unzip required"
  TMP="$(mktemp -d)"
  info "Unpacking $SRC"
  unzip -q "$SRC" -d "$TMP"
  INNER="$(find "$TMP" -maxdepth 2 -type f -name package.json | head -1)"
  [[ -n "$INNER" ]] || die "zip missing package.json"
  SRC_DIR="$(cd "$(dirname "$INNER")" && pwd)"
elif [[ -d "$SRC" && -f "$SRC/package.json" ]]; then
  SRC_DIR="$(cd "$SRC" && pwd)"
else
  die "not a zip or FastPath checkout: $SRC"
fi

info "Installing into $FASTPATH_HOME"
mkdir -p "$FASTPATH_HOME"
# rsync if available, else cp
if command -v rsync >/dev/null; then
  rsync -a --delete \
    --exclude node_modules \
    --exclude .fastpath \
    --exclude dist-release \
    --exclude .git \
    "$SRC_DIR"/ "$FASTPATH_HOME"/
else
  find "$FASTPATH_HOME" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  cp -R "$SRC_DIR"/. "$FASTPATH_HOME"/
fi

cd "$FASTPATH_HOME"
info "npm ci (native modules for this machine)..."
npm ci

if npm approve-scripts --help >/dev/null 2>&1; then
  npm approve-scripts better-sqlite3 onnxruntime-node sharp protobufjs 2>/dev/null || true
  npm ci
fi

if ! node -e "require('better-sqlite3')" 2>/dev/null; then
  info "Rebuilding better-sqlite3..."
  npm rebuild better-sqlite3 || die "better-sqlite3 failed"
fi

# Ensure dist exists (zip should ship it; checkout may need build)
if [[ ! -f packages/cli/dist/index.js ]]; then
  info "Building..."
  npm run build
fi

mkdir -p "$HOME/.fastpath"
VERSION="$(node -p "require('./package.json').version")"
cat > "$HOME/.fastpath/config.json" <<EOF
{
  "home": "$FASTPATH_HOME",
  "version": "$VERSION",
  "workspaces": {},
  "lastWorkspace": null
}
EOF

info "FastPath home ready: $FASTPATH_HOME (v$VERSION)"
echo "Next:"
echo "  export FASTPATH_HOME='$FASTPATH_HOME'"
echo "  bash \"\$FASTPATH_HOME/scripts/install-target.sh\" /path/to/your/repo"
echo "  # or: node \"\$FASTPATH_HOME/packages/cli/dist/index.js\" use /path/to/your/repo"
