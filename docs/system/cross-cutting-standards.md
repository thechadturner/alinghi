# Cross-Cutting Standards (Logging, Timers, Caching, SSE, Workers)

## Purpose

This document captures **cross-cutting conventions** that apply across the frontend and Node services:

- How to **log** correctly (and where).
- How to manage **timers** without leaks.
- How to use **caches** safely.
- How to handle **SSE/streaming** connections.
- How to use **Web Workers** for heavy work.

Use this as the default reference when adding new code or refactoring existing behavior.

---

## 1. Logging

### Frontend (SolidJS)

- **Use** `frontend/utils/console.ts` for all logging.
- **Do NOT** call `console.log` / `console.error` etc. directly in frontend code (ESLint enforces this for most files).

**Import pattern**:

```typescript
import { debug, warn, error as logError, info, log } from "@utils/console";
```

**Guidelines**:

- **`debug(...)`**: Verbose diagnostics; only emitted when `VITE_VERBOSE=true`.
- **`log(...)` / `info(...)`**: High-level information (user actions, data lifecycle milestones).
- **`warn(...)`**: Recoverable issues (fallback paths, unexpected shapes, non-fatal errors).
- **`logError(...)`**: Errors that impact functionality or indicate a bug.

### Backend (Node servers)

- Use the **shared console gate** from `shared`:

```javascript
const { installConsoleGate, logAlways, log, error, warn, debug } = require('../shared');
installConsoleGate();
```

**Guidelines**:

- Log **one line per event** with structured context objects where helpful.
- Use `logAlways` for startup/shutdown and critical lifecycle messages.
- Prefer `error`/`warn` for operational issues; keep `debug` for noisy internals.

---

## 2. Timers

### Frontend

- **Preferred utilities**:
  - `frontend/utils/useTimerCleanup.ts` – SolidJS hook to track and clean up timers.
  - `frontend/utils/timerAudit.ts` – Diagnostics for long-lived timers and leaks.

**Rules**:

- Avoid raw `setTimeout` / `setInterval` in components; when needed, wrap them using `useTimerCleanup`.
- Always ensure timers are cleared during `onCleanup` – either manually or via the hook.
- For **animation or frequent updates**, prefer `requestAnimationFrame` and central scheduling instead of multiple intervals.

### Backend

- Long-lived timers in Node (e.g., periodic tasks) should:
  - Be centralized in **one module per service**.
  - Log startup and shutdown.
  - Be stopped during graceful shutdown (e.g., `SIGINT`, `SIGTERM` handlers).

---

## 3. Caching

### Frontend Data Caches

- Primary mechanisms:
  - **LRU caches** (e.g., `frontend/utils/lruCache.ts`) for in-memory data (`categoryData`, `dataCache`).
  - IndexedDB / HuniDB via `unifiedDataStore` and `indexedDB` helpers.

**Standards**:

- All new long-lived caches **must**:
  - Have an explicit **size limit** (LRU or similar).
  - Have a **cleanup strategy** (TTL or periodic cleanup task).
- Prefer using **existing shared caches** in `unifiedDataStore` rather than creating ad-hoc caches in components.
- For overlay or in-memory maps:
  - Avoid unbounded `Map`/`Set` growth; use LRU or periodic pruning where datasets can grow over time.

### Backend Caching

- Redis is used where appropriate (e.g., streaming). For other HTTP APIs:
  - Add caching only when **measured bottlenecks** justify it.
  - Document cache keys and TTL in the relevant service or doc.

---

## 4. SSE and Streaming

### SSE (Server-Sent Events)

- Follow `docs/streaming` and `docs/backend/SSE_MEMORY_LEAK_PREVENTION.md` for patterns.

Key practices:

- Track **per-connection state** and clean up on disconnect.
- Enforce **maximum connection counts** and idle timeouts where appropriate.
- Use **heartbeat/ping** mechanisms for long-lived connections.

### WebSocket / Streaming

- For `server_stream`:
  - Use the **connection manager** and reconnection strategies described in `docs/streaming/streaming-service-overview.md`.
  - Keep processing logic in `processor.js` and storage in `redis.js`; avoid duplicating logic in controllers.

### Frontend Streaming

- Use `frontend/store/streamingStore.ts` and dedicated map/time-series components to consume streaming data.
- Do not open ad-hoc WebSocket connections from random components; route through shared store/utilities.

---

## 5. Web Workers & Heavy Processing

### When to Use Workers

Use a worker when:

- Processing is **O(n log n)** or worse on large datasets (sorting, aggregation, regression).
- Work can take **tens of milliseconds or more** and risks blocking the UI.
- The same logic is reused across multiple charts or pages.

### Patterns

- Prefer using existing worker managers:
  - `frontend/utils/enhancedScatterWorkerManager.ts`
  - Other worker managers under `frontend/utils/*WorkerManager.ts`
- Workers live in `frontend/workers/*.ts` and communicate using **plain messages** (no SolidJS or DOM types).

**Guidelines**:

- Keep worker interfaces small and **typed** (request/response types).
- Do not access stores from workers; pass data in and return results.
- For repeated patterns (e.g., filtering, sampling), centralize logic in workers + utils rather than re‑implementing in components.

---

## 6. D3 & Cleanup

- All D3-heavy components should:
  - Use `useChartCleanup` to register selections, event listeners, observers, and timers.
  - Ensure `onCleanup` (or the hook’s internal cleanup) clears the SVG and associated resources.
- Do not attach window‑level listeners without registering them for cleanup.

---

## 7. Review Checklist

For any new feature or refactor, ask:

1. **Logging**
   - Does it use `console.ts` / shared console gate instead of raw `console.*`?
2. **Timers**
   - Are all timers tracked and cleaned up (preferably via `useTimerCleanup`)?
3. **Caching**
   - Are caches bounded and cleaned?
   - Is this using `unifiedDataStore`/existing caches where possible?
4. **Streaming**
   - Are SSE/WebSocket connections using the shared services/stores, not ad‑hoc?
5. **Workers**
   - Is heavy processing moved into workers when needed?
6. **D3**
   - Are D3 selections and event listeners cleaned up via `useChartCleanup`?

Adhering to these standards keeps the app performant, memory-safe, and predictable as the codebase grows.


