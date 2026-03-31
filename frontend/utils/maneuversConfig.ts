/**
 * Maneuvers Configuration System
 * 
 * Provides context-based configuration for maneuvers components to support
 * different data sources (dataset, fleet, historical) with configurable
 * table columns, color options, and API endpoints.
 */

import * as d3 from 'd3';
import { apiEndpoints } from '@config/env';
import { persistantStore } from '../store/persistantStore';
import { sourcesStore } from '../store/sourcesStore';
import { getColorByIndex } from './colorScale';

export type ManeuversContext = 'dataset' | 'fleet' | 'historical';

export interface TableColumnConfig {
  columns: string[];
  descriptions: string[];
  channels: string[];
}

export interface ManeuversConfig {
  context: ManeuversContext;
  apiEndpoints: {
    table: string;
    map: string;
    timeSeries: string;
  };
  buildQueryParams: (baseParams: {
    className: string;
    projectId: number;
    eventType: string;
    description?: string;
    eventList?: number[];
  }) => Record<string, any>;
  colorOptions: string[];
  getTableColumns: (phase: string, color: string, className?: string) => TableColumnConfig;
  getColorScale: (colorName: string, data: any[]) => d3.ScaleLinear<number, string> | d3.ScaleThreshold<number, string> | d3.ScaleOrdinal<string | number, string>;
}

/**
 * Get table column configuration based on phase and color
 */
function getDatasetTableColumns(phase: string, color: string, className?: string): TableColumnConfig {
  // Base columns - TACK will be replaced if color is MAINSAIL, HEADSAIL, or RACE
  let secondColumn = 'TACK';
  let secondDesc = 'TACK';
  let secondChan = 'twa_entry';

  // Phase-specific loss channel (tgt = loss vs target VMG)
  let lossChannel = 'loss_total_tgt';
  let lossDesc = 'LOSS TOTAL [M]';
  if (phase === 'INVESTMENT') {
    lossChannel = 'loss_inv_tgt';
    lossDesc = 'INVESTMENT LOSS [M]';
  } else if (phase === 'TURN') {
    lossChannel = 'loss_turn_tgt';
    lossDesc = 'TURN LOSS [M]';
  } else if (phase === 'ACCELERATION') {
    lossChannel = 'loss_build_tgt';
    lossDesc = 'BUILD LOSS [M]';
  }

  // Replace TACK with color-specific column if color is MAINSAIL, HEADSAIL, RACE, STATE, CONFIG, YEAR, or EVENT
  // When color is RACE we still show RACE in its own column and use TACK as second column (see below)
  if (color === 'RACE') {
    secondColumn = 'RACE';
    secondDesc = 'RACE';
    secondChan = 'Race_number';
  } else if (color === 'STATE') {
    secondColumn = 'STATE';
    secondDesc = 'STATE';
    secondChan = 'State';
  } else if (color === 'CONFIG') {
    secondColumn = 'CONFIG';
    secondDesc = 'CONFIG';
    secondChan = 'Config';
  } else if (color === 'YEAR') {
    secondColumn = 'YEAR';
    secondDesc = 'YEAR';
    secondChan = 'Year';
  } else if (color === 'EVENT') {
    secondColumn = 'EVENT';
    secondDesc = 'EVENT';
    secondChan = 'Event';
  }

  // Determine TWS unit based on class name
  const twsUnit = className?.toLowerCase() === 'ac40' ? '[kph]' : '[kts]';
  const twsDesc = `TWS ${twsUnit}`;

  // Dataset: always show RACE (race number) after DATETIME; when color is RACE use TACK as second data column to avoid duplicate
  const secondCol = color === 'RACE' ? 'TACK' : secondColumn;
  const secondDescOut = color === 'RACE' ? 'TACK' : secondDesc;
  const secondChanOut = color === 'RACE' ? 'twa_entry' : secondChan;

  return {
    columns: ['DATETIME', 'RACE', secondCol, twsDesc, lossDesc, 'MMG', 'VMG%'],
    descriptions: ['DATETIME', 'RACE', secondDescOut, twsDesc, lossDesc, 'MMG', 'VMG% OF TARGET'],
    channels: ['Datetime', 'Race_number', secondChanOut, 'tws_avg', lossChannel, 'mmg', 'vmg_perc_avg']
  };
}

