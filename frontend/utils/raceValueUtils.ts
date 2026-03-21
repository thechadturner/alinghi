/**
 * Race Value Utilities
 * 
 * Centralized handling of Race_number dual role:
 * 1. Filter/Grouping Metadata - Categorical values for filtering (UI shows "TRAINING")
 * 2. Plottable Data Channel - Numeric values for visualization (charts plot -1)
 * 
 * DESIGN PRINCIPLE:
 * - Backend stores: -1 (number)
 * - Data pipeline: -1 (preserved throughout)
 * - Filter UI: "TRAINING" (string for display)
 * - Filter store: 'TRAINING' (string)
 * - Translation: Happens in filterCore.ts createFilterConfig()
 * 
 * When user requests 'TRAINING' data, internal code automatically uses -1 for Race_number.
 */

/**
 * Check if a race value represents training.
 * Training can be represented as: -1, 0, '-1', 'TRAINING', 'training'
 */
export function isTrainingRace(value: unknown): boolean {
  if (value === -1 || value === 0 || value === '-1') return true;
  if (typeof value === 'string') {
    const upper = value.toUpperCase();
    return upper === 'TRAINING';
  }
  return false;
}

/**
 * Format race value for UI display.
 * Converts -1 → "TRAINING" for user-facing display.
 * Used in filter dropdowns, legends, and labels.
 */
export function formatRaceForDisplay(race: number | string | null | undefined): string {
  if (race === null || race === undefined) return 'NONE';
  if (isTrainingRace(race)) return 'TRAINING';
  return String(race);
}

/**
 * Format training hour option for UI display (e.g. "0" → "Hour 0").
 * Used in Map Settings when isTrainingHourMode (fleet map with no races, bins by hour).
 */
export function formatHourForDisplay(option: number | string | null | undefined): string {
  if (option === null || option === undefined) return 'NONE';
  const n = Number(option);
  return Number.isFinite(n) && n >= 0 ? `Hour ${n}` : String(option);
}

/**
 * Get numeric value for plotting on charts.
 * Converts "TRAINING" → -1 for numeric scales.
 * Used when Race_number is a data channel (y-axis, etc.).
 */
export function getRaceNumericValue(race: number | string | null | undefined): number {
  if (race === null || race === undefined) return NaN;
  if (isTrainingRace(race)) return -1;
  const num = Number(race);
  return isNaN(num) ? NaN : num;
}

/**
 * Get all equivalent filter values for a race.
 * When user selects 'TRAINING', this returns [-1, 0, 'TRAINING', 'training', '-1']
 * so filtering matches all possible representations in the data.
 * Used by createFilterConfig() to expand filter selections.
 */
export function getRaceFilterEquivalents(race: number | string): (number | string)[] {
  if (isTrainingRace(race)) {
    return [-1, 0, 'TRAINING', 'training', '-1'];
  }
  // For numeric races, include both number and string representations
  const num = Number(race);
  if (!isNaN(num)) {
    return [num, String(num)];
  }
  return [race];
}

/**
 * Check if two race values are equivalent.
 * Handles: -1 === 'TRAINING' === 0 === '-1'
 * Used in filter UI to check if an option is selected.
 */
export function isSameRace(r1: any, r2: any): boolean {
  // Direct equality
  if (r1 === r2) return true;
  
  // Both represent training
  if (isTrainingRace(r1) && isTrainingRace(r2)) return true;
  
  // Numeric equality (handles '1' === 1)
  const n1 = Number(r1);
  const n2 = Number(r2);
  if (!isNaN(n1) && !isNaN(n2)) {
    return n1 === n2;
  }
  
  return false;
}

/**
 * Normalize a race value from data for consistent internal representation.
 * Keeps -1 as-is (numeric), converts string representations to numbers where possible.
 * Used when processing data from API/backend.
 */
export function normalizeRaceValue(value: any): number | string | undefined {
  if (value === undefined || value === null) return undefined;
  
  // Keep -1 as-is (don't convert to 'TRAINING' in data)
  if (value === -1 || value === 0) return value;
  
  // Convert string '-1' or 'TRAINING' to numeric -1 for data consistency
  if (value === '-1' || value === 'TRAINING' || value === 'training') return -1;
  
  // Try to convert to number
  const num = Number(value);
  return isNaN(num) ? value : num;
}

/**
 * Sort race values with TRAINING first, then numeric ascending.
 * Used when displaying race options in dropdowns.
 */
export function sortRaceValues(a: any, b: any): number {
  const aIsTraining = isTrainingRace(a);
  const bIsTraining = isTrainingRace(b);
  
  // TRAINING always comes first
  if (aIsTraining && !bIsTraining) return -1;
  if (!aIsTraining && bIsTraining) return 1;
  if (aIsTraining && bIsTraining) return 0;
  
  // Both are numeric - sort numerically
  const aNum = Number(a);
  const bNum = Number(b);
  if (!isNaN(aNum) && !isNaN(bNum)) {
    return aNum - bNum;
  }
  
  // Fallback to string comparison
  return String(a).localeCompare(String(b));
}
