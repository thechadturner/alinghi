import { createSignal, createEffect, onCleanup } from "solid-js";
import * as d3 from "d3";

import { myTickFormat } from "../../../utils/global";
import { isDark } from "../../../store/themeStore";
import { setTooltip } from "../../../store/globalStore";
import { error as logError } from "../../../utils/console";

const defaultColor = "#1f77b4";

type HoverPoint = { time: number; value: number; source_name: string; event_id: number };

function makeXGridlines(xScale: d3.ScaleLinear<number, number>) {
  return d3.axisBottom(xScale).ticks(10).tickFormat((d: d3.NumberValue) => myTickFormat(Number(d)));
}
function makeYGridlines(yScale: d3.ScaleLinear<number, number>) {
  return d3.axisLeft(yScale).ticks(5).tickFormat((d: d3.NumberValue) => myTickFormat(Number(d)));
}

export interface PrestartChartProps {
  channelKey: string;
  tsData: { event_id: number; source_name: string; charts: string[]; values: Record<string, number>[] }[];
  selectedSourceNames: string[];
  /** Selected time (sec) from chart click; when set, show red line and value labels/dots. */
  selectedTimeSec?: number | null;
  /** Called when user clicks on chart to set time (time in seconds). */
  onTimeSelect?: (timeSec: number) => void;
  /** Called when user double-clicks on chart to clear selected time and reset map. */
  onTimeClear?: () => void;
  /** For ACCELERATION/MAX BSP view: source_name -> time (sec). Dashed golden vertical line drawn at each time (selected sources only). */
  markerTimesBySource?: Record<string, number>;
  onSourceClick?: (sourceName: string) => void;
  getColorForSource: (sourceName: string | null | undefined) => string | undefined;
}

function getToolTipPosition(event: MouseEvent): { x: number; y: number } {
  try {
    const mouseX = event.clientX;
    const mouseY = event.clientY;
    const pad = 12;
    const estWidth = 220;
    const estHeight = 100;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = mouseX + pad;
    if (x + estWidth > viewportWidth) {
      x = Math.max(pad, mouseX - estWidth - pad);
    }

    let y = mouseY - estHeight - pad;
    if (y < pad) {
      y = mouseY + pad;
      if (y + estHeight > viewportHeight) {
        y = Math.max(pad, viewportHeight - estHeight - pad);
      }
    } else if (y + estHeight > viewportHeight) {
      y = Math.max(pad, mouseY - estHeight - pad);
    }

    x -= 75;
    return { x, y };
  } catch (err) {
    logError("PrestartChart: Error calculating tooltip position", err);
    return { x: 0, y: 0 };
  }
}

