# @fastpath/mcp-server

Read-only MCP server for the FastPath local hybrid code index.

## Credentials / auth

No API credentials. Local filesystem only. Scope is the workspace path in `FASTPATH_WORKSPACE`.

Secrets go in mcp.json env, not project .env. FastPath does not load dotenv.

## mcp.json

```json
{
  "mcpServers": {
    "fastpath": {
      "command": "node",
      "args": ["/absolute/path/to/fastpath/packages/mcp-server/dist/index.js"],
      "env": {
        "FASTPATH_WORKSPACE": "/absolute/path/to/repo"
      },
      "disabled": false
    }
  }
}
```

## Scope

Least privilege: read-only tools over an indexed workspace. No shell, no writes, no network.

## Tools

`search`, `symbol`, `context_for_task`, `grep_fast`, `impact` — all `readOnlyHint`.

## Risks

- Reads source files under the workspace
- Index may be stale until `fastpath index`
- Disable unused MCP servers when using Scout agent
