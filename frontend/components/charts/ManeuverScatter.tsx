import { createEffect, onCleanup, onMount, createSignal, Show } from "solid-js";
import * as d3 from "d3";
import { regressionLog, regressionLoess } from "d3-regression";

import { lasso } from "../../utils/d3-lasso";
import { putData } from "../../utils/global";
import { error as logError, debug } from "../../utils/console";
import { apiEndpoints } from "../../config/env";

// Static import for worker - Vite will bundle this correctly in production
import LassoSelectionWorker from "../../workers/lasso-selection-processor.ts?worker";

import { selectedEvents, setSelectedEvents, triggerUpdate, setTriggerUpdate, triggerSelection, setTriggerSelection, setHasSelection, setSelection, isEventHidden } from "../../store/selectionStore";
import { tooltip, setTooltip, filtered, color, tabledata } from "../../store/globalStore";
import { groupBy, myTickFormat, getIndexColor, formatDateTime } from "../../utils/global";
import { getColorByIndex } from "../../utils/colorScale";
import { buildColorGrouping } from "../../utils/colorGrouping";
import { user } from "../../store/userStore";
import { persistantStore } from "../../store/persistantStore";
import { selectedGradesManeuvers, setSelectedGradesManeuvers } from "../../store/filterStore";
import { getCurrentDatasetTimezone } from "../../store/datasetTimezoneStore";
import { getStrokeColor as getThemeStrokeColor, isDark } from "../../store/themeStore";
import Table from "./FitTable";
import infoIconUrl from "../../assets/info.svg";
import warningIconUrl from "../../assets/warning.svg";

// Y-axis display labels for TAKEOFF (exit -> pop naming)
const CHANNEL_DISPLAY_LABELS: Record<string, string> = {
  exit_time: "POP_TIME",
  bsp_exit: "BSP_POP",
  twa_exit: "TWA_POP",
};

function getChannelDisplayLabel(channel: string): string {
  const ch = String(channel || "").toLowerCase();
  return CHANNEL_DISPLAY_LABELS[ch] ?? String(channel || "").toUpperCase();
}

// Shared hover state across all ManeuverScatter instances
let hoveredEventId: number | null = null;
let isLassoActive = false;

// Helper to update all charts for hover effects (works across all instances)
// Optimized to only update visible charts
function updateAllChartsHover(hoverEventId: number | null) {
  hoveredEventId = hoverEventId;

  // Get current selection to maintain larger size for selected points
  const selected = selectedEvents();
  const hasSelection = selected.length > 0;

  // Helper to check if an element's container is visible
  const isElementVisible = (element: Element): boolean => {
    // Find the chart container (parent div with svg)
    let parent = element.parentElement;
    while (parent) {
      // Check if this is a chart container (has svg child)
      const svg = parent.querySelector('svg');
      if (svg) {
        // Check if container is in viewport
        const rect = parent.getBoundingClientRect();
        return rect.top < window.innerHeight && rect.bottom > 0;
      }
      parent = parent.parentElement;
    }
    return false;
  };

  // Update circles - only in visible charts
  d3.selectAll("circle.scatter")
    .filter(function () {
      return isElementVisible(this);
    })
    .transition()
    .duration(200)
    .attr("r", (d: any) => {
      if (!d || !d.event_id) return 5;

      const isSelected = hasSelection && selected.includes(d.event_id);
      const isHovered = hoverEventId && d.event_id === hoverEventId;

      // If hovered, use selected point size (8)
      if (isHovered) return 8;

      // Base size: larger if selected, normal if not
      return hasSelection ? (isSelected ? 8 : 4) : 5;
    });

  // Update rects - only in visible charts
  d3.selectAll("rect.scatter")
    .filter(function () {
      return isElementVisible(this);
    })
    .transition()
    .duration(200)
    .attr("width", (d: any) => {
      if (!d || !d.event_id) return 8.25;

      const isSelected = hasSelection && selected.includes(d.event_id);
      const isHovered = hoverEventId && d.event_id === hoverEventId;

      // If hovered, use selected point size (14)
      if (isHovered) return 14;

      // Base size: larger if selected, normal if not
      return hasSelection ? (isSelected ? 14 : 6) : 8.25;
    })
    .attr("height", (d: any) => {
      if (!d || !d.event_id) return 8.25;

      const isSelected = hasSelection && selected.includes(d.event_id);
      const isHovered = hoverEventId && d.event_id === hoverEventId;

      // If hovered, use selected point size (14)
      if (isHovered) return 14;

      // Base size: larger if selected, normal if not
      return hasSelection ? (isSelected ? 14 : 6) : 8.25;
    });
}

interface ManeuverScatterProps {
  channel: string;
  zoom?: boolean;
  /** When 'TAKEOFF', all points are shown as circles (no twa_entry split). Same data as big table. */
  eventType?: string;
  /** Info/warning message for bottom-right icon and tooltip (list-based from Scatter.tsx scatter_info). */
  infoType?: string;
  infoMessage?: string;
  [key: string]: any;
}

