const { log, error, warn, debug } = require('../../shared');
const EventEmitter = require('events');
const connectionManager = require('./connections');

/**
 * State Machine Processor
 * Processes incoming data points and computes derived channels:
 * - TACK: cwa > 0 ? 'stbd' : 'port'
 * - POINTOFSAIL: cwa < 70 ? 'upwind' : (cwa >= 70 && cwa <= 120 ? 'reach' : 'downwind')
 * - MANEUVER_TYPE: Track previous TWA, detect tacks (prevTwa < 0 && twa > 0 ? 'T' : ...)
 * 
 * Maps InfluxDB field names to default channel names following 1_normalization.py convention:
 * - AC40 uses _kph (kilometers per hour) for speed channels
 * - AC75 uses _kts (knots) for speed channels
 */

class StateMachineProcessor extends EventEmitter {
  constructor() {
    super();
    // Per-source state storage (keyed by source_name, normalized uppercase)
    this.sourceStates = new Map(); // source_name (normalized) -> { prevTwa, prevCwa, history, etc. }
    // Cache class names per source_name to avoid repeated lookups
    this.sourceClassCache = new Map(); // source_name (normalized) -> className
  }

  /**
   * Get class name for a source (AC40 or AC75)
   * Determines the unit suffix to use (_kph for AC40, _kts for AC75)
   * @param {string|number} sourceIdentifier - Source name (normalized) or source_id (for backward compatibility)
   * @returns {string} - Class name ('ac40' or 'ac75'), defaults to 'ac40'
   */
  getClassName(sourceIdentifier) {
    // Normalize if it's a string (source_name)
    const key = typeof sourceIdentifier === 'string' ? sourceIdentifier.toUpperCase().trim() : sourceIdentifier;
    
    // Check cache first
    if (this.sourceClassCache.has(key)) {
      return this.sourceClassCache.get(key);
    }

    // Try to get from connection config (if key is a number, it's source_id; if string, it's source_name)
    try {
      let connection = null;
      if (typeof key === 'number') {
        // Backward compatibility: key is source_id
        connection = connectionManager.getConnection(key);
      } else {
        // Key is source_name - find connection by source_name
        const connections = connectionManager.getAllConnections();
        connection = connections.find(conn => conn.source_name && 
          String(conn.source_name).toUpperCase().trim() === key);
      }
      
      if (connection && connection.config) {
        const className = connection.config.class_name || connection.config.class;
        if (className) {
          const normalized = String(className).toLowerCase().trim();
          this.sourceClassCache.set(key, normalized);
          return normalized;
        }
      }
    } catch (err) {
      debug(`[StateMachineProcessor] Error getting class for source "${key}":`, err.message);
    }

    // Default to AC40 (uses _kph)
    const defaultClass = 'ac40';
    this.sourceClassCache.set(key, defaultClass);
    return defaultClass;
  }

