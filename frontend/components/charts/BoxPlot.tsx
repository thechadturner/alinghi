import { createEffect, onCleanup } from "solid-js";
import * as d3 from "d3";
import { setTooltip } from "../../store/globalStore";
import { isDark } from "../../store/themeStore";
import { getColorByIndex, resolveDataField } from "../../utils/colorScale";
import { buildColorGrouping } from "../../utils/colorGrouping";
import { debug as logDebug, error as logError, warn as logWarn } from "../../utils/console";
import { CHART_FIELD_AGGREGATE_SUFFIX_RE } from "../../utils/speedUnits";

/** Set to true to enable verbose BoxPlot debug logs (e.g. field resolution, grouping). */
const BOXPLOT_DEBUG = false;

/** Tukey (1.5×IQR) whiskers with outliers, or full data range. */
export type WhiskerMode = "tukey" | "full";

interface BoxPlotProps {
  chart?: any;
  handleZoom?: any;
  zoom?: boolean;
  data?: any[]; // Optional direct data prop for reactivity
  /** When true, the group label in the tooltip is shown in uppercase (e.g. source_name in fleet performance) */
  uppercaseGroupInTooltip?: boolean;
  /** Whisker mode: 'tukey' = 1.5×IQR fences and outlier points (default); 'full' = whiskers to data min/max. */
  whiskerMode?: WhiskerMode;
}