/**
 * Get table column configuration for fleet context
 */
function getFleetTableColumns(phase: string, color: string, className?: string): TableColumnConfig {
  // Base columns - TACK will be replaced if color is MAINSAIL, HEADSAIL, RACE, or SOURCE
  let secondColumn = 'TACK';
  let secondDesc = 'TACK';
  let secondChan = 'twa_entry';

  // Phase-specific loss channel (tgt = loss vs target VMG)
  let lossChannel = 'loss_total_tgt';
  let lossDesc = 'LOSS TOTAL [M]';
  if (phase === 'INVESTMENT') {
    lossChannel = 'loss_inv_tgt';
    lossDesc = 'INVESTMENT LOSS [M]';
  } else if (phase === 'TURN') {
    lossChannel = 'loss_turn_tgt';
    lossDesc = 'TURN LOSS [M]';
  } else if (phase === 'ACCELERATION') {
    lossChannel = 'loss_build_tgt';
    lossDesc = 'BUILD LOSS [M]';
  }

  // Replace TACK with color-specific column if color is MAINSAIL, HEADSAIL, RACE, SOURCE, STATE, CONFIG, YEAR, or EVENT
  if (color === 'SOURCE') {
    secondColumn = 'SOURCE';
    secondDesc = 'SOURCE';
    secondChan = 'source_name';
  } else if (color === 'RACE') {
    secondColumn = 'RACE';
    secondDesc = 'RACE';
    secondChan = 'Race_number';
  } else if (color === 'STATE') {
    secondColumn = 'STATE';
    secondDesc = 'STATE';
    secondChan = 'State';
  } else if (color === 'CONFIG') {
    secondColumn = 'CONFIG';
    secondDesc = 'CONFIG';
    secondChan = 'Config';
  } else if (color === 'YEAR') {
    secondColumn = 'YEAR';
    secondDesc = 'YEAR';
    secondChan = 'Year';
  } else if (color === 'EVENT') {
    secondColumn = 'EVENT';
    secondDesc = 'EVENT';
    secondChan = 'Event';
  }

  // Determine TWS unit based on class name
  const twsUnit = className?.toLowerCase() === 'ac40' ? '[kph]' : '[kts]';
  const twsDesc = `TWS ${twsUnit}`;

  // Fleet: always show RACE (race number) after DATETIME; when color is RACE use TACK as second data column to avoid duplicate
  const secondCol = color === 'RACE' ? 'TACK' : secondColumn;
  const secondDescOut = color === 'RACE' ? 'TACK' : secondDesc;
  const secondChanOut = color === 'RACE' ? 'twa_entry' : secondChan;

  return {
    columns: ['DATETIME', 'RACE', secondCol, twsDesc, lossDesc, 'MMG', 'VMG%'],
    descriptions: ['DATETIME', 'RACE', secondDescOut, twsDesc, lossDesc, 'MMG', 'VMG% OF TARGET'],
    channels: ['Datetime', 'Race_number', secondChanOut, 'tws_avg', lossChannel, 'mmg', 'vmg_perc_avg']
  };
}

const ACCMAX_TOOLTIP = 'Value at time of maximum acceleration.';

