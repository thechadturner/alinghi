/** Placeholder name for new charts; user must change it before saving. */
export const NEW_CHART_PLACEHOLDER_NAME = 'new chart';

/** Value stored in video layout sources when slot should use the current selected source at runtime. */
export const SELECTED_SOURCE_SENTINEL = '__selected_source__';

export function isSelectedSourceSentinel(value: string): boolean {
  return (value || '').trim() === SELECTED_SOURCE_SENTINEL;
}

export function isNewChartPlaceholderName(name: string): boolean {
  return (name || '').trim().toLowerCase() === NEW_CHART_PLACEHOLDER_NAME;
}

/** Names API row shape (object_name, date_modified, isMine, is_shared). Backend may return lowercase column names. */
export type ObjectNameRow = {
  object_id?: string | number;
  object_name?: string;
  date_modified?: string;
  isMine?: number;
  ismine?: number;
  is_shared?: number;
  isshared?: number;
};

/** Dedupe /object/names rows by chart name; prefer your row, then newest date_modified. */
export function dedupeObjectNameRows(rows: ObjectNameRow[]): ObjectNameRow[] {
  const parseTime = (s: string | undefined) => {
    const t = s ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  /** > 0 if a should replace b */
  const prefer = (a: ObjectNameRow, b: ObjectNameRow): number => {
    const aMine = rowIsMine(a) ? 1 : 0;
    const bMine = rowIsMine(b) ? 1 : 0;
    if (aMine !== bMine) return aMine - bMine;
    const ta = parseTime(a.date_modified);
    const tb = parseTime(b.date_modified);
    if (ta !== tb) return ta > tb ? 1 : ta < tb ? -1 : 0;
    return 0;
  };
  const byKey = new Map<string, ObjectNameRow>();
  for (const row of rows) {
    const key = String(row.object_name ?? '').trim().toLowerCase();
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    if (prefer(row, existing) > 0) byKey.set(key, row);
  }
  return Array.from(byKey.values()).sort((a, b) =>
    String(a.object_name ?? '').localeCompare(String(b.object_name ?? ''), undefined, { sensitivity: 'base' })
  );
}

export function rowIsMine(row: ObjectNameRow): boolean {
  const v = row.isMine ?? row.ismine;
  return Number(v) === 1;
}

/**
 * True when the row is your chart and `is_shared` is explicitly 0 (not shared / private).
 * Shared charts (yours or others') and rows without `is_shared` do not get the private-owner sidebar icon.
 */
export function rowIsPrivateMineChart(row: ObjectNameRow): boolean {
  if (!rowIsMine(row)) return false;
  const v = row.is_shared ?? row.isshared;
  if (v === undefined || v === null) return false;
  return Number(v) === 0;
}

/** Your chart with `is_shared` explicitly 1 (shared / public). */
export function rowIsExplicitlySharedMine(row: ObjectNameRow): boolean {
  if (!rowIsMine(row)) return false;
  const v = row.is_shared ?? row.isshared;
  if (v === undefined || v === null) return false;
  return Number(v) === 1;
}

/**
 * Returns whether the current user owns the loaded chart based on GET /object/names response.
 * @param namesData - response.data from GET /users/object/names (array of { object_name, isMine/ismine, ... })
 * @param loadedObjectName - the chart name that was loaded (trimmed)
 */
export function isOwnerOfLoadedObject(namesData: unknown, loadedObjectName: string): boolean {
  if (!loadedObjectName || !Array.isArray(namesData)) return true; // new chart / no name → treat as owner for Save
  const name = loadedObjectName.trim().toLowerCase();
  const row = (namesData as ObjectNameRow[]).find(
    (r) => (r.object_name || '').trim().toLowerCase() === name
  );
  // If row not found (e.g. names list is limited), treat as owner so Save is not hidden
  if (!row) return true;
  return rowIsMine(row);
}
