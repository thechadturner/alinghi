# RaceSight Solid.js MCP Server

MCP server that exposes Solid.js and TypeScript conventions to Cursor. It provides resources, prompts, and a tool so the AI gets consistent guidance when editing frontend code.

## Build

From this directory:

```bash
npm install
npm run build
```

From the repo root (RaceSight):

```bash
cd tools/mcp-solid-server && npm install && npm run build
```

## Run

After building, the server is started by Cursor via `.cursor/mcp.json` (stdio). To run manually:

```bash
node dist/index.js
```

The process reads/writes JSON-RPC on stdin/stdout; it is intended to be spawned by Cursor, not run interactively.

## Contents

- **Resources**: `solid-patterns`, `ts-conventions` (read-only guidance).
- **Prompts**: "Add Solid component", "Refactor to Solid signals", "Make type-safe".
- **Tool**: `get_solid_guidance` with `topic`: `"solid"` or `"typescript"`.

## Dependencies

- `@modelcontextprotocol/sdk` ^1.27
- `zod` ^3.23
