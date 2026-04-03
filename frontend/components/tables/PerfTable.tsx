import { createSignal, createEffect, Show } from "solid-js";
import { huniDBStore } from "../../store/huniDBStore";
import { selectedSources, startDate, endDate } from "../../store/filterStore";
import { hiddenEvents } from "../../store/selectionStore";
import { persistantStore } from "../../store/persistantStore";
import { defaultChannelsStore } from "../../store/defaultChannelsStore";
import { escapeTableName } from "../../store/huniDBTypes";
import { error as logError, debug as logDebug } from "../../utils/console";

interface PerfTableProps {
  chartObjects: any[];
  twsBin: string; // "ALL" or numeric string like "10", "12", etc.
  windDirection?: 'UW' | 'DW' | 'BOTH'; // Upwind, Downwind, or Both (default: no filter)
  filterGrades?: string; // Comma-delimited grades (e.g., "2, 3" or "2")
  filterStates?: string; // Comma-delimited states (e.g., "H0, H1" or "H0")
  filterYear?: string; // Comma-delimited years (e.g., "2023, 2024" or "2023")
  filterEvent?: string; // Comma-delimited events (e.g., "Event1, Event2" or "Event1")
  filterConfig?: string; // Comma-delimited configs (e.g., "Config1, Config2" or "Config1")
  importanceSort?: string; // "None", "Minimize", or "Maximize"
  selectedEventIds?: number[]; // Event IDs from brush selection in timeseries scatter
  /** When provided (e.g. from Fleet Performance server-loaded data), table uses this instead of local DB. */
  aggregatesData?: Array<Record<string, unknown>>;
}

interface PivotedRow {
  channel: string;
  [sourceName: string]: string | number | null; // source names as dynamic keys
}

