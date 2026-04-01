/**
 * Shared suggestion history for all Tagger crew combos (localStorage).
 * Any name entered in one field is offered in every crew datalist.
 */
import { warn } from '@utils/console';

/** Kept for typing blur handlers if needed elsewhere. */
export type TaggerCrewComboFieldKey =
  | 'helmPort'
  | 'helmStbd'
  | 'flightPort'
  | 'flightStbd'
  | 'strategist';

const STORAGE_KEY_V2 = 'tagger_crew_names_history_v1';
const LEGACY_STORAGE_KEY = 'tagger_crew_combo_history_v1';
const MAX_NAMES = 80;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const LEGACY_FIELD_ORDER: readonly TaggerCrewComboFieldKey[] = [
  'helmPort',
  'helmStbd',
  'flightPort',
  'flightStbd',
  'strategist',
];

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function mergeLegacyPerFieldIntoNames(parsed: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim();
    if (!t || t.toUpperCase() === 'NA') {
      return;
    }
    const k = t.toLowerCase();
    if (seen.has(k)) {
      return;
    }
    seen.add(k);
    out.push(t);
  };
  for (const key of LEGACY_FIELD_ORDER) {
    const arr = parsed[key];
    if (!Array.isArray(arr)) {
      continue;
    }
    for (const x of arr) {
      add(x == null ? '' : String(x));
      if (out.length >= MAX_NAMES) {
        return out;
      }
    }
  }
  return out;
}

/** Load shared crew name history; migrates legacy per-field storage once. */
export function loadCrewComboHistory(): string[] {
  if (typeof localStorage === 'undefined') {
    return [];
  }
  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY_V2);
    if (rawV2?.trim()) {
      const parsed = JSON.parse(rawV2) as unknown;
      if (Array.isArray(parsed)) {
        return sanitizeNameList(parsed);
      }
      if (isPlainRecord(parsed) && Array.isArray(parsed.names)) {
        return sanitizeNameList(parsed.names);
      }
    }

    const rawLegacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (rawLegacy?.trim()) {
      const parsed = JSON.parse(rawLegacy) as unknown;
      if (isPlainRecord(parsed)) {
        const merged = mergeLegacyPerFieldIntoNames(parsed);
        if (merged.length > 0) {
          persistCrewComboHistory(merged);
        }
        try {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {
          /* ignore */
        }
        return merged;
      }
    }
    return [];
  } catch (e) {
    warn('[taggerCrewComboHistory] load failed', e);
    return [];
  }
}

function sanitizeNameList(arr: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    const t = x == null ? '' : String(x).trim();
    if (!t || t.toUpperCase() === 'NA') {
      continue;
    }
    const k = t.toLowerCase();
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_NAMES) {
      break;
    }
  }
  return out;
}

export function persistCrewComboHistory(names: string[]): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    const clean = sanitizeNameList(names);
    localStorage.setItem(STORAGE_KEY_V2, JSON.stringify({ names: clean }));
  } catch (e) {
    warn('[taggerCrewComboHistory] persist failed', e);
  }
}

/** MRU: most recently blurred name moves to front (case-insensitive dedupe). */
export function addCrewNameToHistory(prev: string[], value: string): string[] {
  const v = value.trim();
  if (!v || v.toUpperCase() === 'NA') {
    return prev;
  }
  const next = prev.filter((x) => x.toLowerCase() !== v.toLowerCase());
  next.unshift(v);
  return next.slice(0, MAX_NAMES);
}

/** Suggestions: NA, then shared MRU names, then A–Z (case-insensitive dedupe). */
export function mergedCrewDatalistOptions(history: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (x: string) => {
    const t = x.trim();
    if (!t) {
      return;
    }
    const k = t.toLowerCase();
    if (seen.has(k)) {
      return;
    }
    seen.add(k);
    out.push(t);
  };
  add('NA');
  for (const h of history) {
    add(h);
  }
  for (const L of LETTERS) {
    add(L);
  }
  return out;
}
