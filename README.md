# Personal AI OS

A mobile-first personal AI operating system starter with:

- agent registry
- workflow registry
- persistent tasks
- scheduler
- approval gates
- audit logs
- diagnostics
- configurable OpenAI-compatible AI provider
- one central MCP server over Streamable HTTP
- PostgreSQL persistence
- Railway-ready deployment

## Local

1. Copy `.env.example` to `.env`.
2. Start PostgreSQL and set `DATABASE_URL`.
3. `npm install`
4. `npm run dev`
5. Open `http://localhost:3000`

If `AI_API_KEY` and `AI_MODEL` are not configured, the system still runs its deterministic planner and clearly reports that an AI model is not configured.

## Railway

Create a Railway PostgreSQL service, then set `DATABASE_URL` and `APP_TOKEN` on the app service. Railway exposes PostgreSQL connection variables including `DATABASE_URL`. See the official Railway docs: https://docs.railway.com/databases/postgresql

The MCP endpoint is `/mcp`. Protect it with `Authorization: Bearer <APP_TOKEN>`.

## MCP tools

The central MCP server exposes controlled tools such as:

- `create_task`
- `get_task`
- `list_agents`
- `create_agent`
- `list_workflows`
- `create_workflow`
- `run_workflow`
- `schedule_workflow`
- `approve_task`
- `reject_task`
- `diagnose_system`
- `system_health`

The server uses the official MCP TypeScript SDK and Streamable HTTP transport.

## AI provider

The planner accepts any OpenAI-compatible chat-completions endpoint. Set `AI_API_KEY`, `AI_BASE_URL`, and `AI_MODEL`. Without these variables, the app uses a deterministic planner and never pretends that an AI call occurred.
