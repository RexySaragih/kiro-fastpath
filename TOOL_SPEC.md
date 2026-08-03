# FastPath MCP — Tool Spec (v0.2)

## Agent jobs

Give Kiro a warm local hybrid index so agents **retrieve a few chunks then act**, instead of packing the workspace and over-exploring.

## Defaults

| Field | Value |
|-------|-------|
| Language | TypeScript (ESM) |
| Transport | stdio |
| Capabilities | tools only |
| Posture | **read-only** (index writes via CLI only) |
| Auth | none (local filesystem; workspace via `FASTPATH_WORKSPACE`) |
| Output | compact markdown |
| Scope | 5 tools |
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
| `FASTPATH_TOP_K` | no | Soft default result hint |

## Tools

### 1. `search`
Hybrid FTS + vector (RRF). Params: `query`, `top_k?`, `path_prefix?`. Annotations: readOnly, idempotent, not openWorld, not destructive.

### 2. `symbol`
Exact/fuzzy symbol lookup. Params: `name`, `kind?`, `top_k?`. Same annotations.

### 3. `context_for_task`
One-shot context pack. Params: `task`, `max_chunks?` (max 8). Same annotations.

### 4. `grep_fast`
Sparse n-gram prefilter + regex verify. Params: `pattern`, `top_k?`, `path_prefix?`. Same annotations.

### 5. `impact`
Definitions + importers + references. Params: `name`, `depth?` (1–3), `top_k?`. Same annotations.

## Non-goals

- Write/delete tools
- Cloud embeddings by default (feature-hash is offline)
- Spec generation

## Risks

- Index may be stale until `fastpath index`
- Feature-hash embeddings are weaker than voyage/nomic for pure NL
- Regex parsers for non-TS languages are best-effort
- Large workspaces need ignore rules
