#!/usr/bin/env bash
# Install FastPath into FASTPATH_HOME (default ~/kiro-fastpath) from a release zip or checkout.
#
# Usage:
#   bash scripts/install-home.sh /path/to/kiro-fastpath-checkout
#   bash scripts/install-home.sh /path/to/kiro-fastpath-0.3.0.zip
#   bash scripts/install-home.sh --force /path/to/kiro-fastpath
#   FASTPATH_HOME=~/kiro-fastpath bash scripts/install-home.sh ./kiro-fastpath
#
# ARG is the kiro-fastpath product repo (has packages/cli) — NOT your application repo.
#
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

FORCE=0
SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f) FORCE=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      die "unknown flag: $1"
      ;;
    *)
      SRC="$1"
      shift
      ;;
  esac
done

[[ -n "$SRC" ]] || die "usage: $0 [--force] <kiro-fastpath-checkout-dir|release.zip>
  Example: $0 ~/Documents/kiro-fastpath
  Do NOT pass your application repo. Wire apps with install-target.sh next."

FASTPATH_HOME="${FASTPATH_HOME:-$HOME/kiro-fastpath}"
FASTPATH_HOME="$(cd "$(dirname "$FASTPATH_HOME")" && pwd)/$(basename "$FASTPATH_HOME")"
mkdir -p "$(dirname "$FASTPATH_HOME")"

command -v node >/dev/null || die "node >= 20 required"
command -v npm >/dev/null || die "npm required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node >= 20 required (found $(node -v))"

assert_fastpath_tree() {
  local dir="$1"
  [[ -f "$dir/package.json" ]] || die "not a FastPath tree (missing package.json): $dir"
  local name
  name="$(node -p "try{require('$dir/package.json').name}catch{''}")"
  [[ "$name" == "fastpath" ]] ||   die "not a kiro-fastpath checkout (package.json name='$name', expected 'fastpath'): $dir
  You probably passed your application repo. Use:
    $0 /path/to/kiro-fastpath
  Then wire the app with:
    bash \"\$HOME/kiro-fastpath/scripts/install-target.sh\" /path/to/your-repo"
  [[ -d "$dir/packages/cli" && -d "$dir/packages/core" ]] || \
    die "not a FastPath monorepo (missing packages/cli or packages/core): $dir"
}

TMP=""
cleanup() { [[ -n "$TMP" && -d "$TMP" ]] && rm -rf "$TMP"; }
trap cleanup EXIT

if [[ -f "$SRC" && "$SRC" == *.zip ]]; then
  command -v unzip >/dev/null || die "unzip required"
  TMP="$(mkdtemp -d)"
  info "Unpacking $SRC"
  unzip -q "$SRC" -d "$TMP"
  INNER="$(find "$TMP" -maxdepth 3 -type f -name package.json | head -1)"
  [[ -n "$INNER" ]] || die "zip missing package.json"
  SRC_DIR="$(cd "$(dirname "$INNER")" && pwd)"
elif [[ -d "$SRC" && -f "$SRC/package.json" ]]; then
  SRC_DIR="$(cd "$SRC" && pwd)"
else
  die "not a zip or FastPath checkout: $SRC
  Example: $0 /Users/you/Documents/kiro-fastpath"
fi

assert_fastpath_tree "$SRC_DIR"

# Refuse wiping a non-empty home that does not already look like FastPath (unless --force)
if [[ -d "$FASTPATH_HOME" ]] && [[ -n "$(ls -A "$FASTPATH_HOME" 2>/dev/null || true)" ]]; then
  if [[ -f "$FASTPATH_HOME/package.json" ]]; then
    HOME_NAME="$(node -p "try{require('$FASTPATH_HOME/package.json').name}catch{''}" 2>/dev/null || true)"
    if [[ "$HOME_NAME" != "fastpath" && "$FORCE" -ne 1 ]]; then
      die "FASTPATH_HOME=$FASTPATH_HOME is non-empty and package.json name='$HOME_NAME' (not 'fastpath').
  Refusing to wipe. Fix FASTPATH_HOME, or pass --force if you intend to replace it.
  Example: FASTPATH_HOME=~/kiro-fastpath $0 --force $SRC_DIR"
    fi
  elif [[ "$FORCE" -ne 1 ]]; then
    die "FASTPATH_HOME=$FASTPATH_HOME is non-empty and does not look like FastPath.
  Refusing to wipe. Pass --force only if you are sure.
  Tip: use the default ~/kiro-fastpath, never point FASTPATH_HOME at your app repo."
  fi
fi

info "Installing into $FASTPATH_HOME"
mkdir -p "$FASTPATH_HOME"

info "Cleaning previous FASTPATH_HOME contents..."
find "$FASTPATH_HOME" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

if command -v rsync >/dev/null; then
  rsync -a \
    --exclude node_modules \
    --exclude .fastpath \
    --exclude dist-release \
    --exclude .git \
    "$SRC_DIR"/ "$FASTPATH_HOME"/
else
  cp -R "$SRC_DIR"/. "$FASTPATH_HOME"/
  rm -rf "$FASTPATH_HOME/node_modules" "$FASTPATH_HOME/.git" 2>/dev/null || true
fi

assert_fastpath_tree "$FASTPATH_HOME"

cd "$FASTPATH_HOME"
info "Installing npm dependencies..."
if [[ -f package-lock.json ]]; then
  npm ci || {
    info "npm ci failed (lock out of sync) — falling back to npm install"
    npm install
  }
else
  npm install
fi

if npm approve-scripts --help >/dev/null 2>&1; then
  npm approve-scripts better-sqlite3 onnxruntime-node sharp protobufjs 2>/dev/null || true
  npm install
fi

if ! node -e "require('better-sqlite3')" 2>/dev/null; then
  info "Rebuilding better-sqlite3..."
  npm rebuild better-sqlite3 || die "better-sqlite3 failed"
fi

info "Building..."
npm run build
[[ -f packages/cli/dist/index.js ]] || die "CLI missing after build"

mkdir -p "$HOME/.fastpath"
VERSION="$(node -p "require('./package.json').version")"
# Preserve known workspaces if config already exists
if [[ -f "$HOME/.fastpath/config.json" ]]; then
  node -e "
const fs=require('fs');
const p=process.env.HOME+'/.fastpath/config.json';
let cfg={workspaces:{},lastWorkspace:null};
try{cfg=JSON.parse(fs.readFileSync(p,'utf8'));}catch{}
cfg.home=process.argv[1];
cfg.version=process.argv[2];
cfg.workspaces=cfg.workspaces||{};
fs.writeFileSync(p, JSON.stringify(cfg,null,2)+'\n');
" "$FASTPATH_HOME" "$VERSION"
else
  cat > "$HOME/.fastpath/config.json" <<EOF
{
  "home": "$FASTPATH_HOME",
  "version": "$VERSION",
  "workspaces": {},
  "lastWorkspace": null
}
EOF
fi

info "FastPath home ready: $FASTPATH_HOME (v$VERSION)"
echo ""
echo "Next — wire your APP repo (not FastPath):"
echo "  export FASTPATH_HOME='$FASTPATH_HOME'"
echo "  bash \"\$FASTPATH_HOME/scripts/install-target.sh\" /path/to/your-repo"
echo "  # or: node \"\$FASTPATH_HOME/packages/cli/dist/index.js\" use /path/to/your-repo"
echo "After upgrades: node \"\$FASTPATH_HOME/packages/cli/dist/index.js\" rewire --all"
