#!/usr/bin/env bash
# Build a portable FastPath release zip (no node_modules — target runs npm ci).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
OUT_DIR="$ROOT/dist-release"
STAGE="$OUT_DIR/stage/fastpath-$VERSION"
ZIP="$OUT_DIR/fastpath-$VERSION-$PLATFORM.zip"

echo "==> Building FastPath $VERSION ($PLATFORM)"
npm ci
npm run build

rm -rf "$STAGE"
mkdir -p "$STAGE/packages" "$STAGE/scripts" "$STAGE/fixtures"

# Root manifests + lock
cp package.json package-lock.json README.md tsconfig.base.json "$STAGE/"
[[ -f .gitignore ]] && cp .gitignore "$STAGE/"

# Packages (dist + sources needed for npm workspaces)
for pkg in core cli mcp-server agent-pack; do
  mkdir -p "$STAGE/packages/$pkg"
  cp "packages/$pkg/package.json" "$STAGE/packages/$pkg/"
  if [[ -d "packages/$pkg/dist" ]]; then
    cp -R "packages/$pkg/dist" "$STAGE/packages/$pkg/"
  fi
  if [[ "$pkg" == "agent-pack" ]]; then
    cp -R packages/agent-pack/agents packages/agent-pack/hooks \
      packages/agent-pack/steering packages/agent-pack/kiroignore.template \
      "$STAGE/packages/agent-pack/" 2>/dev/null || true
  fi
  # CLI/core need tsconfig only if rebuilding; ship package.json + dist is enough
done

# core needs types for consumers; already in dist
# Copy scripts + fixtures
cp -R scripts/. "$STAGE/scripts/"
cp -R fixtures/. "$STAGE/fixtures/"

# Ensure runbook exists in zip
[[ -f "$STAGE/scripts/OFFICE_RUNBOOK.txt" ]] || echo "See README" > "$STAGE/scripts/OFFICE_RUNBOOK.txt"

rm -f "$ZIP"
(
  cd "$OUT_DIR/stage"
  zip -qr "$ZIP" "fastpath-$VERSION"
)

echo "==> Wrote $ZIP"
echo "Install on target:"
echo "  bash scripts/install-home.sh $ZIP"
echo "  # or: FASTPATH_HOME=~/kiro-fastpath bash scripts/install-home.sh $ZIP"
