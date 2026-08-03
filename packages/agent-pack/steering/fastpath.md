---
inclusion: always
---

# FastPath is mandatory retrieval

Kiro MUST locate code through FastPath, not by walking the repo.

## Always

1. Use auto-injected `## FastPath retrieved context` when present.
2. Otherwise call FastPath MCP tools: `search`, `symbol`, `grep_fast`, `context_for_task`, `impact`.
3. Open at most 3 files from those results, then edit.

## Never

- `listDirectory` / recursive glob of the workspace for discovery
- Reading unrelated modules "for context"
- Specs/plans for renames, typos, one-file fixes
- Enabling unrelated MCP servers on the Scout agent

If the index is empty, tell the user to run `fastpath index` — do not fall back to full-repo exploration.