/** TAKEOFF-specific columns for big table and scatter (channel -> header; description = tooltip). Tws_bin first so it is always requested and shown for takeoff. */
export const TAKEOFF_TABLE_COLUMNS: { channel: string; header: string; description?: string }[] = [
  { channel: 'Tws_bin', header: 'TWS BIN', description: 'Wind speed bin (KPH)' },
  { channel: 'Tws_avg', header: 'TWS [KPH]', description: 'Average true wind speed' },
  { channel: 'Mmg', header: 'Mmg', description: 'Meters made good in direction of wind for duration of takeoff' },
  { channel: 'Vmg_perc_avg', header: 'Vmg%', description: 'Average VMG% of target for duration of takeoff' },
  { channel: 'Loss_total_tgt', header: 'Loss total tgt', description: 'Overall maneuver loss in meters relative to target VMG' },
  { channel: 'Bsp_start', header: 'Start Bsp', description: 'Initial boat speed' },
  { channel: 'Twa_build', header: 'Build Twa', description: 'True wind angle during acceleration.'  },
  { channel: 'Time_accel', header: 'Accel Time', description: 'Seconds accelerating from minimum boat speed to pop onto foils' },
  { channel: 'Exit_time', header: 'Pop Time', description: 'Time from reaching 28 KPH of boat speed to popping onto foils' },
  { channel: 'Bsp_exit', header: 'Pop Bsp', description: 'Boat speed at time of pop onto foils.' },
  { channel: 'Twa_exit', header: 'Pop Twa', description: 'True wind angle at time of pop onto foils.' },
  { channel: 'Pitch_accmax', header: 'ACCMAX Pitch', description: ACCMAX_TOOLTIP },
  { channel: 'Heel_accmax', header: 'ACCMAX Heel', description: ACCMAX_TOOLTIP },
  { channel: 'Rake_accmax', header: 'ACCMAX DB Rake', description: ACCMAX_TOOLTIP },
  { channel: 'Rud_rake_accmax', header: 'ACCMAX Rud Rake', description: ACCMAX_TOOLTIP },
  { channel: 'Rud_diff_accmax', header: 'ACCMAX Rud Diff', description: ACCMAX_TOOLTIP },
  { channel: 'Cant_accmax', header: 'ACCMAX Cant', description: ACCMAX_TOOLTIP },
  { channel: 'Jib_sheet_pct_accmax', header: 'ACCMAX Jib Sht%', description: ACCMAX_TOOLTIP },
  { channel: 'Jib_lead_ang_accmax', header: 'ACCMAX Jib Lead', description: ACCMAX_TOOLTIP },
  { channel: 'Jib_cunno_load_accmax', header: 'ACCMAX Jib Cunno', description: ACCMAX_TOOLTIP },
  { channel: 'Wing_clew_pos_accmax', header: 'ACCMAX Wing Clew', description: ACCMAX_TOOLTIP },
  { channel: 'Wing_twist_accmax', header: 'ACCMAX Wing Twist', description: ACCMAX_TOOLTIP },
  { channel: 'Wing_ca1_accmax', header: 'ACCMAX Wing Ca1', description: ACCMAX_TOOLTIP }
];

/** Channels to request from API when event type is TAKEOFF (only takeoff-relevant columns). */
export const TAKEOFF_CHANNELS: string[] = TAKEOFF_TABLE_COLUMNS.map((c) => c.channel);

/**
 * Get table column configuration for DataTable_Big (full table)
 */
