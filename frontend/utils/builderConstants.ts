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

/** Names API row shape (object_name, date_modified, isMine). Backend may return ismine (lowercase). */
export type ObjectNameRow = { object_name?: string; date_modified?: string; isMine?: number; ismine?: number };

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
  // Backend (PostgreSQL) often returns lowercase column names, so check both isMine and ismine
  const isMineVal = (row as Record<string, unknown>).isMine ?? (row as Record<string, unknown>).ismine;
  return Number(isMineVal) === 1;
}