  /**
   * Get default channel name for an InfluxDB field name
   * Maps InfluxDB field names to default channel names with units following 1_normalization.py
   * @param {string} influxFieldName - InfluxDB field name (case-insensitive)
   * @param {string} className - Class name ('ac40' or 'ac75')
   * @returns {string|null} - Default channel name or null if no mapping
   */
  getDefaultChannelName(influxFieldName, className) {
    if (!influxFieldName) return null;

    const fieldLower = influxFieldName.toLowerCase();
    const isAC40 = className === 'ac40';
    const speedUnit = isAC40 ? 'kph' : 'kts';

    // Mapping following 1_normalization.py lines 172-193
    // Include all InfluxDB measurement name variants from REQUIRED_CHANNELS (influxdb.js)
    const mappings = {
      // Coordinates (same for all classes)
      'latitude_gps_unk': 'Lat_dd',
      'longitude_gps_unk': 'Lng_dd',
      
      // Speed channels (class-dependent units) - include SGP, TM, BOW, MHU variants
      'boat_speed_km_h_1': `Bsp_${speedUnit}`,
      'gps_sog_km_h_1': `Sog_${speedUnit}`,
      'tws_sgp_km_h_1': `Tws_${speedUnit}`,
      'tws_tm_km_h_1': `Tws_${speedUnit}`,
      'tws_bow_sgp_km_h_1': `Tws_${speedUnit}`,
      'tws_mhu_sgp_km_h_1': `Tws_${speedUnit}`,
      'aws_sgp_km_h_1': `Aws_${speedUnit}`,
      'aws_bow_sgp_km_h_1': `Aws_${speedUnit}`,
      'aws_mhu_sgp_km_h_1': `Aws_${speedUnit}`,
      'vmg_km_h_1': `Vmg_${speedUnit}`,
      
      // Angle channels (degrees, same for all classes) - include SGP, TM, BOW, MHU variants
      'twd_sgp_deg': 'Twd_deg',
      'twd_tm_deg': 'Twd_deg',
      'twd_bow_sgp_deg': 'Twd_deg',
      'twd_mhu_sgp_deg': 'Twd_deg',
      'twa_sgp_deg': 'Twa_deg',
      'twa_tm_deg': 'Twa_deg',
      'twa_bow_sgp_deg': 'Twa_deg',
      'twa_mhu_sgp_deg': 'Twa_deg',
      'heading_deg': 'Hdg_deg',
      'gps_cog_deg': 'Cog_deg',
      'awa_sgp_deg': 'Awa_deg',
      'awa_tm_deg': 'Awa_deg',
      'awa_bow_sgp_deg': 'Awa_deg',
      'awa_mhu_sgp_deg': 'Awa_deg',
      'leeway_deg': 'Lwy_deg',
      
      // Boat attitude and rates (from InfluxDB REQUIRED_CHANNELS)
      'pitch_deg': 'Pitch_deg',
      'heel_deg': 'Heel_deg',
      'rate_pitch_deg_s_1': 'Pitch_rate_dps',
      'rate_yaw_deg_s_1': 'Yaw_rate_dps',
      'rate_roll_deg_s_1': 'Roll_rate_dps',
      
      // Other normalized names (preserve as-is from 1_normalization.py)
      'ts': 'ts',
      'tws_fleet': 'Tws_fleet_kts', // Fleet wind uses kts
      'twd_fleet': 'Twd_fleet_deg',
      'twa_n': 'Twa_n_deg',
      'cwa': 'Cwa_deg',
      'cwa_n': 'Cwa_n_deg',
      'lwy_n': 'Lwy_n_deg',
      'pitch_deg': 'Pitch_deg',
      'pitch_rate_dps': 'Pitch_rate_dps',
      'accel': 'Accel_rate_mps2',
      'angrate': 'Yaw_rate_dps',
      'ang_rate': 'Yaw_rate_dps',
      'rate_yaw_deg_s_1': 'Yaw_rate_dps',
      'rate_pitch_deg_s_1': 'Pitch_rate_dps',
      'race_number': 'Race_number',
      'leg_number': 'Leg_number',
      'trk_race_num_unk': 'Race_number',
      'trk_leg_num_unk': 'Leg_number',

      // JIB channels (from 1_normalization_influx.py)
      'load_jib_sheet_kgf': 'JIB_sheet_load_kgf',
      'angle_jib_sht_deg': 'JIB_lead_ang_deg',
      'load_jib_cunno_kgf': 'JIB_cunno_load_kgf',
      'per_jib_lead_pct': 'JIB_lead_pct',
      'per_jib_sheet_pct': 'JIB_sheet_pct',

      // Righting hull (REQUIRED_CHANNELS, match 1_normalization_influx.py)
      'length_rh_p_mm': 'RH_port_mm',
      'length_rh_s_mm': 'RH_stbd_mm',
      'length_rh_bow_mm': 'RH_bow_mm',
      // Rudder
      'angle_rudder_deg': 'RUD_ang_deg',
      'angle_rud_avg_deg': 'RUD_rake_ang_deg',
      'angle_rud_diff_tack_deg': 'RUD_diff_ang_deg',
      'length_immersion_rud_p_mm': 'RUD_imm_port_mm',
      'length_immersion_rud_s_mm': 'RUD_imm_stbd_mm',
      // Daggerboard
      'angle_db_rake_p_deg': 'DB_rake_ang_port_deg',
      'angle_db_rake_s_deg': 'DB_rake_ang_stbd_deg',
      'angle_db_rake_p_aoa_deg': 'DB_rake_aoa_port_deg',
      'angle_db_rake_s_aoa_deg': 'DB_rake_aoa_stbd_deg',
      'angle_db_cant_p_deg': 'DB_cant_port_deg',
      'angle_db_cant_s_deg': 'DB_cant_stbd_deg',
      'angle_db_cant_p_eff_deg': 'DB_cant_eff_port_deg',
      'angle_db_cant_s_eff_deg': 'DB_cant_eff_stbd_deg',
      'length_db_h_p_mm': 'DB_ext_port_mm',
      'length_db_h_s_mm': 'DB_ext_stbd_mm',
      'length_immersion_db_p_mm': 'DB_imm_port_mm',
      'length_immersion_db_s_mm': 'DB_imm_stbd_mm',
      'length_db_piercing_p_m': 'DB_piercing_port_mm',
      'length_db_piercing_s_m': 'DB_piercing_stbd_mm',
      // Wing / CA
      'angle_ca1_deg': 'CA1_ang_deg',
      'angle_ca2_deg': 'CA2_ang_deg',
      'angle_ca3_deg': 'CA3_ang_deg',
      'angle_ca4_deg': 'CA4_ang_deg',
      'angle_ca5_deg': 'CA5_ang_deg',
      'angle_ca6_deg': 'CA6_ang_deg',
      'angle_wing_twist_deg': 'WING_twist_deg',
      'angle_wing_rot_deg': 'WING_rot_deg',
      'awa_-_e1_deg': 'WING_aoa_deg',
      'angle_clew_deg': 'WING_clew_ang_deg',
      'length_wing_clew_mm': 'WING_clew_pos_mm',
      // Rig / shroud (REQUIRED_CHANNELS)
      'load_bobstay_tf': 'BOBSTAY_load_tf',
      'load_shrd_lwr_p_tf': 'SHRD_lwr_port_tf',
      'load_shrd_lwr_s_tf': 'SHRD_lwr_stbd_tf',
      'load_shrd_upr_p_tf': 'SHRD_upr_port_tf',
      'load_shrd_upr_s_tf': 'SHRD_upr_stbd_tf',
      // Optional / target channels (live-relevant for display)
      'time_race_s': 'TIME_RACE_s',
      'trk_course_axis_deg': 'Course_axis_deg',
      'targ_twa_deg': 'Targ_Twa_deg',
      'targ_boat_speed_km_h_1': `Targ_Bsp_${speedUnit}`,
      'polar_boat_speed_km_h_1': `Polar_Bsp_${speedUnit}`,
      'targ_vmg_km_h_1': `Targ_Vmg_${speedUnit}`
    };

    return mappings[fieldLower] || null;
  }

