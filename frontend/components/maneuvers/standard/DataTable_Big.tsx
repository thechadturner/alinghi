import { createSignal, createEffect, onMount, onCleanup, createMemo } from "solid-js";
import * as d3 from "d3";

import { selectedEvents, setSelectedEvents, triggerUpdate, setTriggerSelection, setTriggerUpdate, setHasSelection, setSelection, isEventHidden, selectedRange } from "../../../store/selectionStore";
import { phase, color, tabledata, setTableData, eventType } from "../../../store/globalStore";

import { getIndexColor, putData, formatDateTime } from "../../../utils/global";
import { error as logError, debug, warn } from "../../../utils/console";
import { apiEndpoints } from "../../../config/env";
import { selectedGradesManeuvers, setSelectedGradesManeuvers } from "../../../store/filterStore";
import { user } from "../../../store/userStore";
import { getManeuversConfig, getBigTableColumns } from "../../../utils/maneuversConfig";
import { buildColorGrouping } from "../../../utils/colorGrouping";
import { persistantStore } from "../../../store/persistantStore";

export default function DataTable_Big(props) {
  // Get context from props, default to 'dataset' for backward compatibility
  const context = props?.context || 'dataset';
  const config = getManeuversConfig(context);
  const [columns, setColumns] = createSignal([]);
  const [descriptions, setDescriptions] = createSignal([]);
  const [channels, setChannels] = createSignal([]);
  const [sortConfig, setSortConfig] = createSignal({ key: null, direction: 'asc' });
  const [formattedColumns, setFormattedColumns] = createSignal([]);
  const [columnScales, setColumnScales] = createSignal({});

  // Memoize color scales for each categorical column type to ensure proper disposal
  // This prevents computations from being created outside reactive context
  const sourceColorScale = createMemo(() => {
    const data = tabledata();
    if (data.length === 0) return null;
    try {
      const grouping = buildColorGrouping(data, 'SOURCE');
      return grouping.getItemColor;
    } catch (e) {
      return null;
    }
  });

  const raceColorScale = createMemo(() => {
    const data = tabledata();
    if (data.length === 0) return null;
    try {
      const grouping = buildColorGrouping(data, 'RACE');
      return grouping.getItemColor;
    } catch (e) {
      return null;
    }
  });

  const stateColorScale = createMemo(() => {
    const data = tabledata();
    if (data.length === 0) return null;
    try {
      const grouping = buildColorGrouping(data, 'STATE');
      return grouping.getItemColor;
    } catch (e) {
      return null;
    }
  });

  const configColorScale = createMemo(() => {
    const data = tabledata();
    if (data.length === 0) return null;
    try {
      const grouping = buildColorGrouping(data, 'CONFIG');
      return grouping.getItemColor;
    } catch (e) {
      return null;
    }
  });

  const yearColorScale = createMemo(() => {
    const data = tabledata();
    if (data.length === 0) return null;
    try {
      const grouping = buildColorGrouping(data, 'YEAR');
      return grouping.getItemColor;
    } catch (e) {
      return null;
    }
  });

  const eventColorScale = createMemo(() => {
    const data = tabledata();
    if (data.length === 0) return null;
    try {
      const grouping = buildColorGrouping(data, 'EVENT');
      return grouping.getItemColor;
    } catch (e) {
      return null;
    }
  });

  // Helper function to get color scale for a specific column type
  const getColorScaleForType = (colorType) => {
    switch (colorType) {
      case 'SOURCE':
        return sourceColorScale();
      case 'RACE':
        return raceColorScale();
      case 'STATE':
        return stateColorScale();
      case 'CONFIG':
        return configColorScale();
      case 'YEAR':
        return yearColorScale();
      case 'EVENT':
        return eventColorScale();
      default:
        return null;
    }
  };

  // Helper function to get color for a value in a specific column
  const getColorForValue = (value, columnType) => {
    if (!value || !columnType) return null;
    
    const scale = getColorScaleForType(columnType);
    if (!scale) return null;
    
    // Create a dummy item to get the color
    let dummyItem = {};
    if (columnType === 'SOURCE') {
      dummyItem = { source_name: value };
    } else if (columnType === 'RACE') {
      dummyItem = { Race_number: value, race: value };
    } else if (columnType === 'STATE') {
      dummyItem = { State: value, state: value, STATE: value };
    } else if (columnType === 'CONFIG') {
      dummyItem = { Config: value, config: value, CONFIG: value };
    } else if (columnType === 'YEAR') {
      dummyItem = { Year: value, year: value, YEAR: value };
    } else if (columnType === 'EVENT') {
      dummyItem = { Event: value, event: value, EVENT: value };
    }
    
    try {
      return scale(dummyItem);
    } catch (e) {
      return null;
    }
  };

  const initTable = () => {
    // Use config to get big table columns based on context, color, and event type (e.g. TAKEOFF)
    const className = persistantStore.selectedClassName();
    const columnConfig = getBigTableColumns(context, color(), className, eventType());
    const cols = columnConfig.columns;
    const descs = columnConfig.descriptions;
    const chans = columnConfig.channels;
    setColumns(cols);
    setDescriptions(descs);
    setChannels(chans);

    // TAKEOFF, BEARAWAY, ROUNDUP: tack is Port/Stbd from entry/build TWA (set by report); do not overwrite with S-P/P-S
    const evt = (eventType() || '').toUpperCase();
    const usePortStbd = evt === 'TAKEOFF' || evt === 'BEARAWAY' || evt === 'ROUNDUP';
    if (usePortStbd) {
      tabledata().forEach((item: any) => {
        const twa = item.twa_entry ?? item.twa_build ?? item.Twa_start ?? 0;
        item.tack = Number(twa) > 0 ? 'STBD' : 'PORT';
      });
    } else if (phase() == 'FULL' || phase() == 'TURN') {
      tabledata().forEach((item) => {
        item.tack = item.twa_entry > 0 ? 'S - P' : 'P - S';
      });
    } else if (phase() == 'INVESTMENT') {
      tabledata().forEach((item) => {
        item.tack = item.twa_entry > 0 ? 'STBD' : 'PORT';
      });
    } else {
      tabledata().forEach((item) => {
        item.tack = item.twa_entry > 0 ? 'PORT' : 'STBD';
      });
    }
  }

  const toggleEventSelection = (id: number) => {
    let newLength = 0;
    
    setSelectedEvents((prev) => {
      const newArray = prev.includes(id)
        ? prev.filter((d) => d !== id)
        : [...prev, id];
      newLength = newArray.length;
      return newArray;
    });

    setTriggerSelection(true);
    // Keep hasSelection true when the other panel has a brush selection (e.g. map timeseries brushed in split view)
    const hasBrushRange = selectedRange() && selectedRange().length > 0;
    setHasSelection(newLength > 0 || !!hasBrushRange);
    if (newLength === 0 && !hasBrushRange) {
      setSelection([]);
    }
  };

  const isEventSelected = (id: number) => selectedEvents().includes(id);

  const sortData = (key: string) => {
    const currentSort = sortConfig();
    const direction = currentSort.key === key && currentSort.direction === 'asc' ? 'desc' : 'asc';

    setSortConfig({ key, direction });

    const getDt = (row: any) => row?.datetime ?? row?.Datetime ?? row?.DATETIME ?? row?.[key];
    const getNumeric = (row: any, k: string) => {
      const kl = k?.toLowerCase?.();
      let v = row[k] ?? row[kl] ?? row[k?.toUpperCase?.()];
      if (v != null) return v;
      if (kl === 'bsp_min_delta') return row['Bsp_min_delta'];
      if (kl === 'bsp_min') return row['Bsp_min'];
      if (kl === 'bsp_drop') return row['Bsp_drop'] ?? row['BSP_DROP'];
      if (kl === 'drop_time') return row['Drop_time'] ?? row['DROP_TIME'];
      if (kl === 'time_two_boards') return row['Time_two_boards'] ?? row['TIME_TWO_BOARDS'];
      return undefined;
    };
    if (key) {
      const values = tabledata().map((row) => (key === "Datetime" ? new Date(getDt(row)).getTime() : getNumeric(row, key)));
      const min = d3.min(values.filter((v): v is number => v != null && !isNaN(Number(v)))) ?? 0;
      const max = d3.max(values.filter((v): v is number => v != null && !isNaN(Number(v)))) ?? 0;
      const scale = d3.scaleLinear().domain([min, max]).range([0, 6]);

      setColumnScales((prev) => ({
        ...prev,
        [key]: JSON.stringify({ domain: [min, max], range: [0, 6] }),
      }));

      setFormattedColumns((prev) => (prev.includes(key) ? prev : [...prev, key]));
    }

    const sortedData = [...tabledata()].sort((a, b) => {
      const aValue = key === "Datetime" ? new Date(getDt(a)).getTime() : getNumeric(a, key);
      const bValue = key === "Datetime" ? new Date(getDt(b)).getTime() : getNumeric(b, key);
      return direction === 'asc' ? (Number(aValue) - Number(bValue)) : (Number(bValue) - Number(aValue));
    });

    setTableData(sortedData);
  };

  const clearFormatting = () => {
    setFormattedColumns([]); // Clear all formatted columns
    setColumnScales({}); // Clear all scales
  };

  // Expose clearFormatting function via prop callback if provided
  createEffect(() => {
    if (props.onClearFormattingReady) {
      props.onClearFormattingReady(clearFormatting);
    }
  });

  // Watch for triggerUpdate changes - the JSX will reactively re-render when signals change
  createEffect(() => {
    // Access triggerUpdate to track changes - this ensures reactivity
    triggerUpdate();
    // No need to call renderRows() here - it's already in the JSX template and will update reactively
  });

  // Watch for selectedEvents changes (from cross-window sync) - the JSX will reactively re-render
  createEffect(() => {
    // Access selectedEvents to trigger effect when it changes (for reactivity tracking)
    // This ensures the table updates when selection changes (handles cross-window sync)
    selectedEvents();
    // No need to call renderRows() here - it's already in the JSX template and will update reactively
  });

  // Re-initialize columns when event type, color, or phase changes (e.g. switch to TAKEOFF)
  createEffect(() => {
    eventType();
    color();
    phase();
    if (tabledata().length > 0) {
      initTable();
    }
  });

  // Function to perform the GRADE update (maneuver page TABLE view)
  const performGradeUpdate = async (gradeValue: number, selected: number[]): Promise<void> => {
    const { selectedClassName, selectedProjectId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();

    if (!className || !projectId) {
      logError('Cannot update GRADE: missing class_name or project_id');
      return;
    }

    const currentEventType = eventType();
    const eventTypes = currentEventType ? [currentEventType] : ['TACK', 'GYBE', 'BEARAWAY', 'ROUNDUP'];

    try {
      const response = await putData(`${apiEndpoints.admin.events}/tags`, {
        class_name: className,
        project_id: projectId,
        events: selected,
        event_types: eventTypes,
        key: 'GRADE',
        value: gradeValue
      });

      if (response.success) {
        debug(`Successfully updated GRADE to ${gradeValue} for ${selected.length} event(s)`);

        const currentGrades = selectedGradesManeuvers();
        const gradeValueStr = String(gradeValue);
        if (!currentGrades.includes(gradeValueStr)) {
          setSelectedGradesManeuvers([...currentGrades, gradeValueStr]);
          debug(`Added grade ${gradeValue} to selectedGrades filter`);
        }

        setSelectedEvents([]);
        setHasSelection(false);
        setSelection([]);
        setTriggerSelection(true);

        if (props.onDataUpdate && typeof props.onDataUpdate === 'function') {
          props.onDataUpdate();
        } else {
          setTriggerUpdate(true);
        }
      } else {
        logError('Failed to update GRADE:', response.message || 'Unknown error');
      }
    } catch (error: unknown) {
      logError('Error updating GRADE:', error);
    }
  };

  onMount(() => {
    // Fallback init for maneuver window: ensure columns/init run after store is committed (same pattern as Map/TimeSeries).
    requestAnimationFrame(() => {
      if (tabledata().length > 0) {
        initTable();
      }
    });

    const handleKeyPress = (event: KeyboardEvent) => {
      try {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }

        const selected = selectedEvents();
        if (!selected || selected.length === 0) return;

        const key = event.key;
        if (!['0', '1', '2', '3', '4', '5'].includes(key)) return;

        const currentUser = user();
        if (!currentUser) return;

        if (!currentUser.is_super_user) {
          const userPermissions = currentUser.permissions;
          let isReader = false;
          if (typeof userPermissions === 'string') {
            isReader = userPermissions === 'reader';
          } else if (typeof userPermissions === 'object' && userPermissions !== null) {
            const permissionValues = Object.values(userPermissions);
            isReader = permissionValues.length > 0 && permissionValues.every((p: string) => p === 'reader');
          }
          if (isReader) return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        const gradeValue = parseInt(key, 10);
        const message = `Are you sure you want to update GRADE to ${gradeValue} for ${selected.length} selected event(s)?\n\nThis action will modify the data and cannot be easily undone.`;
        const confirmed = window.confirm(message);
        if (!confirmed) return;

        setTimeout(() => {
          performGradeUpdate(gradeValue, selected).catch((err: unknown) => {
            logError('Error in performGradeUpdate:', err);
          });
        }, 0);
      } catch (err: unknown) {
        logError('Error in handleKeyPress:', err);
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeyPress);
    });
  });

  // Calculate VMG intervals (5 intervals from min to max)
  const calculateVmgIntervals = (rows) => {
    const vmgValues = rows
      .map(r => parseFloat(r.vmg_perc_avg))
      .filter(v => !isNaN(v) && v !== null && v !== undefined);
    
    if (vmgValues.length === 0) return null;
    
    const min = Math.min(...vmgValues);
    const max = Math.max(...vmgValues);
    
    // Handle edge case where all values are the same
    if (min === max) {
      return {
        min,
        max,
        intervalSize: 0,
        getInterval: () => `${min.toFixed(1)}-${max.toFixed(1)}`
      };
    }
    
    const intervalSize = (max - min) / 5;
    
    return {
      min,
      max,
      intervalSize,
      getInterval: (vmg: number) => {
        if (vmg < min || vmg > max) return null;
        const intervalIndex = Math.min(4, Math.floor((vmg - min) / intervalSize));
        const intervalMin = min + (intervalIndex * intervalSize);
        const intervalMax = intervalIndex === 4 ? max : min + ((intervalIndex + 1) * intervalSize);
        return `${intervalMin.toFixed(1)}-${intervalMax.toFixed(1)}`;
      }
    };
  };

  const groupKeyName = () => {
    switch (color()) {
      case 'TWS': return 'tws_bin';
      case 'VMG': return 'vmg_interval'; // Special handling for VMG intervals
      case 'TACK': return 'tack';
      case 'RACE': return 'Race_number';
      case 'SOURCE': return 'source_name';
      case 'STATE': return 'State';
      case 'CONFIG': return 'Config';
      case 'YEAR': return 'Year';
      case 'EVENT': return 'Event';
      default: return 'tws_bin';
    }
  };

  const buildGroupedTable = (rows) => {
    // For VMG, calculate intervals first
    let vmgIntervals = null;
    if (color() === 'VMG') {
      vmgIntervals = calculateVmgIntervals(rows);
      if (!vmgIntervals) return rows; // Fallback if no valid VMG data
    }

    const gkey = groupKeyName();
    const groups = new Map();
    (rows || []).forEach(r => {
      let k;
      if (color() === 'VMG' && vmgIntervals) {
        const vmg = parseFloat(r.vmg_perc_avg);
        k = vmgIntervals.getInterval(vmg);
        if (!k) return; // Skip invalid values
      } else {
        k = r[gkey];
      }
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    const isNumeric = (v) => typeof v === 'number' && !isNaN(v) && isFinite(v);
    const exclude = new Set(['event_id','Datetime','twa_entry']);
    const averaged = [];
    groups.forEach((items, key) => {
      const out = {};
      // Datetime: earliest (support lowercase datetime from API)
      const firstDt = items[0]?.datetime ?? items[0]?.Datetime ?? items[0]?.DATETIME;
      out.Datetime = items.reduce((minVal, r) => {
        const dt = r.datetime ?? r.Datetime ?? r.DATETIME;
        return dt != null && (minVal == null || new Date(dt) < new Date(minVal)) ? dt : minVal;
      }, firstDt);
      // carry grouping and categorical fields from first
      const first = items[0] || {};
      // Representative event_id so selection from grouped row matches map/timeseries (they use first-in-group as rep)
      out.event_id = first.event_id != null ? first.event_id : undefined;
      out.twa_entry = first.twa_entry;
      out.Race_number = first.Race_number;
      out.source_name = first.source_name;
      out.State = first.State ?? first.state ?? first.STATE;
      out.Config = first.Config ?? first.config ?? first.CONFIG;
      out.tws_avg = 0;
      // average numeric fields
      const sums = {};
      const counts = {};
      items.forEach(r => {
        Object.keys(r).forEach(k => {
          if (exclude.has(k)) return;
          if (isNumeric(r[k])) {
            sums[k] = (sums[k] || 0) + r[k];
            counts[k] = (counts[k] || 0) + 1;
          } else {
            // copy latest categorical
            out[k] = r[k];
          }
        });
      });
      Object.keys(sums).forEach(k => { out[k] = sums[k] / counts[k]; });
      const evt = (eventType() || '').toUpperCase();
      const usePortStbd = evt === 'TAKEOFF' || evt === 'BEARAWAY' || evt === 'ROUNDUP';
      if (usePortStbd) {
        const twa = first.twa_entry ?? first.twa_build ?? first.Twa_start ?? 0;
        out.tack = Number(twa) > 0 ? 'STBD' : 'PORT';
      } else if (phase() == 'FULL' || phase() == 'TURN') {
        out.tack = first.twa_entry > 0 ? 'S - P' : 'P - S';
      } else if (phase() == 'INVESTMENT') {
        out.tack = first.twa_entry > 0 ? 'STBD' : 'PORT';
      } else {
        out.tack = first.twa_entry > 0 ? 'PORT' : 'STBD';
      }
      // mirror grouping value to proper field names for display columns (categorical modes)
      switch (color()) {
        case 'RACE': 
          // Convert -1 to 'TRAINING' when grouping by RACE
          out.Race_number = (key === -1 || key === '-1' || String(key) === '-1') ? 'TRAINING' : key;
          break;
        case 'SOURCE': out.source_name = key; break;
        case 'STATE': out.State = key; break;
        case 'CONFIG': out.Config = key; break;
        case 'YEAR': out.Year = key; break;
        case 'EVENT': out.Event = key; break;
        case 'TACK': out.tack = key; break;
      }
      averaged.push(out);
    });
    return averaged;
  };

  const renderRows = () => {
    initTable()
    const rowsToRender = tabledata().filter((row) => !isEventHidden(row.event_id));

    return rowsToRender.map((row) => {
      const isSelected = isEventSelected(row.event_id);
      const selected = selectedEvents();
      const hasMoreThan8Selections = selected.length > 8;
      const isColoredBySource = color() === 'SOURCE';
      
      let rowColor = "white"; // Default to white
      
      if (isSelected) {
        if (isColoredBySource) {
          // When colored by SOURCE and selected: use source color for the row
          const sourceName = row.source_name || row.sourceName || row.source;
          rowColor = getColorForValue(sourceName, 'SOURCE') || "white";
        } else if (!hasMoreThan8Selections) {
          // When <= 8 selections and NOT colored by SOURCE: use selection-based colors
          rowColor = getIndexColor(selected, row.event_id);
        }
        // When > 8 selections and NOT colored by SOURCE: keep white (hasMoreThan8Selections)
      }
      // When not selected: keep white

      return (
        <tr
          class={isSelected ? "row-selected" : ""}
          style={rowColor ? `background-color: ${rowColor} !important; color: ${isSelected ? "white !important" : "inherit"}` : undefined}
          onClick={() => toggleEventSelection(row.event_id)}
        >
          {columns().map((column, colIndex) => {
            const channel = channels()[colIndex];
            let cellValue = "";
            let cellClass = "";

            switch (column) {
              case "DATETIME": {
                const rawDt = row.datetime ?? row.Datetime ?? row.DATETIME;
                cellValue = row.datetimeLocal ?? (rawDt ? (formatDateTime(rawDt) ?? "") : "");
                cellClass = "head";
                break;
              }
              case "TACK":
                cellValue = row['tack'];
                if (cellValue == 'PORT') {
                  cellClass = "port";
                } else if (cellValue == 'STBD') {
                  cellClass = "stbd";
                } else {
                  cellClass = cellValue === "P - S" ? "port" : "stbd";
                }
                break;
              case "RACE":
                const raceValue = row[channel] ?? row['Race_number'] ?? row['race_number'] ?? row['race'] ?? row['Race'] ?? '';
                // Convert -1 to 'TRAINING' for display
                if (raceValue === -1 || raceValue === '-1' || String(raceValue) === '-1') {
                  cellValue = 'TRAINING';
                } else {
                  cellValue = String(raceValue);
                }
                break;
              case "SOURCE":
                cellValue = row[channel];
                break;
              case "STATE":
                // Access the field value and convert to string
                cellValue = String(row[channel] ?? row['State'] ?? row['state'] ?? '');
                break;
              case "CONFIG":
                // Access the field value and convert to string
                cellValue = String(row[channel] ?? row['Config'] ?? row['config'] ?? '');
                break;
              case "YEAR":
                // Access the field value and convert to string
                cellValue = String(row[channel] ?? row['Year'] ?? row['year'] ?? '');
                break;
              case "EVENT":
                // Access the field value and convert to string
                cellValue = String(row[channel] ?? row['Event'] ?? row['event'] ?? '');
                break;
              default:
                // Try multiple field name variations to handle case mismatches
                // API returns lowercase aliases, but check original case too
                const channelLower = channel.toLowerCase();
                let rawValue = row[channel] ?? row[channelLower] ?? row[channel.toUpperCase()];
                
                // For bsp_drop, bsp_min, bsp_min_delta, drop_time, time_two_boards – try database column name variations (same as scatter)
                if (rawValue === null || rawValue === undefined) {
                  if (channelLower === 'bsp_drop') rawValue = row['Bsp_drop'] ?? row['BSP_DROP'];
                  else if (channelLower === 'bsp_min') rawValue = row['Bsp_min'];
                  else if (channelLower === 'bsp_min_delta') rawValue = row['Bsp_min_delta'];
                  else if (channelLower === 'drop_time') rawValue = row['Drop_time'] ?? row['DROP_TIME'];
                  else if (channelLower === 'time_two_boards') rawValue = row['Time_two_boards'] ?? row['TIME_TWO_BOARDS'];
                }
                
                // Debug logging for NaN values (remove after fixing)
                if ((rawValue === null || rawValue === undefined || isNaN(Number(rawValue))) && 
                    (channelLower === 'bsp_drop' || channelLower === 'drop_time')) {
                  warn(`NaN value for ${channel}:`, {
                    channel,
                    channelLower,
                    rowKeys: Object.keys(row),
                    rowValue: row[channel],
                    rowValueLower: row[channelLower],
                    rowBspDrop: row['Bsp_drop'],
                    rowDropTime: row['Drop_time']
                  });
                }
                
                if (rawValue === null || rawValue === undefined || rawValue === '' || isNaN(Number(rawValue))) {
                  cellValue = "";
                } else {
                  cellValue = (Math.round(Number(rawValue) * 10) / 10).toString();
                }
                break;
            }

            // Apply conditional formatting for all previously sorted columns
            if (channel !== "twa_entry" && channel !== "Datetime") {
              if (
                formattedColumns().includes(channel) &&
                columnScales()[channel]
              ) {
                const { domain, range } = JSON.parse(
                  columnScales()[channel]
                ); // Deserialize scale
                const scale = d3.scaleLinear().domain(domain).range(range); // Recreate D3 scale
                // Use same resolution as display (case-insensitive + Time_two_boards) so last column gets a value
                const channelLower = channel?.toLowerCase?.();
                const rawForScale = channel === "Datetime"
                  ? new Date(row[channel]).getTime()
                  : (row[channel] ?? row[channelLower] ?? row[channel?.toUpperCase?.()] ?? (channelLower === 'bsp_min_delta' ? row['Bsp_min_delta'] : channelLower === 'bsp_min' ? row['Bsp_min'] : channelLower === 'bsp_drop' ? (row['Bsp_drop'] ?? row['BSP_DROP']) : channelLower === 'drop_time' ? (row['Drop_time'] ?? row['DROP_TIME']) : channelLower === 'time_two_boards' ? (row['Time_two_boards'] ?? row['TIME_TWO_BOARDS']) : undefined));
                if (rawForScale != null && !isNaN(Number(rawForScale))) {
                  const scaleValue = scale(Number(rawForScale));
                  cellClass = `c${Math.round(scaleValue)}`;
                }
              }
            }

            // Get color for categorical columns (SOURCE, RACE, STATE, CONFIG, YEAR, EVENT)
            let cellStyle = {};
            if (column === 'SOURCE' || column === 'RACE' || column === 'STATE' || column === 'CONFIG' || column === 'YEAR' || column === 'EVENT') {
              const cellColor = getColorForValue(cellValue, column);
              if (cellColor) {
                cellStyle = { color: cellColor, fontWeight: 'bold' };
              }
            }

            // Check if this is DATETIME column and grade is 4, add golden star
            const grade = row.grade ?? row.Grade ?? row.GRADE;
            const isGrade4 = column === 'DATETIME' && grade !== undefined && grade !== null && Number(grade) === 4;
            const cellContent = isGrade4 ? (
              <>
                <span style={{ color: '#FFD700' }}>★</span>  {cellValue}
              </>
            ) : cellValue;

            return <td class={`centered ${cellClass}`} style={cellStyle}>{cellContent}</td>;
          })}
        </tr>
      );
    });
  };

  return (
    <>
      <div class="scrollable-container">
        {/* <h1 class="centered font-bold">Summary Table</h1> */}
        <table class="maneuvers-table">
          <thead>
            <tr>
              {columns().map((column, index) => (
                <th
                  title={descriptions()[index]}
                  onClick={() => sortData(channels()[index])}
                  style={{ cursor: 'pointer' }}
                >
                  {column} {sortConfig().key === channels()[index] ? (sortConfig().direction === 'asc' ? '▲' : '▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{renderRows()}</tbody>
        </table>
      </div>
      {!props.hideClearFormatting && (
        <div class="flex justify-end mt-2">
          <button class="btn" onClick={clearFormatting}>
            Clear Formatting
          </button>
        </div>
      )}
    </>
  );
}
