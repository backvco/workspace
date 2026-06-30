# Building tools (MCP) and adding them to a project

A **tool** here = an **MCP server**: a small program that exposes typed actions
(`tools`) which any Claude agent — the planner, a working agent, the advisor —
can call natively. This is the well-defined, schema-validated way to give Claude
new capabilities (vs. gluing a bespoke CLI in through the prompt).

## The contract

A tool is a stdio JSON-RPC (MCP) server. It must answer three methods over
newline-delimited JSON on stdin/stdout:

- `initialize` → `{ protocolVersion, capabilities:{tools:{}}, serverInfo:{name,version} }`
- `tools/list` → `{ tools: [{ name, description, inputSchema }] }` — `inputSchema`
  is JSON Schema; this is what Claude reads to call the tool correctly.
- `tools/call` `{ name, arguments }` → `{ content: [{ type:'text', text }] }`

Notifications (`notifications/initialized`, `notifications/cancelled`) get no
reply. `ping` → `{}`.

Keep tools **dependency-free** when possible: Node 22 has global `fetch`, so a
tool can just call the workspace-api REST endpoints (or anything else) directly.

## How to build one

1. Copy [`_template-mcp.js`](./_template-mcp.js) to `server/mcp/<name>-mcp.js`.
2. Define your tools in the `TOOLS` array: `name`, `description`, `inputSchema`
   (JSON Schema), and an async `run(args)` that does the work and returns a value.
3. That's it — the JSON-RPC plumbing in the template handles the rest.

`tickets-mcp.js` is the reference implementation (board CRUD over REST).

### Build it with Claude

You don't have to hand-write it. From the **Tools** tab, *Scaffold with Claude*:
describe what the tool should do and which API/data it talks to, and a Claude
session writes `<name>-mcp.js` from the template, grounded in this contract.

## How to put a tool into a project

A project picks up a tool when the tool's server config is written into the
project's `.mcp.json`:

```json
{
  "mcpServers": {
    "tickets": { "command": "node", "args": ["<abs>/server/mcp/tickets-mcp.js"], "env": { "WORKSPACE_PORT": "5301" } }
  }
}
```

Do this from the **Tools** tab (*Install into project*) — it writes the entry for
you (same mechanism the MCP manager uses for databases). After that, any agent
that runs in that project has the tool's actions available.

## Permissions

If an agent runs under a permission profile (`server/perms/*.json`), allow the
tool's actions so it isn't prompted: add `mcp__<server>__<tool>` to the profile's
`allow` list (e.g. `mcp__tickets__create_tickets`).
