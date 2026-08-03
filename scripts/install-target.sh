#!/usr/bin/env bash
# FastPath — wire a Kiro workspace using FASTPATH_HOME (default ~/kiro-fastpath).
#
# Usage:
#   ./scripts/install-target.sh /path/to/your/repo
#   FASTPATH_HOME=~/kiro-fastpath ./scripts/install-target.sh /path/to/krom-falcon
#   ./scripts/install-target.sh --skip-warm /path/to/your/repo
#   ./scripts/install-target.sh --hash /path/to/your/repo   # CI/offline (no MiniLM)
#
# Prefers an existing FASTPATH_HOME install. Falls back to this checkout.
#
set -euo pipefail

SKIP_WARM=0
USE_HASH=0
WORKSPACE=""

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }
ok() { echo "OK  $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-warm) SKIP_WARM=1; shift ;;
    --hash) USE_HASH=1; SKIP_WARM=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      die "unknown flag: $1"
      ;;
    *)
      WORKSPACE="$1"
      shift
      ;;
  esac
done

[[ -n "$WORKSPACE" ]] || die "usage: $0 [--skip-warm|--hash] /path/to/repo"
WORKSPACE="$(cd "$WORKSPACE" && pwd)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

resolve_home() {
  if [[ -n "${FASTPATH_HOME:-}" && -f "${FASTPATH_HOME}/packages/cli/dist/index.js" ]]; then
    cd "$FASTPATH_HOME" && pwd
    return
  fi
  for def in "$HOME/kiro-fastpath" "$HOME/fastpath"; do
    if [[ -f "$def/packages/cli/dist/index.js" ]]; then
      cd "$def" && pwd
      return
    fi
  done
  if [[ -f "$SCRIPT_ROOT/packages/cli/dist/index.js" || -f "$SCRIPT_ROOT/package.json" ]]; then
    echo "$SCRIPT_ROOT"
    return
  fi
  die "FASTPATH_HOME not found. Run: bash scripts/install-home.sh /path/to/kiro-fastpath"
}

FASTPATH_HOME="$(resolve_home)"
CLI="$FASTPATH_HOME/packages/cli/dist/index.js"

info "FastPath home: $FASTPATH_HOME"
info "Target workspace: $WORKSPACE"

command -v node >/dev/null || die "node not found — install Node.js >= 20"
command -v npm >/dev/null || die "npm not found"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node >= 20 required (found $(node -v))"

cd "$FASTPATH_HOME"
export FASTPATH_HOME

info "Ensuring dependencies..."
if [[ -f package-lock.json ]]; then
  npm ci 2>/dev/null || npm install
else
  npm install
fi

if npm approve-scripts --help >/dev/null 2>&1; then
  npm approve-scripts better-sqlite3 onnxruntime-node sharp protobufjs 2>/dev/null || true
fi

if ! node -e "require('better-sqlite3')" 2>/dev/null; then
  info "Rebuilding better-sqlite3..."
  npm rebuild better-sqlite3 || die "better-sqlite3 failed — install Xcode CLT / build-essential"
fi

if [[ ! -f "$CLI" ]]; then
  info "Building packages..."
  npm run build
fi
[[ -f "$CLI" ]] || die "CLI missing: $CLI"

export FASTPATH_WORKSPACE="$WORKSPACE"
if [[ "$USE_HASH" -eq 1 ]]; then
  export FASTPATH_EMBED=hash
  export FASTPATH_RERANK=off
  export FASTPATH_ALLOW_HASH=1
  info "Mode: hash embed (offline/CI) — not SCOUT READY for office MiniLM path"
else
  export FASTPATH_EMBED=minilm
  export FASTPATH_RERANK=on
fi

FP() { node "$CLI" "$@"; }

if [[ "$SKIP_WARM" -eq 0 ]]; then
  info "Warming MiniLM + reranker + tree-sitter grammars (first run downloads models)..."
  FP warm
else
  info "Skipping warm"
fi

info "Initializing FastPath in workspace..."
FP init "$WORKSPACE"

info "Indexing workspace (this can take a while)..."
FP index "$WORKSPACE"

info "Installing Kiro agents + MCP + UserPromptSubmit inject hook..."
FP use "$WORKSPACE"

for agent_file in "$WORKSPACE"/.kiro/agents/*.{md,json}; do
  [[ -f "$agent_file" ]] || continue
  if grep -E -q '\b(allowedTools|includeMcpJson|toolsSettings)\b' "$agent_file"; then
    die "IDE-incompatible agent written: $agent_file"
  fi
done
ok "Agent pack IDE-compatible"

info "Running doctor..."
set +e
FP doctor "$WORKSPACE"
DOCTOR_RC=$?
set -e

VERSION="$(node -p "require('$FASTPATH_HOME/package.json').version")"
mkdir -p "$HOME/.fastpath"
# Merge lastWorkspace via node to avoid clobbering workspaces map
node -e "
const fs=require('fs');const p=process.env.HOME+'/.fastpath/config.json';
let c={home:process.env.FASTPATH_HOME,version:process.argv[1],workspaces:{},lastWorkspace:null};
try{c={...c,...JSON.parse(fs.readFileSync(p,'utf8'))};}catch{}
c.home=process.env.FASTPATH_HOME;c.version=process.argv[1];
c.lastWorkspace=process.argv[2];
c.workspaces=c.workspaces||{};
c.workspaces[process.argv[2]]={wiredAt:new Date().toISOString()};
fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');
" "$VERSION" "$WORKSPACE"

cat <<EOF

────────────────────────────────────────────────────────────
FastPath install finished.

FastPath:  $FASTPATH_HOME
Workspace: $WORKSPACE
CLI:       node $CLI

Kiro checklist (3 steps):
  1) Reload window
  2) Agent picker → Workspace → Scout
  3) Hook UI → enable fastpath-auto-context

Aliases (~/.zshrc):
  export FASTPATH_HOME='$FASTPATH_HOME'
  alias fastpath='node "\$FASTPATH_HOME/packages/cli/dist/index.js"'

After big git pulls: fastpath index --git
Long sessions: fastpath watch
Runbook: $FASTPATH_HOME/scripts/OFFICE_RUNBOOK.txt
────────────────────────────────────────────────────────────
EOF

if [[ "$DOCTOR_RC" -ne 0 ]]; then
  echo "WARNING: doctor reported issues (exit $DOCTOR_RC)." >&2
  exit "$DOCTOR_RC"
fi

ok "SCOUT READY (doctor passed)"
