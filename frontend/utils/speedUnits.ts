/**
 * Persisted speed display preference (wind/boat speed channel suffix and labels).
 *
 * **Storage vs display:** Some APIs store maneuver aggregates in a fixed physical unit (e.g. Tws_avg
 * in km/h from AC40 pipelines). Headers driven by `defaultUnits` describe the user’s preferred
 * unit; where data are only available in the other unit, either convert values when rendering or
 * keep labels aligned with actual storage (see plan: honesty follow-up).
 */
export type SpeedDisplayUnit = 'kts' | 'kph';

const KPH_PER_KNOT = 1.852;

/** Persisted enum values (avoid repeating string literals in UI code). */
export const SPEED_UNIT_KTS: SpeedDisplayUnit = 'kts';
export const SPEED_UNIT_KPH: SpeedDisplayUnit = 'kph';

/** Aliases for toggles / UI: prefer over `SPEED_UNIT_*` in `.tsx` to avoid speed-token noise in identifiers. */
export const nauticalSpeedPreference: SpeedDisplayUnit = SPEED_UNIT_KTS;
export const metricSpeedPreference: SpeedDisplayUnit = SPEED_UNIT_KPH;

/** Strip aggregate suffixes like `_std` / `_kph` / `_deg` from chart value field names (BoxPlot fallback). */
export const CHART_FIELD_AGGREGATE_SUFFIX_RE = /_(kts|kph|deg|avg|min|max|perc)$/i;

/**
 * Canonical API / parquet channel names (mixed case). Use from components instead of embedding
 * speed suffix literals in .tsx.
 */
export const SpeedChannelNames = {
  bspMetric: 'Bsp_kph',
  bspKnots: 'Bsp_kts',
  twsMetric: 'Tws_kph',
  twsKnots: 'Tws_kts',
  twaKnots: 'Twa_kts',
  twsFleetKnots: 'Tws_fleet_kts',
} as const;

/** Lowercase channel keys used in some configs / APIs. */
export const SpeedChannelNamesLower = {
  bspMetricKey: 'bsp_kph',
  bspKnotsKey: 'bsp_kts',
  twsMetricKey: 'tws_kph',
  twsKnotsKey: 'tws_kts',
} as const;

/** Regex: strip _kph/_kts/_deg/_perc suffix from field names (parsing only; lives in .ts). */
const FIELD_UNIT_SUFFIX_RE = /[_\s]*(kph|kts|deg|perc)$/i;

export function stripFieldUnitSuffixForBase(field: string): string {
  return field.replace(FIELD_UNIT_SUFFIX_RE, '');
}

/** Normalize field to comparable base (targets, aggregates). */
export function normalizeFieldBaseKey(field: string): string {
  return stripFieldUnitSuffixForBase(field.replace(/_target$/i, '')).replace(/[_\s]/g, '');
}

/** Lowercase field → comparable base (targets / cloud keys), including `_target` trim. */
export function fieldBaseKeyForMatching(field: string): string {
  const lower = field.toLowerCase().replace(/_target$/i, '');
  return stripFieldUnitSuffixForBase(lower).replace(/[_\s]/g, '');
}

/** Remove trailing speed unit from channel label text (before adding a fresh unit bracket). */
export function stripSpeedUnderscoreSuffixFromChannel(channelName: string): string {
  return channelName.replace(/_kph$/i, '').replace(/_kts$/i, '').trim();
}

/**
 * Axis suffix ` [KTS]` / ` [KPH]` from **persisted display preference** (`defaultUnits`), not the parquet column suffix.
 * Channel may still be `Bsp_kph` while the user prefers knots — label matches preference; values use `*ValueFromRow` coalescing.
 */
export function axisBracketSuffixForSpeedChannel(_channelName: string, displayUnit: SpeedDisplayUnit): string {
  return ` ${speedUnitBracketUpper(displayUnit)}`;
}

/** Split map timeline y-axis label so unit bracket can be styled smaller (e.g. SVG tspan). */
export interface MapTimelineYAxisLabelParts {
  name: string;
  /** e.g. ` [KTS]` including leading space; `null` when the label is a single string. */
  unitBracket: string | null;
}

export function mapTimelineYAxisLabelParts(
  channelName: string,
  displayUnit: SpeedDisplayUnit
): MapTimelineYAxisLabelParts {
  const lower = channelName.toLowerCase();
  if (lower.includes('kph') || lower.includes('kts')) {
    const base = stripSpeedUnderscoreSuffixFromChannel(channelName);
    return {
      name: base,
      unitBracket: axisBracketSuffixForSpeedChannel(channelName, displayUnit),
    };
  }
  if (lower === 'vmg_perc') return { name: 'VMG %', unitBracket: null };
  return { name: channelName.replace(/_/g, ' '), unitBracket: null };
}

