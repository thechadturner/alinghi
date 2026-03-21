import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import * as d3 from "d3";
import { warn as logWarn, error as logError } from "../../../utils/console";
import { selectedTime, isPlaying, playbackSpeed } from "../../../store/playbackStore";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";

interface SparklineProps {
  config?: any;
  liveMode?: boolean;
  sourceMode?: string;
  selectedSourceIds?: () => Set<string>;
  color?: string;
  channelName?: string;
  timespan?: number;
  sparklineWidth?: number;
  height?: number;
  backgroundColor?: string;
  opacity?: number;
  /** When provided (e.g. from Overlay), use this row for current value. Updates when selectedTime changes. */
  dataRow?: any;
  /** When provided (e.g. from Overlay), full timeseries for sparkline window. Filter by selectedTime + timespan. */
  timeseriesData?: any[];
  /** Live mode: real-time data array (or accessor). */
  liveData?: any[] | (() => any[]);
}

export default function Sparkline(props: SparklineProps) {
  const { config } = props;
  const liveMode = props?.liveMode || false;
  const sourceMode = props?.sourceMode || 'single';
  const selectedSourceIds = props?.selectedSourceIds || (() => new Set());
  
  // Accept color, channelName, timespan, sparklineWidth, height, backgroundColor, and opacity as props (with fallbacks)
  const propColor = props?.color;
  const propChannelName = props?.channelName;
  const propTimespan = props?.timespan;
  const propSparklineWidth = props?.sparklineWidth;
  const propHeight = props?.height;
  const propBackgroundColor = props?.backgroundColor;
  const propOpacity = props?.opacity;
  
  // Use defaultChannelsStore for channel names
  const { bspName } = defaultChannelsStore;

  // Resolve values: props > config > defaults
  const timespan = propTimespan ?? config?.timespan ?? config?.duration ?? 30; // Default 30 seconds
  const channelName = propChannelName ?? config?.valueChannel ?? config?.channel ?? bspName();
  const defaultColor = propColor ?? config?.color ?? "#10b981"; // Default green
  const sparklineWidth = propSparklineWidth ?? config?.sparklineWidth ?? config?.width ?? 150; // Default 150px
  const componentHeight = propHeight ?? config?.height ?? 60; // Default 60px (matches current min-height)
  const backgroundColor = propBackgroundColor ?? config?.backgroundColor ?? "#1f2937"; // Default dark gray
  const backgroundOpacity = propOpacity ?? config?.opacity ?? 1.0; // Default full opacity
  
  // Calculate scale factor based on height (default is 60px)
  const baseHeight = 60;
  const scaleFactor = componentHeight / baseHeight;
  
  let containerRef: HTMLElement | null = null;
  let svgRef: SVGSVGElement | null = null;
  let svg: any = null;
  
  const [currentValue, setCurrentValue] = createSignal(0);
  const [sparklineColor, setSparklineColor] = createSignal(defaultColor);
  const [isLoading, setIsLoading] = createSignal(true);
  const [liveSparklineData, setLiveSparklineData] = createSignal<any[]>([]);
  const [liveCurrentRow, setLiveCurrentRow] = createSignal<any>({});
  let resizeObserver: ResizeObserver | null = null;

  // Effective row: from parent (dataRow) or live mode (liveCurrentRow)
  const effectiveRow = (): any => {
    if (props.dataRow != null) {
      const r = typeof props.dataRow === 'function' ? props.dataRow() : props.dataRow;
      return r ?? {};
    }
    return liveCurrentRow() ?? {};
  };

  // Data for sparkline: from parent (timeseriesData) or live mode (liveSparklineData)
  const effectiveTimeseriesData = (): any[] => {
    const ts = props.timeseriesData;
    if (ts != null && Array.isArray(ts)) return ts;
    return liveSparklineData();
  };

  // Get value from data point using channel name (handles case-insensitive matching)
  // Per repo rules: data fields from API are stored in lowercase, but configs use descriptive names
  const getValueFromData = (dataPoint: any, channelName: string): number | null => {
    if (!dataPoint || !channelName) return null;
    
    // Try multiple case variations to handle different naming conventions
    const variations = [
      channelName,                    // Original case (e.g., "Tws", "Bsp")
      channelName.toLowerCase(),      // Lowercase (e.g., "tws", "bsp") - per repo rules
      channelName.toUpperCase(),      // Uppercase (e.g., "TWS", "BSP")
      channelName.charAt(0).toUpperCase() + channelName.slice(1).toLowerCase(), // Title case (e.g., "Tws", "Bsp")
    ];
    
    // Also try with underscores converted to different cases
    if (channelName.includes('_')) {
      variations.push(
        channelName.replace(/_/g, '').toLowerCase(),  // Remove underscores, lowercase (e.g., "vmgperc")
        channelName.replace(/_/g, ''),                // Remove underscores, original (e.g., "Vmgperc")
        channelName.replace(/_/g, '').toUpperCase()  // Remove underscores, uppercase (e.g., "VMGPERC")
      );
    }
    
    // Also try case-insensitive key matching (in case data has different case)
    const dataKeys = Object.keys(dataPoint || {});
    const matchingKey = dataKeys.find(key => key.toLowerCase() === channelName.toLowerCase());
    if (matchingKey) {
      variations.push(matchingKey);
    }
    
    // Try each variation
    for (const variant of variations) {
      if (dataPoint[variant] !== undefined && dataPoint[variant] !== null) {
        const value = Number(dataPoint[variant]);
        if (!isNaN(value) && isFinite(value)) {
          return value;
        }
      }
    }
    
    return null;
  };

  // Calculate color based on value (similar to Donut, simplified)
  const calculateColor = (value: number): string => {
    // Use prop color if provided, otherwise config color, otherwise default
    if (propColor) return propColor;
    if (config?.color) return config.color;
    
    // Default green for now (can be enhanced with threshold logic like Donut)
    return "#10b981";
  };

  // Filter data to rolling time window
  const filterDataByTimeWindow = (data, currentTime, durationSeconds) => {
    if (!data || data.length === 0 || !currentTime) return [];
    
    const windowStart = new Date(currentTime.getTime() - (durationSeconds * 1000));
    const windowEnd = currentTime;
    
    return data.filter(d => {
      const timestamp = d.Datetime ?? d.datetime;
      if (!timestamp) return false;
      
      const timestampDate = timestamp instanceof Date ? timestamp : new Date(timestamp);
      if (isNaN(timestampDate.getTime())) return false;
      
      return timestampDate >= windowStart && timestampDate <= windowEnd;
    });
  };

  // For live mode, watch for real-time data updates from props
  createEffect(() => {
    if (liveMode && props?.liveData) {
      const liveData = typeof props.liveData === 'function' ? props.liveData() : props.liveData;
      if (liveData && Array.isArray(liveData) && liveData.length > 0) {
        const latestPoint = liveData[liveData.length - 1];
        if (latestPoint) {
          setLiveCurrentRow(latestPoint);
        }
        const now = new Date();
        const windowData = filterDataByTimeWindow(liveData, now, timespan);
        setLiveSparklineData(windowData);
      }
    }
  });

  // Update current value and color from effective row (dataRow from Overlay or liveCurrentRow)
  createEffect(() => {
    const row = effectiveRow();
    if (!row || Object.keys(row).length === 0) {
      setIsLoading(props.dataRow == null && !liveMode);
      return;
    }

    try {
      const value = getValueFromData(row, channelName);
      
      if (value != null) {
        setCurrentValue(value);
        const color = calculateColor(value);
        setSparklineColor(color);
        setIsLoading(false);
      } else {
        logWarn('Sparkline: Could not extract value from data using channel:', channelName);
        setIsLoading(true);
      }
    } catch (error: any) {
      logError('Sparkline: Error processing data:', error);
      setIsLoading(true);
    }
  });

  // Draw sparkline using D3
  const drawSparkline = (currentTimeOverride = null) => {
    if (!svgRef || isLoading()) return;
    
    const container = svgRef.parentElement;
    if (!container) return;
    
    const width = sparklineWidth; // Use prop/config width for sparkline area
    const height = 40 * scaleFactor; // Scale sparkline height proportionally
    const margin = { top: 5 * scaleFactor, right: 5 * scaleFactor, bottom: 5 * scaleFactor, left: 5 * scaleFactor };
    
    // Get current time for filtering - use override if provided, otherwise read from signal
    const currentTime = currentTimeOverride || (liveMode ? new Date() : selectedTime());
    if (!currentTime) return;
    
    // Get data and filter to time window (timeseriesData from Overlay or liveSparklineData)
    const allData = effectiveTimeseriesData();
    const windowData = filterDataByTimeWindow(allData, currentTime, timespan);
    
    if (windowData.length === 0) {
      // Clear SVG if no data
      if (svgRef) {
        d3.select(svgRef).selectAll("*").remove();
      }
      return;
    }
    
    // Prepare data for sparkline
    const sparklinePoints = windowData
      .map(d => {
        const timestamp = d.Datetime ?? d.datetime;
        const value = getValueFromData(d, channelName);
        if (!timestamp || value == null) return null;
        
        const timestampDate = timestamp instanceof Date ? timestamp : new Date(timestamp);
        if (isNaN(timestampDate.getTime())) return null;
        
        return {
          time: timestampDate,
          value: value
        };
      })
      .filter(d => d != null)
      .sort((a, b) => a.time.getTime() - b.time.getTime());
    
    if (sparklinePoints.length === 0) {
      d3.select(svgRef).selectAll("*").remove();
      return;
    }
    
    // Get or create SVG selection
    const svgSelection = d3.select(svgRef);
    const playing = isPlaying();
    
    // Create scales
    const xScale = d3.scaleTime()
      .domain(d3.extent(sparklinePoints, d => d.time))
      .range([margin.left, width - margin.right]);
    
    const yScale = d3.scaleLinear()
      .domain(d3.extent(sparklinePoints, d => d.value))
      .range([height - margin.bottom, margin.top]);
    
    // Create line generator
    const line = d3.line()
      .x(d => xScale(d.time))
      .y(d => yScale(d.value))
      .defined(d => d.value != null && !isNaN(d.value));
    
    if (playing) {
      // When playing: use enter/update/exit pattern for smooth updates
      // Get or create SVG
      if (!svg || !svg.node()) {
        svgSelection.selectAll("svg").remove();
        svg = svgSelection
          .append("svg")
          .attr("width", width)
          .attr("height", height);
      } else {
        svg.attr("width", width).attr("height", height);
      }
      
      // Select existing path and bind new data
      const pathSelection = svg.selectAll("path.sparkline-path")
        .data([sparklinePoints]); // Wrap in array since we have one path
      
      // Calculate transition duration based on playback speed (similar to boat animation)
      // Base duration: 200ms, adjusted by playback speed
      const baseDuration = 200;
      const speed = playbackSpeed() || 1;
      const transitionDuration = Math.max(50, baseDuration / speed); // Faster playback = shorter transition
      
      // Enter: create new path if it doesn't exist
      const pathEnter = pathSelection.enter()
        .append("path")
        .attr("class", "sparkline-path")
        .attr("fill", "none")
        .attr("stroke", sparklineColor())
        .attr("stroke-width", 2 * scaleFactor)
        .attr("d", line); // Set initial path for new elements (no transition on enter)
      
      // Update: update existing path with smooth transition
      if (pathSelection.size() > 0) {
        // Existing path - use transition for smooth animation
        pathSelection
          .transition()
          .duration(transitionDuration)
          .ease(d3.easeQuadInOut)
          .attr("stroke", sparklineColor())
          .attr("d", line);
      }
      
      // Exit: remove path if data is empty (shouldn't happen, but handle it)
      pathSelection.exit().remove();
    } else {
      // When not playing: clear and redraw
      svgSelection.selectAll("svg").remove();
      
      // Create new SVG
      svg = svgSelection
        .append("svg")
        .attr("width", width)
        .attr("height", height);
      
      // Draw sparkline
      svg.append("path")
        .attr("class", "sparkline-path")
        .datum(sparklinePoints)
        .attr("fill", "none")
        .attr("stroke", sparklineColor())
        .attr("stroke-width", 2 * scaleFactor)
        .attr("d", line);
    }
  };

  // Redraw sparkline when data, values, selectedTime, or playing state changes
  createEffect(() => {
    const loading = isLoading();
    const data = effectiveTimeseriesData();
    const current = currentValue();
    const color = sparklineColor();
    const time = liveMode ? new Date() : selectedTime();
    const playing = isPlaying();
    
    if (!loading && data.length > 0 && time) {
      drawSparkline(time);
    }
  });

  // Handle resize
  onMount(() => {
    if (svgRef && window.ResizeObserver) {
      resizeObserver = new ResizeObserver(() => {
        drawSparkline();
      });
      const container = svgRef.parentElement;
      if (container) {
        resizeObserver.observe(container);
      }
    }
  });

  onCleanup(() => {
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    if (svg && svg.node()) {
      svg.remove();
      svg = null;
    }
  });

  // Format value for display
  const formatValue = (val) => {
    if (val === undefined || val === null) return "N/A";
    if (isNaN(val)) return "NaN";
    
    if (config?.format === 'integer') {
      return Math.round(val).toLocaleString();
    } else if (config?.format === 'decimal') {
      return val.toFixed(1);
    } else if (config?.format === 'percentage') {
      return `${val.toFixed(1)}%`;
    }
    return val.toFixed(1);
  };

  const label = config?.label || channelName;

  // Helper function to convert hex to rgba
  const hexToRgba = (hex: string, alpha: number): string => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  // Calculate scaled dimensions and font sizes
  const scaledPadding = 8 * scaleFactor;
  const scaledLabelFontSize = 0.875 * scaleFactor; // rem units
  const scaledValueFontSize = 30 * scaleFactor; // px
  const scaledLabelMarginBottom = 4 * scaleFactor;
  const scaledGap = 8 * scaleFactor;
  const scaledValueWidth = 90 * scaleFactor;
  const scaledSpinnerSize = 20 * scaleFactor;
  const scaledSparklineHeight = 40 * scaleFactor;

  return (
    <div class="sparkline-component" style={{ 
      "position": "relative", 
      "width": "fit-content", 
      "min-height": `${componentHeight}px`, 
      "display": "flex", 
      "flex-direction": "column", 
      "background": hexToRgba(backgroundColor, backgroundOpacity), 
      "border-radius": `${6 * scaleFactor}px`, 
      "padding": `${scaledPadding}px`
    }}>
      {/* Label at top */}
      <Show when={label}>
        <div style={{ 
          "font-size": `${scaledLabelFontSize}rem`, 
          "font-weight": "500", 
          "color": sparklineColor(), 
          "margin-bottom": `${scaledLabelMarginBottom}px` 
        }}>
          {label}
        </div>
      </Show>
      
      {/* Value and sparkline container - sparkline starts right after the value */}
      <div style={{ "display": "flex", "gap": `${scaledGap}px`, "align-items": "flex-end" }}>
        {/* Value text on left - fixed width for consistent component sizing */}
        <div style={{ "flex": "0 0 auto", "width": `${scaledValueWidth}px`, "text-align": "right" }}>
          <Show when={isLoading()}>
            <div style="text-align: center;">
              <div class="spinner" style={{ 
                "width": `${scaledSpinnerSize}px`, 
                "height": `${scaledSpinnerSize}px`, 
                "border": `${2 * scaleFactor}px solid #374151`, 
                "border-top": `${2 * scaleFactor}px solid #3b82f6`, 
                "border-radius": "50%", 
                "animation": "spin 1s linear infinite", 
                "margin": "0 auto"
              }}></div>
            </div>
          </Show>
          <Show when={!isLoading()}>
            <span class="value" style={{ 
              "font-size": `${scaledValueFontSize}px`, 
              "font-weight": "bold", 
              "color": sparklineColor() 
            }}>
              {formatValue(currentValue())}
            </span>
          </Show>
        </div>
        
        {/* Sparkline starts right after the value and extends to the right */}
        <div 
          ref={svgRef}
          style={`flex: 0 0 auto; width: ${sparklineWidth}px; height: ${scaledSparklineHeight}px; overflow: hidden;`}
        />
      </div>
      
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

