FastPath CHANGELOG
==================

1.0.0
-----
Battle-ready office release.

- Doctor: native ABI check, DB integrity_check, schema_version, search smoke,
  Architect validation, hook/MCP path resolve, MiniLM cache note, inject hitRate
- Agents: Scout.md / Architect.md only (removed Scout.json dual source);
  FASTPATH_HOME in mcp env; MCP connect/request timeouts; Scout denies shell/subagent
- CLI: index --rebuild, upgrade, rewire --all, unwire [--purge-index], repair-native,
  eval --office
- install-home: refuse wipe of non-FastPath home unless --force; preserve workspace registry
- Core: sqlite busy_timeout=5000; schema_version honesty; McpTimeouts / IndexLimits warn caps
- CI: Node 20+22 matrix, audit:critical, MiniLM+treesitter smoke job
- Docs: SUPPORT_MATRIX, RELEASE_GATE, office runbook updates

0.3.0
-----
Product-ready pack: MiniLM, call graph, Scout/Architect, portable ~/kiro-fastpath home,
install-home/target, doctor --json, index --git, watch path-delta, metrics.
