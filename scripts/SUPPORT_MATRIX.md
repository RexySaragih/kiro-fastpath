FastPath support matrix (v1.0)
==============================

OS
--
  Supported: macOS (arm64/x64), Linux (x64) — bash installers + Node natives
  Not supported: Windows (no .ps1 installers yet)

Node
----
  Required: >= 20
  CI matrix: 20, 22
  After Node upgrade: fastpath repair-native

Kiro
----
  IDE: custom agents via .kiro/agents/*.md (workspace must be trusted)
  Effort: session-level only — NOT per-agent (kirodotdev/Kiro#8754 open)
  Hook: UserPromptSubmit shell command; UI enable required (unverifiable from disk)
  MCP: inline mcpServers + tools: ["@fastpath"] (mitigates custom-agent MCP injection bugs)

Languages (index)
-----------------
  First-class: TypeScript / JavaScript (tree-sitter + TS fallback)
  Best-effort: Python, Go (regex / tree-sitter when grammars warm)
  Import edges: relative resolves only (no tsconfig paths aliases)

Distribution
------------
  Primary: git clone → scripts/install-home.sh → install-target.sh / use
  Optional: npm run pack:release → zip → install-home.sh zip
  Not: public npm publish (package private: true)

Security
--------
  See SECURITY_NOTES.txt — audit:critical must pass; known highs under transformers/onnx/sharp

Known Kiro product limits (not FastPath bugs)
---------------------------------------------
  - Per-agent effort field missing (#8754)
  - File-tree / context packing may still inject workspace noise
  - Soft steering cannot force MCP tool use — rely on auto-inject + Scout binding
