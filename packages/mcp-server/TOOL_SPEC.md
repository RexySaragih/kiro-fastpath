# FastPath MCP — Tool Spec (v0.3)

## Agent jobs

Give Kiro a warm local hybrid index so agents **retrieve a few chunks then act**, instead of packing the workspace and over-exploring.

## Defaults

| Field | Value |
|-------|-------|
| Language | TypeScript (ESM) |
| Transport | stdio |
| Capabilities | tools only |
| Posture | read-only for code (index writes via CLI); `memory` action=save writes to the local `.fastpath` memory store only |
| Auth | none (local filesystem; workspace via `FASTPATH_WORKSPACE`) |
| Output | compact markdown |
| Scope | 3 advertised tools (`find`, `impact`, `memory`); legacy names remain callable |
| SDK | `@modelcontextprotocol/sdk@1.30.0` |

## credentials

No API credentials or tokens. Local filesystem only.
Do not store secrets in project `.env` — use mcp.json `env` if configuration is needed.

## Storage

- SQLite at `<workspace>/.fastpath/index.db`
- FTS5 (BM25) + symbols + resolved import edges
- Sparse n-gram inverted index for `find` mode=grep
- Feature-hash embeddings (256-d) + RRF fusion with FTS
- Symbol extraction: TypeScript compiler API; regex for Python/Go

## Env (mcp.json only — never project `.env`)

| Var | Required | Description |
|-----|----------|-------------|
| `FASTPATH_WORKSPACE` | no | Workspace root (default: `process.cwd()`) |
## Tools (pick guide)

| Need | Tool |
|------|------|
| Concept / fuzzy topic | `find` mode=`search` |
| Known identifier | `find` mode=`symbol` |
| Starter files for a coding task | `find` mode=`context` |
| Exact text / regex in source lines | `find` mode=`grep` (content only; use `path_prefix` for dirs) |
| Callers / importers / rename blast radius | `impact` |
| Save / recall / list / forget a note | `memory` |

### 1. `find`
Unified locate. Params: `query`, `mode?` (`search`\|`symbol`\|`grep`\|`context`), `kind?`, `top_k?`, `path_prefix?`. Annotations: readOnly, idempotent, not openWorld, not destructive.

### 2. `impact`
Definitions + callers + importers + refs for a **known** symbol. Params: `name`, `depth?` (1–3), `top_k?`. Same annotations.

### 3. `memory`
Persist or recall project memories. Params: `action` (`save`\|`recall`\|`list`\|`forget`), plus action-specific fields. Save is NOT readOnly (local store write).

Legacy aliases (`search`, `symbol`, `context_for_task`, `grep_fast`, `memory_save`, `memory_recall`) remain callable for older agent profiles but are not listed in `ListTools`.

## Non-goals

- Write/delete tools for source code
- Cloud embeddings by default (feature-hash is offline)
- Spec generation

## Risks

- Index may be stale until `fastpath index`
- Feature-hash embeddings are weaker than voyage/nomic for pure NL
