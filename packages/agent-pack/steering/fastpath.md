---
inclusion: always
---

# FastPath is mandatory retrieval

Output: `caveman.md`. Code: `ponytail.md`. Both always-on (Scout: caveman only — it does not write code).

Locate **repo content** via FastPath — never tree walks or shell-grep of the workspace.

1. Use auto-injected `## FastPath` / `## FastPath memory` when present — those blocks already contain focused code windows (`path:start-end` + body).
2. If `## NO_MATCH` — spawn **Scout** (gatherer sub-agent) or call `find` with a sharper query. Do **not** treat recency as task hits.
3. Else call `find`, `impact`, `window`, or `memory`.
4. **Reads:** Prefer injected / MCP windows. Use FastPath `window` for a few more lines. Host `read` only when a window is insufficient (Scout ≤3 host reads; Architect ≤5 per locate step; Default: minimize whole-file reads). Never whole-file reads "for context."

**Agents:** Scout = context-gathering sub-agent (cheap model, read-only, structured `path:start-end` output). Spawn when auto-inject is NO_MATCH or insufficient. Architect 6+ / design / impact (can spawn Scout). Default = daily surface with edit + shell + can spawn Scout. Routing advisor in inject is a hint.

**When to spawn Scout:** NO_MATCH, complex multi-concern tasks, "go find X". **When not:** auto-inject already has strong hits, user gave an explicit path, tiny prompt. If Scout confidence is `partial`/`none`, verify with your own `find`/`window` before editing.

**Shell:** test/build stdout, git, `grep -n` on one known file. Never `grep -r` / `rg` / `find` for discovery — use `find` mode=`grep`. Scout has no shell and does not edit.

## Debug / test failure loop

1. Paste unique tokens from stderr / assertion message.
2. `find` mode=`grep` (or symbol) → `window` around the fail site. Spawn Scout if that locate would take many tool calls.
3. Fix root cause (ponytail) on **Default** or **Architect**.
4. Re-run the smallest check on **Default** or **Architect** (Scout cannot shell or edit).

Never: listDirectory/glob · recursive shell search · unrelated “for context” reads · specs for one-file fixes · extra MCP on Scout. Empty index → ask user for `fastpath index`.

Recall memory before re-deriving; save ONE line after a lasting decision. Session summaries are automatic. Use `memory` op=list|forget to manage stale notes.
