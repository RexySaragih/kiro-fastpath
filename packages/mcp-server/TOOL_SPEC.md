# FastPath MCP — Tool Spec (v0.2)

## Agent jobs

Give Kiro a warm local hybrid index so agents **retrieve a few chunks then act**, instead of packing the workspace and over-exploring.

## Defaults

| Field | Value |
|-------|-------|
| Language | TypeScript (ESM) |
| Transport | stdio |
| Capabilities | tools only |
| Posture | read-only for code (index writes via CLI); `memory_save` writes to the local `.fastpath` memory store only |
| Auth | none (local filesystem; workspace via `FASTPATH_WORKSPACE`) |
| Output | compact markdown |
| Scope | 7 tools |
| SDK | `@modelcontextprotocol/sdk@1.30.0` |

## credentials

No API credentials or tokens. Local filesystem only.
Do not store secrets in project `.env` — use mcp.json `env` if configuration is needed.

## Storage

- SQLite at `<workspace>/.fastpath/index.db`
- FTS5 (BM25) + symbols + resolved import edges
- Sparse n-gram inverted index for `grep_fast`
- Feature-hash embeddings (256-d) + RRF fusion with FTS
- Symbol extraction: TypeScript compiler API; regex for Python/Go

## Env (mcp.json only — never project `.env`)

| Var | Required | Description |
|-----|----------|-------------|
| `FASTPATH_WORKSPACE` | no | Workspace root (default: `process.cwd()`) |
## Tools (pick guide)

| Need | Tool |
|------|------|
| Concept / fuzzy topic | `search` |
| Known identifier | `symbol` |
| Starter files for a coding task | `context_for_task` |
| Exact text / regex in source lines | `grep_fast` (content only; use `path_prefix` for dirs) |
| Callers / importers / rename blast radius | `impact` |
| Save a lasting note | `memory_save` |
| Recall a past note | `memory_recall` |

### 1. `search`
Hybrid FTS + vector (RRF). Params: `query`, `top_k?`, `path_prefix?`. Annotations: readOnly, idempotent, not openWorld, not destructive. Not for regex or exact symbol-name lookup.

### 2. `symbol`
Exact/fuzzy symbol lookup by identifier. Params: `name`, `kind?`, `top_k?`. Same annotations. Not for prose questions.

### 3. `context_for_task`
One-shot context pack for starting work. Params: `task`, `max_chunks?` (max 8). Same annotations. Prefer once per task; skip if inject already enough.

### 4. `grep_fast`
Sparse n-gram prefilter + regex verify against **file contents** (not filenames). Params: `pattern`, `top_k?`, `path_prefix?`. Same annotations. Never use filename globs as `pattern`; scope dirs with `path_prefix`.

### 5. `impact`
Definitions + callers + importers + refs for a **known** symbol. Params: `name`, `depth?` (1–3), `top_k?`. Same annotations.

### 6. `memory_save`
Persist a project memory (decision / fact / preference / session) into `.fastpath/index.db`. Params: `kind`, `text`, `tags?`, `paths?`. Annotations: NOT readOnly (local store write), idempotent, not destructive, not openWorld. Not for code search.

### 7. `memory_recall`
FTS + embedding RRF recall over saved memories. Params: `query`, `top_k?` (max 10). Annotations: readOnly, idempotent, not openWorld, not destructive. Not for source code.

## Non-goals

- Write/delete tools
- Cloud embeddings by default (feature-hash is offline)
- Spec generation

## Risks

- Index may be stale until `fastpath index`
- Feature-hash embeddings are weaker than voyage/nomic for pure NL
- Regex parsers for non-TS languages are best-effort
- Large workspaces need ignore rules
