---
inclusion: always
---

# FastPath is mandatory retrieval

Output style: see `caveman.md` (always-on).

Locate **repo content** via FastPath — never tree walks or shell-grep of the workspace.

1. Use auto-injected `## FastPath retrieved context` / `## FastPath memory` when present — those blocks already contain focused code windows (`path:start-end` + body).
2. If `## NO_MATCH` — ask for a path/symbol or call `find` with a sharper query. Do **not** treat recency as task hits.
3. Else call `find`, `impact`, `window`, or `memory`.
4. **Reads:** Prefer injected / MCP windows. Use FastPath `window` for a few more lines. Host `read` only when a window is insufficient (Scout ≤3 host reads; Architect ≤5 per locate step; Default: minimize whole-file reads). Never whole-file reads "for context."

**Agents:** Scout ≤5 distinct files, no shell (verify on Default/Architect). Architect 6+ / design / impact. Default = daily surface with shell for verify. Routing advisor in inject is a hint.

**Shell:** test/build stdout, git, `grep -n` on one known file. Never `grep -r` / `rg` / `find` for discovery — use `find` mode=`grep`. Scout has no shell.

## Debug / test failure loop

1. Paste unique tokens from stderr / assertion message.
2. `find` mode=`grep` (or symbol) → `window` around the fail site.
3. Fix root cause (ponytail).
4. Re-run the smallest check on **Default** or **Architect** (Scout cannot shell).

Never: listDirectory/glob · recursive shell search · unrelated “for context” reads · specs for one-file fixes · extra MCP on Scout. Empty index → ask user for `fastpath index`.

Recall memory before re-deriving; save ONE line after a lasting decision. Session summaries are automatic. Use `memory` op=list|forget to manage stale notes.