export default function BoxPlot(props: BoxPlotProps) {
  let containerRef: HTMLElement | null = null;
  let chartRef: HTMLDivElement | null = null;

  // Helper function to get the grouping field value from data
  const getGroupValue = (d: any, groupField: string): any => {
    // Use resolveDataField for consistent field resolution
    const value = resolveDataField(d, groupField);
    if (value !== undefined && value !== null) {
      return value;
    }
    // Fallback: try direct access with variations
    if (d[groupField] !== undefined && d[groupField] !== null) {
      return d[groupField];
    }
    const lowerField = groupField.toLowerCase();
    if (d[lowerField] !== undefined && d[lowerField] !== null) {
      return d[lowerField];
    }
    const upperField = groupField.toUpperCase();
    if (d[upperField] !== undefined && d[upperField] !== null) {
      return d[upperField];
    }
    return 'Unknown';
  };

  // Helper function to get the value field from data
  const getValue = (d: any, valueField: string, aggregateType: string = 'AVG'): number | null => {
    if (!d || !valueField) return null;
    
    // If aggregate type is specified and not AVG, try to use suffixed field (e.g. channel_std)
    const normalizedAggregateType = (aggregateType || 'AVG').toUpperCase();
    if (normalizedAggregateType !== 'AVG') {
      const suffix = normalizedAggregateType.toLowerCase();
      const valueFieldLower = valueField.toLowerCase();
      const yFieldSuffixed = `${valueField}_${suffix}`;
      const yFieldSuffixedLower = `${valueFieldLower}_${suffix}`;
      
      // Check if suffixed field exists in data
      if (yFieldSuffixed in d || yFieldSuffixedLower in d) {
        const suffixedField = (yFieldSuffixed in d) ? yFieldSuffixed : yFieldSuffixedLower;
        const val = resolveDataField(d, suffixedField);
        if (val !== undefined && val !== null && !isNaN(Number(val))) {
          return Number(val);
        }
        // Try direct access
        if (d[suffixedField] !== undefined && d[suffixedField] !== null && !isNaN(Number(d[suffixedField]))) {
          return Number(d[suffixedField]);
        }
      } else {
        logDebug(`BoxPlot: Suffixed field not found, using base field: ${valueField} for aggregateType: ${normalizedAggregateType}`);
      }
    }
    
    // Try resolveDataField first with original field name
    let val = resolveDataField(d, valueField);
    if (val !== undefined && val !== null && !isNaN(Number(val))) {
      return Number(val);
    }
    
    // Remove common channel suffixes to find base field
    const baseField = valueField.replace(CHART_FIELD_AGGREGATE_SUFFIX_RE, '');
    if (baseField !== valueField) {
      val = resolveDataField(d, baseField);
      if (val !== undefined && val !== null && !isNaN(Number(val))) {
        return Number(val);
      }
    }
    
    // Try direct access with variations (case-insensitive)
    const fieldVariations = [
      valueField,
      valueField.toLowerCase(),
      valueField.toUpperCase(),
      baseField,
      baseField.toLowerCase(),
      baseField.toUpperCase()
    ];
    
    for (const fieldVar of fieldVariations) {
      if (d[fieldVar] !== undefined && d[fieldVar] !== null && !isNaN(Number(d[fieldVar]))) {
        return Number(d[fieldVar]);
      }
    }
    
    return null; // Return null instead of 0 to indicate field not found
  };

  function buildGroupedValues(data: any[], groupField: string, valueField: string, colorField: string, customGroups?: any[], aggregateType: string = 'AVG') {
    if (!data || data.length === 0) {
      logDebug('BoxPlot: No data provided to buildGroupedValues');
        return [];
      }

    // Determine actual field names that exist in the data (like PerfScatter does)
    const firstItem = data[0];
    const availableFields = Object.keys(firstItem);
    
    // Helper function to find field with case-insensitive matching
    const findField = (requestedField: string, availableFields: string[]): string | null => {
      const requestedLower = requestedField.toLowerCase();
      
      // Try exact match first
      if (availableFields.includes(requestedField)) {
        return requestedField;
      }
      
      // Try case-insensitive match
      const match = availableFields.find(field => field.toLowerCase() === requestedLower);
      if (match) {
        return match;
      }
      
      // Try using resolveDataField (it has better field resolution logic)
      const resolved = resolveDataField(firstItem, requestedField);
      if (resolved !== undefined) {
        // Find which field was actually used
        for (const field of availableFields) {
          if (firstItem[field] === resolved) {
            return field;
          }
        }
      }
      
      return null;
    };
    
    // Find the actual field name for value field
    let actualValueField = findField(valueField, availableFields);
    
    // Find the actual field name for group field
    const actualGroupField = findField(groupField, availableFields);
    
    // Log field resolution with available fields listed
    logDebug('BoxPlot: Field resolution', {
      requestedValueField: valueField,
      actualValueField,
      requestedGroupField: groupField,
      actualGroupField,
      availableFields: availableFields,
      availableFieldsCount: availableFields.length,
      sampleDataPoint: firstItem
    });
    
    if (!actualValueField) {
      // Allow requested field when value is resolvable via resolveDataField (e.g. API uses different casing)
      // Check first item and a few more in case first row is missing this channel
      let resolvedNum = false;
      for (let i = 0; i < Math.min(5, data.length); i++) {
        const resolvedVal = resolveDataField(data[i], valueField);
        if (resolvedVal !== undefined && resolvedVal !== null && !isNaN(Number(resolvedVal))) {
          resolvedNum = true;
          break;
        }
      }
      if (resolvedNum) {
        actualValueField = valueField;
        logDebug('BoxPlot: Using resolveDataField for value field (no exact key match)', {
          requestedField: valueField
        });
      } else {
        // Channel may be in chart config but not present in this dataset (e.g. different ingestion path)
        logWarn('BoxPlot: Value field not found in data', {
          requestedField: valueField,
          availableFields: availableFields,
          // Show first few field values to help debug
          sampleFieldValues: availableFields.slice(0, 10).reduce((acc: any, field) => {
            acc[field] = firstItem[field];
            return acc;
          }, {})
        });
        return [];
      }
    }
    
    // Use custom groups if provided, otherwise build color grouping from data
    let colorScale: any = null;
    if (!customGroups || customGroups.length === 0) {
      // Build color grouping from data (similar to ManeuverBoxPlot)
      const { scale } = buildColorGrouping(data, colorField);
      colorScale = scale;
    }

    const by = new Map();
    let totalValues = 0;
    let validValues = 0;
    let nullValues = 0;
    let zeroValues = 0;
    
    data.forEach((d, idx) => {
      // Use actual field names or fallback to helper functions
      const k = actualGroupField ? (d[actualGroupField] ?? getGroupValue(d, groupField)) : getGroupValue(d, groupField);
      if (!by.has(k)) by.set(k, []);
      
      // Use actual field name if found, otherwise use helper function
      // Note: If aggregate type is not AVG, we need to check for suffixed fields
      let v: number | null = null;
      const normalizedAggregateType = (aggregateType || 'AVG').toUpperCase();
      
      if (normalizedAggregateType !== 'AVG') {
        // For non-AVG aggregate types, use getValue which checks for suffixed fields
        v = getValue(d, valueField, aggregateType);
      } else if (actualValueField && d[actualValueField] !== undefined && d[actualValueField] !== null) {
        // For AVG, use the actual field name if found
        const numVal = Number(d[actualValueField]);
        v = !isNaN(numVal) ? numVal : null;
      } else {
        // Fallback to helper function
        v = getValue(d, valueField, aggregateType);
      }
      
      totalValues++;
      
      if (v === null) {
        nullValues++;
        if (idx < 3) { // Log first few failures for debugging
          logDebug('BoxPlot: Value is null', {
            index: idx,
            actualValueField,
            valueField,
            groupValue: k,
            dataPoint: d
          });
        }
      } else if (v === 0) {
        zeroValues++;
        // Include 0 values - they might be valid
        by.get(k).push(v);
        validValues++;
      } else if (!isNaN(v)) {
        by.get(k).push(v);
        validValues++;
      }
    });
    
    logDebug('BoxPlot: Grouping results', {
      groupField,
      valueField,
      totalDataPoints: data.length,
      totalValues,
      validValues,
      nullValues,
      zeroValues,
      groupsFound: by.size,
      groupKeys: Array.from(by.keys()),
      groupSizes: Array.from(by.entries()).map(([k, v]) => ({ key: k, count: (v as number[]).length }))
    });

    // Check if this is performance data (has vmg_perc or vmg fields)
    const isPerformanceData = availableFields.some(field => 
      field.toLowerCase() === 'vmg_perc' || field.toLowerCase() === 'vmg_perc_avg' || 
      field.toLowerCase() === 'vmg' || field.toLowerCase() === 'vmg_avg'
    );
    
    // Track vmg_perc/vmg values per group for performance page star
    const vmgByGroup = new Map();
    if (isPerformanceData) {
      // Find vmg field names
      const vmgPercField = availableFields.find(f => f.toLowerCase() === 'vmg_perc_avg') || 
                          availableFields.find(f => f.toLowerCase() === 'vmg_perc');
      const vmgField = availableFields.find(f => f.toLowerCase() === 'vmg_avg') || 
                      availableFields.find(f => f.toLowerCase() === 'vmg');
      
      data.forEach((d) => {
        const k = actualGroupField ? (d[actualGroupField] ?? getGroupValue(d, groupField)) : getGroupValue(d, groupField);
        if (!vmgByGroup.has(k)) vmgByGroup.set(k, []);
        
        // Try vmg_perc first, then vmg
        let vmgVal: number | null = null;
        if (vmgPercField && d[vmgPercField] !== undefined && d[vmgPercField] !== null) {
          vmgVal = Number(d[vmgPercField]);
        } else if (vmgField && d[vmgField] !== undefined && d[vmgField] !== null) {
          vmgVal = Number(d[vmgField]);
        }
        
        if (vmgVal !== null && !isNaN(vmgVal)) {
          vmgByGroup.get(k).push(vmgVal);
        }
      });
    }

    const groups = Array.from(by.entries()).map(([k, vals], idx) => {
      let c = getColorByIndex(idx);
      
      // Use custom groups if provided
      if (customGroups && customGroups.length > 0) {
        const normalizedKey = String(k).toLowerCase();
        const matchingGroup = customGroups.find((g: any) => 
          String(g.name).toLowerCase() === normalizedKey
        );
        if (matchingGroup) {
          c = matchingGroup.color;
        }
      } else {
        // Use color grouping scale (for maneuvers-style coloring)
        try {
          const colorFieldUpper = colorField.toUpperCase();
          if (colorFieldUpper === 'TACK') {
            const t = String(k);
            c = (t === 'PORT' || t === 'S - P' || t === 'port') ? '#d62728' : 
                (t === 'STBD' || t === 'P - S' || t === 'stbd') ? '#2ca02c' : c;
          } else if (colorScale && typeof colorScale === 'function') {
            const valForScale = (colorFieldUpper === 'TWS' || colorFieldUpper === 'TWS_BIN') ? Number(k) : 
                               (typeof k === 'string' ? k.toLowerCase() : k);
            c = colorScale(valForScale);
          }
        } catch {}
      }
      
      // Calculate mean vmg_perc/vmg for this group if performance data
      let meanVmg: number | null = null;
      if (isPerformanceData && vmgByGroup.has(k)) {
        const vmgVals = vmgByGroup.get(k);
        if (vmgVals && vmgVals.length > 0) {
          meanVmg = d3.mean(vmgVals) ?? null;
        }
      }
      
      return { key: k, vals: (vals as number[]).sort((a: number, b: number) => a - b), color: c, meanVmg };
    });

    // Sort groups
    groups.sort((a, b) => {
      // Try numeric comparison first
      const aNum = Number(a.key);
      const bNum = Number(b.key);
      if (!isNaN(aNum) && !isNaN(bNum)) {
        return aNum - bNum;
      }
      // String comparison
      return String(a.key) > String(b.key) ? 1 : -1;
    });

    return groups;
  }

  function draw() {
    if (!chartRef || !props.chart || !props.chart.series || props.chart.series.length === 0) {
      logDebug('BoxPlot: Missing chartRef or chart or series');
      return;
    }

    const series = props.chart.series[0];
    // Prefer direct data prop if available, otherwise use chart data
    const data = props.data || series.originalData || series.data || [];

    if (!data || data.length === 0) {
      logDebug('BoxPlot: No data available', { 
        hasOriginalData: !!series.originalData, 
        hasData: !!series.data,
        dataLength: data.length 
      });
      // Clear everything except tooltip
      d3.select(containerRef).selectAll('svg').remove();
      return;
    }

    // Debug: log first data point to see structure
    if (data.length > 0) {
      logDebug('BoxPlot: Data sample', {
        firstPoint: data[0],
        dataLength: data.length,
        availableFields: Object.keys(data[0] || {})
      });
    }

    // Get configuration from chart - use original field names as-is
    const xAxisLabel = series.xaxis?.name || 'Group';
    const yAxisLabel = series.yaxis?.name || 'Y-Axis';
    const groupField = series.groupField || series.xaxis?.name || 'source';
    // Use dataField if available (for performance data), otherwise use name
    const valueField = series.yaxis?.dataField || series.yaxis?.name || 'y';
    const colorField = series.xaxis?.name || groupField;
    const customGroups = series.groups;
    // Get aggregate type from series configuration (default to 'AVG')
    // Use yType if available, otherwise fall back to 'AVG' (backward compatibility)
    const aggregateType = series.yType || series.aggregate || 'AVG';
    
    // Log detailed configuration and sample data
    logDebug('BoxPlot: Configuration', {
      xAxisLabel,
      yAxisLabel,
      groupField,
      valueField,
      colorField,
      aggregateType,
      dataLength: data.length,
      hasCustomGroups: !!(customGroups && customGroups.length > 0),
      yaxisConfig: series.yaxis,
      sampleDataPoint: data.length > 0 ? data[0] : null,
      availableFieldsInData: data.length > 0 ? Object.keys(data[0] || {}) : []
    });

    // COMPLETE cleanup - remove all SVG elements before redrawing
    d3.select(chartRef).selectAll('svg').remove();
    
    // Get current container dimensions - match PerfScatter approach
    const containerWidth = chartRef?.clientWidth ?? 450;
    const containerHeight = chartRef?.clientHeight ?? 500;
    
    // Match PerfScatter margins exactly, but with increased right margin for mean labels
    const margin = { top: 10, right: 50, bottom: 80, left: 50 };
    
    // Calculate actual chart area (matching PerfScatter)
    const chartWidth = containerWidth - margin.left - margin.right;
    const chartHeight = containerHeight - margin.top - margin.bottom;

    if (!chartRef) {
      logError('BoxPlot: chartRef is null');
      return;
    }

    // Check if value field exists in data before building groups (same logic as buildGroupedValues)
    const availableFields = Object.keys(data[0] || {});
    const valueFieldLower = valueField.toLowerCase();
    const hasExactMatch = availableFields.includes(valueField) || availableFields.some(f => f.toLowerCase() === valueFieldLower);
    const hasResolvedValue = !hasExactMatch && Array.from({ length: Math.min(5, data.length) }, (_, i) => i).some(i => {
      const v = resolveDataField(data[i], valueField);
      return v !== undefined && v !== null && !isNaN(Number(v));
    });
    const valueFieldAvailable = hasExactMatch || hasResolvedValue;

    if (!valueFieldAvailable) {
      const svg = d3.select(chartRef)
        .append('svg')
        .attr('width', containerWidth)
        .attr('height', containerHeight)
        .style('display', 'block');
      const textColor = isDark() ? '#ffffff' : '#000000';
      svg.append('text')
        .attr('x', containerWidth / 2)
        .attr('y', containerHeight / 2)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('fill', textColor)
        .attr('font-size', '14px')
        .text(`Channel "${valueField}" is not available in this dataset.`);
      return;
    }

    const svg = d3.select(chartRef)
      .append('svg')
      .attr('width', chartWidth + margin.left + margin.right)
      .attr('height', chartHeight + margin.top + margin.bottom)
      .style('display', 'block');

    const textColor = isDark() ? '#ffffff' : '#000000';

    const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const groups = buildGroupedValues(data, groupField, valueField, colorField, customGroups, aggregateType);
    
    if (groups.length === 0) {
      if (BOXPLOT_DEBUG) logDebug('BoxPlot: No groups found after processing data');
      return;
    }
    
    const x = d3.scaleBand().domain(groups.map(d => String(d.key))).range([0, chartWidth]).padding(0.3);

    // Whisker mode: Tukey (1.5×IQR) or full range. Box is always Q1–Q3 (IQR).
    const whiskerMode: WhiskerMode = props.whiskerMode ?? series.whiskerMode ?? "tukey";
    const TUKEY_MULT = 1.5;

    type BoxStats = {
      q1: number; q2: number; q3: number; mean: number;
      whiskerMin: number; whiskerMax: number;
      outliers: number[];
      iqr: number;
      count: number;
    };
    const allBoxStats: BoxStats[] = groups.map(gp => {
      const vals = gp.vals;
      const n = vals.length;
      const q1 = d3.quantile(vals, 0.25) ?? 0;
      const q2 = d3.quantile(vals, 0.5) ?? 0;
      const q3 = d3.quantile(vals, 0.75) ?? 0;
      const mean = n ? (d3.mean(vals) ?? 0) : 0;
      const iqr = q3 - q1;
      let whiskerMin: number;
      let whiskerMax: number;
      let outliers: number[];
      if (whiskerMode === "tukey" && n > 0) {
        const lowerFence = q1 - TUKEY_MULT * iqr;
        const upperFence = q3 + TUKEY_MULT * iqr;
        const inRange = vals.filter(v => v >= lowerFence && v <= upperFence);
        whiskerMin = inRange.length ? (d3.min(inRange) ?? vals[0]) : q1;
        whiskerMax = inRange.length ? (d3.max(inRange) ?? vals[n - 1]) : q3;
        outliers = vals.filter(v => v < lowerFence || v > upperFence);
      } else {
        whiskerMin = n ? vals[0] : 0;
        whiskerMax = n ? vals[n - 1] : 0;
        outliers = [];
      }
      return { q1, q2, q3, mean, whiskerMin, whiskerMax, outliers, iqr, count: n };
    });

    const allVals = groups.flatMap(gp => gp.vals);

    // Y-domain: include whisker ends and outliers so all visible points are on scale
    const domainVals = allBoxStats.flatMap(s => [
      s.whiskerMin,
      s.whiskerMax,
      ...s.outliers
    ]).filter(v => !Number.isNaN(v));
    const rawMin = domainVals.length ? (d3.min(domainVals) ?? 0) : 0;
    const rawMax = domainVals.length ? (d3.max(domainVals) ?? 1) : 1;
    const pad = (rawMax - rawMin) * 0.1 || 0.1;
    const y = d3.scaleLinear().domain([rawMin - pad, rawMax + pad]).nice().range([chartHeight, 0]);

    g.append('g')
      .attr('class', 'x-axis')
      .attr('transform', `translate(0,${chartHeight})`)
      .call(d3.axisBottom(x))
      .selectAll('text')
      .attr('transform', 'rotate(-30)')
      .style('text-anchor', 'end');
    g.append('g')
      .attr('class', 'y-axis')
      .call(d3.axisLeft(y).ticks(4));

    // Axis label colors for dark/light mode
    g.selectAll('.x-axis text, .y-axis text').style('fill', textColor);

    // Calculate overall mean of all y-values and draw as grey dashed line
    const overallMean = d3.mean(allVals) ?? 0;
    g.append('line')
      .attr('class', 'subaxis')
      .attr('x1', 0)
      .attr('x2', chartWidth)
      .attr('y1', y(overallMean))
      .attr('y2', y(overallMean))
      .attr('stroke', '#808080')
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '5,5')
      .style('pointer-events', 'none');

    // Add overall mean label on the right side
    g.append('text')
      .attr('x', chartWidth + 4)
      .attr('y', y(overallMean))
      .attr('text-anchor', 'start')
      .attr('font-size', '10px')
      .attr('fill', '#808080')
      .attr('dy', '0.35em')
      .style('pointer-events', 'none')
      .text(overallMean.toFixed(1));

    // Helper to position tooltip beside the box
    // Uses same approach as PerfScatter: container-relative coordinates with scroll offset
    const getTooltipPositionBesideBox = (xCenter: number, boxY: number, boxHeight: number) => {
      try {
        // Use main-content container like PerfScatter does
        const mainContainer = document.getElementById('main-content');
        if (!mainContainer || !chartRef) return { x: 0, y: 0 };
        
        const containerRect = mainContainer.getBoundingClientRect();
        const svgRect = chartRef.getBoundingClientRect();
        
        // Convert SVG coordinates to container-relative coordinates
        // xCenter and boxY are in SVG coordinate space (relative to the g element)
        // Add margin to get position relative to SVG, then add SVG position relative to container
        const boxXInContainer = (svgRect.left - containerRect.left) + margin.left + xCenter;
        const boxYInContainer = (svgRect.top - containerRect.top) + margin.top + boxY;
        
        // Account for container scroll position (tooltip uses position: absolute)
        const scrollX = mainContainer.scrollLeft || 0;
        const scrollY = mainContainer.scrollTop || 0;
        
        const pad = 12;
        const estWidth = 220;
        const estHeight = 140;
        
        // Position tooltip to the right of the box, centered vertically on the box
        let x = boxXInContainer + pad + scrollX;
        // If tooltip would go off screen, position to the left instead
        if (x + estWidth > containerRect.width + scrollX) {
          x = Math.max(scrollX, boxXInContainer - estWidth - pad + scrollX);
        }
        
        // Center tooltip vertically on the box
        let y = boxYInContainer + boxHeight / 2 - estHeight / 2 + scrollY;
        // Keep tooltip within container bounds
        if (y < scrollY) {
          y = scrollY + pad;
        } else if (y + estHeight > containerRect.height + scrollY) {
          y = Math.max(scrollY, containerRect.height + scrollY - estHeight - pad);
        }
        
        return { x, y };
      } catch {
        return { x: 0, y: 0 };
      }
    };

    type TooltipData = {
      group: string;
      min: number;
      q1: number;
      q2: number;
      q3: number;
      max: number;
      mean: number;
      count: number;
      outlierCount?: number;
      iqr?: number;
    };
    const showTooltip = (xCenter: number, boxY: number, boxHeight: number, data: TooltipData) => {
      const pos = getTooltipPositionBesideBox(xCenter, boxY, boxHeight);
      const w = "min-width:50px;";
      const groupLabel = props.uppercaseGroupInTooltip ? String(data.group).toUpperCase() : data.group;
      let rows = `
            <tr><td>GROUP:</td><td style='${w}'>${groupLabel}</td></tr>
            <tr><td>COUNT:</td><td style='${w}'>${data.count}</td></tr>`;
      if (whiskerMode === "tukey" && data.outlierCount !== undefined && data.outlierCount > 0) {
        rows += `<tr><td>OUTLIERS:</td><td style='${w}'>${data.outlierCount}</td></tr>`;
        if (data.iqr !== undefined) rows += `<tr><td>IQR:</td><td style='${w}'>${(Math.round(data.iqr * 10) / 10)}</td></tr>`;
      }
      rows += `
            <tr><td>MAX:</td><td style='${w}'>${(Math.round(data.max * 10) / 10)}</td></tr>
            <tr><td>Q3:</td><td style='${w}'>${(Math.round(data.q3 * 10) / 10)}</td></tr>
            <tr><td>MEAN:</td><td style='${w}'>${(Math.round(data.mean * 10) / 10)}</td></tr>
            <tr><td>MEDIAN:</td><td style='${w}'>${(Math.round(data.q2 * 10) / 10)}</td></tr>
            <tr><td>Q1:</td><td style='${w}'>${(Math.round(data.q1 * 10) / 10)}</td></tr>
            <tr><td>MIN:</td><td style='${w}'>${(Math.round(data.min * 10) / 10)}</td></tr>`;
      const content = `<table class='table-striped'>${rows}</table>`;
      setTooltip({ visible: true, content, x: pos.x, y: pos.y });
    };

    const hideTooltip = () => {
      setTooltip({ visible: false, content: "", x: 0, y: 0 });
    };

    // Find group with highest mean vmg_perc/vmg for performance page star
    let highestVmgGroup: { key: any; meanVmg: number | null } | null = null;
    const isPerformanceData = groups.some(g => g.meanVmg !== null && g.meanVmg !== undefined);
    if (isPerformanceData) {
      highestVmgGroup = groups.reduce((max, gp) => {
        if (gp.meanVmg !== null && gp.meanVmg !== undefined) {
          if (max === null || gp.meanVmg > max.meanVmg!) {
            return { key: gp.key, meanVmg: gp.meanVmg };
          }
        }
        return max;
      }, null as { key: any; meanVmg: number | null } | null);
    }

    // Draw boxes using precomputed stats (Tukey or full-range whiskers)
    const boxWidth = Math.max(10, x.bandwidth() * 0.6);
    groups.forEach((gp, i) => {
      const stats = allBoxStats[i];
      const { q1, q2, q3, mean, whiskerMin, whiskerMax, outliers, iqr, count } = stats;
      const dataMin = gp.vals.length ? gp.vals[0] : 0;
      const dataMax = gp.vals.length ? gp.vals[gp.vals.length - 1] : 0;
      const xCenter = (x(String(gp.key)) ?? 0) + x.bandwidth() / 2;

      const boxY = y(q3);
      const boxHeight = Math.max(1, y(q1) - y(q3));
      const boxData: TooltipData = {
        group: String(gp.key),
        min: dataMin,
        q1,
        q2,
        q3,
        max: dataMax,
        mean,
        count,
      };
      if (whiskerMode === "tukey") {
        boxData.outlierCount = outliers.length;
        boxData.iqr = iqr;
      }

      const boxGroup = g.append('g')
        .attr('class', 'box-group')
        .style('cursor', 'pointer')
        .on('mouseover', (event) => {
          event.stopPropagation();
          showTooltip(xCenter, boxY, boxHeight, boxData);
        })
        .on('mouseout', (event) => {
          event.stopPropagation();
          hideTooltip();
        });

      boxGroup.append('rect')
        .attr('x', x(String(gp.key)) ?? 0)
        .attr('y', 0)
        .attr('width', x.bandwidth())
        .attr('height', chartHeight)
        .attr('fill', 'transparent')
        .style('pointer-events', 'all');

      // Whisker: from whiskerMin to whiskerMax (Tukey: in-range data; full: data min–max)
      boxGroup.append('line')
        .attr('x1', xCenter)
        .attr('x2', xCenter)
        .attr('y1', y(whiskerMin))
        .attr('y2', y(whiskerMax))
        .attr('stroke', '#555')
        .style('pointer-events', 'none');

      // Whisker caps: small horizontal lines at min/max
      const capHalf = 5;
      boxGroup.append('line')
        .attr('x1', xCenter - capHalf)
        .attr('x2', xCenter + capHalf)
        .attr('y1', y(whiskerMin))
        .attr('y2', y(whiskerMin))
        .attr('stroke', '#555')
        .style('pointer-events', 'none');

      boxGroup.append('line')
        .attr('x1', xCenter - capHalf)
        .attr('x2', xCenter + capHalf)
        .attr('y1', y(whiskerMax))
        .attr('y2', y(whiskerMax))
        .attr('stroke', '#555')
        .style('pointer-events', 'none');

      // Outlier points (Tukey): draw beyond whiskers with slight x jitter so they don’t overlap
      if (whiskerMode === "tukey" && outliers.length > 0) {
        const band = x.bandwidth();
        const jitterWidth = Math.min(8, band * 0.15);
        outliers.forEach((v, j) => {
          const jitter = (j % 2 === 0 ? 1 : -1) * (jitterWidth * (Math.floor(j / 2) * 0.3 + 0.5));
          boxGroup.append('circle')
            .attr('cx', xCenter + jitter)
            .attr('cy', y(v))
            .attr('r', 3)
            .attr('fill', gp.color)
            .attr('opacity', 0.85)
            .attr('stroke', '#333')
            .attr('stroke-width', 1)
            .style('pointer-events', 'none');
        });
      }

      if (groups.length > 1 && isPerformanceData && highestVmgGroup && String(gp.key) === String(highestVmgGroup.key)) {
        boxGroup.append('text')
          .attr('x', xCenter)
          .attr('y', y(whiskerMax) - 15)
          .attr('text-anchor', 'middle')
          .attr('font-size', '20px')
          .attr('fill', '#FFD700')
          .style('pointer-events', 'none')
          .text('★');
      }

      // box - disable pointer events so parent handles them
      boxGroup.append('rect')
        .attr('x', xCenter - boxWidth/2)
        .attr('y', boxY)
        .attr('width', boxWidth)
        .attr('height', boxHeight)
        .attr('fill', gp.color)
        .attr('opacity', 0.7)
        .attr('stroke', '#333')
        .style('pointer-events', 'none');

      // median (match theme: white in dark, black in light) - disable pointer events
      boxGroup.append('line')
        .attr('x1', xCenter - boxWidth/2)
        .attr('x2', xCenter + boxWidth/2)
        .attr('y1', y(q2))
        .attr('y2', y(q2))
        .attr('stroke', textColor)
        .attr('stroke-width', 2)
        .style('pointer-events', 'none');

      // mean (white in dark mode, black in light mode) - disable pointer events
      boxGroup.append('line')
        .attr('x1', xCenter - boxWidth/2)
        .attr('x2', xCenter + boxWidth/2)
        .attr('y1', y(mean))
        .attr('y2', y(mean))
        .attr('stroke', textColor)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '4,2')
        .style('pointer-events', 'none');

      // mean circle marker - centered on mean line
      boxGroup.append('circle')
        .attr('cx', xCenter)
        .attr('cy', y(mean))
        .attr('r', 4)
        .attr('fill', textColor)
        .attr('stroke', textColor)
        .attr('stroke-width', 1)
        .style('pointer-events', 'none');
    });

    // Add mean value labels outside the box to the right of the mean line when there are less than 7 categories total
    // Add them to the main group after all boxes are drawn so they render on top
    if (groups.length < 7) {
      const boxWidth = Math.max(10, x.bandwidth() * 0.6);
      groups.forEach(gp => {
        const mean = gp.vals.length ? (d3.mean(gp.vals) ?? 0) : 0;
        const xCenter = (x(String(gp.key)) ?? 0) + x.bandwidth()/2;
        const meanY = y(mean);
        const labelX = xCenter + boxWidth/2 + 4; // Position to the right of the mean line (right edge of box + 4px)
        
        const labelText = mean.toFixed(1);
        g.append('text')
          .attr('x', labelX)
          .attr('y', meanY)
          .attr('text-anchor', 'start')
          .attr('font-size', '10px')
          .attr('fill', textColor)
          .attr('dy', '0.35em')
          .style('pointer-events', 'none')
          .style('opacity', 1)
          .text(labelText);
      });
    }

    // Remove any existing axis labels before adding new ones
    svg.selectAll('.x-label, .y-label').remove();

    // Y-axis label in upper left (matching PerfScatter style)
    svg.append('text')
      .attr('class', 'y-label chart-element')
      .style('text-anchor', 'start')
      .attr('x', margin.left + 25)
      .attr('y', margin.top + 10)
      .attr('font-size', '16px')
      .text(yAxisLabel.toUpperCase());

    // X-axis label
    svg.append('text')
      .attr('class', 'x-label chart-element')
      .attr('text-anchor', 'middle')
      .attr('transform', `translate(${margin.left + chartWidth / 2}, ${margin.top + chartHeight + margin.bottom - 30})`)
      .attr('font-size', '12px')
      .attr('fill', textColor)
      .text(xAxisLabel);
  }

  createEffect(() => {
    // Track chart data changes to trigger redraw
    // Access the entire chart object to ensure reactivity
    const chart = props.chart;
    if (!chart) {
      logDebug('BoxPlot: No chart prop');
      return;
    }
    
    // Access data signature FIRST to ensure we track it
    // This is critical - accessing it first ensures SolidJS tracks the chart object changes
    const dataSignature = chart._dataSignature;
    
    const series = chart.series?.[0];
    if (!series) {
      logDebug('BoxPlot: No series in chart');
      return;
    }
    
    // Explicitly access the data array to ensure reactivity when it changes
    // Accessing the data directly from the series ensures SolidJS tracks it
    const data = series.originalData || series.data;
    
    // Access data length and elements to ensure reactivity when array contents change
    // Accessing multiple elements ensures we track array reference changes
    const dataLength = data?.length ?? 0;
    const firstDataPoint = data?.[0];
    const lastDataPoint = dataLength > 0 ? data?.[dataLength - 1] : null;
    // Access a middle element if available to track array mutations
    const middleDataPoint = dataLength > 2 ? data?.[Math.floor(dataLength / 2)] : null;
    
    // Access event_id from first and last points to track selection changes
    const firstEventId = firstDataPoint?.event_id;
    const lastEventId = lastDataPoint?.event_id;
    
    // Access all other reactive properties to ensure they're tracked
    series.groups;
    series.groupField;
    series.xaxis?.name;
    series.yaxis?.name;
    series.yaxis?.dataField;
    series.aggregate;
    series.yType;
    
    // Force tracking by accessing the data array reference and key properties
    // This ensures SolidJS tracks when the array reference changes or when filtering changes
    // Accessing dataSignature ensures we track when the chart object reference changes
    void dataLength;
    void firstDataPoint;
    void lastDataPoint;
    void middleDataPoint;
    void firstEventId;
    void lastEventId;
    void dataSignature; // CRITICAL: Track data signature to detect when selection changes
    
    logDebug('BoxPlot: Effect triggered', {
      dataLength,
      hasFirstPoint: !!firstDataPoint,
      firstEventId,
      lastEventId,
      hasLastPoint: !!lastDataPoint,
      dataSignature,
      dataArrayRef: data // Log array reference to verify it changes
    });
    
    // Always redraw when any tracked property changes
    draw();
  });

  onCleanup(() => {
    if (chartRef) {
      d3.select(chartRef).selectAll('*').remove();
    }
    // hide tooltip on unmount
    try { setTooltip({ visible: false, content: "", x: 0, y: 0 }); } catch {}
  });

  return (
    <div ref={el => (containerRef = el)} style={{ width: '100%', height: '100%', display: 'flex', position: 'relative' }}>
      <div
        ref={(el) => { chartRef = el as HTMLDivElement }}
        style={{ width: '100%', height: '100%' }}
      ></div>
    </div>
  );
}