  /**
   * Normalize timestamp to milliseconds
   * Handles timestamps in seconds, milliseconds, or nanoseconds
   * @param {number} timestamp - Timestamp (may be in seconds, milliseconds, or nanoseconds)
   * @returns {number} - Timestamp in milliseconds
   */
  normalizeTimestamp(timestamp) {
    if (!timestamp || typeof timestamp !== 'number') {
      debug('[StateMachineProcessor] Timestamp is invalid, using current time');
      return Date.now(); // Fallback to current time
    }
    
    // Normalize timestamp to milliseconds for millisecond precision
    // Detection logic:
    // - < 1e10 (10 billion): likely seconds (current time ~1.7e9 seconds)
    // - >= 1e15 (1 quadrillion): likely nanoseconds (current time ~1.7e15 nanoseconds)
    // - Otherwise: already in milliseconds (current time ~1.7e12 milliseconds)
    let normalized;
    if (timestamp < 1e10) {
      // Timestamp is in seconds, convert to milliseconds
      normalized = Math.floor(timestamp * 1000);
      debug(`[StateMachineProcessor] Timestamp normalized from seconds to milliseconds: ${timestamp} -> ${normalized}`);
    } else if (timestamp >= 1e15) {
      // Timestamp is in nanoseconds, convert to milliseconds
      normalized = Math.floor(timestamp / 1000000);
      debug(`[StateMachineProcessor] Timestamp normalized from nanoseconds to milliseconds: ${timestamp} -> ${normalized}`);
    } else {
      // Timestamp is already in milliseconds
      normalized = Math.floor(timestamp);
    }
    
    return normalized;
  }

