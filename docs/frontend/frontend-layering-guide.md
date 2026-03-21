# Frontend Layering Guide

## Purpose

This document defines the **allowed dependency layers** in the frontend and where **data access and cross‑cutting concerns** are permitted.  
Use this as a guardrail for refactors and for reviewing new code.

## Layer Overview

From top to bottom:

1. **Pages**
2. **Builders**
3. **Charts / UI Containers**
4. **Pure Visualization / D3 Components**
5. **Stores & Services**
6. **Workers & Low‑Level Utilities**

Each layer may depend **only on the same layer or lower layers**, with a few explicit exceptions called out below.

---

## 1. Pages

- **Location**: `frontend/pages/*.tsx`
- **Responsibilities**:
  - Define **routes** and high‑level screens.
  - Orchestrate page‑level layout (header, sidebars, primary content).
  - Choose which **builder** or **report** to render.
  - Trigger navigation, authentication redirects, and top‑level error boundaries.
- **May depend on**:
  - Builders (`frontend/components/builders/*`)
  - Reports (`frontend/reports/*`)
  - Global layout components (`frontend/components/app/*`)
  - Stores **only for page‑level concerns** (e.g., auth state, global toasts).
- **Should NOT**:
  - Call `unifiedDataStore` or `unifiedDataAPI` directly for chart data.
  - Contain D3 logic or heavy data processing.

---

## 2. Builders

- **Location**: `frontend/components/builders/*.tsx`
- **Responsibilities**:
  - Configure **what data and charts** a page uses.
  - Translate user configuration (menus, filters, layout) into **chart props**.
  - Coordinate multiple charts (e.g., scatter + timeseries + map).
- **May depend on**:
  - Charts (`frontend/components/charts/*`)
  - Stores for **configuration and selection/filter state**.
  - Services only for **builder‑specific metadata** (e.g., loading menu options), not for raw timeseries/map data.
- **Data access rules**:
  - Builders **may not** query `unifiedDataStore` / `unifiedDataAPI` directly.
  - Builders pass **semantic config** (chart type, channels, filters) down to chart components; charts own the data fetching.

---

## 3. Charts / UI Containers

- **Location**:
  - `frontend/components/charts/*`
  - High‑level visualization containers (e.g., `MapContainer`, `TimeSeries`, `PerfScatter`, `SimpleScatter`).
- **Responsibilities**:
  - Fetch and manage **data for a specific visualization**.
  - Interact with **selection**, **playback**, and **filter** stores.
  - Decide when to use **workers** and when to use local processing.
  - Manage D3 lifecycle via `useChartCleanup` and worker managers.
- **May depend on**:
  - Stores: `filterStore`, `selectionStore`, `playbackStore`, `unifiedDataStore`, `globalStore`, `streamingStore`, etc.
  - Services: `unifiedDataAPI` **only through** `unifiedDataStore` (do not duplicate fetching logic).
  - Pure D3 / renderer components (`frontend/components/charts/**/renderers/*`, `frontend/components/charts/**/components/*`).
  - Utils: chart‑specific helpers (`chartLayoutUtils`, `densityOptimizationCache`, etc.).
- **Data access rules**:
  - **Only this layer** should call `unifiedDataStore` / `unifiedDataAPI` for chart data.
  - All **low‑level data queries** (IndexedDB, HuniDB, workers) go through `unifiedDataStore` and `indexedDB` helpers, not directly from builders/pages.

---

## 4. Pure Visualization / D3 Components

- **Location**:
  - `frontend/components/charts/**/components/*`
  - `frontend/components/charts/**/renderers/*`
  - D3‑heavy components like `SimpleScatter`, low‑level map layers, etc.
- **Responsibilities**:
  - Render already‑prepared data using **D3 and SVG/Canvas/WebGL**.
  - Maintain local interaction state (hover, local tooltips, zoom), but **not global app state**.
  - Use `useChartCleanup` for D3 lifecycle and `useTimerCleanup` for timers.
- **May depend on**:
  - Chart‑level containers (via props).
  - Chart/utils (`d3Cleanup`, `colorScale`, `densityOptimizationCache`).
  - Workers via manager utilities passed in from chart containers.
- **Should NOT**:
  - Import or call `unifiedDataStore` or `unifiedDataAPI` directly.
  - Import global stores directly (selection, playback, filter) unless they are truly part of this visualization’s contract; prefer passing state through props.

---

## 5. Stores & Services

- **Location**:
  - Stores: `frontend/store/*.ts`
  - Services: `frontend/services/*.ts`
- **Responsibilities**:
  - **Stores**: Own reactive application state (filters, selection, playback, streaming, HuniDB, unified data, etc.).
  - **Services**: Wrap backend API calls (`/api/*`), encapsulate URL building and error handling.
  - Provide **query helpers** and **caching** (e.g., `unifiedDataStore`, `indexedDB` wrappers).
- **May depend on**:
  - Lower‑level utilities (`frontend/utils/*`).
  - HuniDB library (`@hunico/hunidb`) where appropriate.
  - Browser APIs (IndexedDB, fetch) via utilities.
- **Cross‑layer rules**:
  - Stores/services must **not** import React/Solid components or charts.
  - Stores/services should be **UI‑agnostic** and safe to use from workers where applicable.

---

## 6. Workers & Low‑Level Utilities

- **Location**:
  - Workers: `frontend/workers/*.ts`
  - Low‑level utils: `frontend/utils/*.ts` (e.g., `lruCache`, `timerAudit`, `useTimerCleanup`, D3 helpers).
- **Responsibilities**:
  - Perform **CPU‑heavy or blocking work** off the main thread.
  - Encapsulate **algorithmic logic** (sampling, density optimization, regression, sorting).
  - Provide reusable building blocks (**no UI knowledge**).
- **May depend on**:
  - Utility modules.
  - Minimal shared types/interfaces (e.g., worker message types, data point shapes).
- **Should NOT**:
  - Import SolidJS or DOM APIs (except where the worker is explicitly tied to them and documented as such).
  - Access stores directly – they receive plain data through messages or function parameters.

---

## Unified Data Store Access Policy

To keep data flow predictable and avoid cross‑layer coupling:

- **Allowed to call `unifiedDataStore` / `unifiedDataAPI` directly**:
  - Chart/container components in `frontend/components/charts/*`
  - Data stores and data‑oriented services in `frontend/store/*` and `frontend/services/*`
- **NOT allowed to call directly** (should go through charts or stores instead):
  - Pages (`frontend/pages/*`)
  - Builders (`frontend/components/builders/*`)
  - Pure D3/visualization components (`frontend/components/charts/**/components/*`, `renderers/*`)
  - Workers (`frontend/workers/*`)

When in doubt, **route new data access through `unifiedDataStore`** and keep callers at the chart or store layer.

---

## Review Checklist for New Frontend Code

When adding or reviewing frontend code, verify:

1. **Layering**
   - Does the file live in the right layer (page, builder, chart, D3, store, service, worker)?
   - Does it only import from the same or lower layers?
2. **Data Access**
   - Are `unifiedDataStore` and `unifiedDataAPI` used only from charts/stores/services?
   - Are pages/builders passing **config and props**, not raw data, to charts?
3. **Cross‑cutting concerns**
   - Are logging, timers, and workers used according to the cross‑cutting standards doc (`docs/system/cross-cutting-standards.md`)?