export default function ManeuverScatter(props: ManeuverScatterProps) {
  // props.channel required
  let containerRef: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  const ownerId = () => `maneuver-scatter-${String(props.channel || '')}`;

  // Zoom state management - use prop if provided, otherwise manage internally
  const isZoomed = () => props.zoom !== undefined ? props.zoom : false;
  const [fitData, setFitData] = createSignal<any[]>([]);
  const [fitDataVersion, setFitDataVersion] = createSignal(0);
  const [isComputingLassoSelection, setIsComputingLassoSelection] = createSignal(false);
  const [isVisible, setIsVisible] = createSignal(false);
  let intersectionObserver: IntersectionObserver | null = null;

  let xymargin = { top: 10, right: 10, bottom: 80, left: 0 }, // top/right/bottom align with Performance; left 0 (y-axis uses 50px in code)
    xywidth = 450 - xymargin.left - xymargin.right,
    xyheight = 500 - xymargin.top - xymargin.bottom;

  let isComputingSelection = false; // Flag to track worker computation
  let lassoWorker: Worker | null = null; // Worker for lasso selection computation
  let myColorScale: any = d3.scaleLinear();
  let getItemColor: ((item: any) => string) | null = null; // Store getItemColor function for SOURCE coloring
  let minVal = Number.MAX_VALUE;
  let maxVal = Number.MAX_VALUE;
  let xScale: d3.ScaleLinear<number, number, never> = d3.scaleLinear();
  let yScale: d3.ScaleLinear<number, number, never> = d3.scaleLinear();

  function isFiltered(id: number): boolean {
    return filtered().includes(id);
  }

  /** Resolve channel value from row – same key order as DataTable_Big (row[channel], lowercase, uppercase, then mixed-case DB names). */
  function getRawChannelValue(d: any, ch: string): unknown {
    const chLower = String(ch).toLowerCase();
    let val = d[ch] ?? d[chLower] ?? d[ch?.toUpperCase?.()];
    if (val !== undefined && val !== null) return val;
    // Same fallbacks as DataTable_Big for API/database column name variants
    if (chLower === 'bsp_min_delta') val = d['Bsp_min_delta'];
    else if (chLower === 'bsp_drop') val = d['Bsp_drop'] ?? d['BSP_DROP'];
    else if (chLower === 'bsp_min') val = d['Bsp_min'];
    else if (chLower === 'drop_time') val = d['Drop_time'] ?? d['DROP_TIME'];
    else if (chLower === 'time_two_boards') val = d['Time_two_boards'] ?? d['TIME_TWO_BOARDS'];
    if (val !== undefined && val !== null) return val;
    const key = Object.keys(d).find((k) => k.toLowerCase() === chLower);
    return key != null ? d[key] : undefined;
  }

  /** Case-insensitive channel value (big table / API may use different casing). For bsp_min_delta, compute from bsp_drop − bsp_min when stored value is missing. */
  function getChannelValueFromRow(d: any, ch: string): unknown {
    const chLower = String(ch).toLowerCase();
    let val = getRawChannelValue(d, ch);
    if ((val === undefined || val === null) && chLower === 'bsp_min_delta') {
      const bspDrop = getRawChannelValue(d, 'bsp_drop');
      const bspMin = getRawChannelValue(d, 'bsp_min');
      const drop = typeof bspDrop === 'number' ? bspDrop : Number(bspDrop);
      const min = typeof bspMin === 'number' ? bspMin : Number(bspMin);
      if (!Number.isNaN(drop) && !Number.isNaN(min)) return drop - min;
    }
    return val;
  }

  // Get groups based on current color setting
  function getGroups(data: any[]): Array<{ name: string; color: string }> {
    const currentColor = String(color() || '').toUpperCase();

    // Ensure color scale is updated
    updateColorScale(data);

    if (currentColor === 'TWS') {
      const uniques = groupBy(data, 'tws_bin');
      uniques.sort((a, b) => Number(a) - Number(b));
      return uniques.map(tws => ({
        name: String(tws),
        color: String(myColorScale(tws))
      }));
    } else if (currentColor === 'VMG') {
      // For VMG, create bins or use unique values
      const uniques = groupBy(data, 'vmg_perc_avg');
      uniques.sort((a, b) => Number(a) - Number(b));
      return uniques.map(vmg => ({
        name: String(vmg),
        color: String(myColorScale(vmg))
      }));
    } else if (currentColor === 'TACK') {
      const uniques = groupBy(data, 'tack');
      return uniques.map(tack => ({
        name: String(tack),
        color: (tack === 'STBD' || tack === 'S - P') ? '#2ca02c' : '#d62728' // Stbd = green, Port = red
      }));
    } else if (currentColor === 'RACE') {
      // Use buildColorGrouping for consistency
      const { groups, getItemColor: getItemColorFn } = buildColorGrouping(data, 'RACE');
      return groups.map(group => {
        const dummyItem = { race: group.key, Race_number: group.key };
        const color = getItemColorFn ? getItemColorFn(dummyItem) : 'grey';
        return {
          name: String(group.key),
          color: String(color)
        };
      });
    } else if (currentColor === 'SOURCE') {
      const uniques = groupBy(data, 'source_name');
      return uniques.map(sourceName => {
        const dummyItem = { source_name: sourceName };
        const color = getItemColor ? getItemColor(dummyItem) : 'grey';
        return {
          name: String(sourceName),
          color: String(color)
        };
      });
    } else if (currentColor === 'STATE') {
      const { groups: stateGroups, getItemColor: getItemColorFn } = buildColorGrouping(data, 'STATE');
      return stateGroups.map(group => {
        const dummyItem = { state: group.key, State: group.key, STATE: group.key };
        const itemColor = getItemColorFn ? getItemColorFn(dummyItem) : 'grey';
        return { name: String(group.key), color: String(itemColor) };
      });
    } else if (currentColor === 'CONFIG') {
      const { groups: configGroups, getItemColor: getItemColorFn } = buildColorGrouping(data, 'CONFIG');
      return configGroups.map(group => {
        const dummyItem = { config: group.key, Config: group.key, CONFIG: group.key };
        const itemColor = getItemColorFn ? getItemColorFn(dummyItem) : 'grey';
        return { name: String(group.key), color: String(itemColor) };
      });
    } else if (currentColor === 'YEAR') {
      const { groups: yearGroups, getItemColor: getItemColorFn } = buildColorGrouping(data, 'YEAR');
      return yearGroups.map(group => {
        const dummyItem = { year: group.key, Year: group.key, YEAR: group.key };
        const itemColor = getItemColorFn ? getItemColorFn(dummyItem) : 'grey';
        return { name: String(group.key), color: String(itemColor) };
      });
    } else if (currentColor === 'EVENT') {
      const { groups: eventGroups, getItemColor: getItemColorFn } = buildColorGrouping(data, 'EVENT');
      return eventGroups.map(group => {
        const dummyItem = { event: group.key, Event: group.key, EVENT: group.key, event_type: group.key };
        const itemColor = getItemColorFn ? getItemColorFn(dummyItem) : 'grey';
        return { name: String(group.key), color: String(itemColor) };
      });
    }
    return [];
  }

  // Compute fit data for regression lines
  function computeFitData(data: any[], groups: Array<{ name: string; color: string }>): any[] {
    const fitData: any[] = [];
    const currentSelection = selectedEvents();
    let dataForFit = data;
    const currentColor = String(color() || '').toUpperCase();

    // If there is a selection, restrict fits to selected points only
    if (currentSelection && currentSelection.length > 0) {
      const selectedIdSet = new Set(currentSelection);
      dataForFit = data.filter((d: any) => selectedIdSet.has(d.event_id));
    }

    // TWS / VMG: one fit for all data (single line)
    if (currentColor === 'TWS' || currentColor === 'VMG') {
      const channel = props.channel;
      const xyValues = dataForFit
        .map((d: any) => ({ x: +d.tws_avg, y: +Number(getChannelValueFromRow(d, channel)) }))
        .filter((d: any) => !isNaN(d.x) && !isNaN(d.y))
        .sort((a: any, b: any) => a.x - b.x);
      if (xyValues.length > 0) {
        let fitValues: Array<{ x: number; y: number }>;
        if (xyValues.length > 15) {
          const loess = regressionLoess().x((d: any) => d.x).y((d: any) => d.y).bandwidth(0.5);
          fitValues = loess(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
        } else {
          const log = regressionLog().x((d: any) => d.x).y((d: any) => d.y);
          fitValues = log(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
        }
        fitData.push({
          group: 'All',
          color: getColorByIndex(0), // selection blue (index 0)
          fitValues,
          rawPoints: xyValues,
          pointCount: xyValues.length,
        });
      }
      return fitData;
    }

    // Per-group fits for TACK, RACE, SOURCE, STATE, CONFIG, etc.
    groups.forEach((group: { name: string; color: string }) => {
      let groupData: any[];

      if (currentColor === 'TACK') {
        groupData = dataForFit.filter((d: any) => String(d.tack) === group.name);
      } else if (currentColor === 'RACE') {
        groupData = dataForFit.filter((d: any) => {
          const val = d.race_number ?? d.race ?? d.Race_number ?? d.RACE;
          return String(val) === group.name;
        });
      } else if (currentColor === 'SOURCE') {
        groupData = dataForFit.filter((d: any) => String(d.source_name || '') === group.name);
      } else if (currentColor === 'STATE') {
        groupData = dataForFit.filter((d: any) => String(d.state ?? d.State ?? d.STATE ?? '') === group.name);
      } else if (currentColor === 'CONFIG') {
        groupData = dataForFit.filter((d: any) => String(d.config ?? d.Config ?? d.CONFIG ?? '') === group.name);
      } else if (currentColor === 'YEAR') {
        groupData = dataForFit.filter((d: any) => String(d.year ?? d.Year ?? d.YEAR ?? '') === group.name);
      } else if (currentColor === 'EVENT') {
        groupData = dataForFit.filter((d: any) => String(d.event ?? d.Event ?? d.EVENT ?? d.event_type ?? '') === group.name);
      } else {
        groupData = [];
      }

      if (groupData.length > 0) {
        const channel = props.channel;
        const xyValues = groupData
          .map((d: any) => ({ x: +d.tws_avg, y: +Number(getChannelValueFromRow(d, channel)) }))
          .filter((d: any) => !isNaN(d.x) && !isNaN(d.y))
          .sort((a: any, b: any) => a.x - b.x);

        if (xyValues.length > 0) {
          let fitValues: Array<{ x: number; y: number }>;
          if (xyValues.length > 15) {
            const loess = regressionLoess().x((d: any) => d.x).y((d: any) => d.y).bandwidth(0.5);
            fitValues = loess(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
          } else {
            const log = regressionLog().x((d: any) => d.x).y((d: any) => d.y);
            fitValues = log(xyValues).map(([x, y]: [number, number]) => ({ x, y }));
          }

          fitData.push({
            group: group.name,
            color: group.color,
            fitValues,
            rawPoints: xyValues,
            pointCount: groupData.length,
          });
        }
      }
    });

    return fitData;
  }

  // Draw fit lines on the chart
  function drawFit() {
    if (!isZoomed()) return;

    try {
      const chartbody = d3.select(containerRef).select("svg").select("g");
      if (!chartbody.node()) return;

      // Clear existing fits
      chartbody.selectAll(".fit").remove();

      const data = tabledata().filter(d => isFiltered(d.event_id) && !isEventHidden(d.event_id));
      const groups = getGroups(data);
      const fitDataComputed = computeFitData(data, groups);

      // Draw the fits on the chart
      const lineGenerator = d3.line<{ x: number; y: number }>()
        .curve(d3.curveMonotoneX)
        .x((d: { x: number; y: number }) => xScale(d.x))
        .y((d: { x: number; y: number }) => yScale(d.y));

      fitDataComputed.forEach(({ color, fitValues }: { color: string; fitValues: Array<{ x: number; y: number }> }) => {
        chartbody.append("path")
          .datum(fitValues)
          .attr("d", lineGenerator)
          .attr("class", "fit")
          .style("stroke", color)
          .style("stroke-width", 2)
          .style("fill", "none");
      });

      // Update fitData state and version to trigger reactivity
      setFitDataVersion(v => v + 1);
      setFitData(fitDataComputed);
    } catch (err) {
      logError('Error drawing fits:', err);
    }
  }

  function updateColorScale(scatter_data: any[]): void {
    const currentColor = String(color() || '').toUpperCase();
    let channel = 'tws_bin';
    if (currentColor === 'VMG') channel = 'vmg_perc_avg';
    minVal = Number.MAX_VALUE;
    maxVal = Number.MIN_VALUE;
    scatter_data.forEach((d: any) => {
      try {
        const v = parseFloat(d[channel]);
        if (v > maxVal) maxVal = v;
        if (v < minVal) minVal = v;
      } catch { }
    });

    if (currentColor === 'TWS') {
      // Fixed TWS bins: 10, 15, 20, 25, 30, 35, 40, 45, 50
      // Use scaleThreshold with 8 thresholds to create 9 color ranges (one for each bin)
      // @ts-ignore - D3 scaleThreshold accepts string ranges for color scales
      myColorScale = d3.scaleThreshold().domain([12.5, 17.5, 22.5, 27.5, 32.5, 37.5, 42.5, 47.5]).range(["blue", "lightblue", "cyan", "lightgreen", "yellow", "orange", "red", "darkred", "purple"]);
    } else if (currentColor === 'VMG') {
      // @ts-ignore - D3 scaleLinear accepts string ranges for color scales
      myColorScale = d3.scaleLinear().domain([minVal, (minVal + maxVal) / 2, maxVal]).range(["blue", "lightgrey", "red"]);
    } else if (currentColor === 'TACK') {
      // @ts-ignore - D3 scaleThreshold accepts string ranges for color scales
      myColorScale = d3.scaleThreshold().domain([-180, -1, 1, 180]).range(["red", "red", "#64ed64", "#64ed64"]);
    } else if (currentColor === 'MAINSAIL') {
      // Use buildColorGrouping for consistency with DataTable and Map
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(scatter_data, 'MAINSAIL');
      myColorScale = scale as any;
      getItemColor = getItemColorFn; // Store the function for use in getPointColor
    } else if (currentColor === 'HEADSAIL') {
      // Use buildColorGrouping for consistency with DataTable and Map
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(scatter_data, 'HEADSAIL');
      myColorScale = scale as any;
      getItemColor = getItemColorFn; // Store the function for use in getPointColor
    } else if (currentColor === 'RACE') {
      // Use buildColorGrouping for consistency with DataTable and Map
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(scatter_data, 'RACE');
      myColorScale = scale as any;
      getItemColor = getItemColorFn; // Store the function for use in getPointColor
    } else if (currentColor === 'SOURCE') {
      // Use buildColorGrouping for SOURCE to get fleet colors
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(scatter_data, 'SOURCE');
      myColorScale = scale as any;
      getItemColor = getItemColorFn; // Store the function for use in getPointColor
    } else if (currentColor === 'STATE') {
      // Use buildColorGrouping for consistency with DataTable and Map
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(scatter_data, 'STATE');
      myColorScale = scale as any;
      getItemColor = getItemColorFn; // Store the function for use in getPointColor
    } else if (currentColor === 'CONFIG') {
      // Use buildColorGrouping for consistency with DataTable and Map
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(scatter_data, 'CONFIG');
      myColorScale = scale as any;
      getItemColor = getItemColorFn; // Store the function for use in getPointColor
    } else if (currentColor === 'YEAR') {
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(scatter_data, 'YEAR');
      myColorScale = scale as any;
      getItemColor = getItemColorFn;
    } else if (currentColor === 'EVENT') {
      const { scale, getItemColor: getItemColorFn } = buildColorGrouping(scatter_data, 'EVENT');
      myColorScale = scale as any;
      getItemColor = getItemColorFn;
    } else {
      // @ts-ignore - D3 scaleLinear accepts string ranges for color scales
      myColorScale = d3.scaleLinear().domain([4, 8, 14, 18, 22]).range(["yellow", "orange", "red"]);
    }
  }

  // Get the original color based on current color-by setting (without selection-based coloring)
  function getOriginalColor(d: any): string {
    const currentColor = String(color() || '').toUpperCase();
    if (currentColor === 'TWS') return String((myColorScale as any)(d.tws_bin) || 'grey');
    if (currentColor === 'VMG') return String((myColorScale as any)(d.vmg_perc_avg) || 'grey');
    if (currentColor === 'TACK') {
      // Circles = green (Stbd), squares = red (Port)
      if (d.tack === 'STBD' || d.tack === 'S - P') return '#2ca02c';
      if (d.tack === 'PORT' || d.tack === 'P - S') return '#d62728';
      return 'grey';
    }
    if (currentColor === 'MAINSAIL') {
      if (getItemColor) {
        return getItemColor(d) || 'grey';
      }
      return 'grey';
    }
    if (currentColor === 'HEADSAIL') {
      if (getItemColor) {
        return getItemColor(d) || 'grey';
      }
      return 'grey';
    }
    if (currentColor === 'RACE') {
      if (getItemColor) {
        return getItemColor(d) || 'grey';
      }
      return 'grey';
    }
    if (currentColor === 'SOURCE') {
      if (getItemColor) {
        return getItemColor(d) || 'grey';
      }
      return 'grey';
    }
    if (currentColor === 'STATE') {
      if (getItemColor) {
        return getItemColor(d) || 'grey';
      }
      return 'grey';
    }
    if (currentColor === 'CONFIG') {
      if (getItemColor) {
        return getItemColor(d) || 'grey';
      }
      return 'grey';
    }
    if (currentColor === 'YEAR') {
      if (getItemColor) {
        return getItemColor(d) || 'grey';
      }
      return 'grey';
    }
    if (currentColor === 'EVENT') {
      if (getItemColor) {
        return getItemColor(d) || 'grey';
      }
      return 'grey';
    }
    return 'grey';
  }

  function getPointColor(d: any): string {
    const selected = selectedEvents();
    const hasMoreThan8Selections = selected.length > 8;
    const isColoredBySource = String(color() || '').toUpperCase() === 'SOURCE';

    // When colored by SOURCE, always use original color (source name color)
    if (isColoredBySource) {
      return getOriginalColor(d);
    }

    // When > 8 selections, maintain original color for all points
    if (hasMoreThan8Selections) {
      return getOriginalColor(d);
    }

    // When <= 8 selections, use selection-based coloring for selected points
    if (selected.length > 0) {
      return getIndexColor(selected, d.event_id) || 'grey';
    }

    // No selections, use original color
    return getOriginalColor(d);
  }

  // Helper function to calculate tooltip position - uses container-relative positioning for absolute positioning
  function getTooltipPosition(event: MouseEvent) {
    try {
      if (!containerRef) return { x: 0, y: 0 };

      // Get container bounds for absolute positioning
      const containerRect = containerRef.getBoundingClientRect();

      // Convert mouse position to container-relative coordinates
      const mouseX = event.clientX - containerRect.left;
      const mouseY = event.clientY - containerRect.top;

      const pad = 12;
      const estWidth = 220;
      const estHeight = 140;
      const containerWidth = containerRect.width;
      const containerHeight = containerRect.height;

      // Calculate tooltip position relative to container
      // Position to the right of cursor by default, offset 60px to the left
      let x = mouseX + pad - 60;
      // If tooltip would go off right edge, position to the left of cursor with a gap
      if (x + estWidth > containerWidth) {
        // Position tooltip so its right edge is a pad distance from the cursor, offset 60px to the left
        x = Math.max(pad, mouseX - estWidth - pad - 60);
      }

      // Position above cursor by default (with small offset)
      let y = mouseY - estHeight - pad;

      // If tooltip would go off top of container, position below cursor
      if (y < pad) {
        y = mouseY + pad;
        // If still off bottom, position above cursor but within container
        if (y + estHeight > containerHeight) {
          y = Math.max(pad, containerHeight - estHeight - pad);
        }
      } else if (y + estHeight > containerHeight) {
        // If tooltip would go off bottom, position above cursor
        y = Math.max(pad, mouseY - estHeight - pad);
      }

      return { x, y };
    } catch (error) {
      logError('Error calculating tooltip position:', error);
      return { x: 0, y: 0 };
    }
  }

  function buildChart(forceUpdate: boolean = false) {
    try {
      // Skip rendering if chart is not visible (unless it's the initial render or forced update)
      // Force update is used for color changes that should update even if not visible
      // Check if chart is actually in viewport as a fallback (in case isVisible() hasn't updated yet)
      const hasSVG = containerRef && d3.select(containerRef).select("svg").node();
      if (!forceUpdate && !isVisible() && hasSVG && containerRef) {
        // Double-check if chart is actually visible in viewport (fallback check)
        const rect = containerRef.getBoundingClientRect();
        const isInViewport = rect.top < window.innerHeight && rect.bottom > 0;
        if (!isInViewport) {
          return; // Chart exists and is truly off-screen, skip update
        }
        // Chart is in viewport but isVisible() is false - allow drawing (timing issue)
      }

      const channel = props.channel;
      if (!channel) return;
      const getChannelVal = (d: any) => getChannelValueFromRow(d, channel);
      const dataAll = tabledata();
      const data = dataAll.filter(d => isFiltered(d.event_id) && !isEventHidden(d.event_id));
      updateColorScale(data);

      // Declare lasso instance variable so click handler can access it
      let lassoInstance: any = null;

      // Only remove prior SVG to preserve the tooltip overlay element
      d3.select(containerRef).selectAll("svg").remove();

      // Use container dimensions (same as Performance page AdvancedScatter) so chart fills wrapper.
      // Fallback matches Performance chart default: ~450×500 total, minus margins.
      const containerWidth = containerRef?.clientWidth ?? 450;
      const containerHeight = containerRef?.clientHeight ?? 500;
      xywidth = Math.max(100, containerWidth - xymargin.left - xymargin.right);
      xyheight = Math.max(100, containerHeight - xymargin.top - xymargin.bottom);

      const svg = d3.select(containerRef)
        .append("svg")
        .attr("width", xywidth + xymargin.left + xymargin.right)
        .attr("height", xyheight + xymargin.top + xymargin.bottom)
        .on("dblclick", () => {
          // If handleZoom prop is provided, use it (parent manages zoom)
          // Otherwise, toggle local zoom state
          if (props.handleZoom) {
            const channel = props.channel;
            if (isZoomed()) {
              props.handleZoom(null); // Exit zoom
            } else {
              props.handleZoom(channel); // Enter zoom with this channel
            }
          }
        });

      const chartbody = svg.append("g")
        .attr("transform", "translate(" + xymargin.left + "," + xymargin.top + ")");

      // Coerce to number (handles string numbers and unicode minus)
      const toNum = (v: unknown): number => {
        if (v == null) return NaN;
        if (typeof v === 'number' && !Number.isNaN(v)) return v;
        const n = Number(v);
        if (!Number.isNaN(n)) return n;
        return parseFloat(String(v).replace(/[\u2212\u2013]/g, '-')) ?? NaN;
      };

      let minX = Number.MAX_VALUE, maxX = Number.MIN_VALUE;
      let minY = Number.MAX_VALUE, maxY = Number.MIN_VALUE;
      data.forEach(d => {
        const xval = d.tws_avg ?? d.Tws_avg;
        if (xval != null && !Number.isNaN(Number(xval))) {
          if (xval >= maxX) maxX = xval;
          if (xval <= minX) minX = xval;
        }
        let yval = getChannelVal(d);
        if (yval == null && (channel?.toLowerCase() === 'bsp_min_delta')) {
          yval = getRawChannelValue(d, 'Bsp_min_delta') ?? getRawChannelValue(d, 'bsp_min_delta');
        }
        const ynum = toNum(yval);
        if (!Number.isNaN(ynum)) {
          minY = Math.min(minY, ynum);
          maxY = Math.max(maxY, ynum);
        }
      });
      if (minY === Number.MAX_VALUE || maxY === Number.MIN_VALUE) {
        // No valid y range: use sensible default for bsp_min_delta (typically negative)
        if (channel?.toLowerCase() === 'bsp_min_delta') {
          minY = -50;
          maxY = 0;
        } else {
          minY = 0;
          maxY = 1;
        }
      }
      if (minY < 0) minY *= 1.20; else minY *= 0.70;
      if (maxY < 0) maxY *= 0.70; else maxY *= 1.20;
      if (maxY === minY) { maxY = 10; minY = -10; }

      xScale = d3.scaleLinear().domain([minX * 0.95, maxX * 1.05]).range([0, xywidth - 50]);
      yScale = d3.scaleLinear().domain([minY * 0.95, maxY * 1.05]).range([xyheight, 0]);

      chartbody.append("g").attr("class", "axes")
        .attr("transform", "translate(50,0)")
        .call(d3.axisLeft(yScale).ticks(5).tickFormat((d: d3.NumberValue) => myTickFormat(Number(d))));
      chartbody.append("g").attr("class", "axes")
        .attr("transform", "translate(50," + xyheight + ")")
        .call(d3.axisBottom(xScale).ticks(5).tickFormat((d: d3.NumberValue) => myTickFormat(Number(d))));

      // Inner gridlines (match original maneuver scatter style)
      chartbody.append("g")
        .attr("class", "grid")
        .attr("transform", "translate(" + 50 + "," + xyheight + ")")
        .style("stroke-dasharray", ("3,3"))
        .call(d3.axisBottom(xScale)
          .ticks(5)
          .tickSize(-xyheight)
          .tickFormat(() => "")
        );

      chartbody.append("g")
        .attr("class", "grid")
        .attr("transform", "translate(" + 50 + ", 0)")
        .style("stroke-dasharray", ("3,3"))
        .call(d3.axisLeft(yScale)
          .ticks(5)
          .tickSize(-xywidth)
          .tickFormat(() => "")
        );

      // Axis labels
      const xTranslation = 50;
      chartbody.append("text")
        .attr("class", "y-label chart-element")
        .attr("text-anchor", "start")
        .attr("transform", `translate(${xTranslation + 25},10)`)
        .attr("font-size", "16px")
        .attr("user-select", "none")
        .attr("pointer-events", "none")
        .text(getChannelDisplayLabel(channel));

      chartbody.append("text")
        .attr("class", "x-label chart-element")
        .attr("text-anchor", "middle")
        .attr("transform", `translate(${xTranslation + (xywidth - xTranslation) / 2},${xyheight + 40})`)
        .attr("font-size", "16px")
        .attr("user-select", "none")
        .attr("pointer-events", "none")
        .text("TWS [KPH]");

      // Helper function to check if hover effects should be disabled
      // Optimized: only check flags, no DOM queries (which can cause stalls)
      const shouldDisableHover = () => {
        // Disable hover effects during lasso selection or computation
        // Note: We don't check for lasso path visibility here to avoid expensive DOM queries
        // The isLassoActive flag is set/unset by the lasso start/end events
        return isLassoActive || isComputingSelection;
      };

      // Tooltip throttling variables
      let tooltipUpdateFrame: number | null = null;
      let lastTooltipPointId: number | null = null;

      const mouseover = (event: MouseEvent, d: any) => {
        // Disable hover effects during lasso selection or computation
        if (shouldDisableHover()) return;

        // Update hover state and expand points across all charts
        updateAllChartsHover(d.event_id);

        // Light throttling: batch tooltip updates via requestAnimationFrame
        // Cancel any pending update
        if (tooltipUpdateFrame !== null) {
          cancelAnimationFrame(tooltipUpdateFrame);
        }

        // Skip if same point (deduplication)
        if (lastTooltipPointId === d.event_id) {
          return;
        }

        tooltipUpdateFrame = requestAnimationFrame(() => {
          const pos = getTooltipPosition(event);
          const yLabel = getChannelDisplayLabel(channel);
          const yVal = (() => { const v = getChannelVal(d); const n = Number(v); return isNaN(n) ? String(v) : (Math.round(n * 10) / 10); })();
          const xVal = (() => { const v = d.tws_avg; const n = Number(v); return isNaN(n) ? String(v) : (Math.round(n * 10) / 10); })();

          // Use same datetime field as table (DataTable_Big uses row.Datetime; API may return datetime)
          const rawDatetime = d.datetime ?? d.Datetime ?? d.DATETIME ?? d.date ?? d.Date;
          let dateString = "N/A";
          let timeString = "N/A";
          if (rawDatetime) {
            try {
              const timezone = getCurrentDatasetTimezone();
              const formatted = formatDateTime(rawDatetime, timezone);
              if (formatted) {
                const parts = formatted.split(" ");
                dateString = parts[0] ?? "N/A";
                timeString = parts[1] ?? "N/A";
              }
            } catch (_) {
              // Ignore date parsing errors
            }
          }

          const isFleet = d.source_name != null && String(d.source_name).trim() !== "";
          let tooltipRows = `
                <tr><td>DATE</td><td>${dateString}</td></tr>
                <tr><td>TIME</td><td>${timeString}</td></tr>`;
          if (isFleet) {
            tooltipRows += `
                <tr><td>SOURCE</td><td>${String(d.source_name)}</td></tr>`;
          }
          tooltipRows += `
                <tr><td>TWS [KPH]</td><td>${xVal}</td></tr>
                <tr><td>${yLabel}</td><td>${yVal}</td></tr>`;

          const html = `<table class='table-striped'>${tooltipRows}
              </table>`;
          setTooltip({ visible: true, content: html, x: pos.x, y: pos.y, ownerId: ownerId() } as any);

          lastTooltipPointId = d.event_id;
          tooltipUpdateFrame = null;
        });
      };
      const mouseout = () => {
        // Disable hover effects during lasso selection or computation
        if (shouldDisableHover()) return;

        // Cancel any pending tooltip update
        if (tooltipUpdateFrame !== null) {
          cancelAnimationFrame(tooltipUpdateFrame);
          tooltipUpdateFrame = null;
        }

        // Clear hover state and reset all points across all charts
        updateAllChartsHover(null);
        lastTooltipPointId = null;

        // Only hide if this chart owns the tooltip
        const t = tooltip();
        if ((t as any).ownerId === ownerId()) {
          setTooltip({ visible: false, content: "", x: 0, y: 0, ownerId: undefined } as any);
        }
      };

      const click = (event: MouseEvent, d: any) => {
        // Stop event propagation to prevent SVG click handler from interfering
        event.stopPropagation();
        event.preventDefault(); // Also prevent default to stop lasso drag from starting

        // If lasso is active and has 2+ points, it's a lasso selection - prevent click
        // If lasso has < 2 points or isn't active, it's just a click - allow it
        if (isLassoActive && lassoInstance) {
          const drawnCoords = lassoInstance.getDrawnCoords();
          if (drawnCoords && drawnCoords.length >= 2) {
            // Lasso selection in progress with 2+ points - don't allow click
            return;
          }
        }

        // Disable click selection during lasso selection or computation
        if (shouldDisableHover()) return;

        const id = d.event_id;
        setSelectedEvents(prev => {
          const current = new Set(prev);
          if (current.has(id)) current.delete(id); else current.add(id);
          return Array.from(current);
        });
        setTriggerSelection(true);
        setHasSelection(selectedEvents().length > 0);
        if (selectedEvents().length === 0) setSelection([]);
      };

      const xTrans = 50;
      const xsTrans = 45;

      // TAKEOFF/BEARAWAY/ROUNDUP: split by tack (Stbd = circles green, Port = squares red).
      // Tack/gybe: split by twa_entry (starboard = circles, port = rects).
      const isTakeoff = (props.eventType || '').toUpperCase() === 'TAKEOFF';
      const isPortStbdEvent = isTakeoff || (props.eventType || '').toUpperCase() === 'BEARAWAY' || (props.eventType || '').toUpperCase() === 'ROUNDUP';
      const data_stbd = isPortStbdEvent
        ? data.filter((d: any) => d.tack === 'STBD' || d.tack === 'S - P')
        : data.filter((d: any) => d.twa_entry > 0);
      const data_stbd_selected = data_stbd.filter(d => selectedEvents().includes(d.event_id));
      const data_stbd_nonSelected = data_stbd.filter(d => !selectedEvents().includes(d.event_id));
      // Render non-selected first, then selected on top
      const data_stbd_ordered = [...data_stbd_nonSelected, ...data_stbd_selected];

      chartbody.append("g")
        .selectAll("circle")
        .data(data_stbd_ordered)
        .enter()
        .append("circle")
        .attr("transform", `translate(${xTrans}, 0)`)
        .attr("class", "scatter")
        .style("stroke", getThemeStrokeColor())
        .style("cursor", "pointer")
        .style("fill", (d: any) => getPointColor(d))
        .style("opacity", (d: any) => {
          const selected = selectedEvents();
          const hasSelection = selected.length > 0;
          const hasMoreThan8Selections = selected.length > 8;

          if (!hasSelection) return 1;

          if (hasMoreThan8Selections) {
            // When > 8 selections: selected points opacity 1, unselected opacity 0.2
            return selected.includes(d.event_id) ? 1 : 0.2;
          } else {
            // When <= 8 selections: current behavior (selected opacity 1, unselected opacity 0.5)
            return selected.includes(d.event_id) ? 1 : 0.5;
          }
        })
        .attr("r", (d: any) => {
          const hasSelection = selectedEvents().length > 0;
          const isSelected = hasSelection && selectedEvents().includes(d.event_id);
          const isHovered = hoveredEventId === d.event_id;

          // If hovered, use selected point size (8)
          if (isHovered) return 8;

          // Base size: larger if selected, normal if not
          return hasSelection ? (isSelected ? 8 : 4) : 5;
        })
        .attr("cx", d => xScale(+(d.tws_avg ?? d.Tws_avg ?? NaN)))
        .attr("cy", d => {
          const y = toNum(getChannelVal(d));
          return Number.isNaN(y) ? xyheight : yScale(y);
        })
        .on("mouseover", mouseover)
        .on("mouseout", mouseout)
        .on("click", click)
        .transition()
        .duration(200)
        .attr("r", (d: any) => {
          const hasSelection = selectedEvents().length > 0;
          const isSelected = hasSelection && selectedEvents().includes(d.event_id);
          const isHovered = hoveredEventId === d.event_id;

          // If hovered, use selected point size (8)
          if (isHovered) return 8;

          // Base size: larger if selected, normal if not
          return hasSelection ? (isSelected ? 8 : 4) : 5;
        });

      const data_port = isPortStbdEvent
        ? data.filter((d: any) => d.tack === 'PORT' || d.tack === 'P - S')
        : data.filter((d: any) => d.twa_entry < 0);
      const data_port_selected = data_port.filter(d => selectedEvents().includes(d.event_id));
      const data_port_nonSelected = data_port.filter(d => !selectedEvents().includes(d.event_id));
      // Render non-selected first, then selected on top
      const data_port_ordered = [...data_port_nonSelected, ...data_port_selected];

      chartbody.append("g")
        .selectAll("rect")
        .data(data_port_ordered)
        .enter()
        .append("rect")
        .attr("transform", `translate(${xsTrans}, -4)`)
        .attr("class", "scatter")
        .style("stroke", getThemeStrokeColor())
        .style("fill", d => getPointColor(d))
        .style("opacity", d => {
          const selected = selectedEvents();
          const hasSelection = selected.length > 0;
          const hasMoreThan8Selections = selected.length > 8;

          if (!hasSelection) return 1;

          if (hasMoreThan8Selections) {
            // When > 8 selections: selected points opacity 1, unselected opacity 0.2
            return selected.includes(d.event_id) ? 1 : 0.2;
          } else {
            // When <= 8 selections: current behavior (selected opacity 1, unselected opacity 0.5)
            return selected.includes(d.event_id) ? 1 : 0.5;
          }
        })
        .attr("width", d => {
          const hasSelection = selectedEvents().length > 0;
          const isSelected = hasSelection && selectedEvents().includes(d.event_id);
          const isHovered = hoveredEventId === d.event_id;

          // If hovered, use selected point size (14)
          if (isHovered) return 14;

          // Base size: larger if selected, normal if not
          return hasSelection ? (isSelected ? 14 : 6) : 8.25;
        })
        .attr("height", d => {
          const hasSelection = selectedEvents().length > 0;
          const isSelected = hasSelection && selectedEvents().includes(d.event_id);
          const isHovered = hoveredEventId === d.event_id;

          // If hovered, use selected point size (14)
          if (isHovered) return 14;

          // Base size: larger if selected, normal if not
          return hasSelection ? (isSelected ? 14 : 6) : 8.25;
        })
        .attr("x", d => xScale(+(d.tws_avg ?? d.Tws_avg ?? NaN)))
        .attr("y", d => {
          const y = toNum(getChannelVal(d));
          return Number.isNaN(y) ? xyheight : yScale(y);
        })
        .on("mouseover", mouseover)
        .on("mouseout", mouseout)
        .on("click", click)
        .transition()
        .duration(200)
        .attr("width", (d: any) => {
          const hasSelection = selectedEvents().length > 0;
          const isSelected = hasSelection && selectedEvents().includes(d.event_id);
          const isHovered = hoveredEventId === d.event_id;

          // If hovered, use selected point size (14)
          if (isHovered) return 14;

          // Base size: larger if selected, normal if not
          return hasSelection ? (isSelected ? 14 : 6) : 8.25;
        })
        .attr("height", (d: any) => {
          const hasSelection = selectedEvents().length > 0;
          const isSelected = hasSelection && selectedEvents().includes(d.event_id);
          const isHovered = hoveredEventId === d.event_id;

          // If hovered, use selected point size (14)
          if (isHovered) return 14;

          // Base size: larger if selected, normal if not
          return hasSelection ? (isSelected ? 14 : 6) : 8.25;
        });

      // optional: lasso selection enable as in original
      try {
        const points = chartbody.selectAll(".scatter");
        const svg = d3.select(containerRef).select('svg');
        lassoInstance = lasso()
          .closePathSelect(true)
          // @ts-ignore
          .closePathDistance(75)
          .items(points)
          .targetArea(svg)
          .skipDragCalculations(true) // Skip expensive calculations during drag for smooth rendering
          .on('start', () => {
            // Set lasso active flag to disable hover effects
            isLassoActive = true;
            isComputingSelection = false;

            // Disable pointer events on scatter points to allow lasso drag to continue
            // This prevents points from intercepting mouse events during lasso drawing
            points.style('pointer-events', 'none');

            // Clear any existing hover state (tooltip and size highlighting)
            updateAllChartsHover(null);
            const t = tooltip();
            if ((t as any).ownerId === ownerId()) {
              setTooltip({ visible: false, content: "", x: 0, y: 0, ownerId: undefined } as any);
            }
          })
          .on('end', async () => {
            // Re-enable pointer events on scatter points
            points.style('pointer-events', null);

            // Clear lasso active flag to re-enable hover effects
            isLassoActive = false;

            // Get the drawn lasso coordinates
            const drawnCoords = lassoInstance.getDrawnCoords();

            // Need at least 3 points to form a polygon
            if (!drawnCoords || drawnCoords.length < 3) {
              return;
            }

            // Get all point data with their screen coordinates
            // Use getBoundingClientRect to ensure coordinates match lasso coordinates (clientX/clientY)
            // This ensures both lasso and points are in the same coordinate system (viewport coordinates)
            const pointData = points.data().map((d: any) => {
              // Find the DOM node for this point
              const node = points.nodes().find((n: any) => {
                const nodeData = d3.select(n).datum() as any;
                return nodeData && nodeData.event_id === d.event_id;
              });

              if (node) {
                const element = node as Element;
                const box = element.getBoundingClientRect();

                // Use center of the element's bounding box (matches how lasso stores coordinates)
                const screenX = box.left + box.width / 2;
                const screenY = box.top + box.height / 2;

                return {
                  id: String(d.event_id), // Convert to string for consistency
                  x: screenX,
                  y: screenY
                };
              }
              return null;
            }).filter((p: any) => p !== null);

            if (pointData.length === 0) {
              return;
            }

            // Use worker to compute selection
            isComputingSelection = true;
            setIsComputingLassoSelection(true);

            try {
              // Create worker if it doesn't exist
              if (!lassoWorker) {
                // Use ?worker import - Vite bundles this correctly in production
                lassoWorker = new LassoSelectionWorker();

                if (!lassoWorker) {
                  throw new Error('Failed to create lasso worker');
                }
              }

              const messageId = `lasso-selection-${Date.now()}-${Math.random()}`;

              const selectedIds = await new Promise<string[]>((resolve, reject) => {
                const timeout = setTimeout(() => {
                  if (lassoWorker) {
                    lassoWorker.removeEventListener('message', handleMessage);
                  }
                  reject(new Error('Lasso selection computation timeout'));
                }, 10000); // 10 second timeout

                const handleMessage = (event: MessageEvent) => {
                  if (event.data.id === messageId) {
                    clearTimeout(timeout);
                    if (lassoWorker) {
                      lassoWorker.removeEventListener('message', handleMessage);
                    }

                    if (event.data.type === 'success' && event.data.result) {
                      resolve(event.data.result.selectedIds);
                    } else {
                      reject(new Error(event.data.error || 'Unknown error in lasso selection'));
                    }
                  }
                };

                if (lassoWorker) {
                  lassoWorker.addEventListener('message', handleMessage);

                  lassoWorker.postMessage({
                    id: messageId,
                    type: 'COMPUTE_LASSO_SELECTION',
                    data: {
                      points: pointData,
                      polygon: drawnCoords
                    },
                    timestamp: Date.now()
                  });
                } else {
                  clearTimeout(timeout);
                  reject(new Error('Worker not available'));
                }
              });

              isComputingSelection = false;
              setIsComputingLassoSelection(false);

              // Only update if lasso actually selected points
              if (selectedIds.length > 0) {
                // Convert string IDs back to numbers for event_id
                const ids = selectedIds.map(id => Number(id)).filter(id => !isNaN(id));

                // Toggle selection for lassoed points (ManeuverScatter uses toggle behavior)
                setSelectedEvents(prev => {
                  const current = new Set(prev);
                  ids.forEach(id => {
                    if (current.has(id)) current.delete(id);
                    else current.add(id);
                  });
                  const newSelection = Array.from(current);
                  setHasSelection(newSelection.length > 0);
                  if (newSelection.length === 0) setSelection([]);
                  return newSelection;
                });
                setTriggerSelection(true);

                // Explicitly update visual styling after lasso selection
                // This ensures the points are highlighted immediately
                updateSelectionColors();
              }
            } catch (error: any) {
              isComputingSelection = false;
              setIsComputingLassoSelection(false);
              logError('Error computing lasso selection:', error);
              // Fallback: try to use hover selection if available
              const selectedPts = points.filter(function () { return d3.select(this).classed('selected'); }).data();
              const ids = selectedPts.map((d: any) => d.event_id);
              if (ids.length > 0) {
                setSelectedEvents(prev => {
                  const current = new Set(prev);
                  ids.forEach(id => { if (current.has(id)) current.delete(id); else current.add(id); });
                  return Array.from(current);
                });
                setTriggerSelection(true);
                setHasSelection(true);
              }
            }
          });
        svg.call(lassoInstance);

        // Add mousedown handler on scatter points to prevent lasso drag from starting
        // This allows clicks on points to work without triggering lasso
        const allScatterPoints = chartbody.selectAll(".scatter");
        allScatterPoints.on('mousedown', function (event: MouseEvent) {
          // Stop propagation to prevent lasso drag from starting
          event.stopPropagation();
        });
      } catch (e) {
        logError('Error setting up lasso:', e);
      }

      // Draw fits if zoomed
      if (isZoomed()) {
        drawFit();
      }

      // Update selection colors to sync with current selection state
      // This ensures the chart shows the correct selection when first built or when opened in a new window
      updateSelectionColors();
    } catch (err: any) {
      logError(err?.message || 'Error building chart');
    }
  }

  // Update colors function with theme-based stroke colors
  function updateColors(): void {
    if (!containerRef) return;
    const svg = d3.select(containerRef).select("svg");
    if (!svg.node()) return;

    const strokeColor = getThemeStrokeColor();

    svg.selectAll("circle.scatter")
      .transition()
      .duration(500)
      .style("stroke", strokeColor);

    svg.selectAll("rect.scatter")
      .transition()
      .duration(500)
      .style("stroke", strokeColor);
  }

  function updateSelectionColors() {
    try {
      const selected = selectedEvents();
      const hasSelection = selected.length > 0;
      const hasMoreThan8Selections = selected.length > 8;

      const scatterPoints = d3.select(containerRef).selectAll('.scatter');

      // Update opacity and stroke colors
      scatterPoints.each(function (d: any) {
        const element = d3.select(this);
        element.style('fill', getPointColor(d));
        element.style('stroke', getThemeStrokeColor());

        // Update opacity based on selection count
        if (!hasSelection) {
          element.style('opacity', 1);
        } else if (hasMoreThan8Selections) {
          // When > 8 selections: selected points opacity 1, unselected opacity 0.2
          element.style('opacity', selected.includes(d.event_id) ? 1 : 0.2);
        } else {
          // When <= 8 selections: current behavior (selected opacity 1, unselected opacity 0.5)
          element.style('opacity', selected.includes(d.event_id) ? 1 : 0.5);
        }
      });

      // Update sizes with transitions for smoother updates
      scatterPoints
        .filter("circle")
        .transition()
        .duration(200)
        .attr("r", (d: any) => {
          if (!d || !d.event_id) return 5;

          const isSelected = hasSelection && selected.includes(d.event_id);
          const isHovered = hoveredEventId === d.event_id;

          // If hovered, use selected point size (8)
          if (isHovered) return 8;

          // Base size: larger if selected, normal if not
          return hasSelection ? (isSelected ? 8 : 4) : 5;
        });

      scatterPoints
        .filter("rect")
        .transition()
        .duration(200)
        .attr("width", (d: any) => {
          if (!d || !d.event_id) return 8.25;

          const isSelected = hasSelection && selected.includes(d.event_id);
          const isHovered = hoveredEventId === d.event_id;

          // If hovered, use selected point size (14)
          if (isHovered) return 14;

          // Base size: larger if selected, normal if not
          return hasSelection ? (isSelected ? 14 : 6) : 8.25;
        })
        .attr("height", (d: any) => {
          if (!d || !d.event_id) return 8.25;

          const isSelected = hasSelection && selected.includes(d.event_id);
          const isHovered = hoveredEventId === d.event_id;

          // If hovered, use selected point size (14)
          if (isHovered) return 14;

          // Base size: larger if selected, normal if not
          return hasSelection ? (isSelected ? 14 : 6) : 8.25;
        });

      setTriggerSelection(false);
    } catch { }
  }

  // Flag to prevent filter effect during data updates
  let isUpdatingData = false;

  // Function to perform the GRADE update
  const performGradeUpdate = async (gradeValue: number, selected: number[]): Promise<void> => {
    // Get required values from persistent store
    const { selectedClassName, selectedProjectId, selectedDatasetId, selectedSourceId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const datasetId = selectedDatasetId();
    const sourceId = selectedSourceId();

    if (!className || !projectId) {
      logError('Cannot update GRADE: missing class_name or project_id');
      return;
    }

    try {
      // Use maneuver event types
      const eventTypes = ['TACK', 'GYBE', 'BEARAWAY', 'ROUNDUP'];

      // Call admin API to update GRADE for selected events
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

        // Grade update in HuniDB will be implemented when available
        // Currently grade updates are handled on next data fetch

        // Update grade filter to include the newly graded value
        const currentGrades = selectedGradesManeuvers();
        const gradeValueStr = String(gradeValue);
        if (!currentGrades.includes(gradeValueStr)) {
          setSelectedGradesManeuvers([...currentGrades, gradeValueStr]);
          debug(`Added grade ${gradeValue} to selectedGrades filter`);
        }

        // Clear selected events after successful grade update
        setSelectedEvents([]);
        setHasSelection(false);
        setSelection([]);
        setTriggerSelection(true);

        // Trigger parent component to refetch data with filters applied
        // Set flag to prevent filter effect from triggering during update
        isUpdatingData = true;
        try {
          if (props.onDataUpdate && typeof props.onDataUpdate === 'function') {
            props.onDataUpdate();
          } else {
            // Fallback: trigger update
            setTriggerUpdate(true);
          }
        } finally {
          // Reset flag after a short delay to allow data to settle
          setTimeout(() => {
            isUpdatingData = false;
          }, 500);
        }
      } else {
        logError('Failed to update GRADE:', response.message || 'Unknown error');
      }
    } catch (error: any) {
      logError('Error updating GRADE:', error);
    }
  };

  onMount(() => {
    // Set up Intersection Observer for lazy rendering
    if (containerRef) {
      intersectionObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach(entry => {
            setIsVisible(entry.isIntersecting);
            // If chart becomes visible and hasn't been drawn yet, draw it
            if (entry.isIntersecting && !d3.select(containerRef).select("svg").node()) {
              buildChart();
            }
          });
        },
        {
          // Buffer: 500px top (preload before visible) and 500px bottom (keep loaded after leaving viewport)
          // This ensures charts are populated before scrolling into view and stay populated while still visible
          rootMargin: '500px 0px 500px 0px',
          threshold: 0.01
        }
      );
      intersectionObserver.observe(containerRef);

      // Check initial visibility - if already visible, draw immediately
      setTimeout(() => {
        if (isVisible() && !d3.select(containerRef).select("svg").node()) {
          buildChart();
        }
      }, 0);
    } else {
      // If containerRef not ready, draw immediately (fallback)
      buildChart();
    }

    resizeObserver = new ResizeObserver(() => {
      // Skip resize if not visible
      if (!isVisible()) return;
      buildChart();
    });
    if (containerRef) resizeObserver.observe(containerRef);

    // Add window resize listener
    let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      // Skip resize if not visible
      if (!isVisible()) return;

      // Debounce resize events to avoid excessive redraws
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        buildChart();
      }, 150);
    };

    window.addEventListener('resize', handleResize);

    // Add keyboard listener for GRADE updates (0-5 keys)
    const handleKeyPress = (event: KeyboardEvent) => {
      try {
        // Don't trigger if user is typing in an input field or textarea
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        // Only handle when this chart is visible (so one visible ManeuverScatter handles; others don't steal the key)
        if (!isVisible()) return;

        const selected = selectedEvents();
        const key = event.key;

        // Handle GRADE update hotkeys (0-5) when events ARE selected
        if (selected && selected.length > 0 && ['0', '1', '2', '3', '4', '5'].includes(key)) {
          // Check if user is NOT a reader (readers cannot grade)
          const currentUser = user();
          if (!currentUser) {
            return;
          }

          // Superusers can always grade
          if (currentUser.is_super_user) {
            // Allow grading
          } else {
            // Check if user is a reader - readers cannot grade
            const userPermissions = currentUser.permissions;
            let isReader = false;

            if (typeof userPermissions === 'string') {
              isReader = userPermissions === 'reader';
            } else if (typeof userPermissions === 'object' && userPermissions !== null) {
              const permissionValues = Object.values(userPermissions);
              // User is a reader if ALL their permissions are 'reader'
              isReader = permissionValues.length > 0 && permissionValues.every(p => p === 'reader');
            }

            if (isReader) {
              return; // Readers cannot grade
            }
          }

          // Prevent default behavior and stop propagation
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();

          // Get the grade value from the key
          const gradeValue = parseInt(key, 10);

          // Show confirmation dialog before proceeding
          const message = `Are you sure you want to update GRADE to ${gradeValue} for ${selected.length} selected event(s)?\n\nThis action will modify the data and cannot be easily undone.`;

          // Use window.confirm - it automatically closes when user clicks OK or Cancel
          const confirmed = window.confirm(message);
          if (!confirmed) {
            // User cancelled - dialog is already closed
            return;
          }

          // User confirmed - proceed with the update
          // Call asynchronously to avoid blocking the keydown handler
          // Use setTimeout to ensure the handler completes before starting the async operation
          setTimeout(() => {
            performGradeUpdate(gradeValue, selected).catch(error => {
              logError('Error in performGradeUpdate:', error);
            });
          }, 0);
          return;
        }
      } catch (error: any) {
        logError('Error in handleKeyPress:', error);
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', handleKeyPress);

    // Cleanup function
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('keydown', handleKeyPress);
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
    };
  });

  onCleanup(() => {
    // Cleanup Intersection Observer
    if (intersectionObserver && containerRef) {
      intersectionObserver.unobserve(containerRef);
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }

    // Cleanup worker
    if (lassoWorker) {
      lassoWorker.terminate();
      lassoWorker = null;
    }
    if (resizeObserver && containerRef) { resizeObserver.unobserve(containerRef); resizeObserver.disconnect(); }
    window.removeEventListener('resize', buildChart);
    isLassoActive = false;
    isComputingSelection = false;
    setIsComputingLassoSelection(false);
  });

  createEffect(() => {
    if (!isVisible() || isUpdatingData) return;
    if (!triggerUpdate()) return;
    setTriggerUpdate(false);
    queueMicrotask(() => {
      if (!isVisible() || isUpdatingData) return;
      buildChart();
    });
  });
  createEffect(() => {
    // Skip if not visible
    if (!isVisible()) return;

    if (triggerSelection()) updateSelectionColors();
  });

  // Watch for color changes (from cross-window sync or direct changes) and rebuild chart
  createEffect(() => {
    // Access color() to trigger effect when it changes
    const _currentColor = color();

    debug(`[ManeuverScatter] Color changed to: ${_currentColor}`, {
      isVisible: isVisible(),
      hasData: tabledata().length > 0,
      hasContainer: !!containerRef,
      channel: props.channel
    });

    // Rebuild chart when color changes (handles cross-window sync)
    // Only rebuild if component is ready (data loaded)
    // Force update even if not visible - color changes should update even if scrolled out of view
    if (tabledata().length > 0 && containerRef) {
      debug(`[ManeuverScatter] Rebuilding chart due to color change: ${_currentColor}`);
      buildChart(true); // Force update even if not visible
    } else {
      debug(`[ManeuverScatter] Skipping rebuild - data: ${tabledata().length}, container: ${!!containerRef}`);
    }
  });

  // Watch for selectedEvents changes (from cross-window sync or direct changes) and update selection
  createEffect(() => {
    // Skip if not visible
    if (!isVisible()) return;

    // Access selectedEvents to trigger effect when it changes
    const _currentSelectedEvents = selectedEvents();

    // Update selection colors when selectedEvents changes (handles cross-window sync and clearing)
    // Only update if component is ready (data loaded)
    if (tabledata().length > 0 && containerRef) {
      updateSelectionColors();
      // Also update hover state to refresh sizes across all chart instances
      // This ensures selected points maintain larger size in all charts
      updateAllChartsHover(hoveredEventId);
      // Redraw fits if zoomed
      if (isZoomed()) {
        drawFit();
      }
    }
  });

  // Update point sizes when chart becomes visible (when scrolling)
  // Also ensures selection colors are synced when component becomes visible (e.g., when ManeuverWindow opens)
  createEffect(() => {
    if (isVisible() && containerRef && tabledata().length > 0) {
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        if (!containerRef) return;
        const chartExists = d3.select(containerRef).select("svg").node();
        if (chartExists) {
          // Update selection colors to sync with current selection state from selectionStore
          // This is important when opening ManeuverWindow - it ensures the scatter plot
          // shows the same selection as the main Maneuvers page
          updateSelectionColors();
        }
      });
    }
  });

  // Watch for zoom prop changes
  createEffect(() => {
    // Skip if not visible
    if (!isVisible()) return;

    const currentZoom = props.zoom;
    if (currentZoom && tabledata().length > 0 && containerRef) {
      drawFit();
    }
  });

  // Watch for color changes when zoomed
  createEffect(() => {
    // Skip if not visible
    if (!isVisible()) return;

    const _currentColor = color();
    if (isZoomed() && tabledata().length > 0 && containerRef) {
      drawFit();
    }
  });

  // Theme change effect - update stroke colors when theme changes
  createEffect(() => {
    // Skip if not visible
    if (!isVisible()) return;

    // Access getThemeStrokeColor to trigger effect when theme changes
    const _strokeColor = getThemeStrokeColor();

    // Update stroke colors when theme changes - use updateColors to ensure consistency
    if (tabledata().length > 0 && containerRef) {
      updateColors();
    }
  });

  // Info/warning icon and tooltip (same pattern as AdvancedScatter; messages from scatter_info in Scatter.tsx)
  const infoType = () => props.infoType ?? "";
  const infoMessage = () => (props.infoMessage ?? "").trim();
  const showInfoIcon = () => infoType() === "info" && infoMessage().length > 0;
  const showWarningIcon = () => infoType() === "warning" && infoMessage().length > 0;
  const showInfoOrWarning = () => showInfoIcon() || showWarningIcon();

  const INFO_TOOLTIP_OFFSET = 15;
  const INFO_TOOLTIP_MAX_WIDTH = 280;
  const INFO_TOOLTIP_SHIFT_LEFT = INFO_TOOLTIP_MAX_WIDTH / 2;

  const getInfoTooltipPosition = (e: MouseEvent) => {
    try {
      if (!containerRef) {
        const x = e.clientX + INFO_TOOLTIP_OFFSET;
        const y = e.clientY + INFO_TOOLTIP_OFFSET;
        const shiftLeft = x + INFO_TOOLTIP_MAX_WIDTH > window.innerWidth;
        return {
          x: shiftLeft ? e.clientX - INFO_TOOLTIP_SHIFT_LEFT - INFO_TOOLTIP_OFFSET : x,
          y,
        };
      }
      const rect = containerRef.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      const relY = e.clientY - rect.top;
      const xDefault = relX + INFO_TOOLTIP_OFFSET;
      const rightEdge = rect.width;
      const shiftLeft = xDefault + INFO_TOOLTIP_MAX_WIDTH > rightEdge;
      const x = shiftLeft ? relX - INFO_TOOLTIP_SHIFT_LEFT - INFO_TOOLTIP_OFFSET : xDefault;
      return { x, y: relY + INFO_TOOLTIP_OFFSET };
    } catch {
      return { x: e.clientX + INFO_TOOLTIP_OFFSET, y: e.clientY + INFO_TOOLTIP_OFFSET };
    }
  };

  const onInfoIconMouseEnter = (e: MouseEvent) => {
    const msg = infoMessage();
    if (msg.length === 0) return;
    const position = getInfoTooltipPosition(e);
    const escaped = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    setTooltip({
      visible: true,
      content: `<span class="advanced-scatter-info-tooltip">${escaped}</span>`,
      x: position.x,
      y: position.y,
      ownerId: ownerId(),
    } as any);
  };
  const onInfoIconMouseMove = (e: MouseEvent) => {
    if (infoMessage().length === 0) return;
    const position = getInfoTooltipPosition(e);
    setTooltip((prev) => (prev.visible ? { ...prev, x: position.x, y: position.y, ownerId: ownerId() } as any : prev));
  };
  const onInfoIconMouseLeave = () => {
    setTooltip({ visible: false, content: "", x: 0, y: 0, ownerId: undefined } as any);
  };

  return (
    <div style={{ width: "100%", height: "100%", display: "flex", position: "relative" }}>
      <div
        class="maneuver-scatter-chart-container"
        ref={el => containerRef = el}
        style={{
          width: isZoomed() ? "66%" : "100%",
          height: isZoomed() ? "95%" : "100%",
          padding: "0 8px 8px 0",
          position: "relative",
          float: "left"
        }}
      >
        <div id="tt" class="tooltip" style={{
          opacity: (tooltip().visible && (tooltip() as any).ownerId === ownerId()) ? 1 : 0,
          left: `${tooltip().x}px`,
          top: `${tooltip().y}px`,
          position: "absolute",
          'pointer-events': 'none'
        }} innerHTML={tooltip().content}>
        </div>
        <Show when={isComputingLassoSelection()}>
          <div style={{
            position: "absolute",
            top: "10px",
            left: "50%",
            transform: "translateX(-50%)",
            background: "rgba(0, 0, 0, 0.7)",
            color: "white",
            padding: "8px 16px",
            "border-radius": "4px",
            "font-size": "14px",
            "z-index": 1000,
            "pointer-events": "none"
          }}>
            Computing selection...
          </div>
        </Show>
      </div>
      <Show when={showInfoOrWarning()}>
        <div
          class="advanced-scatter-info-icon-wrap"
          role="img"
          aria-label={infoType() === "warning" ? "Warning" : "Info"}
          onMouseEnter={onInfoIconMouseEnter}
          onMouseMove={onInfoIconMouseMove}
          onMouseLeave={onInfoIconMouseLeave}
        >
          <Show when={showInfoIcon()}>
            <img
              src={infoIconUrl}
              alt="Info"
              class="advanced-scatter-info-icon"
              classList={{ "advanced-scatter-info-icon-dark": isDark() }}
            />
          </Show>
          <Show when={showWarningIcon()}>
            <img
              src={warningIconUrl}
              alt="Warning"
              class="advanced-scatter-info-icon"
            />
          </Show>
        </div>
      </Show>
      <Show when={isZoomed() && fitData().length > 0}>
        <div
          style={{
            width: "33%",
            height: "95%",
            float: "left",
            "margin-top": "100px",
            "padding-left": "30px",
          }}
        >
          <Table
            xaxis="tws"
            fitData={fitData()}
            version={fitDataVersion()}
          />
        </div>
      </Show>
      <div style={{ clear: "both" }}></div>
    </div>
  );
}