/**
 * Y-axis title for map timelines (MapTimeSeries / MultiMapTimeSeries): friendly label, not raw parquet keys.
 * Speed channels → stripped base + bracket from user unit preference (e.g. `Bsp_kph` + kts preference → `Bsp [KTS]`).
 */
export function mapTimelineYAxisLabel(channelName: string, displayUnit: SpeedDisplayUnit): string {
  const { name, unitBracket } = mapTimelineYAxisLabelParts(channelName, displayUnit);
  return unitBracket != null ? `${name}${unitBracket}`.trim() : name;
}

/**
 * Map track tooltip label cell HTML for speed channels: channel base + smaller bracket (e.g. Bsp [KTS]).
 * Bracket matches `axisBracketSuffixForSpeedChannel` / timeline axis semantics.
 */
export function mapSpeedChannelTooltipLabelHtml(
  channelName: string,
  displayUnit: SpeedDisplayUnit
): string | null {
  const lower = channelName.toLowerCase();
  if (!lower.includes('kph') && !lower.includes('kts')) return null;
  const base = stripSpeedUnderscoreSuffixFromChannel(channelName);
  const bracket = axisBracketSuffixForSpeedChannel(channelName, displayUnit).trim();
  return `${base} <span class="map-tooltip-unit">${bracket}</span>`;
}

export function coalesceNumericFromRow(row: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  }
  return Number.NaN;
}

/** Boat speed from a row: primary channel name first, then common alternates (any casing). */
export function bspValueFromRow(row: Record<string, unknown>, primaryField: string, whenMissing: number | typeof Number.NaN = 0): number {
  const n = coalesceNumericFromRow(row, [
    primaryField,
    primaryField.toLowerCase(),
    primaryField.toUpperCase(),
    SpeedChannelNames.bspMetric,
    SpeedChannelNames.bspKnots,
    SpeedChannelNamesLower.bspMetricKey,
    SpeedChannelNamesLower.bspKnotsKey,
    'Bsp',
    'bsp',
  ]);
  if (Number.isNaN(n)) return whenMissing;
  return n;
}

/** Column keys tried for TWS (same order as `twsValueFromRow`). */
function twsRowLookupKeys(primaryField: string): string[] {
  return [
    primaryField,
    primaryField.toLowerCase(),
    primaryField.toUpperCase(),
    SpeedChannelNames.twsMetric,
    SpeedChannelNames.twsKnots,
    SpeedChannelNamesLower.twsMetricKey,
    SpeedChannelNamesLower.twsKnotsKey,
    'Tws',
    'tws',
  ];
}

function physicalUnitForTwsRowKey(key: string): SpeedDisplayUnit {
  const lower = key.toLowerCase();
  if (lower.endsWith('_kts')) return SPEED_UNIT_KTS;
  if (lower.endsWith('_kph')) return SPEED_UNIT_KPH;
  return SPEED_UNIT_KTS;
}

/**
 * TWS magnitude for map wind arrow / labels: resolves columns like `twsValueFromRow` (including `Tws_kts`
 * when `twsName()` is `Tws_kph`), then converts from the source column’s unit to `displayUnit`.
 */
export function twsMagnitudeInDisplayUnit(
  row: Record<string, unknown>,
  primaryField: string,
  displayUnit: SpeedDisplayUnit
): number {
  for (const k of twsRowLookupKeys(primaryField)) {
    const v = row[k];
    let n: number;
    if (typeof v === 'number' && Number.isFinite(v)) n = v;
    else if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) n = Number(v);
    else continue;
    return convertSpeedMagnitude(n, physicalUnitForTwsRowKey(k), displayUnit);
  }
  return Number.NaN;
}

/** True wind speed from a row: prefer configured channel, then metric/knots columns (any casing). */
export function twsValueFromRow(row: Record<string, unknown>, primaryField: string, whenMissing: number | typeof Number.NaN = 0): number {
  const n = coalesceNumericFromRow(row, twsRowLookupKeys(primaryField));
  if (Number.isNaN(n)) return whenMissing;
  return n;
}

/** VMG magnitude from a row (parquet may use Vmg_kph / Vmg_kts / Vmg; APIs may use lowercase keys). */
export function vmgValueFromRow(row: Record<string, unknown>, primaryField: string, whenMissing: number | typeof Number.NaN = 0): number {
  const n = coalesceNumericFromRow(row, [
    primaryField,
    primaryField.toLowerCase(),
    primaryField.toUpperCase(),
    'Vmg_kph',
    'Vmg_kts',
    'vmg_kph',
    'vmg_kts',
    'Vmg',
    'vmg',
  ]);
  if (Number.isNaN(n)) return whenMissing;
  return n;
}

