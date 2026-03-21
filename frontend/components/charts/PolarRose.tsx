import { createSignal, createEffect, onMount, onCleanup } from "solid-js";
import * as d3 from "d3";

import { tooltip, setTooltip } from "../../store/globalStore";
import { persistantStore } from "../../store/persistantStore";
import { user } from "../../store/userStore";
import { apiEndpoints } from "@config/env";
import { getData } from "../../utils/global";
import { processRoseDataWithWorker } from "../../utils/workerManager";
import { applyDataFilter } from "../../utils/dataFiltering";
import { triggerUpdate as selectionTriggerUpdate } from "../../store/selectionStore";
import { error as logError, info, debug, warn } from "../../utils/console";
import { useChartCleanup } from "../../utils/d3Cleanup";

const { selectedClassName, selectedProjectId, selectedPage } = persistantStore;

interface PolarRoseChartProps {
  objectName?: string;
  chart?: any;
}

interface SpeedRange {
  min: number;
  max: number;
}

function PolarRoseChart(props: PolarRoseChartProps) {
  let containerRef: HTMLElement | null = null;
  let chartRef: SVGSVGElement | null = null;

  // Initialize D3 cleanup
  const { addSelection, addEventListener, addTimer, addObserver, cleanup } = useChartCleanup();

  const [processedData, setProcessedData] = createSignal({});
  const [maxValue, setMaxValue] = createSignal(0);
  const [hoveredSegment, setHoveredSegment] = createSignal(null);
  const [speedBins, setSpeedBins] = createSignal({});
  const [chartConfig, setChartConfig] = createSignal(null);
  const [speedRange, setSpeedRange] = createSignal<SpeedRange>({ min: 0, max: 0 });
  const [selectedData, setSelectedData] = createSignal<any[]>([]);
  const [isVisible, setIsVisible] = createSignal(true);

  // Run ID to ignore stale worker results when effect re-runs or component unmounts
  let roseRunId = 0;
  let dataEffectDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Chart dimensions - 3x bigger than before
  const width = 1200; // 400 * 3
  const height = 1050; // 350 * 3
  const radius = Math.min(width, height) / 2 - 150; // Adjusted margin


  // Fetch chart configuration
  const fetchChartConfig = async () => {
    try {
      const objectName = props.objectName || selectedPage() || 'default';
      const response = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=polarrose&object_name=${objectName}&page_name=rose`);
      
      if (response.success && response.data && response.data.chart_info && response.data.chart_info.length > 0) {
        const chartData = response.data.chart_info[0];
        setChartConfig(chartData);
      } else {
        // No chart configuration exists
        setChartConfig(null);
      }
    } catch (error: any) {
      logError('Error fetching chart config:', error);
      setChartConfig(null);
    }
  };

  // Initialize polar rose chart - matching PolarPlot approach
  const initPolarRoseChart = () => {
    if (!chartRef) return;

    d3.select(chartRef).selectAll("*").remove();

    const svg = d3.select(chartRef)
      .append("svg")
      .attr("width", width)
      .attr("height", height)
      .attr("transform", "translate(0, 0)");

    addSelection(svg);

    const g = svg.append("g")
      .attr("transform", `translate(${width / 2}, ${height / 2})`);

    addSelection(g);

    // Create radial scale - matching PolarPlot approach with 10% margin
    const yScale = d3.scaleLinear()
      .domain([0, maxValue() * 1.1]) // 10% margin above max value
      .range([0, radius]);

    // Radial grid circles - matching PolarPlot exactly
    const radialTicks = yScale.ticks(5);
    const radialGroup = g.append("g").attr("class", "r axis");
    radialTicks.forEach(t => {
      const rr = yScale(t);
      radialGroup.append("circle")
        .attr("r", rr);
      
      // Tick labels - matching PolarPlot style exactly
      radialGroup.append("text")
        .attr("y", -rr - 4)
        .attr("transform", "rotate(20)")
        .style("text-anchor", "middle")
        .text(t);
    });

    // Angular grid lines - matching PolarPlot exactly
    const angularValues = Array.from({ length: 8 }, (_, i) => i * 45); // 0, 45, 90, 135, 180, 225, 270, 315
    const angularGroup = g.append("g").attr("class", "a axis");
    angularValues.forEach(a => {
      // Create a per-angle group so both line and label share the same rotation
      const tick = angularGroup.append("g").attr("transform", `rotate(${a - 90})`);

      tick.append("line")
        .attr("x1", 0).attr("y1", 0)
        .attr("x2", radius);

      // Place label at the end of the ray; flip for >180° to keep upright
      const flip = a > 180 && a < 360;
      const text = tick.append("text")
        .attr("x", radius + 6)
        .attr("dy", ".35em")
        .style("text-anchor", flip ? "end" : null);

      if (flip) {
        text.attr("transform", `rotate(180 ${radius + 6}, 0)`);
      }

      text.text(() => {
        if (a > 180) {
          return Math.abs(a - 360) + "°";
        } else {
          return (a * -1) + "°";
        }
      });
    });

    return { svg, g, yScale };
  };

  // Draw rose data - similar to PolarPlot's drawScatterData
  const drawRoseData = (g, yScale) => {
    const directions = Object.keys(processedData());
    if (directions.length === 0) return;

    const angleStep = 360 / 16; // Fixed 16 directions (22.5 degrees each)

    // Render stacked speed bins for each direction
    directions.forEach((dir) => {
      const dirIndex = [
        "0", "22.5", "45", "67.5", "90", "112.5", "135", "157.5",
        "180", "202.5", "225", "247.5", "270", "292.5", "315", "337.5"
      ].indexOf(dir);
      
      const startAngle = (dirIndex * angleStep - 90 - angleStep/2) * (Math.PI / 180);
      const endAngle = (dirIndex * angleStep - 90 + angleStep/2) * (Math.PI / 180);
      
      const speedBinsData = speedBins()[dir] || {};
      const sortedSpeeds = Object.keys(speedBinsData).map(Number).sort((a, b) => b - a); // Reverse order (high to low)
      
      sortedSpeeds.forEach((speed, speedIndex) => {
        const count = speedBinsData[speed];
        if (count === 0) return;
        
        // Calculate cumulative count for this speed bin (higher speeds on top)
        let cumulativeCount = 0;
        for (let i = speedIndex; i < sortedSpeeds.length; i++) {
          cumulativeCount += speedBinsData[sortedSpeeds[i]];
        }
        
        // Calculate previous cumulative count
        const previousSpeed = sortedSpeeds[speedIndex + 1];
        let previousCumulativeCount = 0;
        if (previousSpeed !== undefined) {
          for (let i = speedIndex + 1; i < sortedSpeeds.length; i++) {
            previousCumulativeCount += speedBinsData[sortedSpeeds[i]];
          }
        }
        
        const innerRadius = yScale(previousCumulativeCount); // Use yScale for proper scaling
        const outerRadius = yScale(cumulativeCount); // Use yScale for proper scaling
        
        if (outerRadius <= innerRadius) return; // Skip if no visible segment
        
        // Create arc path for this speed bin
        const x1_inner = innerRadius * Math.cos(startAngle);
        const y1_inner = innerRadius * Math.sin(startAngle);
        const x2_inner = innerRadius * Math.cos(endAngle);
        const y2_inner = innerRadius * Math.sin(endAngle);
        
        const x1_outer = outerRadius * Math.cos(startAngle);
        const y1_outer = outerRadius * Math.sin(startAngle);
        const x2_outer = outerRadius * Math.cos(endAngle);
        const y2_outer = outerRadius * Math.sin(endAngle);

        const largeArcFlag = angleStep > 180 ? 1 : 0;

        const pathData = [
          `M ${x1_inner} ${y1_inner}`,
          `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 1 ${x2_inner} ${y2_inner}`,
          `L ${x2_outer} ${y2_outer}`,
          `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 0 ${x1_outer} ${y1_outer}`,
          `Z`
        ].join(' ');

        // Calculate color based on speed using D3 color scale (blue to red)
        const getColor = (speed) => {
          if (!speed || speed === 0) return "var(--color-chart-line)"; // Light gray for no data
          
          const range = speedRange();
          if (range.min === range.max) return "var(--color-chart-axis)"; // Default blue if no range
          
          // Create a D3 color scale from blue (min) to dark red (max)
          const colorScale = d3.scaleSequential()
            .domain([range.min, range.max]) // Use stored speed range
            .interpolator(d3.interpolateRgb("#1e40af", "#dc2626")); // Blue to dark red
          
          // Use the scale directly
          return colorScale(speed);
        };

        const segmentColor = getColor(speed);

        // Add mouse event handlers
        const mouseover = function(event, d) {
          const tooltipContent = getTooltipContent(dir, speed);
          const containerRect = containerRef.getBoundingClientRect();
          const containerX = event.clientX - containerRect.left;
          const containerY = event.clientY - containerRect.top;

          setTooltip({
            visible: true,
            content: tooltipContent,
            x: containerX,
            y: containerY
          });

          setHoveredSegment(`${dir}-${speed || 'all'}`);
          
          // Increase opacity on hover
          d3.select(this).style("opacity", 1.0);
        };

        const mouseout = function() {
          setTooltip({
            visible: false,
            content: "",
            x: 0,
            y: 0
          });
          
          setHoveredSegment(null);
          
          // Reset opacity on mouse out
          d3.select(this).style("opacity", 0.7);
        };

        g.append("path")
          .attr("d", pathData)
          .attr("data-direction", dir)
          .attr("data-speed", speed)
          .style("fill", segmentColor)
          .style("cursor", "pointer")
          .style("transform-origin", "0px 0px")
          .style("opacity", 0.7) // Set initial opacity
          .on("mouseover", mouseover)
          .on("mouseout", mouseout);
      });
    });
  };

  onMount(() => {
    setIsVisible(document.visibilityState === "visible");
    fetchChartConfig();
    const onVisibilityChange = () => setIsVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibilityChange));
  });

  createEffect(() => {
    const windData = props.data || [];
    const config = chartConfig();
    const visible = isVisible();

    try { info('🌹 PolarRose: Effect triggered', {
      hasData: !!windData,
      dataLength: windData?.length || 0,
      hasConfig: !!config,
      hasSeries: !!(config?.series?.[0]),
      visible
    }); } catch {}

    // Only process if we have both data and config
    if (!windData || windData.length === 0) {
      try { warn('🌹 PolarRose: No data available'); } catch {}
      return;
    }

    if (!config || !config.series || !config.series[0]) {
      try { debug('🌹 PolarRose: Config not yet available (may still be loading)', { hasConfig: !!config }); } catch {}
      return;
    }

    // Skip heavy work when tab/window is not visible (e.g. user switched page or tab)
    if (!visible) {
      try { debug('🌹 PolarRose: Skipping processing (not visible)'); } catch {}
      return;
    }

    // Get the field names from the configuration
    const configuredXAxisName = config.series?.[0]?.xaxis?.name;
    const configuredYAxisName = config.series?.[0]?.yaxis?.name;

    try { debug('🌹 PolarRose: Field names', {
      configuredXAxisName,
      configuredYAxisName,
      series: config.series?.[0]
    }); } catch {}

    // Validate that we have the required axis names
    if (!configuredXAxisName || !configuredYAxisName) {
      logError('🌹 PolarRose: Missing axis names in chart configuration:', { configuredXAxisName, configuredYAxisName, config });
      logError('Missing axis names in chart configuration:', { configuredXAxisName, configuredYAxisName, config });
      return;
    }

    const yAxisInterval = config.series?.[0]?.yaxis?.interval || 1; // Speed bin size

    // Debounce: rapid store updates (e.g. one project click) trigger one worker run instead of many
    if (dataEffectDebounceTimer) clearTimeout(dataEffectDebounceTimer);
    const myRunId = ++roseRunId;

    dataEffectDebounceTimer = setTimeout(async () => {
      dataEffectDebounceTimer = null;
      if (document.visibilityState !== "visible") return;
      if (myRunId !== roseRunId) return;

      try {
        try { info('🌹 PolarRose: Starting data processing', {
          dataLength: windData.length,
          xAxisName: configuredXAxisName,
          yAxisName: configuredYAxisName,
          yAxisInterval
        }); } catch {}

        const result = await processRoseDataWithWorker(windData, {
          xAxisName: configuredXAxisName,
          yAxisName: configuredYAxisName,
          yAxisInterval,
          binSize: 22.5, // 16 compass directions
          validate: true
        });

        if (myRunId !== roseRunId) return;

        try { info('🌹 PolarRose: Data processing result', {
          validDataCount: result.validDataCount,
          processedCount: result.processedCount,
          maxValue: result.maxValue,
          speedRange: result.speedRange,
          totalCountsKeys: Object.keys(result.totalCounts).length,
          speedBinsKeys: Object.keys(result.speedBinsData).length
        }); } catch {}

        setProcessedData(result.totalCounts);
        setSpeedBins(result.speedBinsData);
        setMaxValue(result.maxValue);
        setSpeedRange(result.speedRange);

        try { info('🌹 Rose data processed', { valid: result.validDataCount, processed: result.processedCount }); } catch {}
      } catch (error) {
        if (myRunId !== roseRunId) return;
        logError('🌹 PolarRose: Data processing failed:', error);
        logError('Rose data processing failed:', error);
        setProcessedData({});
        setSpeedBins({});
        setMaxValue(0);
        setSpeedRange({ min: 0, max: 0 });
      }
    }, 250);

    onCleanup(() => {
      if (dataEffectDebounceTimer) {
        clearTimeout(dataEffectDebounceTimer);
        dataEffectDebounceTimer = null;
      }
      roseRunId++; // Invalidate so any in-flight promise will not apply
    });
  });

  // Main rendering effect - matching PolarPlot approach
  createEffect(() => {
    if (!chartRef) return;

    const { g, yScale } = initPolarRoseChart();
    drawRoseData(g, yScale);
  });

  // Effect to handle selection changes using applyDataFilter (which includes selectedRange)
  createEffect(() => {
    const shouldTrigger = selectionTriggerUpdate();
    if (!shouldTrigger || !props.data || props.data.length === 0) return;
    if (document.visibilityState !== "visible") return;

    try { info('PolarRose responding to selection change'); } catch {}

    const filteredData = applyDataFilter(props.data);
    setSelectedData(filteredData);

    const config = chartConfig();
    if (!config?.series?.[0]) return;
    const configuredXAxisName = config.series[0].xaxis?.name;
    const configuredYAxisName = config.series[0].yaxis?.name;
    const yAxisInterval = config.series[0].yaxis?.interval || 1;
    if (!configuredXAxisName || !configuredYAxisName) return;

    const selectionRunId = ++roseRunId;
    (async () => {
      try {
        const result = await processRoseDataWithWorker(filteredData, {
          xAxisName: configuredXAxisName,
          yAxisName: configuredYAxisName,
          yAxisInterval,
          binSize: 22.5,
          validate: true
        });
        if (selectionRunId !== roseRunId) return;
        setProcessedData(result.totalCounts);
        setSpeedBins(result.speedBinsData);
        setMaxValue(result.maxValue);
        setSpeedRange(result.speedRange);
      } catch (error) {
        if (selectionRunId === roseRunId) logError('Rose selection data processing failed:', error);
      }
    })();
  });

  onCleanup(() => {
    if (dataEffectDebounceTimer) {
      clearTimeout(dataEffectDebounceTimer);
      dataEffectDebounceTimer = null;
    }
    roseRunId++;
    cleanup();
  });


  const getTooltipContent = (dir, speed = null) => {
    const totalCount = processedData()[dir] || 0;
    const speedBinsData = speedBins()[dir] || {};
    const config = chartConfig();
    const yAxisInterval = config?.series?.[0]?.yaxis?.interval || 1;
    
    // Use the configured field names for display (what the user configured)
    const displayXAxisName = config?.series?.[0]?.xaxis?.name || 'Twd';
    const displayYAxisName = config?.series?.[0]?.yaxis?.name || 'Tws';
    
    if (speed !== null) {
      // Show specific speed bin information
      const binCount = speedBinsData[speed] || 0;
      const percentage = totalCount > 0 ? (binCount / totalCount) * 100 : 0;
      
      return `
        <table class='table-striped'>
          <tr><td>${displayXAxisName}</td><td>${dir}°</td></tr>
          <tr><td>${displayYAxisName}</td><td>${speed}-${speed + yAxisInterval}</td></tr>
          <tr><td>Count</td><td>${binCount}</td></tr>
          <tr><td>Percentage</td><td>${percentage.toFixed(1)}%</td></tr>
          <tr><td>Total Count</td><td>${totalCount}</td></tr>
        </table>
      `;
    } else {
      // Show overall direction information
      const speedDistribution = Object.entries(speedBinsData)
        .filter(([_, count]) => count > 0)
        .map(([knot, count]) => {
          const percentage = totalCount > 0 ? (count / totalCount) * 100 : 0;
          return `${knot}-${parseInt(knot) + yAxisInterval}kt: ${count} (${percentage.toFixed(1)}%)`;
        })
        .slice(0, 5) // Show top 5 speed ranges
        .join('<br/>');

      return `
        <table class='table-striped'>
          <tr><td>${displayXAxisName}</td><td>${dir}°</td></tr>
          <tr><td>Total Count</td><td>${totalCount}</td></tr>
          <tr><td colspan="2"><small>${displayYAxisName} Distribution:<br/>${speedDistribution}</small></td></tr>
        </table>
      `;
    }
  };


  return (
    <div ref={el => (containerRef = el)} class="polar-rose-container w-full h-full flex flex-col justify-center items-center">
      
      {/* Tooltip */}
      <div
        id="tt"
        class="tooltip polar-rose-tooltip"
        style={{
          opacity: tooltip().visible ? 1 : 0,
          left: `${tooltip().x}px`,
          top: `${tooltip().y}px`,
        }}
        innerHTML={tooltip().content}
      ></div>

      {/* Chart Container */}
      <div ref={(el) => (chartRef = el)} class="polar-rose-chart-container"></div>
    </div>
  );
}

export default PolarRoseChart;