  /**
   * Process a data point through the state machine
   * @param {Object} dataPoint - Incoming data point
   * @param {number} dataPoint.source_id - Source identifier
   * @param {number} dataPoint.timestamp - Timestamp (will be normalized to milliseconds)
   * @param {Object} dataPoint.data - Data object with channel values
   * @returns {Object} - Processed data point with computed channels
   */
  process(dataPoint) {
    try {
      const { source_id, timestamp, data } = dataPoint;

      if (!data) {
        warn('[StateMachineProcessor] Invalid data point: missing data');
        return null;
      }

      // Extract source_name from data (this is the unique identifier)
      const sourceName = data.source || data.source_name || data.sourceName || data.Source || null;
      if (!sourceName) {
        warn('[StateMachineProcessor] Invalid data point: missing source_name in data');
        return null;
      }

      // Normalize source_name for state management
      const normalizedSourceName = String(sourceName).toUpperCase().trim();

      // Normalize timestamp to milliseconds (CRITICAL for millisecond precision)
      const normalizedTimestamp = this.normalizeTimestamp(timestamp);

      // Get or create state for this source (using source_name as key)
      let state = this.sourceStates.get(normalizedSourceName);
      if (!state) {
        state = {
          prevTwa: null,
          prevCwa: null,
          lastManeuverType: null,
          history: []
        };
        this.sourceStates.set(normalizedSourceName, state);
      }

      // Get class name for this source to determine unit suffix (_kph for AC40, _kts for AC75)
      const className = this.getClassName(normalizedSourceName);

      // OPTIMIZED: Single pass through data with case-insensitive normalization
      // Create a NEW clean data object with default channel names (following 1_normalization.py)
      const processedData = {};
      const processedKeys = new Set(); // Track which keys we've already processed

      // Single pass: Process all channels efficiently with case-insensitive normalization
      for (const channel in data) {
        if (!data.hasOwnProperty(channel)) continue;
        
        const value = data[channel];
        const channelLower = channel.toLowerCase();
        
        // Check if this channel should be mapped to a default channel name
        const defaultChannelName = this.getDefaultChannelName(channelLower, className);
        
        if (defaultChannelName) {
          // Channel should be mapped to default channel name
          if (!processedKeys.has(defaultChannelName)) {
            processedData[defaultChannelName] = value;
            processedKeys.add(defaultChannelName);
          }
          // Skip if already processed (avoid duplicates)
        } else if (!processedKeys.has(channel)) {
          // Channel not in mapping list - add as-is (preserve original case for unknown channels)
          processedData[channel] = value;
          processedKeys.add(channel);
        }
      }

      // source_name is already extracted above and stored in processedData
      processedData.source_name = sourceName;

      // Extract channel values (use default channel names after standardization)
      // After normalization, fields should be 'Cwa_deg' or 'Twa_deg'
      const cwa = this.getChannelValue(processedData, ['Cwa_deg', 'Twa_deg', 'Cwa', 'Twa']);

      // Compute TACK (only normalized name, no lowercase duplicate)
      if (cwa !== null && cwa !== undefined) {
        processedData.TACK = cwa > 0 ? 'stbd' : 'port';
      }

      // Compute POINTOFSAIL (only normalized name, no lowercase duplicate)
      if (cwa !== null && cwa !== undefined) {
        if (cwa < 70) {
          processedData.POINTOFSAIL = 'upwind';
        } else if (cwa >= 70 && cwa <= 120) {
          processedData.POINTOFSAIL = 'reach';
        } else {
          processedData.POINTOFSAIL = 'downwind';
        }
      }

      // Compute MANEUVER_TYPE (only normalized name, no lowercase duplicate)
      if (cwa !== null && cwa !== undefined && state.prevCwa !== null) {
        // Detect tack: previous CWA was negative (port) and current CWA is positive (stbd)
        if (state.prevCwa < 0 && cwa > 0) {
          processedData.MANEUVER_TYPE = 'T'; // Tack
        }
        // Detect gybe: previous CWA was positive (stbd) and current CWA is negative (port)
        else if (state.prevCwa > 0 && cwa < 0) {
          processedData.MANEUVER_TYPE = 'G'; // Gybe
        }
        // Detect bear away:
        else if (Math.abs(state.prevCwa) < 90 && Math.abs(cwa) >= 90) {
          processedData.MANEUVER_TYPE = 'B'; // Bear away
        }
        // Detect round up:
        else if (Math.abs(state.prevCwa) > 90 && Math.abs(cwa) <= 90) {
          processedData.MANEUVER_TYPE = 'R'; // Round up
        }
        // No maneuver detected
        else {
          processedData.MANEUVER_TYPE = null;
        }
      } else {
        // First data point or no previous CWA
        processedData.MANEUVER_TYPE = null;
      }

      if (cwa !== null && cwa !== undefined) {
        state.prevCwa = cwa;
      }
      if (processedData.MANEUVER_TYPE) {
        state.lastManeuverType = processedData.MANEUVER_TYPE;
      }

      // ============================================
      // NORMALIZE CHANNELS (following 1_normalization_influx.py lines 810-932)
      // ============================================
      
      // Helper function to calculate angle difference (similar to angle_subtract)
      const angleSubtract = (angle1, angle2) => {
        if (angle1 === null || angle1 === undefined || angle2 === null || angle2 === undefined) {
          return null;
        }
        let diff = angle1 - angle2;
        // Normalize to -180 to 180 range
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return diff;
      };

      // Helper function to get sign of a number
      const getSign = (value) => {
        if (value === null || value === undefined || isNaN(value)) return 0;
        return value > 0 ? 1 : (value < 0 ? -1 : 0);
      };

      // Helper function to safely get channel value
      const getValue = (channel) => {
        const val = processedData[channel];
        return (val !== null && val !== undefined && !isNaN(val)) ? val : null;
      };

      // NORMALIZE CHANNELS (absolute values)
      if (getValue('Awa_deg') !== null) {
        processedData.Awa_n_deg = Math.abs(processedData.Awa_deg);
      }
      if (getValue('Twa_deg') !== null) {
        processedData.Twa_n_deg = Math.abs(processedData.Twa_deg);
      }
      if (getValue('Cwa_deg') !== null) {
        processedData.Cwa_n_deg = Math.abs(processedData.Cwa_deg);
      }
      if (getValue('Twa_bow_deg') !== null) {
        processedData.Twa_bow_n_deg = Math.abs(processedData.Twa_bow_deg);
      }
      if (getValue('Twa_mhu_deg') !== null) {
        processedData.Twa_mhu_n_deg = Math.abs(processedData.Twa_mhu_deg);
      }
      if (getValue('Twa_avg_deg') !== null) {
        processedData.Twa_avg_n_deg = Math.abs(processedData.Twa_avg_deg);
      }

      // PERFORMANCE PERCENTAGES
      try {
        const bspTgtKts = getValue('Bsp_tgt_kts');
        const bspKts = getValue('Bsp_kts');
        if (bspTgtKts !== null && bspKts !== null && bspTgtKts !== 0) {
          processedData.Bsp_perc = Math.max(0, Math.min(150, (bspKts / bspTgtKts) * 100));
        }

        const vmgTgtKts = getValue('Vmg_tgt_kts');
        const vmgKts = getValue('Vmg_kts');
        if (vmgTgtKts !== null && vmgKts !== null && vmgTgtKts !== 0) {
          processedData.Vmg_perc = Math.max(0, Math.min(150, (vmgKts / vmgTgtKts) * 100));
        }

        const bspPolarKph = getValue('Bsp_polar_kph');
        const bspKph = getValue('Bsp_kph');
        if (bspPolarKph !== null && bspKph !== null && bspPolarKph !== 0) {
          processedData.Polar_perc = Math.max(0, Math.min(150, (bspKph / bspPolarKph) * 100));
        }
      } catch (err) {
        debug(`[StateMachineProcessor] Error computing performance percentages: ${err.message}`);
        processedData.Bsp_perc = 0;
        processedData.Vmg_perc = 0;
        processedData.Polar_perc = 0;
      }

      // Calculate tack_sign based on Twa_deg
      const twaDeg = getValue('Twa_deg');
      const tackSign = twaDeg !== null ? getSign(twaDeg) : 0;

      // Normalize channels based on tack_sign
      const normalizeChannel = (baseChannel, normalizedChannel) => {
        const val = getValue(baseChannel);
        if (val !== null) {
          processedData[normalizedChannel] = val * tackSign;
        }
      };

      const normalizeChannelInverted = (baseChannel, normalizedChannel) => {
        const val = getValue(baseChannel);
        if (val !== null) {
          processedData[normalizedChannel] = (val * tackSign) * -1;
        }
      };

      // CA channels (inverted)
      normalizeChannelInverted('CA1_ang_deg', 'CA1_ang_n_deg');
      normalizeChannelInverted('CA2_ang_deg', 'CA2_ang_n_deg');
      normalizeChannelInverted('CA3_ang_deg', 'CA3_ang_n_deg');
      normalizeChannelInverted('CA4_ang_deg', 'CA4_ang_n_deg');
      normalizeChannelInverted('CA5_ang_deg', 'CA5_ang_n_deg');
      normalizeChannelInverted('CA6_ang_deg', 'CA6_ang_n_deg');

      // WING channels
      normalizeChannel('WING_twist_deg', 'WING_twist_n_deg');
      normalizeChannel('WING_rot_deg', 'WING_rot_n_deg');
      normalizeChannel('WING_aoa_deg', 'WING_aoa_n_deg');
      normalizeChannel('WING_clew_ang_deg', 'WING_clew_ang_n_deg');
      normalizeChannel('WING_clew_pos_mm', 'WING_clew_pos_n_mm');

      // Heel (inverted first, then normalized)
      const heelDeg = getValue('Heel_deg');
      if (heelDeg !== null) {
        processedData.Heel_deg = heelDeg * -1;
        processedData.Heel_n_deg = processedData.Heel_deg * tackSign;
      }

      // Lwy2_deg = angle_subtract(Hdg_deg, Cog_deg)
      const hdgDeg = getValue('Hdg_deg');
      const cogDeg = getValue('Cog_deg');
      if (hdgDeg !== null && cogDeg !== null) {
        processedData.Lwy2_deg = angleSubtract(hdgDeg, cogDeg);
        processedData.Lwy2_n_deg = processedData.Lwy2_deg * tackSign;
      }

      // Lwy_n_deg
      const lwyDeg = getValue('Lwy_deg');
      if (lwyDeg !== null) {
        processedData.Lwy_n_deg = lwyDeg * tackSign;
      }

      // RUD_ang_n_deg
      normalizeChannel('RUD_ang_deg', 'RUD_ang_n_deg');

      // Roll_rate_n_dps and Yaw_rate_n_dps
      normalizeChannel('Roll_rate_dps', 'Roll_rate_n_dps');
      normalizeChannel('Yaw_rate_dps', 'Yaw_rate_n_dps');

      // DERIVE WWD / LWD CHANNELS
      const deriveLwdWwd = (portChannel, stbdChannel, lwdChannel, wwdChannel) => {
        const portVal = getValue(portChannel);
        const stbdVal = getValue(stbdChannel);
        if (portVal !== null && stbdVal !== null) {
          if (tackSign > 0) {
            processedData[lwdChannel] = portVal;
            processedData[wwdChannel] = stbdVal;
          } else {
            processedData[lwdChannel] = stbdVal;
            processedData[wwdChannel] = portVal;
          }
        }
      };

      // RH channels
      deriveLwdWwd('RH_port_mm', 'RH_stbd_mm', 'RH_lwd_mm', 'RH_wwd_mm');

      // Foiling_state
      const bspKtsForFoiling = getValue('Bsp_kts');
      const heelNDegForFoiling = getValue('Heel_n_deg');
      if (bspKtsForFoiling !== null && heelNDegForFoiling !== null) {
        if (bspKtsForFoiling > 15 && heelNDegForFoiling < 8) {
          processedData.Foiling_state = 0; // H0
        } else if (bspKtsForFoiling > 15 && heelNDegForFoiling > 8) {
          processedData.Foiling_state = 1; // H1
        } else if (bspKtsForFoiling < 15 && heelNDegForFoiling > 5) {
          processedData.Foiling_state = 1; // H1
        } else if (bspKtsForFoiling < 15 && heelNDegForFoiling < 5) {
          processedData.Foiling_state = 2; // H2
        } else {
          processedData.Foiling_state = 1; // default
        }
      }

      // DB (daggerboard) channels
      deriveLwdWwd('DB_rake_ang_port_deg', 'DB_rake_ang_stbd_deg', 'DB_rake_ang_lwd_deg', 'DB_rake_ang_wwd_deg');
      deriveLwdWwd('DB_rake_aoa_port_deg', 'DB_rake_aoa_stbd_deg', 'DB_rake_aoa_lwd_deg', 'DB_rake_aoa_wwd_deg');
      deriveLwdWwd('DB_ext_port_mm', 'DB_ext_stbd_mm', 'DB_ext_lwd_mm', 'DB_ext_wwd_mm');
      deriveLwdWwd('DB_cant_port_deg', 'DB_cant_stbd_deg', 'DB_cant_lwd_deg', 'DB_cant_wwd_deg');
      deriveLwdWwd('DB_cant_eff_port_deg', 'DB_cant_eff_stbd_deg', 'DB_cant_eff_lwd_deg', 'DB_cant_eff_wwd_deg');

      // DB_imm channels (conditional)
      const dbImmPort = getValue('DB_imm_port_mm');
      const dbImmStbd = getValue('DB_imm_stbd_mm');
      if (dbImmPort !== null && dbImmStbd !== null) {
        deriveLwdWwd('DB_imm_port_mm', 'DB_imm_stbd_mm', 'DB_imm_lwd_mm', 'DB_imm_wwd_mm');
      } else {
        processedData.DB_imm_lwd_mm = 0.0;
        processedData.DB_imm_wwd_mm = 0.0;
      }

      // DB_piercing channels (conditional)
      const dbPiercingPort = getValue('DB_piercing_port_mm');
      const dbPiercingStbd = getValue('DB_piercing_stbd_mm');
      if (dbPiercingPort !== null && dbPiercingStbd !== null) {
        deriveLwdWwd('DB_piercing_port_mm', 'DB_piercing_stbd_mm', 'DB_piercing_lwd_mm', 'DB_piercing_wwd_mm');
      } else {
        processedData.DB_piercing_lwd_mm = 0.0;
        processedData.DB_piercing_wwd_mm = 0.0;
      }

      // RUD_imm channels (conditional)
      const rudImmPort = getValue('RUD_imm_port_mm');
      const rudImmStbd = getValue('RUD_imm_stbd_mm');
      if (rudImmPort !== null && rudImmStbd !== null) {
        deriveLwdWwd('RUD_imm_port_mm', 'RUD_imm_stbd_mm', 'RUD_imm_lwd_mm', 'RUD_imm_wwd_mm');
        processedData.RUD_imm_tot_mm = processedData.RUD_imm_lwd_mm + processedData.RUD_imm_wwd_mm;
      } else {
        processedData.RUD_imm_lwd_mm = 0.0;
        processedData.RUD_imm_wwd_mm = 0.0;
        processedData.RUD_imm_tot_mm = 0.0;
      }

      // SHRD channels
      deriveLwdWwd('SHRD_lwr_port_tf', 'SHRD_lwr_stbd_tf', 'SHRD_lwr_lwd_tf', 'SHRD_lwr_wwd_tf');
      deriveLwdWwd('SHRD_upr_port_tf', 'SHRD_upr_stbd_tf', 'SHRD_upr_lwd_tf', 'SHRD_upr_wwd_tf');

      // RIG_load_tf
      const shrdLwrStbd = getValue('SHRD_lwr_stbd_tf');
      const shrdUprStbd = getValue('SHRD_upr_stbd_tf');
      const shrdUprPort = getValue('SHRD_upr_port_tf');
      const bobstayLoad = getValue('BOBSTAY_load_tf');
      if (tackSign > 0) {
        if (shrdLwrStbd !== null && shrdUprStbd !== null && bobstayLoad !== null) {
          processedData.RIG_load_tf = shrdLwrStbd + shrdUprStbd + bobstayLoad;
        }
      } else {
        if (shrdUprStbd !== null && shrdUprPort !== null && bobstayLoad !== null) {
          processedData.RIG_load_tf = shrdUprStbd + shrdUprPort + bobstayLoad;
        }
      }

      // Add normalized timestamp to processed data (always in milliseconds)
      processedData.timestamp = normalizedTimestamp;
      // OPTIMIZED: Only create Date/ISO string if needed (lazy evaluation)
      // Most consumers can work with timestamp directly, Datetime is just for convenience
      Object.defineProperty(processedData, 'Datetime', {
        get: function() {
          return new Date(normalizedTimestamp).toISOString();
        },
        enumerable: true,
        configurable: true
      });

      // Create processed data point
      // Note: source_id is kept for backward compatibility with connection management
      // but source_name is the primary identifier for Redis and frontend
      const processedPoint = {
        source_id, // Keep for backward compatibility
        source_name: normalizedSourceName, // Primary identifier
        timestamp: normalizedTimestamp, // Use normalized timestamp
        data: processedData
      };

      // Debug: Log normalized channel names to verify normalization is working
      const processedChannelNames = Object.keys(processedData).filter(k => !['source_name', 'timestamp', 'Datetime'].includes(k));
      const incomingChannels = Object.keys(data).filter(k => !['source_name', 'timestamp', 'Datetime', 'source', 'sourceName', 'Source'].includes(k));
      
      // Check for new normalized channels
      const newNormalizedChannels = [
        'Awa_n_deg', 'Twa_n_deg', 'Cwa_n_deg', 'Twa_bow_n_deg', 'Twa_mhu_n_deg', 'Twa_avg_n_deg',
        'Bsp_perc', 'Vmg_perc', 'Polar_perc',
        'CA1_ang_n_deg', 'CA2_ang_n_deg', 'CA3_ang_n_deg', 'CA4_ang_n_deg', 'CA5_ang_n_deg', 'CA6_ang_n_deg',
        'WING_twist_n_deg', 'WING_rot_n_deg', 'WING_aoa_n_deg', 'WING_clew_ang_n_deg', 'WING_clew_pos_n_mm',
        'Heel_n_deg', 'Lwy_n_deg', 'Lwy2_deg', 'Lwy2_n_deg', 'RUD_ang_n_deg',
        'Roll_rate_n_dps', 'Yaw_rate_n_dps',
        'Foiling_state',
        'RH_lwd_mm', 'RH_wwd_mm',
        'DB_rake_ang_lwd_deg', 'DB_rake_ang_wwd_deg', 'DB_rake_aoa_lwd_deg', 'DB_rake_aoa_wwd_deg',
        'DB_ext_lwd_mm', 'DB_ext_wwd_mm', 'DB_cant_lwd_deg', 'DB_cant_wwd_deg',
        'DB_cant_eff_lwd_deg', 'DB_cant_eff_wwd_deg', 'DB_imm_lwd_mm', 'DB_imm_wwd_mm',
        'DB_piercing_lwd_mm', 'DB_piercing_wwd_mm',
        'RUD_imm_lwd_mm', 'RUD_imm_wwd_mm', 'RUD_imm_tot_mm',
        'SHRD_lwr_lwd_tf', 'SHRD_lwr_wwd_tf', 'SHRD_upr_lwd_tf', 'SHRD_upr_wwd_tf',
        'RIG_load_tf'
      ];
      
      const foundNewChannels = newNormalizedChannels.filter(ch => processedChannelNames.includes(ch));
      
      if (foundNewChannels.length > 0) {
        log(`[StateMachineProcessor] ✅ Source "${normalizedSourceName}": Found ${foundNewChannels.length} new normalized channels: [${foundNewChannels.join(', ')}]`);
      }
      
      // Use warn so it shows up even without verbose logging (but reduce frequency)
      if (processedChannelNames.length % 10 === 0 || foundNewChannels.length > 0) {
        warn(`[StateMachineProcessor] Source "${normalizedSourceName}": Incoming channels: [${incomingChannels.slice(0, 10).join(', ')}...] -> Normalized channels: [${processedChannelNames.slice(0, 20).join(', ')}...]`);
      }

      // Emit processed data
      this.emit('processed', processedPoint);

      return processedPoint;

    } catch (err) {
      error('[StateMachineProcessor] Error processing data point:', err.message);
      this.emit('error', err);
      return null;
    }
  }

