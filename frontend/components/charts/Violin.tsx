import { createEffect, onCleanup } from "solid-js";
import * as d3 from "d3";
import { setTooltip } from "../../store/globalStore";
import { isDark } from "../../store/themeStore";
import { getColorByIndex, resolveDataField } from "../../utils/colorScale";
import { buildColorGrouping } from "../../utils/colorGrouping";
import { debug as logDebug, error as logError, warn as logWarn } from "../../utils/console";

/** Violin plot: distribution by group with port tack on the left, starboard on the right. Requires TWA (or tack) in data. */

const VIOLIN_DEBUG = false;

/** Opacity for port (left) and stbd (right) halves – same group color, different shade. */
const PORT_OPACITY = 0.55;
const STBD_OPACITY = 0.85;

interface ViolinProps {
  chart?: any;
  handleZoom?: any;
  zoom?: boolean;
  data?: any[];
  /** TWA field name (e.g. 'TWA', 'Cwa', 'twa'). If not set, resolved from data. */
  twaField?: string;
  /** Optional fill for port (left) half. When set, overrides group color so port is always this color. */
  portColor?: string;
  /** Optional fill for starboard (right) half. When set, overrides group color so starboard is always this color. */
  stbdColor?: string;
  /**
   * Vertical padding as a fraction of (max − min) data span; default 0.1.
   * Use a smaller value (e.g. 0.02–0.04) for a tighter y-axis.
   */
  yPaddingFraction?: number;
  /** When false, skip d3’s domain “nice” expansion (tighter axis to the data). Default true. */
  yNice?: boolean;
  /** Clamp the scale minimum at 0 (e.g. |°| magnitude violins). */
  yClampMinZero?: boolean;
}

type Tack = "port" | "stbd";

interface ViolinGroupStats {
  whiskerMin: number;
  whiskerMax: number;
  q1: number;
  q2: number;
  q3: number;
  mean: number;
  count: number;
}

function getTack(d: any, twaField: string): Tack | null {
  const twaRaw = resolveDataField(d, twaField) ?? d.TWA ?? d.twa ?? d.Cwa ?? d.cwa ?? d.Twa ?? d.Cwa;
  if (twaRaw !== undefined && twaRaw !== null && !Number.isNaN(Number(twaRaw))) {
    return Number(twaRaw) < 0 ? "port" : "stbd";
  }
  const tack = resolveDataField(d, "TACK") ?? d.tack ?? d.Tack;
  if (tack != null) {
    const t = String(tack).toLowerCase();
    if (t === "port" || t === "s - p" || t === "p") return "port";
    if (t === "stbd" || t === "starboard" || t === "p - s" || t === "s") return "stbd";
  }
  return null;
}

function getValue(d: any, valueField: string): number | null {
  if (!d || !valueField) return null;
  const val = resolveDataField(d, valueField);
  if (val === undefined || val === null || Number.isNaN(Number(val))) return null;
  return Number(val);
}

function getGroupValue(d: any, groupField: string): any {
  const value = resolveDataField(d, groupField);
  if (value !== undefined && value !== null) return value;
  if (d[groupField] !== undefined && d[groupField] !== null) return d[groupField];
  const lower = groupField.toLowerCase();
  if (d[lower] !== undefined && d[lower] !== null) return d[lower];
  return "Unknown";
}

/** Number of evaluation points for KDE along y (smooth violin outline). */
const KDE_Y_TICKS = 50;

/** Minimum bandwidth as fraction of range when n is very small (avoids zero width). */
const KDE_MIN_BANDWIDTH_FRACTION = 0.1;

/**
 * Epanechnikov kernel: K(u) = 0.75 * (1 - u^2) for |u| <= 1, else 0.
 * Returns a function that takes (y - value) and returns kernel density contribution.
 */
function kernelEpanechnikov(bandwidth: number): (v: number) => number {
  const k = bandwidth <= 0 ? 1 : bandwidth;
  return (v: number) => {
    const u = v / k;
    if (Math.abs(u) > 1) return 0;
    return 0.75 * (1 - u * u);
  };
}

/**
 * Kernel density estimator: for each y in yTicks, computes mean over V of kernel(y - v).
 * Returns array of [y, density] (density non-negative, not normalized to integrate to 1).
 */
