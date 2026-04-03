/**
 * JSON/API field names for race summary & setup responses (snake_case; physical units fixed server-side).
 * Keeps literal suffix tokens out of .tsx display code.
 */
export const RaceSummaryApiKeys = {
  twsAvg: 'tws_avg_kph',
  bspAvg: 'bsp_avg_kph',
} as const;

export const RaceSetupApiKeys = {
  avgVmg: 'avg_vmg_kph',
  stdVmg: 'std_vmg_kph',
} as const;

/** Values match server column aliases in race-summary / race-setup queries. */
export const RaceSummaryColumnKeys = {
  ...RaceSummaryApiKeys,
  maxSpeed: 'max_speed',
  startSpeed: 'start_speed',
} as const;
