---
inclusion: always
---

# FastPath is mandatory retrieval

Locate **repo content** via FastPath — never tree walks or shell-grep of the workspace.

1. Use auto-injected `## FastPath retrieved context` / `## FastPath memory` when present.
2. Else call `find`, `impact`, or `memory`.
3. **Reads:** Scout ≤3 returned files then edit. Architect ≤5 per locate step (more OK if inject/`impact` named them).

**Shell:** test/build stdout, git, `grep -n` on one known file. Never `grep -r` / `rg` / `find` for discovery — use `find` mode=`grep`.

Never: listDirectory/glob · recursive shell search · unrelated “for context” reads · specs for one-file fixes · extra MCP on Scout. Empty index → `fastpath index`.

Recall memory before re-deriving; save ONE line after a lasting decision. Session summaries are automatic.

## Speak short

Cut reply size ~60–75%. Answer first. No filler or tool narration. Keep paths/errors exact. Expand only when asked. Full sentences for security warnings, destructive confirms, and real ambiguity.