function kernelDensityEstimator(
  kernel: (v: number) => number,
  yTicks: number[]
): (V: number[]) => [number, number][] {
  return (V: number[]) => {
    if (!V.length) return [];
    return yTicks.map((y) => {
      const density = d3.mean(V, (v) => kernel(y - v)) ?? 0;
      return [y, Math.max(0, density)] as [number, number];
    });
  };
}

/**
 * Silverman-style bandwidth: 1.06 * std * n^(-1/5), with a minimum to avoid collapse for small n.
 */
function silvermanBandwidth(vals: number[]): number {
  const n = vals.length;
  if (n < 2) return 0;
  const std = d3.deviation(vals) ?? 0;
  const range = (d3.max(vals) ?? 0) - (d3.min(vals) ?? 0);
  const bw = 1.06 * std * Math.pow(n, -0.2);
  const minBw = range * KDE_MIN_BANDWIDTH_FRACTION;
  return Math.max(bw, minBw, range * 0.02);
}

type KdePoint = [number, number];

/**
 * Build violin half-path from KDE: smooth symmetric shape using d3.area and curveCatmullRom.
 * Returns path string for the half (center to one side). For very few points, KDE is still
 * computed but may look like a narrow bump; we keep a minimum bandwidth so it stays visible.
 */
function violinHalfPathKde(
  vals: number[],
  yScale: d3.ScaleLinear<number, number>,
  centerX: number,
  halfWidth: number,
  side: "left" | "right"
): string | null {
  if (!vals.length) return null;
  const yMin = d3.min(vals) ?? 0;
  const yMax = d3.max(vals) ?? 0;
  const range = yMax - yMin;
  if (range <= 0) {
    const y = yMin;
    const midY = yScale(y);
    const w = halfWidth * 0.5;
    const dy = 2;
    return side === "left"
      ? `M ${centerX} ${midY} L ${centerX - w} ${midY} L ${centerX - w} ${midY + dy} L ${centerX} ${midY + dy} Z`
      : `M ${centerX} ${midY} L ${centerX + w} ${midY} L ${centerX + w} ${midY + dy} L ${centerX} ${midY + dy} Z`;
  }
  const step = range / (KDE_Y_TICKS - 1 || 1);
  const yTicks = d3.range(yMin, yMax + step * 0.5, step);
  if (yTicks.length < 2) {
    yTicks.length = 0;
    yTicks.push(yMin, yMax);
  }
  const bandwidth = silvermanBandwidth(vals);
  const kernel = kernelEpanechnikov(bandwidth);
  const kde = kernelDensityEstimator(kernel, yTicks);
  const densityData: KdePoint[] = kde(vals);
  const maxDensity = d3.max(densityData, (d) => d[1]) ?? 1;
  if (maxDensity <= 0) return null;

  const scaleWidth = (d: number) => (d / maxDensity) * halfWidth;

  const areaGen = d3
    .area<KdePoint>()
    .curve(d3.curveCatmullRom)
    .x0(side === "left" ? (d) => centerX - scaleWidth(d[1]) : () => centerX)
    .x1(side === "left" ? () => centerX : (d) => centerX + scaleWidth(d[1]))
    .y((d) => yScale(d[0]));
  return areaGen(densityData);
}