export default function PerfTable(props: PerfTableProps) {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [tableData, setTableData] = createSignal<PivotedRow[]>([]);
  const [sources, setSources] = createSignal<string[]>([]);
  const [sortedByChannel, setSortedByChannel] = createSignal<string | null>(null);
  const [sortDirection, setSortDirection] = createSignal<'asc' | 'desc'>('desc');
  const [sortedTableData, setSortedTableData] = createSignal<PivotedRow[]>([]);
  const [rowCorrelations, setRowCorrelations] = createSignal<Map<string, number>>(new Map());

  // Helper to escape SQL identifiers
  const escapeIdentifier = (name: string): string => {
    return `"${name.replace(/"/g, '""')}"`;
  };

  // Calculate Pearson correlation between two numeric arrays
  const calculateCorrelation = (xs: number[], ys: number[]): number => {
    const n = xs.length;
    if (n === 0 || n !== ys.length) {
      return 0;
    }

    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;

    let num = 0;
    let denX = 0;
    let denY = 0;

    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      const dy = ys[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }

    const denom = Math.sqrt(denX * denY);
    return denom === 0 ? 0 : num / denom;
  };

  // Build map from display name -> dataField from chart objects (same as scatter uses for value lookup)
  const getDataFieldByDisplayName = (chartObjects: any[]): Record<string, string> => {
    const map: Record<string, string> = {};
    if (!chartObjects?.length) return map;
    chartObjects.forEach((chartObject: any) => {
      const seriesList = chartObject.charts?.[0]?.series;
      if (!seriesList) return;
      seriesList.forEach((series: any) => {
        const add = (axis: 'yaxis' | 'xaxis' | 'taxis') => {
          const axisObj = series[axis];
          if (!axisObj?.name) return;
          const name = String(axisObj.name).trim();
          const upper = name.toUpperCase();
          if (name && name.toLowerCase() !== 'datetime' && upper !== 'DEFAULT' && upper !== 'PAGE DEFAULT') {
            const dataField = axisObj.dataField || axisObj.name;
            map[name] = String(dataField).trim();
          }
        };
        add('yaxis');
        add('xaxis');
        add('taxis');
      });
    });
    return map;
  };

  // Build pivoted table from in-memory aggregate data (e.g. fleet performance server data)
  const pivotDataFromAggregates = (
    data: Array<Record<string, unknown>>,
    displayChannels: string[],
    dataFieldByDisplay?: Record<string, string>
  ): { rows: PivotedRow[]; sources: string[] } => {
    const metaKeys = new Set(['event_id', 'source_name', 'sourcename', 'sourceName', 'SOURCE_NAME', 'Source_name', 'Twa_deg', 'twa_deg', 'datetime', 'Datetime']);
    const getSource = (point: Record<string, unknown>): string => {
      const s = point.source_name ?? point.sourceName ?? point.SOURCE_NAME ?? point.sourcename ?? point.Source_name ?? '';
      return String(s).trim();
    };
    const getChannelValue = (point: Record<string, unknown>, channelKey: string): number | null => {
      const v = point[channelKey];
      if (v !== null && v !== undefined && typeof v === 'number' && !isNaN(v)) return v;
      const chLower = channelKey.toLowerCase();
      const key = Object.keys(point).find((k) => k.toLowerCase() === chLower && !metaKeys.has(k.toLowerCase()));
      if (!key) return null;
      const val = point[key];
      if (val === null || val === undefined) return null;
      const num = Number(val);
      return isNaN(num) ? null : num;
    };

    const sourceSet = new Set<string>();
    data.forEach((p) => sourceSet.add(getSource(p)));
    const sortedSources = Array.from(sourceSet).sort();

    const pivotedRows: PivotedRow[] = displayChannels.map((displayChannel) => {
      const row: PivotedRow = { channel: displayChannel };
      const lookupKey = dataFieldByDisplay?.[displayChannel] ?? displayChannel;
      sortedSources.forEach((source) => {
        const pointsForSource = data.filter((p) => getSource(p) === source);
        const values: number[] = [];
        pointsForSource.forEach((p) => {
          const v = getChannelValue(p, lookupKey);
          if (v !== null) values.push(v);
        });
        row[source] = values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
      });
      return row;
    });

    return { rows: pivotedRows, sources: sortedSources };
  };

  // Extract channel names from chart objects
  const extractChannels = (chartObjects: any[]): string[] => {
    const channels = new Set<string>();

    if (chartObjects && chartObjects.length > 0) {
      chartObjects.forEach(chartObject => {
        if (chartObject.charts && chartObject.charts[0] && chartObject.charts[0].series) {
          chartObject.charts[0].series.forEach((series: any) => {
            // Extract y-axis channels
            if (series.yaxis && series.yaxis.name) {
              const channelName = series.yaxis.name;
              // Only include numeric channels (exclude Datetime, DEFAULT, PAGE DEFAULT, etc.)
              const upperName = channelName.toUpperCase();
              if (channelName && channelName.toLowerCase() !== 'datetime' && upperName !== 'DEFAULT' && upperName !== 'PAGE DEFAULT') {
                channels.add(channelName);
              }
            }
            // Extract x-axis channels
            if (series.xaxis && series.xaxis.name) {
              const channelName = series.xaxis.name;
              const upperName = channelName.toUpperCase();
              // Exclude "DEFAULT" and "PAGE DEFAULT" - these are special values that mean "use page default"
              if (channelName && channelName.toLowerCase() !== 'datetime' && upperName !== 'DEFAULT' && upperName !== 'PAGE DEFAULT') {
                channels.add(channelName);
              }
            }
            // Extract t-axis (target) channels
            if (series.taxis && series.taxis.name) {
              const channelName = series.taxis.name;
              const upperName = channelName.toUpperCase();
              if (channelName && channelName.toLowerCase() !== 'datetime' && upperName !== 'DEFAULT' && upperName !== 'PAGE DEFAULT') {
                channels.add(channelName);
              }
            }
          });
        }
      });
    }

    return Array.from(channels);
  };

  // Build SQL query
  // channelResolutions: display name + actual DB column name (so we only select columns that exist)
  const buildQuery = (
    channelResolutions: { displayChannel: string; dbColumn: string }[],
    twsBin: string,
    windDirection: 'UW' | 'DW' | 'BOTH' | undefined,
    selectedSources: string[],
    filterGrades: number[],
    filterStates: string[],
    filterYears: number[],
    filterEvents: string[],
    filterConfigs: string[],
    projectId: string,
    datasetId: string | null,
    startDate: string | null,
    endDate: string | null,
    twsFieldName: string,
    selectedEventIds?: number[],
    hiddenEventIds?: number[]
  ): { sql: string; params: any[] } => {
    if (channelResolutions.length === 0 || selectedSources.length === 0) {
      return { sql: '', params: [] };
    }

    // Build SELECT clause with AVG for each channel using actual DB column names
    const selectClauses = ['source_name'];
    channelResolutions.forEach(({ dbColumn }) => {
      const escapedColumn = escapeIdentifier(dbColumn);
      selectClauses.push(`avg(${escapedColumn}) as ${escapedColumn}`);
    });

    // Build WHERE conditions
    const conditions: string[] = [];
    const params: any[] = [];

    // Fixed conditions - HuniDB uses 'BIN10' (no space)
    conditions.push(`event_type = ?`);
    params.push('BIN10');

    conditions.push(`agr_type = ?`);
    params.push('AVG');

    // TWA condition based on wind direction - use 'twa_n_deg' for HuniDB
    if (windDirection === 'UW') {
      // Upwind: |TWA| < 90
      const twaField = escapeIdentifier('twa_n_deg');
      conditions.push(`ABS(${twaField}) < ?`);
      params.push(90);
    } else if (windDirection === 'DW') {
      // Downwind: |TWA| > 90
      const twaField = escapeIdentifier('twa_n_deg');
      conditions.push(`ABS(${twaField}) > ?`);
      params.push(90);
    } else if (windDirection === 'BOTH') {
      // Both: no TWA filter (or could be |TWA| > 0 to exclude dead downwind)
      // For now, no filter when BOTH is selected
    } else {
      // Default: no wind direction filter (original behavior - no TWA condition)
    }

    // Grade filter - use filterGrades from props
    if (filterGrades.length > 0) {
      if (filterGrades.length === 1) {
        // Single grade: use = for cleaner SQL
        conditions.push(`grade = ?`);
        params.push(filterGrades[0]);
      } else {
        // Multiple grades: use IN
        const placeholders = filterGrades.map(() => '?').join(',');
        conditions.push(`grade IN (${placeholders})`);
        params.push(...filterGrades);
      }
    } else {
      // Default: grade > 1 (matching example)
      conditions.push(`grade > ?`);
      params.push(1);
    }

    // State filter - use filterStates from props
    if (filterStates.length > 0) {
      if (filterStates.length === 1) {
        // Single state: use = for cleaner SQL
        conditions.push(`LOWER(state) = ?`);
        params.push(filterStates[0].toLowerCase());
      } else {
        // Multiple states: use IN
        const placeholders = filterStates.map(() => '?').join(',');
        conditions.push(`LOWER(state) IN (${placeholders})`);
        params.push(...filterStates.map(s => s.toLowerCase()));
      }
    } else {
      // Default: state = 'H0' (matching example)
      conditions.push(`LOWER(state) = ?`);
      params.push('h0');
    }

    // Year filter - use filterYears from props
    if (filterYears.length > 0) {
      if (filterYears.length === 1) {
        conditions.push(`year = ?`);
        params.push(filterYears[0]);
      } else {
        const placeholders = filterYears.map(() => '?').join(',');
        conditions.push(`year IN (${placeholders})`);
        params.push(...filterYears);
      }
    }

    // Event filter - use filterEvents from props
    if (filterEvents.length > 0) {
      if (filterEvents.length === 1) {
        conditions.push(`event = ?`);
        params.push(filterEvents[0]);
      } else {
        const placeholders = filterEvents.map(() => '?').join(',');
        conditions.push(`event IN (${placeholders})`);
        params.push(...filterEvents);
      }
    }

    // Config filter - use filterConfigs from props
    if (filterConfigs.length > 0) {
      if (filterConfigs.length === 1) {
        conditions.push(`config = ?`);
        params.push(filterConfigs[0]);
      } else {
        const placeholders = filterConfigs.map(() => '?').join(',');
        conditions.push(`config IN (${placeholders})`);
        params.push(...filterConfigs);
      }
    }

    // TWS bin filter — use lowercase with underscores for HuniDB
    if (twsBin !== 'ALL') {
      const twsBinNum = parseFloat(twsBin);
      if (!isNaN(twsBinNum)) {
        // Convert TWS field name to HuniDB format (lowercase with underscores)
        // e.g. mixed-case channel -> lowercase key
        const twsFieldForQuery = twsFieldName.toLowerCase().replace(/-/g, '_');
        const escapedTwsField = escapeIdentifier(twsFieldForQuery);
        conditions.push(`${escapedTwsField} > ? AND ${escapedTwsField} <= ?`);
        params.push(twsBinNum - 1, twsBinNum + 1);
      }
    }

    // Source filter
    if (selectedSources.length > 0) {
      const placeholders = selectedSources.map(() => '?').join(',');
      conditions.push(`source_name IN (${placeholders})`);
      params.push(...selectedSources);
    }

    // Project filter
    conditions.push(`project_id = ?`);
    params.push(projectId);

    // Exclude hidden events from results (session-only hide, not persisted)
    if (hiddenEventIds && hiddenEventIds.length > 0) {
      const placeholders = hiddenEventIds.map(() => '?').join(',');
      conditions.push(`event_id NOT IN (${placeholders})`);
      params.push(...hiddenEventIds);
    }

    // Event ID filter (from brush selection) - takes priority over date range
    // This allows filtering by specific events selected in the timeseries scatter chart
    if (selectedEventIds && selectedEventIds.length > 0) {
      if (selectedEventIds.length === 1) {
        conditions.push(`event_id = ?`);
        params.push(selectedEventIds[0]);
      } else {
        const placeholders = selectedEventIds.map(() => '?').join(',');
        conditions.push(`event_id IN (${placeholders})`);
        params.push(...selectedEventIds);
      }
    } else {
      // Dataset or Date filter (only if no event ID filter)
      // Use dataset_id if available (for specific dataset contexts)
      // Otherwise use date range (for fleet reports)
      if (datasetId && datasetId !== '0' && datasetId !== '') {
        conditions.push(`dataset_id = ?`);
        params.push(datasetId);
      } else if (startDate && endDate) {
        // For fleet reports, filter by date range
        // Assuming the aggregates table has a date field (could be 'date', 'Datetime', etc.)
        // We'll use DATE() function to extract date from datetime if needed
        conditions.push(`DATE(Datetime) >= ? AND DATE(Datetime) <= ?`);
        params.push(startDate, endDate);
      }
    }

    // Legacy: agg.aggregates table is deprecated; only used when it exists (legacy DBs)
    const tableName = escapeTableName('agg.aggregates');
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    // Include MIN(source_id) for ordering (since we're grouping by source_name)
    const sql = `
      SELECT ${selectClauses.join(', ')}, MIN(${escapeIdentifier('source_id')}) as ${escapeIdentifier('min_source_id')}
      FROM ${tableName}
      ${whereClause}
      GROUP BY source_name
      ORDER BY min_source_id
    `;

    return { sql, params };
  };

  // Execute query and fetch data
  const executeQuery = async () => {
    const chartObjects = props.chartObjects;
    const twsBin = props.twsBin;
    const windDirection = props.windDirection;

    if (!chartObjects || chartObjects.length === 0) {
      setTableData([]);
      setSources([]);
      setError('No charts configured. Please configure charts first.');
      return;
    }

    // Extract channels
    const channels = extractChannels(chartObjects);
    if (channels.length === 0) {
      setTableData([]);
      setSources([]);
      setError('No channels found in chart configuration. Please ensure charts have valid axis channels.');
      logDebug('PerfTable: No channels found in chart objects', chartObjects);
      return;
    }

    // Use in-memory data when provided (e.g. Fleet Performance – same data as scatter/bars)
    if (props.aggregatesData !== undefined) {
      setLoading(true);
      setError(null);
      if (props.aggregatesData.length === 0) {
        setTableData([]);
        setSources([]);
        setError('No data found for the selected filters. Try adjusting your filters (sources, states, grades, TWS bin, or wind direction).');
        setLoading(false);
        return;
      }
      const dataFieldByDisplay = getDataFieldByDisplayName(chartObjects);
      const { rows, sources: srcs } = pivotDataFromAggregates(props.aggregatesData, channels, dataFieldByDisplay);
      setTableData(rows);
      setSources(srcs);
      setError(null);
      setLoading(false);
      logDebug('PerfTable: Rendered table from aggregatesData', { rowCount: rows.length, sourceCount: srcs.length });
      return;
    }

    // Get filter values (for DB path only)
    const selectedSourcesList = selectedSources();
    logDebug('PerfTable: Selected sources:', selectedSourcesList);
    if (selectedSourcesList.length === 0) {
      setTableData([]);
      setSources([]);
      // Only set "no sources" error when not already loading - avoids a re-run of this effect
      // (with a stale empty read) overwriting the real error e.g. DB connection failure
      if (!loading()) {
        setError(
          'No sources selected. Please select at least one source in the settings. ' +
          'The table also requires the local database (SQLite) to be loaded; if you see "SQLite WASM" or "Failed to connect to database" in the console, that must be fixed first.'
        );
        logDebug('PerfTable: No sources selected');
      }
      return;
    }

    // Parse filter values from props (comma-delimited strings)
    // Grades: parse as numbers
    const filterGradesValue = props.filterGrades || '';
    const parsedGrades: number[] = [];
    if (filterGradesValue.trim()) {
      const grades = filterGradesValue.split(',').map(g => parseInt(g.trim())).filter(g => !isNaN(g) && g >= 0 && g <= 5);
      parsedGrades.push(...grades);
    }
    
    // States: parse as strings
    const filterStatesValue = props.filterStates || '';
    const parsedStates: string[] = [];
    if (filterStatesValue.trim()) {
      const states = filterStatesValue.split(',').map(s => s.trim()).filter(s => s.length > 0);
      parsedStates.push(...states);
    }
    
    // Years: parse as numbers
    const filterYearValue = props.filterYear || '';
    const parsedYears: number[] = [];
    if (filterYearValue.trim()) {
      const years = filterYearValue.split(',').map(y => parseInt(y.trim())).filter(y => !isNaN(y));
      parsedYears.push(...years);
    }
    
    // Events: parse as strings
    const filterEventValue = props.filterEvent || '';
    const parsedEvents: string[] = [];
    if (filterEventValue.trim()) {
      const events = filterEventValue.split(',').map(e => e.trim()).filter(e => e.length > 0);
      parsedEvents.push(...events);
    }
    
    // Configs: parse as strings
    const filterConfigValue = props.filterConfig || '';
    const parsedConfigs: string[] = [];
    if (filterConfigValue.trim()) {
      const configs = filterConfigValue.split(',').map(c => c.trim()).filter(c => c.length > 0);
      parsedConfigs.push(...configs);
    }
    const { selectedClassName, selectedProjectId, selectedDatasetId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    let datasetId: string | null = null;
    
    if (typeof selectedDatasetId === 'function') {
      const dsId = selectedDatasetId();
      datasetId = dsId && dsId !== 0 ? String(dsId) : null;
    } else if (selectedDatasetId && selectedDatasetId !== 0) {
      datasetId = String(selectedDatasetId);
    }

    // Get date range from filterStore (for fleet reports)
    const startDateValue = startDate();
    const endDateValue = endDate();

    if (!className || !projectId) {
      setError('Missing class name or project ID. Please ensure you are in a valid project context.');
      setTableData([]);
      setSources([]);
      setLoading(false);
      return;
    }

    // Get TWS field name (TWA field name is hardcoded as 'twa_n_deg' for HuniDB)
    const twsFieldName = defaultChannelsStore.twsName().toLowerCase();

    setLoading(true);
    setError(null);

    let sql: string = '';
    let params: any[] = [];
    let plainTextQuery: string = '';

    try {
      // Get DB and check if legacy agg.aggregates table exists (deprecated; not created in current schema)
      const db = await huniDBStore.getDatabase(className.toLowerCase());
      const aggTableName = 'agg.aggregates';
      const tableExistsResult = await db.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
        [aggTableName]
      );
      if (!tableExistsResult || tableExistsResult.length === 0) {
        setTableData([]);
        setSources([]);
        setError('Performance table data is loaded from the server. Use the report filters and load performance data to see the table.');
        setLoading(false);
        return;
      }

      // Resolve chart channels to actual table columns (case-insensitive)
      const tableInfo = await db.query<{ name: string }>(
        `PRAGMA table_info(${escapeTableName(aggTableName)})`
      );
      const existingColumns = tableInfo.map((r) => r.name);
      const channelResolutions: { displayChannel: string; dbColumn: string }[] = [];
      for (const ch of channels) {
        const match = existingColumns.find((c) => c.toLowerCase() === ch.toLowerCase());
        if (match) {
          channelResolutions.push({ displayChannel: ch, dbColumn: match });
        } else {
          logDebug('PerfTable: Skipping channel not in aggregates table', { channel: ch, existingCount: existingColumns.length });
        }
      }

      if (channelResolutions.length === 0) {
        setTableData([]);
        setSources([]);
        setError('None of the chart channels exist in the aggregates table. Load performance data first or check channel names.');
        setLoading(false);
        return;
      }

      // Get selected event IDs from props (for brush selection filtering); exclude hidden events
      const hiddenIds = hiddenEvents();
      const selectedEventIds = (props.selectedEventIds || []).filter((id) => !hiddenIds.includes(id));

      // Build query using only resolved (existing) columns
      const queryResult = buildQuery(
        channelResolutions,
        twsBin,
        windDirection,
        selectedSourcesList,
        parsedGrades,
        parsedStates,
        parsedYears,
        parsedEvents,
        parsedConfigs,
        String(projectId),
        datasetId,
        startDateValue || null,
        endDateValue || null,
        twsFieldName,
        selectedEventIds.length > 0 ? selectedEventIds : undefined,
        hiddenIds.length > 0 ? hiddenIds : undefined
      );
      sql = queryResult.sql;
      params = queryResult.params;

      if (!sql) {
        setTableData([]);
        setSources([]);
        setError('Failed to build query. Please check your configuration.');
        setLoading(false);
        return;
      }

      // Create a plain text version with parameters substituted (replace in order)
      plainTextQuery = sql;
      params.forEach((param) => {
        const value = typeof param === 'string' 
          ? `'${param.replace(/'/g, "''")}'` 
          : (param === null ? 'NULL' : String(param));
        // Replace first occurrence of ? with the parameter value
        plainTextQuery = plainTextQuery.replace('?', value);
      });
      
      logDebug('PerfTable: Executing query', { sql: sql.substring(0, 200), paramsCount: params.length });
      logDebug('PerfTable: Full SQL query', { sql, params, plainTextQuery });

      // Execute query
      const results = await db.query<any>(sql, params);

      logDebug('PerfTable: Query results', { count: results.length });

      if (!results || results.length === 0) {
        setTableData([]);
        setSources([]);
        setError('No data found for the selected filters. Try adjusting your filters (sources, states, grades, TWS bin, or wind direction).');
        setLoading(false);
        logDebug('PerfTable: Query returned no results', { sql: sql.substring(0, 200), paramsCount: params.length });
        return;
      }

      // Pivot data: result columns use dbColumn names; display uses displayChannel
      const dbColumns = channelResolutions.map((r) => r.dbColumn);
      const displayChannels = channelResolutions.map((r) => r.displayChannel);
      const pivotedData = pivotData(results, dbColumns, displayChannels);
      setTableData(pivotedData.rows);
      setSources(pivotedData.sources);

    } catch (err: any) {
      // Log error and set error state
      logError('PerfTable: Error executing query', err);
      logError('PerfTable: SQL query that failed', { sql, params, plainTextQuery });
      const msg = err?.message ?? '';
      const isDbConnectionError =
        /SQLite|WASM|connection|connect to database|CONNECTION_ERROR|INITIALIZATION_ERROR/i.test(msg);
      const userMessage = isDbConnectionError
        ? 'The performance table needs the local database. The database could not be loaded (e.g. SQLite WASM failed). Check the browser console for details and ensure WASM files are served correctly.'
        : (msg || 'Failed to fetch data');
      setError(userMessage);
      setTableData([]);
      setSources([]);
    } finally {
      setLoading(false);
    }
  };

  // Pivot data: transform from source-based rows to channel-based rows
  // resultColumnNames: column names as returned from the SELECT (actual DB column names)
  // displayChannels: channel names for display in the table
  const pivotData = (results: any[], resultColumnNames: string[], displayChannels: string[]): { rows: PivotedRow[]; sources: string[] } => {
    // Extract unique sources and sort them
    const sourceSet = new Set<string>();
    results.forEach(row => {
      if (row.source_name) {
        sourceSet.add(row.source_name);
      }
    });
    const sortedSources = Array.from(sourceSet).sort();

    // Build pivoted rows
    const pivotedRows: PivotedRow[] = [];

    resultColumnNames.forEach((resultCol, index) => {
      const displayChannel = displayChannels[index];
      const row: PivotedRow = { channel: displayChannel };

      sortedSources.forEach(source => {
        const sourceRow = results.find(r => r.source_name === source);
        if (sourceRow) {
          const channelValue = sourceRow[resultCol] ?? sourceRow[escapeIdentifier(resultCol)] ?? sourceRow[displayChannel];
          row[source] = channelValue !== null && channelValue !== undefined ? Number(channelValue) : null;
        } else {
          row[source] = null;
        }
      });

      pivotedRows.push(row);
    });

    return { rows: pivotedRows, sources: sortedSources };
  };

  // Calculate color for a cell value based on row min/mean/max
  const calculateCellColor = (value: number | null, row: PivotedRow): string => {
    if (value === null || value === undefined || isNaN(Number(value))) {
      return 'rgb(255, 255, 255)'; // White for null/NaN
    }

    const numValue = Number(value);
    
    // Get all numeric values in this row
    const rowValues: number[] = [];
    Object.keys(row).forEach(key => {
      if (key !== 'channel') {
        const val = row[key];
        if (val !== null && val !== undefined && !isNaN(Number(val))) {
          rowValues.push(Number(val));
        }
      }
    });

    if (rowValues.length === 0) {
      return 'rgb(255, 255, 255)';
    }

    const min = Math.min(...rowValues);
    const max = Math.max(...rowValues);
    const mean = rowValues.reduce((sum, val) => sum + val, 0) / rowValues.length;

    // If all values are the same, return white
    if (min === max) {
      return 'rgb(255, 255, 255)';
    }

    // Determine color based on value position relative to min, mean, and max
    if (numValue === min) {
      // Darker blue for minimum
      return 'rgb(70, 130, 180)'; // Steel blue (darker blue)
    } else if (numValue === max) {
      // Red for maximum
      return 'rgb(255, 0, 0)'; // Red
    } else if (Math.abs(numValue - mean) < 0.001) {
      // White for mean (with small tolerance for floating point)
      return 'rgb(255, 255, 255)'; // White
    } else if (numValue < mean) {
      // Interpolate between darker blue (min) and white (mean)
      const ratio = (numValue - min) / (mean - min);
      const red = Math.round(70 + (255 - 70) * ratio);
      const green = Math.round(130 + (255 - 130) * ratio);
      const blue = Math.round(180 + (255 - 180) * ratio);
      return `rgb(${red}, ${green}, ${blue})`;
    } else {
      // Interpolate between white (mean) and red (max)
      const ratio = (numValue - mean) / (max - mean);
      const red = 255;
      const green = Math.round(255 * (1 - ratio));
      const blue = Math.round(255 * (1 - ratio));
      return `rgb(${red}, ${green}, ${blue})`;
    }
  };

  // Format value for display
  const formatValue = (value: number | null): string => {
    if (value === null || value === undefined || isNaN(Number(value))) {
      return '—';
    }
    return Number(value).toFixed(1);
  };

  // Get sorted sources based on selected channel
  const sortedSources = (): string[] => {
    const channel = sortedByChannel();
    const direction = sortDirection();
    const allSources = sources();
    const data = tableData();

    if (!channel || allSources.length === 0) {
      return allSources;
    }

    // Find the row for the selected channel
    const channelRow = data.find(row => row.channel === channel);
    if (!channelRow) {
      return allSources;
    }

    // Sort sources based on the channel's values
    const sorted = [...allSources].sort((a, b) => {
      const valueA = channelRow[a] as number | null;
      const valueB = channelRow[b] as number | null;

      // Handle null values - put them at the end
      if (valueA === null || valueA === undefined || isNaN(Number(valueA))) {
        return 1;
      }
      if (valueB === null || valueB === undefined || isNaN(Number(valueB))) {
        return -1;
      }

      const numA = Number(valueA);
      const numB = Number(valueB);

      if (direction === 'asc') {
        return numA - numB;
      } else {
        return numB - numA;
      }
    });

    return sorted;
  };

  // Handle channel click to sort columns
  const handleChannelClick = (channel: string) => {
    if (sortedByChannel() === channel) {
      // Toggle sort direction if clicking the same channel
      setSortDirection(sortDirection() === 'asc' ? 'desc' : 'asc');
    } else {
      // Set new channel and default to descending (highest first)
      setSortedByChannel(channel);
      setSortDirection('desc');
    }
  };

  // React to changes in props and filters
  createEffect(() => {
    // Track all reactive dependencies by accessing them
    props.chartObjects;
    props.twsBin;
    props.windDirection;
    props.filterGrades;
    props.filterStates;
    props.filterYear;
    props.filterEvent;
    props.filterConfig;
    props.selectedEventIds; // Track selected event IDs from brush selection
    props.aggregatesData; // When provided (e.g. Fleet Performance), table uses this instead of DB
    selectedSources(); // Track selected sources from filterStore
    startDate(); // Track start date from filterStore
    endDate(); // Track end date from filterStore

    // Execute query when any dependency changes
    executeQuery();
  });

  // Reactive effect to sort rows by correlation when importance sort is enabled
  createEffect(() => {
    const data = tableData();
    const targetChannel = sortedByChannel();
    const importance = props.importanceSort || "None";
    const allSources = sources();

    // If importance sort is "None" or no channel is selected, use original order
    if (importance === "None" || !targetChannel || data.length === 0 || allSources.length === 0) {
      setSortedTableData(data);
      setRowCorrelations(new Map()); // Clear correlations when not sorting by importance
      return;
    }

    // Find the target channel row
    const targetRow = data.find(row => row.channel === targetChannel);
    if (!targetRow) {
      setSortedTableData(data);
      setRowCorrelations(new Map()); // Clear correlations when target not found
      return;
    }

    // Calculate correlation for each channel row
    const rowsWithCorrelation = data.map(row => {
      // Extract paired values for this channel and target channel across all sources
      // Only include pairs where both values are valid
      const pairedValues: { x: number; y: number }[] = [];
      allSources.forEach(source => {
        const targetValue = targetRow[source];
        const channelValue = row[source];
        if (
          targetValue !== null && targetValue !== undefined && !isNaN(Number(targetValue)) &&
          channelValue !== null && channelValue !== undefined && !isNaN(Number(channelValue))
        ) {
          pairedValues.push({
            x: Number(channelValue),
            y: Number(targetValue)
          });
        }
      });

      // Calculate correlation if we have enough paired data points
      let correlation = 0;
      if (pairedValues.length >= 2) {
        const channelValues = pairedValues.map(p => p.x);
        const targetValues = pairedValues.map(p => p.y);
        correlation = calculateCorrelation(channelValues, targetValues);
      }

      // For "Max": use correlation as-is (positive correlation is good)
      // For "Min": use negative correlation (negative correlation is good, so negate for sorting)
      // For "Abs": use absolute correlation (strength of relationship regardless of direction)
      let sortValue = correlation;
      if (importance === "Min") {
        sortValue = -correlation; // Negate so most negative correlation ranks highest
      } else if (importance === "Abs") {
        sortValue = Math.abs(correlation); // Use absolute value for strength ranking
      }

      return {
        row,
        correlation,
        sortValue
      };
    });

    // Sort by sortValue (descending - highest value first)
    const sorted = rowsWithCorrelation
      .sort((a, b) => b.sortValue - a.sortValue)
      .map(item => item.row);

    // Store correlations for display
    const correlationsMap = new Map<string, number>();
    rowsWithCorrelation.forEach(item => {
      correlationsMap.set(item.row.channel, item.correlation);
    });
    setRowCorrelations(correlationsMap);
    setSortedTableData(sorted);
  });

  return (
    <div class="perf-table-container" style="width: 100%; height: auto;">
      <Show when={loading()}>
        <div style="padding: 20px; text-align: center;">Loading...</div>
      </Show>
      
      <Show when={!loading() && error()}>
        <div style="padding: 20px; text-align: center; color: red;">Error: {error()}</div>
      </Show>

      <Show when={!loading() && !error() && tableData().length > 0}>
        <table style="width: 100%; border-collapse: collapse; font-size: 14px; display: table;">
            <thead>
              <tr>
                <Show when={(props.importanceSort || "None") !== "None" && sortedByChannel() !== null}>
                  <th class="perf-table-rank-header">
                    Rank
                  </th>
                </Show>
                <th class="perf-table-channel-header">
                  CHANNEL
                </th>
              {sortedSources().map(source => (
                <th style="padding: 8px; text-align: center; border: 1px solid #ddd; background-color: #e0e0e0; font-weight: bold; color: #000;">
                  {source}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedTableData().map((row, index) => {
              const isSortedChannel = sortedByChannel() === row.channel;
              const sortArrow = isSortedChannel 
                ? (sortDirection() === 'asc' ? ' ↑' : ' ↓')
                : '';
              const showRank = (props.importanceSort || "None") !== "None" && sortedByChannel() !== null;
              const correlation = rowCorrelations().get(row.channel);
              return (
                <tr>
                  <Show when={showRank}>
                    <td class="perf-table-rank-cell">
                      {index + 1}
                      {correlation !== undefined && (
                        <span class="perf-table-rank-correlation">
                          {correlation >= 0 ? '+' : ''}{correlation.toFixed(3)}
                        </span>
                      )}
                    </td>
                  </Show>
                  <td 
                    class={`perf-table-channel-cell ${isSortedChannel ? 'perf-table-channel-sorted' : ''}`}
                    style={`cursor: pointer; user-select: none; ${isSortedChannel ? 'background-color: green;' : ''}`}
                    onClick={() => handleChannelClick(row.channel)}
                    title="Click to sort columns by this channel"
                  >
                    {row.channel}{sortArrow}
                  </td>
                  {sortedSources().map(source => {
                    const value = row[source] as number | null;
                    const color = calculateCellColor(value, row);
                    return (
                      <td 
                        style={`padding: 8px; text-align: center; border: 1px solid #ddd; background-color: ${color}; color: #000;`}
                      >
                        {formatValue(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Show>

      <Show when={!loading() && !error() && tableData().length === 0}>
        <div style="padding: 20px; text-align: center; color: #666;">
          No data available. Please check your configuration and filters.
        </div>
      </Show>
    </div>
  );
}

