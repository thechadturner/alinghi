/**
 * Parquet / API snake_case keys for prestart timeseries (AC40 pipeline).
 * Literal speed tokens live here, not in `.tsx`.
 */
export const PRESTART_PARQUET_BSP = 'bsp_kph';

/** Timeseries chart keys per desc; matches prestart pipeline column names. */
export const PRESTART_TIMESERIES_CHARTS: Record<string, string[]> = {
  '0_Basics': ['ttk_s', PRESTART_PARQUET_BSP, 'polar_perc', 'twa_n_deg', 'accel_rate_mps2', 'heel_n_deg', 'rh_lwd_mm'],
  '1_Details': [
    PRESTART_PARQUET_BSP,
    'polar_perc',
    'twa_n_deg',
    'accel_rate_mps2',
    'heel_n_deg',
    'pitch_deg',
    'rh_lwd_mm',
    'rud_rake_ang_deg',
    'rud_diff_ang_deg',
    'db_rake_lwd_deg',
    'db_cant_lwd_deg',
    'db_cant_eff_lwd_deg',
    'wing_camber1_n_deg',
    'wing_total_twist_deg',
    'wing_clew_position_mm',
    'jib_sheet_load_kgf',
    'jib_cunno_load_kgf',
    'jib_lead_ang_deg',
  ],
  '2_Details': [
    PRESTART_PARQUET_BSP,
    'polar_perc',
    'twa_n_deg',
    'accel_rate_mps2',
    'heel_n_deg',
    'pitch_deg',
    'rh_lwd_mm',
    'rud_rake_ang_deg',
    'rud_diff_ang_deg',
    'db_rake_lwd_deg',
    'db_cant_lwd_deg',
    'db_cant_eff_lwd_deg',
    'wing_camber1_n_deg',
    'wing_total_twist_deg',
    'wing_clew_position_mm',
    'jib_sheet_load_kgf',
    'jib_cunno_load_kgf',
    'jib_lead_ang_deg',
  ],
};