export default function Violin(props: ViolinProps) {
  let containerRef: HTMLElement | null = null;
  let chartRef: HTMLDivElement | null = null;

  function buildGroupedByTack(
    data: any[],
    groupField: string,
    valueField: string,
    twaField: string,
    colorField: string,
    customGroups?: any[]
  ): { key: any; portVals: number[]; stbdVals: number[]; color: string }[] {
    if (!data?.length) return [];

    const by = new Map<string, { port: number[]; stbd: number[] }>();
    const availableFields = Object.keys(data[0] || {});

    const findField = (name: string): string | null => {
      const n = name.toLowerCase();
      if (availableFields.includes(name)) return name;
      const m = availableFields.find((f) => f.toLowerCase() === n);
      return m ?? null;
    };

    const actualValue = findField(valueField) || valueField;
    const actualGroup = findField(groupField) || groupField;

    for (const d of data) {
      const k = (d[actualGroup] ?? getGroupValue(d, groupField)) as string;
      const tack = getTack(d, twaField);
      if (tack === null) continue;
      const v = getValue(d, valueField);
      if (v === null) continue;

      if (!by.has(k)) by.set(k, { port: [], stbd: [] });
      const bucket = by.get(k)!;
      if (tack === "port") bucket.port.push(v);
      else bucket.stbd.push(v);
    }

    let colorScale: ((v: any) => string) | null = null;
    if (!customGroups?.length) {
      const { scale } = buildColorGrouping(data, colorField);
      colorScale = scale;
    }

    const groups = Array.from(by.entries()).map(([k, { port, stbd }], idx) => {
      let c = getColorByIndex(idx);
      if (customGroups?.length) {
        const norm = String(k).toLowerCase();
        const g = customGroups.find((g: any) => String(g.name).toLowerCase() === norm);
        if (g) c = g.color;
      } else if (colorScale) {
        try {
          const val = typeof k === "string" && (k === "PORT" || k === "STBD") ? k : (typeof k === "number" ? k : String(k).toLowerCase());
          c = colorScale(val);
        } catch {}
      }
      return {
        key: k,
        portVals: port.sort((a, b) => a - b),
        stbdVals: stbd.sort((a, b) => a - b),
        color: c,
      };
    });

    groups.sort((a, b) => {
      const aStr = String(a.key);
      const bStr = String(b.key);
      if (aStr === "Before" && bStr === "After") return -1;
      if (aStr === "After" && bStr === "Before") return 1;
      if (aStr === "Upwind" && bStr === "Downwind") return -1;
      if (aStr === "Downwind" && bStr === "Upwind") return 1;
      const an = Number(a.key);
      const bn = Number(b.key);
      if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
      return aStr > bStr ? 1 : -1;
    });
    return groups;
  }

  function computeStats(vals: number[]): ViolinGroupStats | null {
    if (!vals.length) return null;
    const q1 = d3.quantile(vals, 0.25) ?? vals[0];
    const q2 = d3.quantile(vals, 0.5) ?? vals[0];
    const q3 = d3.quantile(vals, 0.75) ?? vals[vals.length - 1];
    const mean = d3.mean(vals) ?? 0;
    const whiskerMin = vals[0];
    const whiskerMax = vals[vals.length - 1];
    return { whiskerMin, whiskerMax, q1, q2, q3, mean, count: vals.length };
  }

  function draw() {
    if (!chartRef || !props.chart?.series?.length) {
      logDebug("Violin: Missing chartRef or chart series");
      return;
    }

    const series = props.chart.series[0];
    const data = props.data ?? series.originalData ?? series.data ?? [];
    if (!data?.length) {
      logDebug("Violin: No data");
      d3.select(containerRef).selectAll("svg").remove();
      return;
    }

    const groupField = series.groupField ?? series.xaxis?.name ?? "source";
    const valueField = series.yaxis?.dataField ?? series.yaxis?.name ?? "y";
    const colorField = series.xaxis?.name ?? groupField;
    const customGroups = series.groups;

    const twaField = props.twaField ?? "TWA";
    const availableFields = Object.keys(data[0] || {});
    const hasTwa = availableFields.some(
      (f) => f.toLowerCase() === "twa" || f.toLowerCase() === "cwa" || f.toLowerCase() === twaField.toLowerCase()
    );
    const hasTack = availableFields.some((f) => f.toLowerCase() === "tack");
    if (!hasTwa && !hasTack) {
      const svg = d3
        .select(chartRef)
        .append("svg")
        .attr("width", 400)
        .attr("height", 300)
        .style("display", "block");
      const textColor = isDark() ? "#ffffff" : "#000000";
      svg
        .append("text")
        .attr("x", 200)
        .attr("y", 150)
        .attr("text-anchor", "middle")
        .attr("dominant-baseline", "middle")
        .attr("fill", textColor)
        .attr("font-size", "14px")
        .text("Violin plot requires TWA (or tack) in the data.");
      return;
    }

    d3.select(chartRef).selectAll("svg").remove();

    const containerWidth = chartRef?.clientWidth ?? 450;
    const containerHeight = chartRef?.clientHeight ?? 500;
    const margin = { top: 10, right: 58, bottom: 80, left: 54 };
    const chartWidth = containerWidth - margin.left - margin.right;
    const chartHeight = containerHeight - margin.top - margin.bottom;

    const svg = d3
      .select(chartRef)
      .append("svg")
      .attr("width", chartWidth + margin.left + margin.right)
      .attr("height", chartHeight + margin.top + margin.bottom)
      .style("display", "block");

    const textColor = isDark() ? "#ffffff" : "#000000";
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    const groups = buildGroupedByTack(data, groupField, valueField, twaField, colorField, customGroups);
    if (groups.length === 0) {
      if (VIOLIN_DEBUG) logDebug("Violin: No groups with port/stbd split");
      return;
    }

    const x = d3.scaleBand().domain(groups.map((d) => String(d.key))).range([0, chartWidth]).padding(0.3);
    const allVals = groups.flatMap((gr) => [...gr.portVals, ...gr.stbdVals]).filter((v) => !Number.isNaN(v));
    const rawMin = allVals.length ? (d3.min(allVals) ?? 0) : 0;
    const rawMax = allVals.length ? (d3.max(allVals) ?? 1) : 1;
    const padFrac = props.yPaddingFraction ?? 0.1;
    let span = rawMax - rawMin;
    if (span <= 0) span = Math.abs(rawMax) > 1e-9 ? Math.abs(rawMax) * 0.05 : 1;
    const pad = span * padFrac;
    let yMin = rawMin - pad;
    let yMax = rawMax + pad;
    if (props.yClampMinZero) yMin = Math.max(0, yMin);
    const useNice = props.yNice !== false;
    const y = useNice
      ? d3.scaleLinear().domain([yMin, yMax]).nice().range([chartHeight, 0])
      : d3.scaleLinear().domain([yMin, yMax]).range([chartHeight, 0]);
    const [yDom0, yDom1] = y.domain() as [number, number];

    g.append("g")
      .attr("class", "x-axis")
      .attr("transform", `translate(0,${chartHeight})`)
      .call(d3.axisBottom(x))
      .selectAll("text")
      .attr("transform", "rotate(-30)")
      .style("text-anchor", "end");
    g.append("g").attr("class", "y-axis").call(d3.axisLeft(y).ticks(4));
    g.selectAll(".x-axis text, .y-axis text").style("fill", textColor);

    const violinHalfWidth = (x.bandwidth() * 0.45) / 2;
    const useTackColors = props.portColor !== undefined || props.stbdColor !== undefined;
    const portFill = props.portColor ?? "#c00";
    const stbdFill = props.stbdColor ?? "#0a0";

    groups.forEach((gr, idx) => {
      const xCenter = (x(String(gr.key)) ?? 0) + x.bandwidth() / 2;
      const portStats = computeStats(gr.portVals);
      const stbdStats = computeStats(gr.stbdVals);
      const groupColor = gr.color && gr.color.trim() !== "" ? gr.color : getColorByIndex(idx);

      const boxGroup = g.append("g").attr("class", "violin-group").style("cursor", "pointer");

      boxGroup
        .append("rect")
        .attr("x", x(String(gr.key)) ?? 0)
        .attr("y", 0)
        .attr("width", x.bandwidth())
        .attr("height", chartHeight)
        .attr("fill", "transparent")
        .style("pointer-events", "all");

      if (gr.portVals.length > 0) {
        const path = violinHalfPathKde(gr.portVals, y, xCenter, violinHalfWidth, "left");
        if (path) {
          boxGroup
            .append("path")
            .attr("d", path)
            .attr("fill", useTackColors ? portFill : groupColor)
            .attr("opacity", PORT_OPACITY)
            .attr("stroke", "#333")
            .style("pointer-events", "none");
        }
      }

      if (gr.stbdVals.length > 0) {
        const path = violinHalfPathKde(gr.stbdVals, y, xCenter, violinHalfWidth, "right");
        if (path) {
          boxGroup
            .append("path")
            .attr("d", path)
            .attr("fill", useTackColors ? stbdFill : groupColor)
            .attr("opacity", STBD_OPACITY)
            .attr("stroke", "#333")
            .style("pointer-events", "none");
        }
      }

      boxGroup
        .append("line")
        .attr("x1", xCenter)
        .attr("x2", xCenter)
        .attr("y1", y(yDom0))
        .attr("y2", y(yDom1))
        .attr("stroke", textColor)
        .attr("stroke-width", 1)
        .attr("opacity", 0.5)
        .style("pointer-events", "none");

      const portMean = portStats?.mean;
      const stbdMean = stbdStats?.mean;
      const meanLabel = (v: number) => v.toFixed(1);
      if (portMean != null) {
        const py = y(portMean);
        boxGroup
          .append("line")
          .attr("x1", xCenter - violinHalfWidth)
          .attr("x2", xCenter)
          .attr("y1", py)
          .attr("y2", py)
          .attr("stroke", "#999")
          .attr("stroke-width", 1.5)
          .style("pointer-events", "none");
        boxGroup
          .append("text")
          .attr("x", xCenter - violinHalfWidth - 4)
          .attr("y", py)
          .attr("text-anchor", "end")
          .attr("font-size", "10px")
          .attr("fill", textColor)
          .attr("dy", "0.35em")
          .style("pointer-events", "none")
          .style("font-weight", "normal")
          .text(meanLabel(portMean));
      }
      if (stbdMean != null) {
        const sy = y(stbdMean);
        boxGroup
          .append("line")
          .attr("x1", xCenter)
          .attr("x2", xCenter + violinHalfWidth)
          .attr("y1", sy)
          .attr("y2", sy)
          .attr("stroke", "#999")
          .attr("stroke-width", 1.5)
          .style("pointer-events", "none");
        boxGroup
          .append("text")
          .attr("x", xCenter + violinHalfWidth + 4)
          .attr("y", sy)
          .attr("text-anchor", "start")
          .attr("font-size", "10px")
          .attr("fill", textColor)
          .attr("dy", "0.35em")
          .style("pointer-events", "none")
          .style("font-weight", "normal")
          .text(meanLabel(stbdMean));
      }

      boxGroup.on("mouseover", () => {
        const portN = gr.portVals.length;
        const stbdN = gr.stbdVals.length;
        const portM = portStats?.mean?.toFixed(1) ?? "—";
        const stbdM = stbdStats?.mean?.toFixed(1) ?? "—";
        setTooltip({
          visible: true,
          content: `<strong>${String(gr.key)}</strong><br/>Port: n=${portN}, mean=${portM}<br/>Stbd: n=${stbdN}, mean=${stbdM}`,
          x: 0,
          y: 0,
        });
      });
      boxGroup.on("mouseout", () => setTooltip({ visible: false, content: "", x: 0, y: 0 }));
    });

    g.append("text")
      .attr("x", chartWidth / 2)
      .attr("y", chartHeight + margin.bottom - 10)
      .attr("text-anchor", "middle")
      .attr("font-size", "12px")
      .attr("fill", textColor)
      .text(series.xaxis?.name ?? "Group");
    g.append("text")
      .attr("transform", "rotate(-90)")
      .attr("x", -chartHeight / 2)
      .attr("y", -margin.left + 15)
      .attr("text-anchor", "middle")
      .attr("font-size", "12px")
      .attr("fill", textColor)
      .text(series.yaxis?.name ?? "Y");

    // Legend: port (left) / stbd (right) – use same colors as violin paths
    const legend = g.append("g").attr("class", "violin-legend").attr("transform", `translate(${chartWidth - 90}, 8)`);
    legend
      .append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", 10)
      .attr("height", 10)
      .attr("fill", portFill)
      .attr("opacity", useTackColors ? 1 : PORT_OPACITY);
    legend.append("text").attr("x", 14).attr("y", 8).attr("font-size", "10px").attr("fill", textColor).text("Port");
    legend
      .append("rect")
      .attr("x", 45)
      .attr("y", 0)
      .attr("width", 10)
      .attr("height", 10)
      .attr("fill", stbdFill)
      .attr("opacity", useTackColors ? 1 : STBD_OPACITY);
    legend.append("text").attr("x", 59).attr("y", 8).attr("font-size", "10px").attr("fill", textColor).text("Stbd");
  }

  createEffect(() => {
    const chart = props.chart;
    if (!chart?.series?.[0]) return;
    const series = chart.series[0];
    const data = props.data ?? series.originalData ?? series.data;
    void chart._dataSignature;
    void series.groups;
    void series.groupField;
    void series.xaxis?.name;
    void series.yaxis?.name;
    void data?.length;
    void props.yPaddingFraction;
    void props.yNice;
    void props.yClampMinZero;
    draw();
  });

  onCleanup(() => {
    if (chartRef) d3.select(chartRef).selectAll("*").remove();
    try {
      setTooltip({ visible: false, content: "", x: 0, y: 0 });
    } catch {}
  });

  return (
    <div ref={(el) => (containerRef = el)} style={{ width: "100%", height: "100%", display: "flex", position: "relative" }}>
      <div ref={(el) => (chartRef = el as HTMLDivElement)} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
