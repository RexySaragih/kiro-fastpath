---
inclusion: always
---

# FastPath is mandatory retrieval

Output style: see `caveman.md` (always-on).

Locate **repo content** via FastPath — never tree walks or shell-grep of the workspace.

1. Use auto-injected `## FastPath retrieved context` / `## FastPath memory` when present — those blocks already contain focused code windows (`path:start-end` + body).
2. Else call `find`, `impact`, `window`, or `memory`.
3. **Reads:** Prefer injected / MCP windows. Use FastPath `window` for a few more lines. Host `read` only when a window is insufficient (Scout ≤3 host reads; Architect ≤5 per locate step). Never whole-file reads "for context."

**Shell:** test/build stdout, git, `grep -n` on one known file. Never `grep -r` / `rg` / `find` for discovery — use `find` mode=`grep`.

Never: listDirectory/glob · recursive shell search · unrelated “for context” reads · specs for one-file fixes · extra MCP on Scout. Empty index → `fastpath index`.

Recall memory before re-deriving; save ONE line after a lasting decision. Session summaries are automatic.
