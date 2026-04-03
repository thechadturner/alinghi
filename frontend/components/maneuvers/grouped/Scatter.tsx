import { createMemo, onMount } from "solid-js";
import ManeuverBoxPlot from "../../charts/ManeuverBoxPlot";
import ManeuverLegend from "../../legends/Maneuver";
import { tabledata, color, filtered, eventType } from "../../../store/globalStore";
import { selectedGroupKeys, isEventHidden, setTriggerUpdate } from "../../../store/selectionStore";
import { buildColorGrouping, legendTextToGroupKey, groupKeyEquals } from "../../../utils/colorGrouping";
import { groupBy } from "../../../utils/global";
import { sourcesStore } from "../../../store/sourcesStore";
import { TAKEOFF_CHANNELS } from "../../../utils/maneuversConfig";
import * as d3 from "d3";

/** Chart order for scatter view. List channel names in desired display order; channels not listed appear after. */
const charts_order: string[] = ['mmg','vmg_perc_avg','loss_total_tgt','loss_inv_tgt','loss_turn_tgt','loss_build_tgt','bsp_drop','bsp_min','bsp_min_delta','twa_drop_n','overshoot_perc','turn_angle_max','turn_rate_max','rud_ang_max','lwy_max','decel_slope','accel_slope','turn_radius','time_two_boards','time_dropping','time_raising','pop_time','drop_time','raise_time','heel_lock','rake_min_old_turn','rake_max_new_turn','rake_raise','aoa_raise','cant_drop_tgt'];

/** Chart order for TAKEOFF scatter (same columns as big table). */
const charts_order_takeoff: string[] = TAKEOFF_CHANNELS.map((c) => c.toLowerCase());

interface ScatterProps {
  context?: string;
  onLegendClick?: (legendItem: string) => void;
}

