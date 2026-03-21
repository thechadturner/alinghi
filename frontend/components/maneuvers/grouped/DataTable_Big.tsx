import { createSignal, createEffect, onMount } from "solid-js";
import * as d3 from "d3";

import { selectedGroupKeys, setSelectedGroupKeys, triggerUpdate, setTriggerSelection, isEventHidden } from "../../../store/selectionStore";
import { phase, color, tabledata, setTableData, eventType } from "../../../store/globalStore";

import { getManeuversConfig, getBigTableColumns } from "../../../utils/maneuversConfig";
import { buildColorGrouping, getGroupKeyFromItem } from "../../../utils/colorGrouping";
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

  // Create color scales for each categorical column type
  const getColorScaleForType = (colorType) => {
    const data = tabledata();
    if (data.length === 0) return null;
    try {
      const grouping = buildColorGrouping(data, colorType);
      return grouping.getItemColor;
    } catch (e) {
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
    // Hide race column unless we are grouped by race (Color By = RACE)
    const hideRace = color() !== 'RACE';
    const cols = hideRace ? columnConfig.columns.filter((c, i) => columnConfig.columns[i] !== 'RACE') : columnConfig.columns;
    const descs = hideRace ? columnConfig.descriptions.filter((_, i) => columnConfig.columns[i] !== 'RACE') : columnConfig.descriptions;
    const chans = hideRace ? columnConfig.channels.filter((_, i) => columnConfig.columns[i] !== 'RACE') : columnConfig.channels;
    setColumns(cols);
    setDescriptions(descs);
    setChannels(chans);

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

  const toggleGroupSelection = (rowGroupKey: string | number) => {
    setSelectedGroupKeys((prev) =>
      prev.includes(rowGroupKey)
        ? prev.filter((k) => k !== rowGroupKey)
        : [...prev, rowGroupKey]
    );
    setTriggerSelection(true);
  };

  const isGroupSelected = (row: any) => {
    const keys = selectedGroupKeys();
    const rowKey = getGroupKeyFromItem(row, color());
    return keys.includes(rowKey);
  };

  const sortData = (key: string) => {
    const currentSort = sortConfig();
    const direction = currentSort.key === key && currentSort.direction === 'asc' ? 'desc' : 'asc';

    setSortConfig({ key, direction });

    const getDt = (row: any) => row?.datetime ?? row?.Datetime ?? row?.DATETIME ?? row?.[key];
    const getNumeric = (row: any, k: string) => row[k] ?? row[k?.toLowerCase?.()] ?? row[k?.toUpperCase?.()] ?? (k?.toLowerCase?.() === 'time_two_boards' ? (row['Time_two_boards'] ?? row['TIME_TWO_BOARDS']) : undefined);
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

  createEffect(() => {
    if (triggerUpdate()) {
      renderRows();
    }
  });

  // Watch for selectedGroupKeys changes (from cross-window sync or map/timeseries) and update table
  createEffect(() => {
    selectedGroupKeys();
    
    // Re-render table when selection changes (handles cross-window sync)
    // Only update if component is ready (data loaded)
    if (tabledata().length > 0) {
      renderRows();
    }
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

  onMount(() => {
    // Fallback init for maneuver window: ensure columns/init run after store is committed (same pattern as Map/TimeSeries).
    requestAnimationFrame(() => {
      if (tabledata().length > 0) {
        initTable();
      }
    });
    // Allow selectionStore to sync from parent window, then force re-render for selection state
    setTimeout(() => {
      if (tabledata().length > 0) {
        renderRows();
      }
    }, 100);
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
        case 'TACK': out.tack = key; break;
      }
      averaged.push(out);
    });
    return averaged;
  };

  const renderRows = () => {
    initTable()
    // Exclude hidden events from grouping so group averages/counts use only visible events
    const visibleRows = tabledata().filter((row) => !isEventHidden(row.event_id));
    const rowsToRender = buildGroupedTable(visibleRows);

    return rowsToRender.map((row) => {
      const rowGroupKey = getGroupKeyFromItem(row, color());
      const isSelected = isGroupSelected(row);
      const isColoredBySource = color() === 'SOURCE';

      let rowColor = "white";
      if (isSelected) {
        rowColor = getColorForValue(rowGroupKey, color()) || "white";
      }

      return (
        <tr
          class={isSelected ? "row-selected" : ""}
          style={rowColor ? `background-color: ${rowColor} !important; color: ${isSelected ? "black !important" : "inherit"}` : undefined}
          onClick={() => toggleGroupSelection(rowGroupKey)}
        >
          {columns().map((column, colIndex) => {
            const channel = channels()[colIndex];
            let cellValue = "";
            let cellClass = "";

            switch (column) {
              case "DATETIME": {
                cellValue = row.datetimeLocal ?? "";
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
                  cellClass = cellValue === "S - P" ? "port" : "stbd";
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
              default: {
                // Resolve value with case-insensitive fallbacks (API may return time_two_boards etc.)
                const channelLower = channel?.toLowerCase?.();
                let raw = row[channel] ?? row[channelLower] ?? row[channel?.toUpperCase?.()];
                if ((raw === null || raw === undefined) && channelLower === 'time_two_boards') {
                  raw = row['Time_two_boards'] ?? row['TIME_TWO_BOARDS'];
                }
                if (raw === null || raw === undefined || raw === '' || isNaN(Number(raw))) {
                  cellValue = "";
                } else {
                  cellValue = (Math.round(Number(raw) * 10) / 10).toString();
                }
                break;
              }
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
                // Use same case-insensitive resolution so TWO BOARD TIME (Time_two_boards) gets a value
                const rawForScale = channel === "Datetime"
                  ? new Date(row[channel]).getTime()
                  : (row[channel] ?? row[channel?.toLowerCase?.()] ?? row[channel?.toUpperCase?.()] ?? (channel?.toLowerCase?.() === 'time_two_boards' ? (row['Time_two_boards'] ?? row['TIME_TWO_BOARDS']) : undefined));
                if (rawForScale != null && !isNaN(Number(rawForScale))) {
                  const scaleValue = scale(Number(rawForScale));
                  cellClass = `c${Math.round(scaleValue)}`;
                }
              }
            }

            // Get color for categorical columns (SOURCE, RACE, STATE, CONFIG)
            let cellStyle = {};
            if (column === 'SOURCE' || column === 'RACE' || column === 'STATE' || column === 'CONFIG') {
              const cellColor = getColorForValue(cellValue, column);
              if (cellColor) {
                cellStyle = { color: cellColor, fontWeight: 'bold' };
              }
            }

            return <td class={`centered ${cellClass}`} style={cellStyle}>{cellValue}</td>;
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
      <div class="flex justify-end mt-2">
        <button class="btn" onClick={clearFormatting}>
          Clear Formatting
        </button>
      </div>
    </>
  );
}
