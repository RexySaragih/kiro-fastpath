#!/usr/bin/env bash
# Install FastPath into FASTPATH_HOME (default ~/kiro-fastpath) from a release zip or checkout.
#
# Usage:
#   bash scripts/install-home.sh
#   bash scripts/install-home.sh /path/to/kiro-fastpath-checkout
#   bash scripts/install-home.sh /path/to/kiro-fastpath-0.3.0.zip
#   bash scripts/install-home.sh --force /path/to/kiro-fastpath
#   FASTPATH_HOME=~/kiro-fastpath bash scripts/install-home.sh ./kiro-fastpath
#
# With no ARG: uses the checkout that contains this script, else the current directory
# if it looks like FastPath. ARG is the kiro-fastpath product repo (has packages/cli) —
# NOT your application repo.
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }

FORCE=0
SRC=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force|-f) FORCE=1; shift ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
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

# Default source when omitted: script checkout, else cwd (if it looks like FastPath).
if [[ -z "$SRC" ]]; then
  SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  CWD="$(pwd)"
  if [[ -f "$SCRIPT_ROOT/package.json" && -d "$SCRIPT_ROOT/packages/cli" ]]; then
    SRC="$SCRIPT_ROOT"
    info "No source arg; using script checkout: $SRC"
  elif [[ -f "$CWD/package.json" && -d "$CWD/packages/cli" ]]; then
    SRC="$CWD"
    info "No source arg; using current directory: $SRC"
  else
    die "usage: $0 [--force] [kiro-fastpath-checkout-dir|release.zip]
  No source given, and neither the script checkout nor cwd looks like FastPath.
  Example: $0 ~/Documents/kiro-fastpath
  Or run from the kiro-fastpath repo / invoke scripts/install-home.sh with no args.
  Do NOT pass your application repo. Wire apps with install-target.sh next."
  fi
fi

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

# CRITICAL: never wipe when source == destination (deletes the only copy, including .git).
# Compare canonical paths, not strings — symlinks, trailing slashes and `..`
# segments all made the old string check trivially bypassable.
canon() {
  if command -v realpath >/dev/null 2>&1; then
    realpath -- "$1" 2>/dev/null && return
  fi
  # macOS without coreutils: resolve with node (already required above).
  node -e "console.log(require('fs').realpathSync(process.argv[1]))" "$1" 2>/dev/null ||
    printf '%s' "$1"
}

SRC_CANON="$(canon "$SRC_DIR")"
HOME_CANON="$(canon "$FASTPATH_HOME")"

# Nesting is just as destructive as equality: cleaning the home would delete the
# source that lives inside it (or the source dir containing the home).
if [[ "$SRC_CANON" == "$HOME_CANON" ]] ||
   [[ "$HOME_CANON" == "$SRC_CANON"/* ]] ||
   [[ "$SRC_CANON" == "$HOME_CANON"/* ]]; then
  die "Source and FASTPATH_HOME resolve to the same or nested paths:
  source: $SRC_CANON
  home:   $HOME_CANON

  install-home copies a checkout INTO a separate home dir, then cleans the home first.
  Using the same path wipes your working tree.

  Fix — keep your git checkout where it is, install into the default home:
    unset FASTPATH_HOME
    bash $0 $SRC_DIR
  # installs into ~/kiro-fastpath

  Or set an explicit different home:
    FASTPATH_HOME=~/kiro-fastpath bash $0 $SRC_DIR"
fi

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

info "Installing into $FASTPATH_HOME (from $SRC_DIR)"
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

# --- Global CLI: FASTPATH_HOME + `fastpath` on PATH for new shells ---
install_shell_integration() {
  local home="$1"
  local bin_dir="$HOME/.fastpath/bin"
  local env_file="$HOME/.fastpath/env"
  local wrapper="$bin_dir/fastpath"
  local marker_begin="# >>> fastpath >>>"
  local marker_end="# <<< fastpath <<<"
  local block

  mkdir -p "$bin_dir"

  cat > "$env_file" <<EOF
# Generated by FastPath install-home.sh — do not edit by hand (re-run install-home to refresh).
export FASTPATH_HOME='$home'
export PATH="\$HOME/.fastpath/bin:\$PATH"
EOF

  cat > "$wrapper" <<'EOF'
#!/usr/bin/env bash
# FastPath CLI shim — resolves home from FASTPATH_HOME, then ~/.fastpath/config.json, then ~/kiro-fastpath.
set -euo pipefail
resolve_home() {
  if [[ -n "${FASTPATH_HOME:-}" && -f "${FASTPATH_HOME}/packages/cli/dist/index.js" ]]; then
    printf '%s' "$FASTPATH_HOME"
    return
  fi
  if [[ -f "$HOME/.fastpath/config.json" ]]; then
    local from_cfg
    from_cfg="$(node -p "try{JSON.parse(require('fs').readFileSync(process.env.HOME+'/.fastpath/config.json','utf8')).home||''}catch{''}" 2>/dev/null || true)"
    if [[ -n "$from_cfg" && -f "$from_cfg/packages/cli/dist/index.js" ]]; then
      printf '%s' "$from_cfg"
      return
    fi
  fi
  if [[ -f "$HOME/kiro-fastpath/packages/cli/dist/index.js" ]]; then
    printf '%s' "$HOME/kiro-fastpath"
    return
  fi
  echo "ERROR: FastPath CLI not found. Run: bash scripts/install-home.sh /path/to/kiro-fastpath" >&2
  exit 1
}
HOME_DIR="$(resolve_home)"
export FASTPATH_HOME="$HOME_DIR"
exec node "$HOME_DIR/packages/cli/dist/index.js" "$@"
EOF
  chmod +x "$wrapper"

  block="${marker_begin}
# FastPath — load FASTPATH_HOME + put \`fastpath\` on PATH
[ -f \"\$HOME/.fastpath/env\" ] && . \"\$HOME/.fastpath/env\"
${marker_end}"

  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [[ ! -f "$rc" ]]; then
      touch "$rc"
    fi
    if grep -qF "$marker_begin" "$rc" 2>/dev/null; then
      local tmp
      tmp="$(mktemp)"
      awk -v begin="$marker_begin" -v end="$marker_end" '
        $0 == begin { skip=1; next }
        $0 == end { skip=0; next }
        !skip { print }
      ' "$rc" > "$tmp"
      printf '\n%s\n' "$block" >> "$tmp"
      mv "$tmp" "$rc"
      info "Updated FastPath PATH block in $rc"
    else
      printf '\n%s\n' "$block" >> "$rc"
      info "Added FastPath PATH block to $rc"
    fi
  done
}

install_shell_integration "$FASTPATH_HOME"

export FASTPATH_HOME
export PATH="$HOME/.fastpath/bin:$PATH"

info "FastPath home ready: $FASTPATH_HOME (v$VERSION)"
echo ""
echo "CLI (global):"
echo "  FASTPATH_HOME=$FASTPATH_HOME"
echo "  command: fastpath  (via ~/.fastpath/bin)"
echo "  Reload shell or:  source ~/.fastpath/env"
echo ""
echo "Next — wire your APP repo (not FastPath):"
echo "  bash \"\$FASTPATH_HOME/scripts/install-target.sh\" /path/to/your-repo"
echo "  # or: fastpath use /path/to/your-repo"
echo "After upgrades: fastpath rewire --all"
echo ""
echo "Note: your git checkout stays at $SRC_DIR (untouched)."
echo "      FASTPATH_HOME is the install copy at $FASTPATH_HOME."