/** VMG % from a row. */
export function vmgPercValueFromRow(row: Record<string, unknown>, primaryField: string, whenMissing: number | typeof Number.NaN = 0): number {
  const n = coalesceNumericFromRow(row, [
    primaryField,
    primaryField.toLowerCase(),
    primaryField.toUpperCase(),
    'Vmg_perc',
    'vmg_perc',
  ]);
  if (Number.isNaN(n)) return whenMissing;
  return n;
}

/**
 * Timeline Y value for map charts: respects map color mode and coalesces speed columns
 * (e.g. mapdata may expose `Bsp_kts` while IndexedDB rows only have `Bsp_kph`, or the reverse).
 */
export function mapTimelineChannelValue(row: Record<string, unknown>, channel: string, maptype: string): number {
  const mt = String(maptype || '').trim();
  if (mt === 'WIND') {
    return twsValueFromRow(row, channel, 0);
  }
  if (mt === 'VMG') {
    return vmgValueFromRow(row, channel, 0);
  }
  if (mt === 'VMG%') {
    return vmgPercValueFromRow(row, channel, 0);
  }
  return bspValueFromRow(row, channel, 0);
}

/**
 * Read persisted speed unit for initial store hydration.
 * Migrates legacy `teamshare-units` into `defaultUnits` when needed.
 */
export function readInitialSpeedDisplayUnitFromStorage(): SpeedDisplayUnit {
  if (typeof window === 'undefined') return SPEED_UNIT_KTS;
  try {
    const raw = localStorage.getItem('defaultUnits');
    if (raw != null && raw !== 'undefined' && raw !== '') {
      try {
        return normalizeSpeedDisplayUnit(JSON.parse(raw));
      } catch {
        return normalizeSpeedDisplayUnit(raw.replace(/^"|"$/g, ''));
      }
    }
    const legacy = localStorage.getItem('teamshare-units');
    if (legacy != null && legacy !== '') {
      let n: SpeedDisplayUnit;
      try {
        n = normalizeSpeedDisplayUnit(JSON.parse(legacy));
      } catch {
        n = normalizeSpeedDisplayUnit(legacy.replace(/^"|"$/g, ''));
      }
      localStorage.setItem('defaultUnits', JSON.stringify(n));
      localStorage.removeItem('teamshare-units');
      return n;
    }
  } catch {
    /* ignore */
  }
  return SPEED_UNIT_KTS;
}

export function normalizeSpeedDisplayUnit(value: unknown): SpeedDisplayUnit {
  if (value === SPEED_UNIT_KTS || value === SPEED_UNIT_KPH) return value;
  if (value === 'knots') return SPEED_UNIT_KTS;
  if (value === 'meters') return SPEED_UNIT_KPH;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === SPEED_UNIT_KTS || lower === SPEED_UNIT_KPH) return lower as SpeedDisplayUnit;
    if (lower === 'knots') return SPEED_UNIT_KTS;
    if (lower === 'meters') return SPEED_UNIT_KPH;
  }
  return SPEED_UNIT_KTS;
}

/** Suffix for channel names, e.g. Bsp_kts, Tws_kph. Pass `persistantStore.defaultUnits()` from callers. */
export function speedUnitSuffix(unit: SpeedDisplayUnit): 'kts' | 'kph' {
  return unit === SPEED_UNIT_KPH ? SPEED_UNIT_KPH : SPEED_UNIT_KTS;
}

/** Short label for UI, e.g. "kts" / "kph". */
export function speedUnitShortLabel(unit: SpeedDisplayUnit): string {
  return speedUnitSuffix(unit);
}

/** Spelled-out unit for tooltips (avoids abbreviations in copy). */
export function speedUnitTooltipWord(unit: SpeedDisplayUnit): 'knots' | 'km/h' {
  return unit === SPEED_UNIT_KTS ? 'knots' : 'km/h';
}

/** Bracket form for table headers, e.g. "[kts]". */
export function speedUnitBracket(unit: SpeedDisplayUnit): string {
  return `[${speedUnitSuffix(unit)}]`;
}

/** Uppercase bracket for headers like "[KPH]". */
export function speedUnitBracketUpper(unit: SpeedDisplayUnit): string {
  const s = speedUnitSuffix(unit);
  return `[${s.toUpperCase()}]`;
}

/** Convert a numeric speed between kts and kph (maritime 1.852). */
export function convertSpeedMagnitude(value: number, from: SpeedDisplayUnit, to: SpeedDisplayUnit): number {
  if (!Number.isFinite(value) || from === to) return value;
  if (from === SPEED_UNIT_KTS && to === SPEED_UNIT_KPH) return value * KPH_PER_KNOT;
  if (from === SPEED_UNIT_KPH && to === SPEED_UNIT_KTS) return value / KPH_PER_KNOT;
  return value;
}