export function getBigTableColumns(context: ManeuversContext, color: string, className?: string, eventType?: string): TableColumnConfig {
  const isTakeoff = (eventType || '').toUpperCase() === 'TAKEOFF';

  if (isTakeoff) {
    // TAKEOFF: basics (Datetime, Race, Tack, Source) + TAKEOFF-specific columns
    const baseColumns = ['DATETIME', 'RACE', 'TACK'];
    const baseDescriptions = ['DATETIME', 'RACE', 'TACK'];
    const baseChannels = ['Datetime', 'Race_number', 'twa_entry'];
    const sourceColumn = ['SOURCE'];
    const sourceDesc = ['SOURCE'];
    const sourceChan = ['source_name'];

    const takeoffColumns = TAKEOFF_TABLE_COLUMNS.map((c) => c.header);
    const takeoffDescriptions = TAKEOFF_TABLE_COLUMNS.map((c) => c.description ?? c.header);
    const takeoffChannels = TAKEOFF_TABLE_COLUMNS.map((c) => c.channel);

    return {
      columns: [...baseColumns, ...sourceColumn, ...takeoffColumns],
      descriptions: [...baseDescriptions, ...sourceDesc, ...takeoffDescriptions],
      channels: [...baseChannels, ...sourceChan, ...takeoffChannels]
    };
  }

  // Fleet and dataset: RACE (race number) after DATETIME
  const baseColumns = ['DATETIME', 'RACE', 'TACK'];
  const baseDescriptions = ['DATETIME', 'RACE', 'TACK'];
  const baseChannels = ['Datetime', 'Race_number', 'twa_entry'];

  // Color-specific column (RACE already in base, so don't add again when color is RACE)
  let colorColumn: string[] = [];
  let colorDesc: string[] = [];
  let colorChan: string[] = [];

  if (color === 'RACE') {
    // RACE already in base columns
  } else if (context === 'fleet' && color === 'SOURCE') {
    colorColumn = ['SOURCE'];
    colorDesc = ['SOURCE'];
    colorChan = ['source_name'];
  } else if (context === 'fleet' && color === 'CONFIG') {
    colorColumn = ['CONFIG'];
    colorDesc = ['CONFIG'];
    colorChan = ['Config'];
  } else if (context === 'fleet' && color === 'STATE') {
    colorColumn = ['STATE'];
    colorDesc = ['STATE'];
    colorChan = ['State'];
  } else if (color === 'STATE') {
    colorColumn = ['STATE'];
    colorDesc = ['STATE'];
    colorChan = ['State'];
  } else if (color === 'CONFIG') {
    colorColumn = ['CONFIG'];
    colorDesc = ['CONFIG'];
    colorChan = ['Config'];
  } else if (color === 'YEAR') {
    colorColumn = ['YEAR'];
    colorDesc = ['YEAR'];
    colorChan = ['Year'];
  } else if (color === 'EVENT') {
    colorColumn = ['EVENT'];
    colorDesc = ['EVENT'];
    colorChan = ['Event'];
  }

  // Determine TWS unit based on class name
  const twsUnit = className?.toLowerCase() === 'ac40' ? '[kph]' : '[kts]';
  const twsDesc = `TWS ${twsUnit}`;

  const fullColumns = [
    ...baseColumns,
    ...colorColumn,
    twsDesc,
    'INV LOSS',
    'TURN LOSS',
    'BUILD LOSS',
    'TOTAL LOSS',
    'MMG',
    'VMG%',
    'BSP DROP',
    'BS MIN',
    'BS MIN Δ',
    'TURN RATE',
    'TURN RADIUS',
    'TWA EXIT',
    'OS ANG',
    'DROP TIME',
    'POP TIME',
    'RAISE TIME',
    'TWO BOARD TIME'
  ];

  const fullDescriptions = [
    ...baseDescriptions,
    ...colorDesc,
    twsDesc,
    'INVESTMENT IS 15 TO 5 SECONDS BEFORE HEAD TO WIND',
    'TURN IS 5 SECONDS BEFORE HEAD TO WIND TO 5 SECONDS AFTER',
    'BUILD IS 5 SECONDS AFTER HEAD TO WIND TO 20 SECONDS AFTER',
    'BASELINE VMG FOR WIND BIN vs. AVERAGE VMG FOR MANEUVER',
    'METERS MADE GOOD IN DIRECTION OF WIND',
    'VMG% OF TARGET [%]',
    'SPEED AT BUTTON PRESS [KPH]',
    'BS MIN [KPH]',
    'BS DROP - BS MIN [KPH]',
    'MAX TURN RATE [DEG/SEC]',
    'TURN RADIUS [M]',
    'TWA AT MAXIMUM TURN ANGLE',
    'MAXIMUM TURN ANGLE - FINAL HEADING',
    'TIME IN SECONDS OF BUTTON PRESS (MINUS = BEFORE HEAD TO WIND)',
    'TIME IN SECONDS OF WING INVERSION CA1 = CA6 (MINUS = BEFORE HEAD TO WIND)',
    'TIME IN SECONDS OF BUTTON PRESS (MINUS = BEFORE HEAD TO WIND)',
    'SECONDS WITH BOTH FOILS > 1.2 M EXTENSION'
  ];

  const fullChannels = [
    ...baseChannels,
    ...colorChan,
    'tws_avg',
    'loss_inv_tgt',
    'loss_turn_tgt',
    'loss_build_tgt',
    'loss_total_tgt',
    'mmg',
    'vmg_perc_avg',
    'bsp_drop',
    'bsp_min',
    'bsp_min_delta',
    'turn_rate_max',
    'turn_radius',
    'twa_exit_n',
    'overshoot_angle',
    'drop_time',
    'pop_time',
    'raise_time',
    'Time_two_boards'
  ];

  return {
    columns: fullColumns,
    descriptions: fullDescriptions,
    channels: fullChannels
  };
}

/**
 * Build color scale based on context and color name
 */