export default function Scatter(props: ScatterProps) {
  onMount(() => {
    requestAnimationFrame(() => {
      if (tabledata().length > 0) {
        setTriggerUpdate(true);
      }
    });
  });

  const channels = createMemo((): string[] => {
    const rows = tabledata();
    if (!rows || rows.length === 0) return [];
    const sample = rows[0];
    const isTakeoff = (eventType() || '').toUpperCase() === 'TAKEOFF';
    const orderToUse = isTakeoff ? charts_order_takeoff : charts_order;

    // Create exclude set with lowercase versions for case-insensitive matching
    // Exclude State and Config as they are color-by channels, not visualization channels
    const excludeLower = new Set(['datetime','event_id','tws_avg','tws_bin','twa_entry','tack','race_number','leg_number','event','year','source_name','config','state','time','sink_min','grade','tack_side','row_num','twd_delta']);
    
    // Normalize channel names to lowercase and deduplicate using a Set
    // This prevents duplicates from case variations like "Source_name" and "source_name"
    const seenLowercase = new Set<string>();
    const normalizedChannels: string[] = [];
    
    for (const key of Object.keys(sample)) {
      const keyLower = key.toLowerCase();
      // Skip if excluded (case-insensitive) or already seen
      if (excludeLower.has(keyLower) || seenLowercase.has(keyLower)) {
        // Mark as seen even if excluded, to prevent duplicates
        seenLowercase.add(keyLower);
        continue;
      }
      // Add to seen set and include in channels
      seenLowercase.add(keyLower);
      // Use the original case from the first occurrence
      normalizedChannels.push(key);
    }
    
    // When charts_order is set: only draw those channels, in that order. Otherwise draw all.
    if (orderToUse.length > 0) {
      const byLower = new Map(normalizedChannels.map(c => [c.toLowerCase(), c]));
      const ordered: string[] = [];
      for (const name of orderToUse) {
        const key = name.toLowerCase();
        // Use exact key from first row when present; otherwise use lowercase so chart can resolve via case-insensitive lookup
        const channelKey = byLower.get(key) ?? key;
        ordered.push(channelKey);
      }
      return ordered;
    }
    return normalizedChannels;
  });

  // Calculate VMG intervals (5 intervals from min to max) - same logic as ManeuverBoxPlot
  const calculateVmgIntervals = (rows: any[]): { min: number; max: number; intervalSize: number; getInterval: (vmg: number) => string | null } | null => {
    const vmgValues = rows
      .map(r => parseFloat(r.vmg_perc_avg))
      .filter(v => !isNaN(v) && v !== null && v !== undefined);
    
    if (vmgValues.length === 0) return null;
    
    const min = Math.min(...vmgValues);
    const max = Math.max(...vmgValues);
    
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
      getInterval: (vmg) => {
        if (vmg < min || vmg > max) return null;
        const intervalIndex = Math.min(4, Math.floor((vmg - min) / intervalSize));
        const intervalMin = min + (intervalIndex * intervalSize);
        const intervalMax = intervalIndex === 4 ? max : min + ((intervalIndex + 1) * intervalSize);
        return `${intervalMin.toFixed(1)}-${intervalMax.toFixed(1)}`;
      }
    };
  };

  // Get groups and color scale for legend - adapted from ManeuverScatter; highlight selected groups
  const getLegendGroups = createMemo(() => {
    const rows = tabledata().filter((r: any) => filtered().includes(r.event_id) && !isEventHidden(r.event_id));
    if (!rows || rows.length === 0) return { groups: [], colorScale: null };
    
    const currentColor = String(color() || 'TWS').toUpperCase();
    const keys = selectedGroupKeys();
    
    // Access sourcesStore to make memo reactive to source changes (for SOURCE coloring)
    if (currentColor === 'SOURCE') {
      sourcesStore.sources();
      sourcesStore.isReady();
    }
    
    const isGroupSelected = (groupName: string) =>
      keys.some((k) => groupKeyEquals(k, legendTextToGroupKey(groupName, currentColor)));
    
    let groups: Array<{ name: string; color: string; isHighlight?: boolean }> = [];
    let colorScale: any = null;
    
    if (currentColor === 'TWS') {
      const uniques = groupBy(rows, 'tws_bin');
      uniques.sort((a, b) => Number(a) - Number(b));
      // Fixed TWS bins: 10, 15, 20, 25, 30, 35, 40, 45, 50
      // Use scaleThreshold with 8 thresholds to create 9 color ranges (one for each bin)
      // @ts-ignore - D3 scaleThreshold accepts string ranges for color scales
      // @ts-ignore - D3 scaleThreshold accepts string ranges for color scales
      colorScale = d3.scaleThreshold().domain([12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5]).range(["blue","lightblue","cyan","lightgreen","yellow","orange","red","darkred","purple"] as any);
      groups = uniques.map(tws => ({
        name: String(tws),
        color: String(colorScale ? colorScale(Number(tws)) : 'grey'),
        isHighlight: isGroupSelected(String(tws))
      }));
    } else if (currentColor === 'VMG') {
      const vmgIntervals = calculateVmgIntervals(rows);
      if (vmgIntervals) {
        // Create 5 interval groups
        const intervalGroups: string[] = [];
        for (let i = 0; i < 5; i++) {
          const intervalMin = vmgIntervals.min + (i * vmgIntervals.intervalSize);
          const intervalMax = i === 4 ? vmgIntervals.max : vmgIntervals.min + ((i + 1) * vmgIntervals.intervalSize);
          intervalGroups.push(`${intervalMin.toFixed(1)}-${intervalMax.toFixed(1)}`);
        }
        // @ts-ignore - D3 scaleLinear accepts string ranges for color scales
        colorScale = d3.scaleLinear().domain([vmgIntervals.min, (vmgIntervals.min + vmgIntervals.max) / 2, vmgIntervals.max]).range(["blue","lightgrey","red"]);
        groups = intervalGroups.map(interval => {
          const intervalMin = parseFloat(interval.split('-')[0]);
          return {
            name: interval,
            color: String(colorScale(intervalMin)),
            isHighlight: isGroupSelected(interval)
          };
        });
      }
    } else if (currentColor === 'TACK') {
      const uniques = groupBy(rows, 'tack');
      groups = uniques.map(tack => ({
        name: String(tack),
        // S-P (starboard to port) = green, P-S (port to starboard) = red
        color: (tack === 'STBD' || tack === 'S - P') ? '#2ca02c' : '#d62728',
        isHighlight: isGroupSelected(String(tack))
      }));
    } else if (currentColor === 'RACE' || currentColor === 'SOURCE' || currentColor === 'STATE' || currentColor === 'CONFIG') {
      const { groups: colorGroups, scale, getItemColor } = buildColorGrouping(rows, currentColor);
      colorScale = scale;
      groups = colorGroups.map(group => {
        let itemColor = 'grey';
        if (getItemColor) {
          const dummyItem: any = {};
          if (currentColor === 'RACE') {
            dummyItem.race = group.key;
            dummyItem.Race_number = group.key;
          } else if (currentColor === 'SOURCE') {
            dummyItem.source_name = group.key;
          } else if (currentColor === 'STATE') {
            dummyItem.State = group.key;
            dummyItem.state = group.key;
            dummyItem.STATE = group.key;
          } else if (currentColor === 'CONFIG') {
            dummyItem.Config = group.key;
            dummyItem.config = group.key;
            dummyItem.CONFIG = group.key;
          }
          itemColor = getItemColor(dummyItem);
        }
        return {
          name: String(group.key),
          color: String(itemColor),
          isHighlight: isGroupSelected(String(group.key))
        };
      });
    }
    
    return { groups, colorScale };
  });

  return (
    <div style={{ "display": "flex", "flex-direction": "column", "width": "100%", "height": "100%" }}>
      <ManeuverLegend
        elementId="maneuver-legend-boxplot"
        target_info={{}}
        groups={getLegendGroups().groups}
        colorScale={getLegendGroups().colorScale}
        color={color() || 'TWS'}
        click={props.onLegendClick}
      />
      <ManeuverBoxPlot channels={channels()} />
    </div>
  );
}
