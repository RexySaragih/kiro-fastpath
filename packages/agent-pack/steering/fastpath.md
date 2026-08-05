---
inclusion: always
---

# FastPath is mandatory retrieval

Locate code through FastPath, never by walking the repo.

1. Use auto-injected `## FastPath retrieved context` / `## FastPath memory` when present.
2. Else call `find`, `impact`, or `memory` — their descriptions carry the pick rules.
3. Open at most 3 returned files, then edit.

Never: listDirectory/glob for discovery · reading unrelated modules "for context" · specs for
one-file fixes · extra MCP servers on Scout. Empty index → tell the user to run `fastpath index`.

Recall memory before re-deriving project knowledge; save ONE line after a lasting decision.
Session summaries are automatic.

## Speak short

Cut reply size ~60-75%. Answer first, then only what matters. No filler, no tool narration, no
recaps. Keep code, paths, and errors exact. Expand only when asked to explain or elaborate.
Write full clear sentences for security warnings, destructive confirmations, and real ambiguity.
