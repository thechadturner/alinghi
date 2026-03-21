import { createSignal, Show, onMount, For, createEffect, createMemo } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { FiSearch, FiSettings } from "solid-icons/fi";
import { log, error as logError } from "../../../../utils/console";
import { getData, getIndexColor, formatTime as formatTimeGlobal } from "../../../../utils/global";
import { apiEndpoints } from "@config/env";
import { user } from "../../../../store/userStore";
import { persistantStore } from "../../../../store/persistantStore";
import { selectedEvents, setSelectedEvents, setHasSelection, setTriggerSelection, cutEvents, isCut } from "../../../../store/selectionStore";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import { setCurrentDataset, getCurrentDatasetTimezone } from "../../../../store/datasetTimezoneStore";
import Loading from "../../../../components/utilities/Loading";
interface TableProps {
  objectName?: string;
  [key: string]: any;
}

const { selectedClassName, selectedProjectId, selectedDatasetId, selectedPage } = persistantStore;

export default function Table(props: TableProps) {
  // Only use navigate if we're not in split view
  let navigate: ((path: string) => void) | null;
  try {
    navigate = useNavigate();
  } catch (error: any) {
    // If useNavigate fails (e.g., in split view), set navigate to null
    navigate = null;
  }
  
  const [hasData, setHasData] = createSignal<boolean>(false);
  const [hasConfig, setHasConfig] = createSignal<boolean>(false);
  const [tableConfig, setTableConfig] = createSignal<any | null>(null);
  const [tableData, setTableData] = createSignal<any[]>([]);
  const [filteredData, setFilteredData] = createSignal<any[]>([]);
  const [loading, setLoading] = createSignal<boolean>(true);
  const [searchQuery, setSearchQuery] = createSignal<string>("");
  const [columnFormats, setColumnFormats] = createSignal<Record<string, string>>({});
  const [columnHeaders, setColumnHeaders] = createSignal<Record<string, string>>({}); // Map column names to display headers
  const [columnRounding, setColumnRounding] = createSignal<Record<string, number>>({}); // Map column names to rounding decimals
  const [columnSuffixes, setColumnSuffixes] = createSignal<Record<string, string>>({}); // Map column names to suffixes
  const [configuredColumns, setConfiguredColumns] = createSignal<string[]>([]); // Column names from chart_info (display order)
  const [sortColumn, setSortColumn] = createSignal<string | null>(null);
  const [sortDirection, setSortDirection] = createSignal<'asc' | 'desc'>('asc');
  const [isSelecting, setIsSelecting] = createSignal<boolean>(false);
  const [selectStartIndex, setSelectStartIndex] = createSignal<number | null>(null);
  const [renderedRowsVersion, setRenderedRowsVersion] = createSignal<number>(0);
  const [hasDragSelection, setHasDragSelection] = createSignal<boolean>(false);
  const [eventTimeRanges, setEventTimeRanges] = createSignal<Map<number, { starttime: string; endtime: string }>>(new Map()); // Map of event_id -> { starttime, endtime }
  const [datasetTimezone, setDatasetTimezone] = createSignal<string | null>(null);
  
  // Get object name from props or use default - make it reactive
  // Note: Must match Table builder's default ('default') to find existing objects
  const objectName = createMemo(() => {
    return props?.objectName || selectedPage() || 'default';
  });

  // Fetch table configuration from user_objects
  const fetchTableConfig = async (): Promise<any | null> => {
    try {
      const controller = new AbortController();
      const currentUser = user();
      if (!currentUser?.user_id) {
        return null;
      }
      
      const objName = objectName();
      const url = `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=table&object_name=${objName}`;
      
      const response = await getData(url, controller.signal);
      
      if (response.success && response.data) {
        setTableConfig(response.data);
        setHasConfig(true);
        
        // Build column formatting map, header map, rounding map, suffix map, and configured column order
        if (response.data.chart_info && response.data.chart_info.length > 0) {
          const formats: Record<string, string> = {};
          const headers: Record<string, string> = {};
          const rounding: Record<string, number> = {};
          const suffixes: Record<string, string> = {};
          const columns: string[] = [];
          response.data.chart_info[0].series?.forEach((series: any) => {
            const channelName = series.channel?.name;
            if (channelName) {
              columns.push(channelName);
              // Store formatting
              formats[channelName.toLowerCase()] = series.formatting || 'none';
              
              // Store header (use custom header if provided, otherwise use channel name)
              const displayHeader = series.header || series.label || channelName;
              headers[channelName.toLowerCase()] = displayHeader;
              
              // Store rounding
              rounding[channelName.toLowerCase()] = series.rounding ?? 2;
              
              // Store suffix
              suffixes[channelName.toLowerCase()] = series.suffix || '';
            }
          });
          // Match fetchTableData order: Datetime first if not already in list
          const hasDatetime = columns.some((ch: string) => ch.toLowerCase() === 'datetime');
          const orderedColumns = hasDatetime ? columns : ['Datetime', ...columns];
          setConfiguredColumns(orderedColumns);
          setColumnFormats(formats);
          setColumnHeaders(headers);
          setColumnRounding(rounding);
          setColumnSuffixes(suffixes);
        } else {
          setConfiguredColumns([]);
        }
        
        return response.data;
      }
      setHasConfig(false);
      return null;
    } catch (error: unknown) {
      logError('Error fetching table config:', error);
      return null;
    }
  };

  // Use timezone store for reactive timezone access
  createEffect(async () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    let datasetId: number | null = null;
    
    if (typeof selectedDatasetId === 'function') {
      const dsId = selectedDatasetId();
      datasetId = dsId ? Number(dsId) : null;
    } else if (selectedDatasetId) {
      datasetId = Number(selectedDatasetId);
    }

    if (className && projectId && datasetId && datasetId > 0) {
      await setCurrentDataset(className, projectId, datasetId);
      const tz = getCurrentDatasetTimezone();
      setDatasetTimezone(tz);
    } else {
      setDatasetTimezone(null);
    }
  });

  // Normalize row for display/filter: race_number -1 -> "TRAINING" so search and display match
  const normalizeRowForDisplay = (row: any): any => {
    if (!row || typeof row !== 'object') return row;
    const raceVal = row.Race_number ?? row.race_number ?? row.Race_Number;
    if (Number(raceVal) !== -1) return row;
    return {
      ...row,
      Race_number: 'TRAINING',
      race_number: 'TRAINING'
    };
  };

  // Processed table data used for filtering and display (race -1 shown as TRAINING)
  const processedTableData = createMemo(() => {
    const data = tableData();
    if (!data || data.length === 0) return [];
    return data.map((row: any) => normalizeRowForDisplay(row));
  });

  // Fetch table data from aggregate-data endpoint
  const fetchTableData = async (config: any): Promise<any[]> => {
    try {
      if (!config || !config.chart_info || config.chart_info.length === 0) {
        return [];
      }

      const chartInfo = config.chart_info[0];
      let channels = chartInfo.series?.map((s: any) => s.channel?.name).filter(Boolean) || [];
      const dataType = config.dataType || 'Phases';
      const channelSource = config.channelSource || 'events_aggregate';

      if (channels.length === 0) {
        return [];
      }

      // Always include Datetime - check if it's already in the list
      const hasDatetime = channels.some((ch: string) => ch.toLowerCase() === 'datetime');
      const datetimeIndex = hasDatetime ? channels.findIndex((ch: string) => ch.toLowerCase() === 'datetime') : -1;
      
      if (!hasDatetime) {
        // Datetime not in list - add it as second item (after event_id if present)
        // Note: event_id is not in channels, it's always returned by the API
        // So we'll add Datetime as the first item in the channels array
        channels = ['Datetime', ...channels];
      } else {
        // Datetime is already in list - keep it at user's specified position
        // No changes needed, user's order is preserved
      }

      // Map data types to event types and aggregate types
      const dataTypeMap: Record<string, string> = {
        'Phases': 'phase',
        'Periods': 'period',
        'Bins': 'bin 10'
      };
      const eventType = dataTypeMap[dataType] || 'bin 10';
      const agrType = 'avg';

      // Get dataset_id with proper validation
      let datasetId: number = 0;
      if (typeof selectedDatasetId === 'function') {
        const dsId = selectedDatasetId();
        datasetId = dsId ? Number(dsId) : 0;
      } else if (selectedDatasetId) {
        datasetId = Number(selectedDatasetId);
      }

      // Log what we're getting for debugging
      log(`Table: Fetching data with dataset_id=${datasetId}, class_name=${selectedClassName()}, project_id=${selectedProjectId()}`);

      // Ensure we have a valid dataset_id (API requires >= 1)
      if (!datasetId || datasetId <= 0) {
        logError('Table: Invalid or missing dataset_id, cannot fetch table data', {
          datasetId,
          selectedDatasetIdType: typeof selectedDatasetId,
          selectedDatasetIdValue: typeof selectedDatasetId === 'function' ? selectedDatasetId() : selectedDatasetId
        });
        return [];
      }

      // Get timezone for datetime formatting
      const timezone = datasetTimezone() || 'UTC';
      
      const controller = new AbortController();
      let url = `${apiEndpoints.app.data}/aggregate-data?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}&table_name=events_aggregate&event_type=${encodeURIComponent(eventType)}&agr_type=${agrType}&channels=${encodeURIComponent(JSON.stringify(channels))}`;
      
      // Add timezone parameter if available
      if (timezone && timezone !== 'UTC') {
        url += `&timezone=${encodeURIComponent(timezone)}`;
      }
      
      const response = await getData(url, controller.signal);

      if (response.success && response.data) {
        // Client-side filtering: ensure all rows have the correct dataset_id
        // This is a safety check in case the API returns mixed data
        // Only filter if dataset_id is present in the row - if not present, trust the API
        const filteredData = response.data.filter((row: any) => {
          const rowDatasetId = row.dataset_id || row.dataset_ID || row.DATASET_ID;
          // If dataset_id is not in the row, keep it (API should have filtered correctly)
          if (rowDatasetId === undefined || rowDatasetId === null) {
            return true;
          }
          // If dataset_id is present, ensure it matches
          return Number(rowDatasetId) === datasetId;
        });

        if (filteredData.length !== response.data.length) {
          log(`Table: Filtered out ${response.data.length - filteredData.length} rows with incorrect dataset_id (expected ${datasetId})`);
        }

        log(`Table: Returning ${filteredData.length} rows (from ${response.data.length} API response)`);
        return filteredData;
      }
      return [];
    } catch (error: unknown) {
      logError('Table: Error fetching table data:', error as any);
      return [];
    }
  };

  // Format datetime to HH:MM:SS using dataset timezone
  const formatTime = (datetime: string | Date | null | undefined): string => {
    if (!datetime) return '';
    const timezone = datasetTimezone();
    const formatted = formatTimeGlobal(datetime, timezone);
    return formatted || '';
  };

  // Get cell background color based on formatting rules
  const getCellStyle = (channel: string, value: any): Record<string, string> => {
    const channelLower = channel.toLowerCase();
    
    // Tack: red for PORT, green for STBD with white text
    if (channelLower === 'tack') {
      if (value === 'PORT') return { backgroundColor: '#dc2626', color: '#ffffff' };
      if (value === 'STBD') return { backgroundColor: '#16a34a', color: '#ffffff' };
    }
    
    // PointofSail: blue for UPWIND, red for REACHING, orange for DOWNWIND
    if (channelLower === 'pointofsail') {
      if (value === 'UPWIND') return { backgroundColor: '#2563eb', color: '#ffffff' };
      if (value === 'REACHING') return { backgroundColor: '#dc2626', color: '#ffffff' };
      if (value === 'DOWNWIND') return { backgroundColor: '#ea580c', color: '#ffffff' };
    }
    
    // Race_number: shades of blue, lighter to darker
    if (channelLower === 'race_number' || channelLower === 'race') {
      const raceNum = parseInt(value);
      if (!isNaN(raceNum)) {
        // Light blue to dark blue (#4C15D3 = RGB(76, 21, 211))
        const maxRace = 10;
        const normalized = Math.min(raceNum / maxRace, 1);
        // Start with light blue RGB(200, 220, 255) -> dark blue RGB(76, 21, 211)
        const r = Math.round(200 - normalized * 124); // 200 -> 76
        const g = Math.round(220 - normalized * 199); // 220 -> 21
        const b = Math.round(255 - normalized * 44); // 255 -> 211
        return { backgroundColor: `rgb(${r}, ${g}, ${b})`, color: '#000000' };
      }
    }
    
    // Leg_number: shades of purple, lighter to darker
    if (channelLower === 'leg_number' || channelLower === 'leg') {
      const legNum = parseInt(value);
      if (!isNaN(legNum)) {
        // Light purple to dark purple (#8769CF = RGB(135, 105, 207))
        const maxLeg = 10;
        const normalized = Math.min(legNum / maxLeg, 1);
        // Start with light purple RGB(220, 200, 240) -> dark purple RGB(135, 105, 207)
        const r = Math.round(220 - normalized * 85); // 220 -> 135
        const g = Math.round(200 - normalized * 95); // 200 -> 105
        const b = Math.round(240 - normalized * 33); // 240 -> 207
        return { backgroundColor: `rgb(${r}, ${g}, ${b})`, color: '#000000' };
      }
    }
    
    // Apply conditional formatting based on the format field
    const format = columnFormats()[channelLower];
    if (format && format !== 'none') {
      // Convert value to number
      const numValue = typeof value === 'string' ? parseFloat(value) : value;
      
      if (typeof numValue === 'number' && !isNaN(numValue)) {
        // Heatmap: color scale based on value
        if (format === 'heatmap') {
          const minMax = getColumnMinMax(channel);
          if (minMax.min !== minMax.max) {
            const normalized = (numValue - minMax.min) / (minMax.max - minMax.min);
            const color = getHeatmapColor(normalized);
            return { backgroundColor: color, color: '#ffffff' };
          }
        }
        
        // Traffic Light: Green/Yellow/Red thresholds
        if (format === 'traffic_light') {
          const percentiles = getColumnPercentiles(channel);
          if (numValue >= percentiles.p80) return { backgroundColor: '#16a34a', color: '#ffffff' };
          if (numValue >= percentiles.p50) return { backgroundColor: '#facc15', color: '#000000' };
          return { backgroundColor: '#dc2626', color: '#ffffff' };
        }
        
        // Bar Threshold: Visual bar based on value
        if (format === 'bar_threshold') {
          const minMax = getColumnMinMax(channel);
          if (minMax.min !== minMax.max) {
            const normalized = (numValue - minMax.min) / (minMax.max - minMax.min);
            const percent = (normalized * 100).toFixed(0);
            return {
              background: `linear-gradient(to right, #3b82f6 ${percent}%, transparent ${percent}%)`,
              color: 'inherit'
            };
          }
        }
      }
    }
    
    return {};
  };

  // Get arrow character based on value change (for arrow formatting)
  const getArrowSymbol = (channel: string, value: any, rowIndex: number): string | null => {
    const column = channel.toLowerCase();
    const format = columnFormats()[column];
    
    if (format === 'arrow' && rowIndex > 0 && typeof value === 'number' && !isNaN(value)) {
      const prevRow = filteredData()[rowIndex - 1];
      if (prevRow) {
        const prevValue = parseFloat(String(prevRow[column]));
        const currValue = parseFloat(String(value));
        if (!isNaN(prevValue)) {
          if (currValue > prevValue) return '↑';
          if (currValue < prevValue) return '↓';
          return '→';
        }
      }
    }
    return null;
  };

  // Get min and max values for a column (use full unfiltered dataset)
  const getColumnMinMax = (columnName: string): { min: number; max: number } => {
    const data = tableData(); // Use full unfiltered dataset for consistent formatting
    if (data.length === 0) return { min: 0, max: 0 };
    
    const columnLower = columnName.toLowerCase();
    const values = data
      .map((row: any) => {
        // Try multiple case variations to find the column
        const val = row[columnName] || row[columnLower] || row[columnName.toLowerCase()];
        return parseFloat(val);
      })
      .filter((v: number) => !isNaN(v));
    
    if (values.length === 0) return { min: 0, max: 0 };
    return {
      min: Math.min(...values),
      max: Math.max(...values)
    };
  };

  // Get percentile values for a column (use full unfiltered dataset)
  const getColumnPercentiles = (columnName: string): { p50: number; p80: number } => {
    const column = columnName.toLowerCase();
    const values = tableData() // Use full unfiltered dataset for consistent formatting
      .map((row: any) => parseFloat(row[column]))
      .filter((v: number) => !isNaN(v))
      .sort((a: number, b: number) => a - b);
    
    if (values.length === 0) return { p50: 0, p80: 0 };
    
    return {
      p50: values[Math.floor(values.length * 0.5)] || 0,
      p80: values[Math.floor(values.length * 0.8)] || 0
    };
  };

  // Get heatmap color based on normalized value (0-1)
  const getHeatmapColor = (normalized: number): string => {
    if (normalized < 0) normalized = 0;
    if (normalized > 1) normalized = 1;
    
    // Blue to red gradient
    if (normalized < 0.5) {
      // Blue to green (cold to medium)
      const ratio = normalized * 2;
      const r = Math.round(59 + (34 - 59) * ratio);
      const g = Math.round(130 + (197 - 130) * ratio);
      const b = Math.round(236 + (45 - 236) * ratio);
      return `rgb(${r}, ${g}, ${b})`;
    } else {
      // Green to red (medium to hot)
      const ratio = (normalized - 0.5) * 2;
      const r = Math.round(34 + (220 - 34) * ratio);
      const g = Math.round(197 - (220 - 197) * ratio);
      const b = 45;
      return `rgb(${r}, ${g}, ${b})`;
    }
  };

  // Check if a row's event falls within cut ranges
  const isEventInCutRanges = (eventId: number): boolean => {
    const currentIsCut = isCut();
    const currentCutEvents = cutEvents();
    
    if (!currentIsCut || !currentCutEvents || currentCutEvents.length === 0) {
      return true; // Not in cut mode, show all rows
    }
    
    // Get event time range for this event
    const eventTimeRange = eventTimeRanges().get(eventId);
    if (!eventTimeRange) {
      // If we don't have time range for this event, don't filter it out (might be loading)
      return true;
    }
    
    const eventStartTime = new Date(eventTimeRange.starttime).getTime();
    const eventEndTime = new Date(eventTimeRange.endtime).getTime();
    
    // Check if this event's time range overlaps with any cut range
    return currentCutEvents.some((range: any) => {
      if (typeof range === 'number') return false; // Skip event IDs
      
      if (range.start_time && range.end_time) {
        const cutStartTime = new Date(range.start_time).getTime();
        const cutEndTime = new Date(range.end_time).getTime();
        
        // Check if event time range overlaps with cut range
        return (eventStartTime <= cutEndTime && eventEndTime >= cutStartTime);
      }
      return false;
    });
  };

  // Apply search filter with intelligent matching (uses processed data so "training" matches race_number -1)
  const applySearchFilter = () => {
    const data = processedTableData();
    if (!data || data.length === 0) {
      if (filteredData().length > 0) {
        setFilteredData([]);
      }
      return;
    }

    // First, filter by cut ranges if in cut mode
    let dataToFilter = data;
    const currentIsCut = isCut();
    if (currentIsCut) {
      dataToFilter = data.filter((row: any) => {
        const eventId = row['event_id'] || row['Event_id'] || row['event_ID'];
        if (!eventId) return false; // Skip rows without event_id
        return isEventInCutRanges(eventId);
      });
    }

    const query = searchQuery().toLowerCase().trim();
    if (!query) {
      setFilteredData(dataToFilter);
      return;
    }

    // Check if the query contains "or" as a separator between criteria
    const hasOrSeparator = /race.*or.*leg|leg.*or.*race|tack.*or.*leg|leg.*or.*tack/i.test(query);
    
    const filtered = dataToFilter.filter((row: any) => {
      // Check for multiple contextual searches like "race 2 leg 4" or "race 2,4"
      const raceMatch = query.match(/race\s+([\d,]+)/i);
      const legMatch = query.match(/leg\s+([\d,]+)/i);
      const tackMatch = query.match(/tack\s+([\w,]+)/i);
      const sailMatch = query.match(/pointofsail\s+([\w,]+)/i);
      
      // Track which criteria need to match
      const matches: boolean[] = [];
      
      // Check each criterion
      if (raceMatch) {
        const raceNums = raceMatch[1].split(',').map((n: string) => n.trim());
        const rowValue = String(row.Race_number || row.race_number || row.Race_Number || '').trim();
        // Use exact match for numbers
        const matchesRace = raceNums.some((num: string) => rowValue === num);
        matches.push(matchesRace);
      }
      if (legMatch) {
        const legNums = legMatch[1].split(',').map((n: string) => n.trim());
        const rowValue = String(row.Leg_number || row.leg_number || row.Leg_Number || '').trim();
        // Use exact match for numbers
        const matchesLeg = legNums.some((num: string) => rowValue === num);
        matches.push(matchesLeg);
      }
      if (tackMatch) {
        const tacks = tackMatch[1].split(',').map((t: string) => t.trim().toLowerCase());
        const rowValue = String(row.Tack || row.tack || '').toLowerCase();
        const matchesTack = tacks.some((tack: string) => rowValue === tack || rowValue.includes(tack));
        matches.push(matchesTack);
      }
      if (sailMatch) {
        const sails = sailMatch[1].split(',').map((s: string) => s.trim().toLowerCase());
        const rowValue = String(row.PointofSail || row.pointofsail || '').toLowerCase();
        const matchesSail = sails.some((sail: string) => rowValue === sail || rowValue.includes(sail));
        matches.push(matchesSail);
      }
      
      // If we have specific criteria and "or" separator, use OR logic
      if (matches.length > 0 && hasOrSeparator) {
        return matches.some((m: boolean) => m);
      }
      
      // If we have specific criteria without "or", all must match (AND logic)
      if (matches.length > 0) {
        return matches.every((m: boolean) => m);
      }
      
      // Default: search all columns - split query by spaces, "and"/"or", and operators (&, |, &&, ||)
      // Split on: spaces, "and", "or", &&, ||, &, |
      const searchTerms = query
        .split(/\s+(?:and|or)\s+|(?:\s*&&\s*|\s*\|\|\s*)|(?:\s*[&|]\s*)|\s+/)
        .filter((term: string) => term && term.length > 0);
      
      // Detect AND/OR logic from various operators
      // Check if query contains word-based operators or symbol operators
      const hasAndWord = /\s+and\s+/.test(query);
      const hasOrWord = /\s+or\s+/.test(query);
      const hasAndDoubleSymbol = /&&/.test(query);
      const hasOrDoubleSymbol = /\|\|/.test(query);
      const hasAndSingleSymbol = !hasAndDoubleSymbol && /&/.test(query);
      const hasOrSingleSymbol = !hasOrDoubleSymbol && /\|/.test(query);
      
      const useAndLogic = hasAndWord || hasAndDoubleSymbol || hasAndSingleSymbol;
      const useOrLogic = hasOrWord || hasOrDoubleSymbol || hasOrSingleSymbol;
      
      if (useAndLogic) {
        // AND logic: all search terms must be found in the row
        return searchTerms.every((term: string) => 
          Object.values(row).some((value: any) => 
            String(value).toLowerCase().includes(term)
          )
        );
      } else if (useOrLogic) {
        // OR logic: any search term can match
        return searchTerms.some((term: string) => 
          Object.values(row).some((value: any) => 
            String(value).toLowerCase().includes(term)
          )
        );
      } else {
        // No operator specified - use OR logic (match any term)
        return searchTerms.some((term: string) => 
          Object.values(row).some((value: any) => 
            String(value).toLowerCase().includes(term)
          )
        );
      }
    });
    setFilteredData(filtered);
  };

  // Fetch event time ranges for all events in the table
  createEffect(async () => {
    const data = tableData();
    if (!data || data.length === 0) {
      setEventTimeRanges(new Map());
      return;
    }
    
    // Extract all unique event IDs from the table
    const eventIds: number[] = [...new Set(
      data
        .map((row: any) => row['event_id'] || row['Event_id'] || row['event_ID'])
        .filter((id: any) => id != null && id !== undefined)
    )] as number[];
    
    if (eventIds.length === 0) {
      setEventTimeRanges(new Map());
      return;
    }
    
    try {
      // Get datasetId and projectId for proper event lookup
      let datasetId: number | undefined = undefined;
      let projectId: number | undefined = undefined;
      
      if (typeof selectedDatasetId === 'function') {
        const dsId = selectedDatasetId();
        datasetId = dsId ? Number(dsId) : undefined;
      } else if (selectedDatasetId) {
        datasetId = Number(selectedDatasetId);
      }
      
      if (typeof selectedProjectId === 'function') {
        const projId = selectedProjectId();
        projectId = projId ? Number(projId) : undefined;
      } else if (selectedProjectId) {
        projectId = Number(selectedProjectId);
      }
      
      // Fetch time ranges for all events with proper context
      // unifiedDataStore.getEventTimeRanges will use datasetId and projectId from persistantStore
      // but we ensure they're available here for clarity
      const timeRanges = await unifiedDataStore.getEventTimeRanges(eventIds);
      setEventTimeRanges(timeRanges);
      log('Table: Fetched time ranges for', timeRanges.size, 'events', { datasetId, projectId });
    } catch (error: unknown) {
      logError('Table: Error fetching event time ranges:', error as any);
      setEventTimeRanges(new Map());
    }
  });

  // Watch search query changes, table data, and cut events
  createEffect(() => {
    searchQuery();
    tableData();
    cutEvents();
    isCut();
    eventTimeRanges(); // Re-filter when time ranges are loaded
    applySearchFilter();
  });

  // Watch selectedEvents changes and trigger row re-render
  createEffect(() => {
    selectedEvents();
    setRenderedRowsVersion(prev => prev + 1);
  });

  // Note: Event time ranges are automatically fetched and cached in HuniDB by selectionStore.setSelectedEvents()
  // No need to fetch them here - this avoids redundant API calls and improves performance


  // Check if we should show "no data" message
  const shouldShowNoData = () => {
    return !loading() && hasConfig() && !hasData();
  };

  // Check if we should show "create table" message
  const shouldShowCreateTable = () => {
    return !loading() && !hasConfig();
  };

  // Handle row selection - toggle event in selectionStore directly
  const toggleEventSelection = (eventId: number): void => {
    let newLength = 0;
    
    setSelectedEvents((prev: number[]) => {
      const newArray = prev.includes(eventId) 
        ? prev.filter((d: number) => d !== eventId)
        : [...prev, eventId];
      newLength = newArray.length;
      return newArray;
    });

    setTriggerSelection(true);
    setHasSelection(newLength > 0);
  };

  // Get sort indicator for column header
  const getSortIndicator = (column: string): string | null => {
    if (sortColumn() !== column) return null;
    return sortDirection() === 'asc' ? ' ▲' : ' ▼';
  };

  // Get visible columns: use configured columns from chart object when available; otherwise all keys from data (excluding event_id)
  const getVisibleColumns = (data: any[]): string[] => {
    const configured = configuredColumns();
    if (configured.length > 0) {
      // Only show columns defined in the table chart config, in config order; include only those present in data
      if (!data || data.length === 0) return configured;
      const dataKeys = new Set(Object.keys(data[0]).map((k: string) => k.toLowerCase()));
      return configured.filter((col: string) => dataKeys.has(col.toLowerCase()));
    }
    // No config: fallback to all keys from first row (legacy behavior)
    if (!data || data.length === 0) return [];
    return Object.keys(data[0]).filter((key: string) => key.toLowerCase() !== 'event_id');
  };

  // Sort data by column
  const sortedData = () => {
    const data = filteredData();
    const column = sortColumn();
    const direction = sortDirection();
    
    // Access selectedEvents to make this reactive to selection changes
    selectedEvents();
    
    if (!column || data.length === 0) return data;
    
    return [...data].sort((a: any, b: any) => {
      const aVal = a[column];
      const bVal = b[column];
      
      // Handle null/undefined
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      
      // Try numeric comparison first
      const aNum = parseFloat(aVal);
      const bNum = parseFloat(bVal);
      
      if (!isNaN(aNum) && !isNaN(bNum)) {
        return direction === 'asc' ? aNum - bNum : bNum - aNum;
      }
      
      // Fall back to string comparison
      const aStr = String(aVal).toLowerCase();
      const bStr = String(bVal).toLowerCase();
      if (direction === 'asc') {
        return aStr < bStr ? -1 : aStr > bStr ? 1 : 0;
      } else {
        return aStr > bStr ? -1 : aStr < bStr ? 1 : 0;
      }
    });
  };

  // Create memoized rendered rows that react to selection changes
  const renderedRows = createMemo(() => {
    // Read selectedEvents and renderedRowsVersion to make this reactive to selection changes
    const currentSelectedEvents = selectedEvents();
    const version = renderedRowsVersion(); // Force re-render when version changes
    const data = sortedData();
    
    return data.map((row: any, rowIndex: number) => {
      const eventId = row['event_id'];
      const isSelected = currentSelectedEvents.includes(eventId);
      
      // Get color for this row based on its position in the selection order
      const rowColor = isSelected ? getIndexColor(currentSelectedEvents, eventId) : undefined;
      
      const visibleColumns = getVisibleColumns(filteredData());
      
      // Build row style object - use rowColor if selected, otherwise default
      const hasValidColor = rowColor && rowColor !== 'lightgray' && rowColor !== undefined;
      const rowStyle: any = hasValidColor
        ? { "background-color": rowColor, "color": "#000000" }
        : { "background-color": "var(--color-bg-card)" };
      
      return (
        <tr 
          class="cursor-pointer transition-colors"
          style={rowStyle}
          onMouseEnter={(e) => {
            // Handle drag selection first
            handleMouseEnter(rowIndex);
            // Get current selection state to check if row is selected
            const currentSelectedEvents = selectedEvents();
            const isCurrentlySelected = currentSelectedEvents.includes(eventId);
            const currentRowColor = isCurrentlySelected 
              ? getIndexColor(currentSelectedEvents, eventId) 
              : undefined;
            // Only apply hover to row if row is not selected (no valid color)
            // Don't set row background - let td cells handle their own backgrounds (conditional formatting)
            if (!currentRowColor || currentRowColor === 'lightgray' || currentRowColor === undefined) {
              // Apply hover to individual cells that don't have conditional formatting
              const cells = e.currentTarget.querySelectorAll('td');
              cells.forEach((cell: any) => {
                // Only apply hover if cell doesn't have a background style (no conditional formatting)
                if (!cell.style.backgroundColor && !cell.style.background) {
                  cell.style.backgroundColor = "var(--color-bg-secondary)";
                }
              });
            }
          }}
          onMouseLeave={(e) => {
            // Reset cell backgrounds - preserve conditional formatting and selection
            // The cell styles are managed by the renderedRows memo, so we just clear any hover effects
            const cells = e.currentTarget.querySelectorAll('td');
            cells.forEach((cell: any) => {
              // If cell has conditional formatting or selection (has background style), keep it
              // Otherwise, the renderedRows will set the correct background
              // We just need to clear any temporary hover background
              const hasConditionalOrSelection = cell.getAttribute('data-has-background') === 'true';
              if (!hasConditionalOrSelection && cell.style.backgroundColor === "var(--color-bg-secondary)") {
                cell.style.backgroundColor = "";
              }
            });
          }}
          onClick={() => {
            // Only toggle if this was a simple click (not drag selection)
            // For simple clicks, toggle the selection
            if (!hasDragSelection()) {
              toggleEventSelection(eventId);
            }
            // If it was a drag, we've already handled the selection in handleMouseEnter
          }}
          onMouseDown={() => handleMouseDown(rowIndex)}
        >
          <For each={visibleColumns}>
            {(columnKey: string) => {
              // Skip event_id column
              if (columnKey.toLowerCase() === 'event_id') return null;
              
              const value = row[columnKey];
              const cellStyle = getCellStyle(columnKey, value);
              
              // Build cell style object
              const cellStyleObj: any = {};
              
              // First, apply conditional formatting if it exists
              if (cellStyle && Object.keys(cellStyle).length > 0) {
                Object.entries(cellStyle).forEach(([key, val]) => {
                  // Convert camelCase to kebab-case for CSS
                  const cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
                  cellStyleObj[cssKey] = val;
                });
              }
              
              // Apply row selection color on top of conditional formatting (selection takes precedence)
              if (hasValidColor && rowColor) {
                cellStyleObj['background-color'] = rowColor;
                // Preserve text color from conditional formatting if it exists, otherwise use black for selected rows
                if (!cellStyleObj['color']) {
                  cellStyleObj['color'] = '#000000';
                }
              }
              
              // Convert to string - ensure we always have a valid style string if there are any styles
              const finalStyleString = Object.keys(cellStyleObj).length > 0
                ? Object.entries(cellStyleObj)
                    .map(([key, val]) => `${key}: ${val}`)
                    .join('; ')
                : '';
              
              // Check if this cell has background styling (conditional formatting or selection)
              const hasBackground = !!(cellStyleObj['background-color'] || cellStyleObj['background']);
              
              const isConfigColumn = columnKey.toLowerCase() === 'config' || columnKey.toLowerCase() === 'configuration';
              const tdStyleWithConfig = isConfigColumn
                ? (finalStyleString ? `${finalStyleString}; min-width: 150px` : 'min-width: 150px')
                : finalStyleString;
              return (
                <td 
                  class="text-xs" 
                  style={tdStyleWithConfig || undefined}
                  data-has-background={hasBackground ? 'true' : 'false'}
                >
                  {(() => {
                    const columnLower = columnKey.toLowerCase();
                    let displayValue: string;
                    
                    // Handle datetime columns
                    if (columnLower === 'datetime') {
                      displayValue = formatTime(value);
                    } else if ((columnLower === 'race_number' || columnLower === 'race') && Number(value) === -1) {
                      displayValue = 'TRAINING';
                    } else if (value === null || value === undefined || value === '') {
                      displayValue = '-';
                    } else {
                      // Try to format as a number with rounding and suffix
                      const numValue = parseFloat(value);
                      if (!isNaN(numValue)) {
                        const rounding = columnRounding()[columnLower] ?? 2;
                        const suffix = columnSuffixes()[columnLower] || '';
                        displayValue = numValue.toFixed(rounding) + suffix;
                      } else {
                        displayValue = String(value);
                      }
                    }
                    
                    return (
                      <>
                        {displayValue}
                        {(() => {
                          const arrow = getArrowSymbol(columnKey, value, rowIndex);
                          return arrow ? <span class="ml-1">{arrow}</span> : null;
                        })()}
                      </>
                    );
                  })()}
                </td>
              );
            }}
          </For>
        </tr>
      );
    });
  });

  // Handle column header click for sorting
  const handleSort = (column: string): void => {
    if (sortColumn() === column) {
      // Toggle direction
      setSortDirection(sortDirection() === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  // Handle mouse down for multi-row selection
  const handleMouseDown = (rowIndex: number): void => {
    setIsSelecting(true);
    setSelectStartIndex(rowIndex);
    // Don't toggle here - let onClick handle simple clicks
  };

  // Handle mouse enter for drag selection
  const handleMouseEnter = (rowIndex: number): void => {
    if (isSelecting() && selectStartIndex() !== null) {
      setHasDragSelection(true);
      const data = sortedData();
      const start = Math.min(selectStartIndex()!, rowIndex);
      const end = Math.max(selectStartIndex()!, rowIndex);
      
      // Add all rows in range to selectedEvents
      const rangeEventIds: number[] = [];
      for (let i = start; i <= end; i++) {
        const eventId = data[i]['event_id'];
        if (eventId && !selectedEvents().includes(eventId)) {
          rangeEventIds.push(eventId);
        }
      }
      
      if (rangeEventIds.length > 0) {
        setSelectedEvents((prev: number[]) => {
          const newArray = [...prev, ...rangeEventIds];
          setHasSelection(true);
          setTriggerSelection(true);
          return newArray;
        });
      }
    }
  };

  // Handle mouse up to end selection
  const handleMouseUp = (): void => {
    setIsSelecting(false);
    setSelectStartIndex(null);
    // Reset drag selection flag after a small delay to allow onClick to check it
    setTimeout(() => setHasDragSelection(false), 0);
  };

  onMount(async () => {
    // Add global mouse up listener for drag selection
    const handleGlobalMouseUp = () => {
      handleMouseUp();
    };
    
    document.addEventListener('mouseup', handleGlobalMouseUp);
    document.addEventListener('mouseleave', handleGlobalMouseUp);
    
    // Load data
    setLoading(true);
    try {
      // Timezone is set reactively via createEffect above
      // Just get the current timezone if needed
      const timezone = getCurrentDatasetTimezone();
      if (timezone) {
        setDatasetTimezone(timezone);
      }
      
      const config = await fetchTableConfig();
      
      if (config) {
        const data = await fetchTableData(config);
        setTableData(data);
        setHasData(data && data.length > 0);
      } else {
        setHasData(false);
      }
    } catch (error: unknown) {
      logError('Error loading table data:', error);
      setHasData(false);
    } finally {
      setLoading(false);
    }
    
    // Cleanup on unmount
    return () => {
      document.removeEventListener('mouseup', handleGlobalMouseUp);
      document.removeEventListener('mouseleave', handleGlobalMouseUp);
    };
  });

  return (
    <div class="explore-table-container h-full max-h-screen flex flex-col p-2 overflow-hidden">
      <Show when={loading()}>
        <Loading />
      </Show>
      
      <Show when={!loading()}>
        <Show when={shouldShowCreateTable()}>
          <div class="flex flex-col items-center justify-center h-full min-h-[500px] text-center p-8">
            <div class="mb-6">
              <svg class="w-16 h-16 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm2 2v2h2V6H5zm4 0v2h2V6H9zm4 0v2h2V6h-2zm4 0v2h2V6h-2zM5 10v2h2v-2H5zm4 0v2h2v-2H9zm4 0v2h2v-2h-2zm4 0v2h2v-2h-2zM5 14v2h2v-2H5zm4 0v2h2v-2H9zm4 0v2h2v-2h-2zm4 0v2h2v-2h-2z"></path>
              </svg>
              <h3 class="text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2">No Customized Tables Available</h3>
              <p class="text-gray-500 dark:text-gray-400 mb-6">Create your first customized table to start visualizing your data</p>
            </div>
            <button 
              onClick={() => {
                if (navigate) {
                  navigate('/table-builder');
                } else {
                  log('Table: Cannot navigate to table-builder in split view');
                }
              }}
              class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg transition-colors duration-200 shadow-md hover:shadow-lg"
            >
              Create Table
            </button>
          </div>
        </Show>

        <Show when={shouldShowNoData()}>
          <div class="flex flex-col items-center justify-center h-full min-h-[500px] text-center p-8">
            <div class="mb-6">
              <svg class="w-16 h-16 mx-auto text-gray-400 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path>
              </svg>
              <h3 class="text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2">No Data Available</h3>
              <p class="text-gray-500 dark:text-gray-400 mb-6">No data is available for this table at this time. Please check your filters or data source.</p>
            </div>
          </div>
        </Show>
        
        <Show when={hasData()}>
          <div class="h-full flex flex-col overflow-hidden">
          {/* Search Filter - Settings icon left, filter input right */}
          <div class="flex-shrink-0 mb-2 p-2">
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="explore-table-settings-btn flex-shrink-0 p-1.5 rounded hover:opacity-70 transition-opacity"
                onClick={() => {
                  if (navigate) {
                    navigate('/table-builder');
                  } else {
                    log('Table: Cannot navigate to table-builder in split view');
                  }
                }}
                title="Table settings"
                aria-label="Open table settings"
              >
                <FiSettings size={20} />
              </button>
              <div class="relative flex-1 min-w-0">
                <FiSearch class="absolute left-3 top-1/2 transform -translate-y-1/2 explore-table-search-icon" size={14} />
                <input
                  type="text"
                  placeholder="Search / filter table..."
                  class="w-full pl-9 pr-3 explore-table-filter-input"
                  value={searchQuery()}
                  onInput={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <span class="explore-table-data-type-label flex-shrink-0">
                Showing {filteredData().length} {(tableConfig()?.dataType || 'Phases').toUpperCase()}
              </span>
            </div>
            {searchQuery() && (
              <p class="mt-2 text-xs explore-table-filter-count">
                Showing {filteredData().length} of {tableData().length} rows
              </p>
            )}
          </div>

                  {/* Table - Scrollable */}
                  <div class="flex-1 min-h-0 mb-2 explore-table-scroll">
                    <div class="h-full overflow-auto">
                        <table class="data-table compact w-full text-left text-sm">
                <thead>
                  <tr>
                    <For each={getVisibleColumns(filteredData())}>
                      {(column) => {
                        const isConfigColumn = column.toLowerCase() === 'config' || column.toLowerCase() === 'configuration';
                        return (
                          <th 
                            class="cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700 select-none"
                            onClick={() => handleSort(column)}
                            style={isConfigColumn ? { "min-width": "150px" } : undefined}
                          >
                            {columnHeaders()[column.toLowerCase()] || column}{getSortIndicator(column)}
                          </th>
                        );
                      }}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  {renderedRows()}
                </tbody>
                </table>
              </div>
          </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
