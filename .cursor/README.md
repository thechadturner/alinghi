# Cursor configuration for RaceSight

This folder configures Cursor for the RaceSight project (Solid.js + TypeScript), including MCP servers, rules, and pointers to workspace settings.

## MCP

- **Config file**: `.cursor/mcp.json`
- **Servers**:
  - **filesystem**: Safe file read/write in the workspace (scoped to the project directory).
  - **hunico-solid** (MCP id): Custom MCP that exposes Solid.js and TypeScript conventions (resources, prompts, and a guidance tool).

**Build the Solid MCP server** before using it:

```bash
cd tools/mcp-solid-server && npm install && npm run build
```

Restart Cursor after editing `mcp.json` for changes to take effect.

## Cursor rules

Rules live in `.cursor/rules/*.mdc` and apply when you work on matching files:

- **solidjs.mdc**: Solid.js conventions for `frontend/**/*.ts` and `frontend/**/*.tsx` (signals, effects, cleanup, logging, CSS, no React).
- **typescript.mdc**: TypeScript and path aliases for `**/*.ts` and `**/*.tsx` (type safety, explicit returns, `@/`, `@store/`, etc.).

## Workspace settings

Editor and language settings are in **`.vscode/settings.json`** at the repo root (TypeScript, Solid.js, format on save, path aliases). Path aliases there match `tsconfig.json` so Cursor and the TypeScript language server stay aligned.

## Project conventions (short)

- **Solid.js only** (no React); use `frontend/utils/console` for logging; prefer CSS over inline styles; do not change APIs or database schema unless requested.
- Full docs: [docs/frontend/frontend-architecture.md](docs/frontend/frontend-architecture.md), [docs/README.md](docs/README.md).

## Cursor Settings UI

For user-level Cursor settings (theme, model, features), use **Cursor Settings > General / Models / Features**, not this folder.
