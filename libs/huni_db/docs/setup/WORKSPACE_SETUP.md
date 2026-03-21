# HuniDB Workspace Setup

HuniDB is configured to use npm workspaces and share dependencies with the parent Hunico project.

## How It Works

1. **Root package.json** includes `"workspaces": ["libs/*"]`
2. **Shared dependencies** are hoisted to the root `node_modules/`
3. **HuniDB-specific dependencies** remain in `libs/huni_db/package.json`

## Installation

From the **root directory**:

```bash
npm install
```

This will:
- Install all root dependencies
- Install huni_db dependencies
- Hoist shared dependencies to root `node_modules/`
- Create symlinks for workspace packages

## Shared Dependencies

These dependencies are shared from the parent project:

- `typescript` - TypeScript compiler
- `vite` - Build tool
- `vitest` - Test framework
- `eslint` - Linting
- `@typescript-eslint/*` - TypeScript ESLint plugins
- `@vitest/coverage-v8` - Test coverage

## HuniDB-Specific Dependencies

These remain in `libs/huni_db/package.json`:

- `@sqlite.org/sqlite-wasm` - SQLite WASM (production)
- `vite-plugin-dts` - Type definitions generator
- `@types/node` - Node.js type definitions

## Running Commands

### From Root

```bash
# Run huni_db tests
npm test --workspace=libs/huni_db

# Build huni_db
npm run build --workspace=libs/huni_db

# Install dependencies
npm install
```

### From HuniDB Directory

```bash
cd libs/huni_db

# All commands work as normal
npm test
npm run build
npm run typecheck
```

## Benefits

1. **Reduced disk space** - Shared dependencies installed once
2. **Faster installs** - No duplicate package downloads
3. **Version consistency** - Same tool versions across project
4. **Easier maintenance** - Update dependencies in one place

## Notes

- Workspaces require npm 7+ or yarn/pnpm
- Dependencies are resolved from root `node_modules/` first
- Workspace packages can reference each other via workspace protocol
- Build outputs remain in `libs/huni_db/dist/`

