/**
 * Core channel names used for the live map and initial Redis load.
 * Processor-mapped names (same as in LIVE_CHANNELS); single source of truth for
 * "required" live stream channels when client-side filtering or Redis merge is needed.
 */
export const LIVE_STREAM_CHANNELS: string[] = [
  'Lat_dd',
  'Lng_dd',
  'Bsp_kph',
  'Hdg_deg',
  'Tws_kph',
  'Twd_deg',
  'Twa_deg',
];

/**
 * Canonical list of channel names available from the Redis/streaming server.
 * Matches the normalized channel names produced by the streaming processor
 * (server_stream/controllers/processor.js) and documented in streaming-redis-api.
 * Used by the Live Table channel picker so users can select from all known live channels
 * even before data has arrived.
 */
export const LIVE_CHANNELS: string[] = [
  // Basic navigation
  'Lat_dd',
  'Lng_dd',
  'Hdg_deg',
  'Cog_deg',
  // Speed
  'Bsp_kph',
  'Bsp_kts',
  'Sog_kph',
  'Sog_kts',
  'Vmg_kph',
  'Vmg_kts',
  // Wind
  'Twd_deg',
  'Tws_kph',
  'Tws_kts',
  'Twa_deg',
  'Twa_n_deg',
  'Awa_deg',
  'Awa_n_deg',
  'Aws_kph',
  'Aws_kts',
  'Cwa_deg',
  'Cwa_n_deg',
  'Tws_fleet_kts',
  'Twd_fleet_deg',
  // Performance
  'Bsp_perc',
  'Vmg_perc',
  'Polar_perc',
  // Leeway
  'Lwy_deg',
  'Lwy_n_deg',
  'Lwy2_deg',
  'Lwy2_n_deg',
  // Heel, pitch and rates
  'Heel_deg',
  'Heel_n_deg',
  'Pitch_deg',
  'Pitch_rate_dps',
  'Roll_rate_dps',
  'Roll_rate_n_dps',
  'Yaw_rate_dps',
  'Yaw_rate_n_dps',
  'Accel_rate_mps2',
  // Foiling state
  'Foiling_state',
  // CA channels
  'CA1_ang_n_deg',
  'CA2_ang_n_deg',
  'CA3_ang_n_deg',
  'CA4_ang_n_deg',
  'CA5_ang_n_deg',
  'CA6_ang_n_deg',
  // WING channels
  'WING_twist_n_deg',
  'WING_rot_n_deg',
  'WING_aoa_n_deg',
  'WING_clew_ang_n_deg',
  'WING_clew_pos_n_mm',
  // Rudder
  'RUD_ang_n_deg',
  'RUD_imm_lwd_mm',
  'RUD_imm_wwd_mm',
  'RUD_imm_tot_mm',
  // Daggerboard - LWD/WWD
  'DB_rake_ang_lwd_deg',
  'DB_rake_ang_wwd_deg',
  'DB_rake_aoa_lwd_deg',
  'DB_rake_aoa_wwd_deg',
  'DB_ext_lwd_mm',
  'DB_ext_wwd_mm',
  'DB_cant_lwd_deg',
  'DB_cant_wwd_deg',
  'DB_cant_eff_lwd_deg',
  'DB_cant_eff_wwd_deg',
  'DB_imm_lwd_mm',
  'DB_imm_wwd_mm',
  'DB_piercing_lwd_mm',
  'DB_piercing_wwd_mm',
  // Rigging
  'RH_lwd_mm',
  'RH_wwd_mm',
  'SHRD_lwr_lwd_tf',
  'SHRD_lwr_wwd_tf',
  'SHRD_upr_lwd_tf',
  'SHRD_upr_wwd_tf',
  'RIG_load_tf',
  // JIB
  'JIB_sheet_load_kgf',
  'JIB_lead_ang_deg',
  'JIB_cunno_load_kgf',
  'JIB_lead_pct',
  'JIB_sheet_pct',
  // State (computed)
  'TACK',
  'POINTOFSAIL',
  'MANEUVER_TYPE',
  // Metadata / identifiers
  'Race_number',
  'Leg_number',
];
