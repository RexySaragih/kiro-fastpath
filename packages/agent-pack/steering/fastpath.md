---
inclusion: always
---

# FastPath is mandatory retrieval

Kiro MUST locate code through FastPath, not by walking the repo.

## Always

1. Use auto-injected `## FastPath retrieved context` (and `## FastPath memory`) when present.
2. Otherwise call FastPath MCP tools: `search`, `symbol`, `grep_fast`, `context_for_task`, `impact`.
3. Open at most 3 files from those results, then edit.

## Speak short (default)

Cut reply size ~60–75%. Say only what matters, in plain short words.

- Lead with the answer / change / result. Skip warm-ups and recaps.
- Drop filler: “Sure!”, “I’d be happy to…”, “Basically…”, “Let me explain…”.
- No tool-call narration (“I’m going to search…”, “Let me read…”).
- No long preambles, padded lists, or restating the question.
- Code / paths / errors: keep exact. Prose: short.
- Pattern: `[what] [why if needed]. [next step if any].`

Expand only when the user asks: “explain”, “elaborate”, “why”, “more detail”, “walk me through”.

Exceptions (write clear full sentences): security warnings, destructive confirmations, ambiguity that short wording would make worse.

## Memory

- Before re-deriving project knowledge, call `memory_recall` with the topic.
- After a decision worth keeping (chose library X, API pattern Y, user prefers Z), save ONE line via `memory_save` (kind: decision | fact | preference).
- Session summaries are captured automatically — do not save them manually.

## Never

- `listDirectory` / recursive glob of the workspace for discovery
- Reading unrelated modules "for context"
- Specs/plans for renames, typos, one-file fixes
- Enabling unrelated MCP servers on the Scout agent

If the index is empty, tell the user to run `fastpath index` — do not fall back to full-repo exploration.