export default function PrestartChart(props: PrestartChartProps) {
  const [containerRef, setContainerRef] = createSignal<HTMLDivElement | undefined>(undefined);
  const [size, setSize] = createSignal<{ width: number; height: number }>({ width: 0, height: 0 });

  createEffect(() => {
    const el = containerRef();
    if (!el) return;
    const updateSize = () => {
      const w = el.offsetWidth || 800;
      const h = Math.max(180, el.offsetHeight || 200);
      setSize({ width: w, height: h });
    };
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  });

  createEffect(() => {
    const el = containerRef();
    const { width, height } = size();
    const data = props.tsData;
    const selectedNames = props.selectedSourceNames;
    const selectedTimeSec = props.selectedTimeSec ?? null;
    const onTimeSelect = props.onTimeSelect;
    const onTimeClear = props.onTimeClear;
    if (!el || data.length === 0 || width <= 0 || height <= 0) return;
    const hasSelection = selectedNames.length > 0;
    /** For draw order: when no selection, all are "selected" (drawn on top); when selection exists, only those in list are selected. */
    const isSourceSelectedForOrder = (sourceName: string) => !hasSelection || selectedNames.includes(sourceName);
    /** For styling: only true when there is a selection AND this source is in the list (otherwise all lines get 3px when nothing selected). */
    const isSourceSelectedForStyle = (sourceName: string) => hasSelection && selectedNames.includes(sourceName);
    const key = props.channelKey;
    const dataByEvent = data.map((row) => {
      const values = row.values || [];
      const points = values.map((v, j) => {
        const rawTime = (v as Record<string, unknown>).time;
        const time = typeof rawTime === "number" && Number.isFinite(rawTime) ? rawTime : j;
        return { time, value: v[key] != null ? Number(v[key]) : null };
      });
      const color = props.getColorForSource(row.source_name) ?? defaultColor;
      return { event_id: row.event_id, source_name: row.source_name, points, color };
    });
    const allValues = dataByEvent.flatMap((d) => d.points.map((p) => p.value)).filter((v): v is number => v != null && !Number.isNaN(v));
    const margin = { top: 10, right: 20, bottom: 30, left: 50 };
    const chartLeft = margin.left;
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    /** For ttk_s (time-to-mark seconds) use fixed y-axis -20 to +30; otherwise data-driven. */
    const yDomain: [number, number] =
      key === "ttk_s" ? [-10, 60] : allValues.length ? [Math.min(...allValues), Math.max(...allValues)] : [0, 1];
    const minVal = yDomain[0];
    const maxVal = yDomain[1];
    const xExtent = d3.extent(dataByEvent.flatMap((d) => d.points), (d) => d.time) as [number, number];
    const xScale = d3.scaleLinear().domain(xExtent).range([0, plotWidth]);
    const yScale = d3.scaleLinear().domain(yDomain).range([plotHeight, 0]);
    /** Clamp value to y-axis bounds so lines/points stay on chart. */
    const clampY = (v: number) => Math.max(minVal, Math.min(maxVal, v));
    const line = d3
      .line<{ time: number; value: number | null }>()
      .x((d) => xScale(d.time))
      .y((d) => (d.value != null ? yScale(clampY(d.value)) : plotHeight))
      .defined((d) => d.value != null && !Number.isNaN(d.value));
    const xAxisTickFormat = (s: number) => (s === 0 ? "START" : s > 0 ? `${s}s` : `−${Math.abs(s)}s`);
    const pathKey = (d: { event_id: number; source_name: string }) => `${d.source_name}_${d.event_id}`;
    // Match grouped TimeSeries: draw non-selected first, then selected (selected on top)
    const nonSelectedPaths = dataByEvent.filter((d) => !isSourceSelectedForOrder(d.source_name));
    const selectedPaths = dataByEvent.filter((d) => isSourceSelectedForOrder(d.source_name));
    const orderedPaths = [...nonSelectedPaths, ...selectedPaths];

    const darkMode = isDark();

    // Tooltip handlers – methodology and labeling similar to maneuver TimeSeries
    const getTooltipContent = (point: HoverPoint): string => {
      const xDisplay =
        typeof point.time === "number" && !Number.isNaN(point.time)
          ? String(parseFloat(point.time.toFixed(2)))
          : "—";
      const yDisplay =
        typeof point.value === "number" && !Number.isNaN(point.value)
          ? (Math.round(point.value * 10) / 10).toFixed(1)
          : "—";
      const tooltipRows = `
        <tr><td>SOURCE</td><td>${String(point.source_name)}</td></tr>
        <tr><td>TIME (SEC)</td><td>${xDisplay}</td></tr>
        <tr><td>${String(key || "").toUpperCase()}</td><td>${yDisplay}</td></tr>`;
      return `<table class='table-striped'>${tooltipRows}</table>`;
    };

    const mouseover = (event: MouseEvent, d: HoverPoint) => {
      const position = getToolTipPosition(event);
      setTooltip({ visible: true, content: getTooltipContent(d), x: position.x, y: position.y });
    };
    const mousemove = (event: MouseEvent, d: HoverPoint) => {
      const position = getToolTipPosition(event);
      setTooltip({ visible: true, content: getTooltipContent(d), x: position.x, y: position.y });
    };
    const mouseout = () => {
      setTooltip({ visible: false, content: "", x: 0, y: 0 });
    };

    d3.select(el).selectAll("*").remove();
    const svg = d3.select(el).append("svg").attr("width", width).attr("height", height).attr("class", "ts");
    const chartbody = svg.append("g").attr("class", "prestart-chart-body").attr("transform", `translate(${chartLeft},${margin.top})`);

    // Transparent overlay for click-to-set time (path hit areas are drawn later and will receive path clicks)
    const mouseOverlay = chartbody
      .append("rect")
      .attr("class", "prestart-chart-time-overlay")
      .attr("width", plotWidth)
      .attr("height", plotHeight)
      .attr("fill", "none")
      .attr("pointer-events", "all")
      .style("cursor", "crosshair");
    if (onTimeSelect) {
      mouseOverlay.on("click", (event: MouseEvent) => {
        const rect = el.getBoundingClientRect();
        const mouseX = event.clientX - rect.left - chartLeft;
        if (mouseX < 0 || mouseX > plotWidth) return;
        let timeSec = xScale.invert(mouseX);
        const [d0, d1] = xExtent;
        if (Number.isFinite(d0) && Number.isFinite(d1)) {
          timeSec = Math.max(d0, Math.min(d1, timeSec));
        }
        onTimeSelect(timeSec);
      });
    }
    if (onTimeClear) {
      mouseOverlay.on("dblclick", () => {
        onTimeClear();
      });
    }

    // Grid (behind axes and paths) – match maneuver TimeSeries
    chartbody
      .append("g")
      .attr("class", "grid")
      .attr("transform", `translate(0,${plotHeight})`)
      .style("stroke-dasharray", "3,3")
      .call(makeXGridlines(xScale).tickSize(-plotHeight).tickFormat((_d: d3.NumberValue, _i: number) => ""));
    chartbody
      .append("g")
      .attr("class", "grid")
      .attr("transform", "translate(0,0)")
      .style("stroke-dasharray", "3,3")
      .call(makeYGridlines(yScale).tickSize(-plotWidth).tickFormat((_d: d3.NumberValue, _i: number) => ""));

    // Axes – same class and theme as maneuver TimeSeries
    const yAxis = chartbody
      .append("g")
      .attr("class", "axes")
      .attr("transform", "translate(0,0)")
      .call(d3.axisLeft(yScale).ticks(5).tickFormat((d: d3.NumberValue) => myTickFormat(Number(d))));
    yAxis.selectAll("text").style("fill", darkMode ? "#ffffff" : "#000000");

    const xAxis = chartbody
      .append("g")
      .attr("class", "axes")
      .attr("transform", `translate(0,${plotHeight})`)
      .call(d3.axisBottom(xScale).ticks(10).tickFormat((d) => xAxisTickFormat(Number(d))));
    xAxis.selectAll("text").style("fill", darkMode ? "#ffffff" : "#000000");

    // Dashed vertical line(s) at max accel / max BSP time for selected tracks (one per selection, colored like the track)
    const markerTimesBySource = props.markerTimesBySource ?? {};
    const markerLinesData: { sourceName: string; time: number }[] = selectedNames
      .filter((name) => markerTimesBySource[name] != null && Number.isFinite(markerTimesBySource[name]))
      .map((name) => ({ sourceName: name, time: Number(markerTimesBySource[name]) }));
    if (markerLinesData.length > 0) {
      chartbody
        .selectAll<SVGLineElement, { sourceName: string; time: number }>(".prestart-chart-marker-line")
        .data(markerLinesData, (d) => `${d.sourceName}-${d.time}`)
        .join("line")
        .attr("class", "prestart-chart-marker-line")
        .attr("x1", (d) => xScale(d.time))
        .attr("x2", (d) => xScale(d.time))
        .attr("y1", 0)
        .attr("y2", plotHeight)
        .style("stroke", (d) => props.getColorForSource(d.sourceName) ?? "#d4af37")
        .style("stroke-width", 1.5)
        .style("stroke-dasharray", "6,4")
        .style("pointer-events", "none");
    }

    const pathSelection = chartbody.selectAll<SVGPathElement, (typeof dataByEvent)[number]>(".linePath").data(orderedPaths, pathKey);
    pathSelection
      .enter()
      .append("path")
      .attr("class", "linePath solid_line")
      .merge(pathSelection)
      .attr("d", (d) => line(d.points as { time: number; value: number | null }[]) ?? "")
      .style("fill", "none")
      .style("pointer-events", "none")
      .each(function (d) {
        const node = this as SVGPathElement;
        const selected = isSourceSelectedForStyle(d.source_name);
        // Match maneuver TimeSeries: 1px default, 0.5px unselected when selection exists, 3px selected
        const strokeWidth = selected ? "3px" : hasSelection ? "0.5px" : "1px";
        const strokeOpacity = selected ? 1 : hasSelection ? 0.2 : 1;
        node.style.setProperty("transition", "none", "important");
        node.style.setProperty("stroke", selected ? d.color : hasSelection ? "lightgrey" : d.color, "important");
        node.style.setProperty("stroke-width", strokeWidth, "important");
        node.style.setProperty("stroke-opacity", String(strokeOpacity), "important");
      });
    pathSelection.exit().remove();
    if (props.onSourceClick) {
      const hitSelection = chartbody.selectAll<SVGPathElement, (typeof dataByEvent)[number]>(".prestart-chart-hit").data(orderedPaths, pathKey);
      hitSelection
        .enter()
        .append("path")
        .attr("class", "prestart-chart-hit")
        .merge(hitSelection)
        .attr("d", (d) => line(d.points as { time: number; value: number | null }[]) ?? "")
        .attr("fill", "none")
        .attr("stroke", "transparent")
        .attr("stroke-width", 20)
        .style("pointer-events", "stroke")
        .style("cursor", "pointer")
        .on("click", (event: MouseEvent, d) => {
          event.stopPropagation();
          props.onSourceClick!(d.source_name);
        });
      hitSelection.exit().remove();
    }

    // Red vertical line at selected time (like explore/timeseries)
    chartbody.selectAll(".prestart-chart-selected-time-line").remove();
    if (selectedTimeSec != null && Number.isFinite(selectedTimeSec)) {
      const xPos = xScale(selectedTimeSec);
      if (xPos >= 0 && xPos <= plotWidth) {
        chartbody
          .append("line")
          .attr("class", "prestart-chart-selected-time-line selected-time-line")
          .attr("x1", xPos)
          .attr("x2", xPos)
          .attr("y1", 0)
          .attr("y2", plotHeight)
          .attr("stroke", "#e11")
          .attr("stroke-width", 2)
          .style("pointer-events", "none");
      }
    }

    // Value labels and dots at selected time (like explore TimeSeries time-value-label)
    chartbody.selectAll("circle.prestart-chart-time-value-circle").remove();
    chartbody.selectAll("text.prestart-chart-time-value-label").remove();
    if (selectedTimeSec != null && Number.isFinite(selectedTimeSec)) {
      type LabelDatum = { id: string; x: number; y: number; color: string; text: string; textX: number; textY: number };
      const allPointData: LabelDatum[] = [];
      for (const d of orderedPaths) {
        const points = d.points.filter((p) => p.value != null && !Number.isNaN(p.value));
        if (points.length === 0) continue;
        let closest = points[0];
        let bestDist = Math.abs((closest.time ?? 0) - selectedTimeSec);
        for (const p of points) {
          const dist = Math.abs((p.time ?? 0) - selectedTimeSec);
          if (dist < bestDist) {
            bestDist = dist;
            closest = p;
          }
        }
        const value = closest.value as number;
        const xPos = xScale(selectedTimeSec);
        const yPos = yScale(clampY(value));
        if (xPos >= 0 && xPos <= plotWidth && yPos >= 0 && yPos <= plotHeight) {
          allPointData.push({
            id: `${d.source_name}_${d.event_id}`,
            x: xPos,
            y: yPos,
            color: d.color,
            text: `${d.source_name}: ${(Math.round(value * 10) / 10).toFixed(1)}`,
            textX: xPos + 5,
            textY: yPos + 4,
          });
        }
      }
      const circles = chartbody.selectAll<SVGCircleElement, LabelDatum>("circle.prestart-chart-time-value-circle").data(allPointData, (d) => d.id);
      circles
        .enter()
        .append("circle")
        .attr("class", "prestart-chart-time-value-circle time-value-label")
        .attr("r", 4)
        .attr("cx", (d) => d.x)
        .attr("cy", (d) => d.y)
        .attr("fill", (d) => d.color)
        .attr("stroke", "white")
        .attr("stroke-width", 1)
        .style("pointer-events", "none");
      circles.exit().remove();
      const texts = chartbody.selectAll<SVGTextElement, LabelDatum>("text.prestart-chart-time-value-label").data(allPointData, (d) => d.id);
      texts
        .enter()
        .append("text")
        .attr("class", "prestart-chart-time-value-label time-value-label")
        .attr("font-size", "12px")
        .attr("text-anchor", "start")
        .attr("fill", (d) => d.color)
        .text((d) => d.text)
        .attr("x", (d) => d.textX)
        .attr("y", (d) => d.textY)
        .style("pointer-events", "none")
        .style("user-select", "none");
      texts.exit().remove();
    }

    // Hover points for nearest-point lookup
    const hoverPoints: HoverPoint[] = [];
    for (const d of orderedPaths) {
      for (const p of d.points) {
        if (p.value != null && !Number.isNaN(p.value)) {
          hoverPoints.push({ time: p.time, value: p.value, source_name: d.source_name, event_id: d.event_id });
        }
      }
    }

    // Chart-level mousemove for tooltip: find closest point (hit path blocks small circles, so use this instead)
    const handleChartMouseMove = (event: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      const mouseX = event.clientX - rect.left - chartLeft;
      const mouseY = event.clientY - rect.top - margin.top;
      if (mouseX < 0 || mouseX > plotWidth || mouseY < 0 || mouseY > plotHeight) {
        mouseout();
        return;
      }
      const mouseTime = xScale.invert(mouseX);
      const mouseVal = yScale.invert(mouseY);
      let closest: HoverPoint | null = null;
      let bestDist = Infinity;
      for (const p of hoverPoints) {
        const dx = (p.time - mouseTime) / (xExtent[1] - xExtent[0] || 1);
        const dy = (p.value - mouseVal) / (maxVal - minVal || 1);
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          closest = p;
        }
      }
      if (closest) {
        mouseover(event, closest);
      }
    };

    const handleChartMouseLeave = () => mouseout();

    svg
      .on("mousemove.prestart-tooltip", handleChartMouseMove)
      .on("mouseleave.prestart-tooltip", handleChartMouseLeave)
      .style("cursor", "crosshair");

    // Clean up on next effect run
    onCleanup(() => {
      d3.select(el).select("svg").on("mousemove.prestart-tooltip", null).on("mouseleave.prestart-tooltip", null);
    });

    chartbody
      .append("text")
      .attr("class", "axis-label")
      .attr("text-anchor", "top")
      .attr("transform", "translate(10,15)")
      .attr("font-size", "14px")
      .attr("user-select", "none")
      .attr("pointer-events", "none")
      .attr("fill", darkMode ? "#ffffff" : "#000000")
      .text(key.toUpperCase());
  });

  return <div ref={setContainerRef} class="prestart-chart" style={{ width: "100%", height: "200px" }} />;
}