function buildColorScale(context: ManeuversContext, colorName: string, data: any[]): d3.ScaleLinear<number, string> | d3.ScaleThreshold<number, string> | d3.ScaleOrdinal<string | number, string> {
  if (colorName === 'TWS') {
    // Fixed TWS bins: 10, 15, 20, 25, 30, 35, 40, 45, 50
    // Use scaleThreshold with 8 thresholds to create 9 color ranges (one for each bin)
    const twsScale = d3.scaleThreshold<number, string>();
    twsScale.domain([12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5]);
    twsScale.range(["blue", "lightblue", "cyan", "lightgreen", "yellow", "orange", "red", "darkred", "purple"]);
    return twsScale;
  } else if (colorName === 'VMG') {
    const nums: number[] = data.map((d: any) => {
      const val = d.vmg_perc_avg ?? d.vmg_perc_avg;
      return Number(val);
    }).filter((v): v is number => !isNaN(v));
    const min = nums.length ? d3.min(nums)! : 0;
    const max = nums.length ? d3.max(nums)! : 1;
    const mid = (min + max) / 2;
    const vmgScale = d3.scaleLinear<number, string>();
    vmgScale.domain([min, mid, max]);
    (vmgScale as any).range(["blue", "lightgrey", "red"]);
    return vmgScale;
  } else if (colorName === 'TACK') {
    return d3.scaleThreshold<number, string>().domain([-180, -1, 1, 180]).range(["red", "red", "#64ed64", "#64ed64"]);
  } else if (colorName === 'SOURCE' && context === 'fleet') {
    // Use fleet source colors
    const sources = sourcesStore.sources();
    if (sources.length === 0) {
      // Fallback to index-based if sources not loaded
      const sourceNames = Array.from(new Set(data.map((d: any) => d.source_name || 'Unknown').filter(Boolean)));
      const colors = sourceNames.map((_, i) => getColorByIndex(i));
      return d3.scaleOrdinal<string | number, string>().domain(sourceNames).range(colors);
    }
    const sourceNames = sources.map(s => String(s.source_name).toLowerCase());
    const colors = sources.map(s => s.color || '#1f77b4');
    const ordinalScale = d3.scaleOrdinal<string | number, string>().domain(sourceNames).range(colors);
    (ordinalScale as any).unknown('#1f77b4');
    return ordinalScale;
  } else if (colorName === 'RACE' || colorName === 'STATE' || colorName === 'CONFIG' || colorName === 'YEAR' || colorName === 'EVENT') {
    const values = data.map((d: any) => {
      if (colorName === 'RACE') return d.race ?? d.Race_number;
      if (colorName === 'STATE') return d.State ?? d.state ?? d.STATE;
      if (colorName === 'CONFIG') return d.Config ?? d.config ?? d.CONFIG;
      if (colorName === 'YEAR') return d.Year ?? d.year ?? d.YEAR;
      if (colorName === 'EVENT') return d.Event ?? d.event ?? d.EVENT;
      return '';
    }).filter(v => v !== undefined && v !== null);
    const cats = Array.from(new Set(values as (string | number)[]));
    // Sort categorical values consistently
    const sortedCats = cats.sort((a, b) => {
      const aStr = String(a);
      const bStr = String(b);
      return aStr.localeCompare(bStr);
    });
    const colors: string[] = [];
    let i = 0;
    sortedCats.forEach(v => {
      if (colorName === 'RACE' && String(v) === '0') {
        colors.push('lightgrey');
      } else {
        colors.push(getColorByIndex(i));
      }
      i += 1;
    });
    return d3.scaleOrdinal<string | number, string>().domain(sortedCats).range(colors);
  } else {
    // Default fallback
    const defaultScale = d3.scaleLinear<number, string>();
    defaultScale.domain([8, 16, 28, 36, 44]);
    //defaultScale.domain([4, 8, 14, 18, 22]);
    (defaultScale as any).range(["yellow", "orange", "red"]);
    return defaultScale;
  }
}

/**
 * Get maneuvers configuration for a specific context
 */
