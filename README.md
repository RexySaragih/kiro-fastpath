# FastPath v0.3

Warm local hybrid code index + thin MCP + **Scout** / **Architect** agents for AWS Kiro (IDE and CLI).

Makes Kiro **retrieve → act** instead of packing the workspace and over-exploring.

> Git repo: **kiro-fastpath**. Clone into `~/kiro-fastpath` on each machine. Not an `npx`-only MCP — needs a local home (index, MiniLM, inject hook, agents).

## Architecture

| Layer | Tech |
|-------|------|
| Store | SQLite `.fastpath/index.db` (WAL) |
| Lexical | FTS5 BM25 |
| Regex speedup | Sparse n-gram inverted index |
| Semantic | MiniLM (`@huggingface/transformers`) + RRF; hash fallback |
| ANN | LSH (+ optional `sqlite-vec`) |
| Graph | Import edges + `call_edges` |
| Symbols | web-tree-sitter (legacy TS/regex fallback) |
| Freshness | Prompt-inject delta, `watch`, `index --git` |
| Delivery | MCP stdio — 5 read-only tools |
| Harness | Scout / Architect + steering + doctor |

```text
index (CLI) → SQLite / FTS / ngrams / vectors / call graph
                ↓
   UserPromptSubmit hook (auto-inject STDOUT)
   + FastPath MCP (tools when needed)
                ↓
     Kiro Scout agent → edit
```

## Make Kiro actually use the index

Indexing alone does nothing. Kiro only uses FastPath when all three exist:

1. **Auto-inject** — `.kiro/hooks/fastpath-context.json` on `UserPromptSubmit` (exit `0` STDOUT → context).
2. **Tool binding** — Scout has inline `mcpServers.fastpath` + `tools: [..., "@fastpath"]`.
3. **Behavior** — steering + Scout prompt: max ~3 file reads, no repo walks.

`install-target` / `use` / `install-kiro` install all three. Then select **Scout** and enable the hook in Kiro Hook UI.

## Quick start (git — recommended)

**Once per machine** (office or home):

```bash
git clone <kiro-fastpath-url> ~/kiro-fastpath
bash ~/kiro-fastpath/scripts/install-home.sh ~/kiro-fastpath
```

`install-home` takes the **kiro-fastpath** checkout — not your app repo.

**Per project workspace** (e.g. krom-falcon):

```bash
export FASTPATH_HOME=~/kiro-fastpath
bash "$FASTPATH_HOME/scripts/install-target.sh" /path/to/krom-falcon
# or: node "$FASTPATH_HOME/packages/cli/dist/index.js" use /path/to/krom-falcon
```

**In Kiro:**

1. Reload window  
2. Agent picker → **Workspace → Scout**  
3. Hook UI → enable **fastpath-auto-context**  
4. Disable other MCP servers for daily work  

**Updates:**

```bash
cd ~/kiro-fastpath && git pull && npm ci && npm run build
# re-wire if agents/hooks/templates changed:
node packages/cli/dist/index.js use /path/to/krom-falcon
# after a large pull of the *project* repo:
node packages/cli/dist/index.js index --git /path/to/krom-falcon
```

Docs for agents / first install:

- `scripts/OFFICE_RUNBOOK.txt` — day-to-day ops  
- `scripts/INSTALL_PROMPT.txt` — paste into an agent to install on a new machine  
- `scripts/SECURITY_NOTES.txt` — npm audit policy  

Optional USB/airgap zip: `npm run pack:release` then `bash scripts/install-home.sh dist-release/fastpath-*.zip`.

## Dev from a checkout

```bash
cd /path/to/fastpath   # this repo
npm install
npm approve-scripts better-sqlite3 onnxruntime-node sharp protobufjs   # if npm supports it
npm run build
bash scripts/install-target.sh /path/to/your/repo
```

## Agents

| Agent | Use for |
|-------|---------|
| **Scout** | Daily coding — locate → edit, max ~3 files |
| **Architect** | Multi-file features (+ shell / subagent) |

Do not add CLI-only fields (`allowedTools`, `includeMcpJson`) to agent markdown — Kiro IDE will hide the agent.

## CLI

```bash
fastpath init|index|watch|status|doctor|warm|eval [workspace]
fastpath index [workspace] --git          # git-changed files only
fastpath doctor [workspace] [--json]
fastpath install-kiro|repair-kiro|use [workspace]
fastpath home|version|metrics [--summary]
```

Env (also set by install into MCP/hook):

| Variable | Meaning |
|----------|---------|
| `FASTPATH_HOME` | Product install root (default `~/kiro-fastpath`) |
| `FASTPATH_WORKSPACE` | Target repo |
| `FASTPATH_EMBED` | `auto` \| `minilm` \| `hash` |
| `FASTPATH_RERANK` | `on` \| `off` |
| `FASTPATH_PARSER` | `treesitter` \| `legacy` |
| `FASTPATH_ALLOW_HASH` | `1` to allow hash backend in doctor |

Optional ANN: `npm install sqlite-vec -w @fastpath/core` then re-index.

### MCP shape (written by install — do not hand-copy ADATA paths)

```json
{
  "mcpServers": {
    "fastpath": {
      "command": "node",
      "args": ["$FASTPATH_HOME/packages/mcp-server/dist/index.js"],
      "env": {
        "FASTPATH_WORKSPACE": "/path/to/repo",
        "FASTPATH_EMBED": "minilm",
        "FASTPATH_RERANK": "on"
      }
    }
  }
}
```

## MCP tools (read-only)

| Tool | Use when |
|------|----------|
| `search` | Hybrid locate (FTS + vectors via RRF + optional rerank) |
| `symbol` | Know the symbol name |
| `context_for_task` | One-shot context pack for a prompt |
| `grep_fast` | Exact/regex text via n-gram prefilter |
| `impact` | Definitions, callers, importers, references |

## Verify

```bash
npm test
npm run test:connections
npm run eval
npm run audit:critical
node packages/cli/dist/index.js doctor /path/to/your/repo
```

Expect doctor: **SCOUT READY**.

## Residual risks

- Hash embeddings are weaker than MiniLM for natural-language queries; office path uses MiniLM.
- Non-TS parsers are best-effort.
- Kiro may still inject workspace file trees (product behavior) — keep ignores strict and MCP lean.
- Soft steering cannot force tool use — rely on auto-inject + Scout binding.
- Some transitive `npm audit` highs under `@huggingface/transformers` — see `scripts/SECURITY_NOTES.txt`.

## License

MIT