  /**
   * Get channel value from data object (case-insensitive)
   * @param {Object} data - Data object
   * @param {Array<string>} possibleNames - Possible channel names to try
   * @returns {*} - Channel value or null
   */
  getChannelValue(data, possibleNames) {
    for (const name of possibleNames) {
      if (data.hasOwnProperty(name)) {
        return data[name];
      }
      // Try lowercase version
      const lowerName = name.toLowerCase();
      if (data.hasOwnProperty(lowerName)) {
        return data[lowerName];
      }
    }
    return null;
  }

  /**
   * Get state for a source
   * @param {number} source_id - Source identifier
   * @returns {Object|null} - State object or null
   */
  getState(source_id) {
    return this.sourceStates.get(source_id) || null;
  }

  /**
   * Clear state for a source
   * @param {number} source_id - Source identifier
   */
  clearState(source_id) {
    this.sourceStates.delete(source_id);
    log(`[StateMachineProcessor] Cleared state for source ${source_id}`);
  }

  /**
   * Clear all states
   */
  clearAllStates() {
    this.sourceStates.clear();
    log('[StateMachineProcessor] Cleared all states');
  }

  /**
   * Reset state for a source (keep structure but reset values)
   * @param {string|number} sourceIdentifier - Source name (normalized) or source_id (for backward compatibility)
   */
  resetState(sourceIdentifier) {
    // Normalize if it's a string (source_name)
    const key = typeof sourceIdentifier === 'string' ? sourceIdentifier.toUpperCase().trim() : sourceIdentifier;
    const state = this.sourceStates.get(key);
    if (state) {
      state.prevTwa = null;
      state.prevCwa = null;
      state.lastManeuverType = null;
      state.history = [];
      log(`[StateMachineProcessor] Reset state for source ${source_id}`);
    }
  }
}

// Singleton instance
const processor = new StateMachineProcessor();

module.exports = processor;