export function getManeuversConfig(context: ManeuversContext = 'dataset'): ManeuversConfig {
  const { selectedClassName, selectedDatasetId, selectedSourceId, selectedDate } = persistantStore;

  if (context === 'fleet') {
    return {
      context: 'fleet',
      apiEndpoints: {
        table: `${apiEndpoints.app.data}/fleet-maneuvers-table-data`,
        // Map and time series use the unified maneuvers endpoints with explicit event_list
        // This works across all sources by filtering on event_list
        map: `${apiEndpoints.app.data}/maneuvers-map-data`,
        timeSeries: `${apiEndpoints.app.data}/maneuvers-timeseries-data`
      },
      buildQueryParams: (baseParams) => {
        // For map/time series endpoints: use event_list (works across all sources)
        // The regular maneuvers-map-data endpoint supports event_list filtering
        if (baseParams.eventList !== undefined && Array.isArray(baseParams.eventList)) {
          return {
            class_name: baseParams.className,
            project_id: baseParams.projectId,
            desc: baseParams.description || '',
            event_list: JSON.stringify(baseParams.eventList)
          };
        }
        // Table data path (no eventList) - uses source_id and date
        return {
          class_name: baseParams.className,
          project_id: baseParams.projectId,
          source_id: selectedSourceId(),
          date: selectedDate(),
          event_type: baseParams.eventType,
          ...(baseParams.description ? { desc: baseParams.description } : {})
        };
      },
      colorOptions: ['TWS', 'VMG', 'TACK', 'SOURCE'],
      getTableColumns: (phase: string, color: string) => getFleetTableColumns(phase, color, selectedClassName()),
      getColorScale: (colorName: string, data: any[]) => buildColorScale('fleet', colorName, data)
    };
  } else if (context === 'historical') {
    // Historical uses new simplified endpoints
    return {
      context: 'historical',
      apiEndpoints: {
        table: `${apiEndpoints.app.data}/maneuvers-history`,
        map: `${apiEndpoints.app.data}/maneuvers-map-data`,
        timeSeries: `${apiEndpoints.app.data}/maneuvers-timeseries-data`
      },
      buildQueryParams: (baseParams) => {
        if (baseParams.eventList && baseParams.eventList.length > 0) {
          return {
            class_name: baseParams.className,
            project_id: baseParams.projectId,
            ...(baseParams.description ? { desc: baseParams.description } : {}),
            event_list: JSON.stringify(baseParams.eventList)
          };
        }
        return {
          class_name: baseParams.className,
          project_id: baseParams.projectId,
          source_id: selectedSourceId(),
          date: selectedDate(),
          event_type: baseParams.eventType,
          ...(baseParams.description ? { desc: baseParams.description } : {})
        };
      },
      colorOptions: ['TWS', 'VMG', 'TACK','SOURCE'],
      getTableColumns: (phase: string, color: string) => getFleetTableColumns(phase, color, selectedClassName()),
      getColorScale: (colorName: string, data: any[]) => buildColorScale('historical', colorName, data)
    };
  } else {
    // Default: dataset
    return {
      context: 'dataset',
      apiEndpoints: {
        table: `${apiEndpoints.app.data}/maneuvers-table-data`,
        map: `${apiEndpoints.app.data}/maneuvers-map-data`,
        timeSeries: `${apiEndpoints.app.data}/maneuvers-timeseries-data`
      },
      buildQueryParams: (baseParams) => {
        // For map/time series we expect an explicit eventList; for table we still use dataset_id/event_type
        // If eventList is provided (even if empty), use it for map/time series endpoints
        // The calling function should validate that eventList is non-empty before calling
        if (baseParams.eventList !== undefined) {
          return {
            class_name: baseParams.className,
            project_id: baseParams.projectId,
            ...(baseParams.description ? { desc: baseParams.description } : {}),
            event_list: JSON.stringify(baseParams.eventList)
          };
        }
        // Table data path (no eventList)
        return {
          class_name: baseParams.className,
          project_id: baseParams.projectId,
          dataset_id: selectedDatasetId(),
          event_type: baseParams.eventType,
          ...(baseParams.description ? { desc: baseParams.description } : {})
        };
      },
      colorOptions: ['TWS', 'VMG', 'TACK', 'RACE', 'STATE'],
      getTableColumns: (phase: string, color: string) => getDatasetTableColumns(phase, color, selectedClassName()),
      getColorScale: (colorName: string, data: any[]) => buildColorScale('dataset', colorName, data)
    };
  }
}

