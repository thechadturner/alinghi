# Solid.js Table Rendering & Reactivity Patterns

This document captures patterns and fixes applied to **FleetDataTable** for correct table rendering (especially on macOS/WebKit) and for reactive updates when external signals (e.g. `selectedTime`) change. Use these patterns when building or fixing other table UIs or list UIs in Solid.js.

---

## 1. Table structure (OSX / WebKit compatibility)

### Problem

On some browsers (notably WebKit on macOS), tables can fail to render or lay out correctly when:

- `<thead>` or `<tbody>` are conditionally rendered (e.g. swapped out by a ternary).
- Fragment nodes (`<>...</>`) appear as **direct children of `<tr>`** (e.g. multiple `<th>`/`<td>` from a fragment).
- Stray text/whitespace nodes end up between table elements.

### Rules we followed

1. **Single `<thead>` and single `<tbody>`**
   - Always render exactly one `<thead>` and one `<tbody>`.
   - Do **not** conditionally replace the whole block (e.g. avoid `condition ? <><thead>…<tbody>…</></> : <><thead>…<tbody>…</></>`).
   - Only the **content inside** thead/tbody should vary (e.g. different header rows or body rows based on layout).

2. **No fragments as direct children of `<tr>`**
   - Valid direct children of `<tr>` are only `<th>` and `<td>`.
   - If you need multiple cells per iteration (e.g. AVG and STD), use an **array** of elements, not a fragment:
     - Prefer: `return [<td>…</td>, <td>…</td>]`
     - Avoid: `return <><td>…</td><td>…</td></>` inside a `<For>` that returns a row’s cells.

3. **Wrap the table in a container**
   - Use a wrapper div (e.g. `fleet-datatable-table-wrap`) with `overflow: auto` and `min-width: 0` so layout and scrolling behave consistently across platforms.

4. **`<tbody>` before the loop**
   - Structure: `<tbody>` then a single loop (e.g. `<For>`) that outputs `<tr>` elements. Avoid conditionals that remove or replace `tbody` itself.

**Example structure (conceptual):**

```jsx
<table>
  <thead>
    {/* header content; can vary by layout */}
  </thead>
  <tbody>
    {empty ? (
      <tr><td colSpan={…}>Empty message</td></tr>
    ) : (
      <For each={rows()}>
        {(row) => (
          <tr>
            <td>{row.name}</td>
            <For each={row.cells}>
              {(cell) => [
                <td>{cell.avg}</td>,
                <td>{cell.std}</td>,
              ]}
            </For>
          </tr>
        )}
      </For>
    )}
  </tbody>
</table>
```

---

## 2. Solid.js `<For>` and external signals

### Problem

Table (or list) content did **not** update when an external signal changed (e.g. `selectedTime`), even though that signal was read inside the `<For>` callback.

### Cause

In Solid.js, `<For>` re-runs its **child callback** when the **list** passed to `each` changes (reference or item identity). It does **not** re-run the callback when some other signal (e.g. `selectedTime`) changes. So:

- The list (e.g. `sourceRows()` or `channels()`) was stable when only `selectedTime` changed.
- The callback ran once per item and produced static content; any read of `selectedTime` inside the callback was not enough to make the **list** update.
- Result: cells showed stale values until something else changed the list.

### Solution: drive the list from the signal with `createMemo`

Make the **list** passed to `<For>` depend on the external signal by computing it in a **memo**. When the signal changes, the memo re-runs, returns a **new array**, and `<For>` sees a new list and re-renders.

1. **Compute full row data in `createMemo`**
   - Inside the memo, read all reactive inputs: the external signal (e.g. `selectedTime()` / `currentTime()`), plus any other data (e.g. `sourceRows()`, `dataBySource()`, `channels()`).
   - Build an array of **row objects** with **precomputed display values** (e.g. strings for each cell).
   - Return that array from the memo.

2. **Use the memo in `<For>`**
   - `each={verticalBodyRows()}` (or similar). No signal reads inside the `<For>` callback for the time-dependent values; just render the precomputed strings from each row object.

3. **Same pattern elsewhere**
   - e.g. TimeSeries LegendTable: `rows = createMemo(() => computeLegendRows(..., selectedTime(), ...))` then `<For each={rows()}>`. The list depends on `selectedTime`, so when time changes, the list changes and the table updates.

**Example (conceptual):**

```js
// Memo re-runs when selectedTime (or sourceRows, dataBySource, etc.) changes
const verticalBodyRows = createMemo(() => {
  const rows = sourceRows();
  if (!rows.length) return [];
  const data = dataBySource();
  const t = currentTime();  // or selectedTime() — this is the key dependency
  const timeMs = timeToMs(t);
  return rows.map((s) => {
    const dataArr = data[s.source_id] ?? [];
    const cellTMs = effectiveTimeMs(timeMs, dataArr);
    const cells = channels().map((ch) => {
      const val = valueAtTime(dataArr, ch, cellTMs);
      return { channel: ch, valueDisplay: val != null ? formatNum(val) : "—" };
    });
    return { source_id: s.source_id, source_name: s.source_name, cells };
  });
});

// In JSX: list passed to For depends on time, so table updates when time changes
<For each={verticalBodyRows()}>
  {(row) => (
    <tr>
      <td>{row.source_name}</td>
      <For each={row.cells}>
        {(cell) => <td>{cell.valueDisplay}</td>}
      </For>
    </tr>
  )}
</For>
```

### When to use this pattern

- **List content depends on an external signal** (time, filter, selection, etc.) but the **list identity/length** is driven by something else (e.g. same sources/channels).
- You need the **whole list** to be recomputed when that signal changes so that `<For>` re-renders.

### When other approaches are enough

- If the **list itself** is derived from the signal (e.g. filtered list from a filter signal), a single `createMemo` that returns the list and passes it to `<For>` is enough; no need to precompute cell strings unless you want to avoid reading signals inside the callback.
- If only a **single value** (not per-row) depends on the signal, reading that signal in the component body or in the JSX outside the loop is enough; no need to put the whole list in a memo.

---

## 3. Summary

| Issue | Fix |
|-------|-----|
| Table broken on OSX/WebKit | One `<thead>`, one `<tbody>`; no conditional swap of thead/tbody; no fragments as direct children of `<tr>`; use arrays for multiple cells; wrap table in a div. |
| Table not updating when `selectedTime` (or other signal) changes | Put time-dependent row data in a `createMemo` that reads the signal; pass memo result to `<For>` so the list reference changes when the signal changes. |

These patterns were applied in **FleetDataTable** (`frontend/components/charts/guages/FleetDataTable.tsx`). For more on overlay/data rules for that component, see `docs/frontend/unifiedDataStore-guide.md` and `docs/frontend/frontend-stores.md`.
