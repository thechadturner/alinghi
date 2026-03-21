import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import * as d3 from "d3";
import { warn as logWarn, error as logError } from "../../../utils/console";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";

interface Donut180DotProps {
  config?: any;
  liveMode?: boolean;
  sourceMode?: string;
  selectedSourceIds?: () => Set<string>;
  height?: number;
  backgroundColor?: string;
  opacity?: number;
  /** When provided (e.g. from Overlay), use this row for current value. Accessor so updates when selectedTime changes. */
  dataRow?: any;
  /** When provided (e.g. from Overlay), use for 2-minute rolling mean. Same timeline as dataRow. */
  timeseriesData?: any[] | (() => any[]);
  /** Live mode: real-time data array (or accessor). */
  liveData?: any[] | (() => any[]);
}

export default function Donut(props: Donut180DotProps) {
  const { config } = props;
  const liveMode = props?.liveMode || false;
  const sourceMode = props?.sourceMode || 'single';
  const selectedSourceIds = props?.selectedSourceIds || (() => new Set());

  // Use defaultChannelsStore for channel names
  const { bspName } = defaultChannelsStore;
  
  // Accept height prop (from config or props, default to 150)
  const propHeight = props?.height;
  const height = propHeight ?? config?.height ?? 150;
  
  // Accept backgroundColor and opacity from props (for overlay container styling)
  const backgroundColor = props?.backgroundColor || "#FFFFFF";
  const opacity = props?.opacity ?? 1.0;
  
  // Helper function to convert hex to rgba
  const hexToRgba = (hex: string, alpha: number): string => {
    if (!hex) return `rgba(255, 255, 255, ${alpha})`;
    if (hex.startsWith('#')) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    // If already rgba or rgb, try to extract and modify
    if (hex.startsWith('rgba')) {
      return hex.replace(/[\d\.]+\)$/g, `${alpha})`);
    }
    if (hex.startsWith('rgb')) {
      return hex.replace('rgb', 'rgba').replace(')', `, ${alpha})`);
    }
    return hex;
  };
  
  let containerRef: HTMLElement | null = null;
  let svg: any = null;
  let gaugeGroup: any = null;
  
  const [currentValue, setCurrentValue] = createSignal(0);
  const [targetValue, setTargetValue] = createSignal<number | null>(null);
  const [warningValue, setWarningValue] = createSignal<number | null>(null);
  const [alarmValue, setAlarmValue] = createSignal<number | null>(null);
  const [gaugeColor, setGaugeColor] = createSignal("#10b981"); // Default green
  const [isLoading, setIsLoading] = createSignal(true);
  const [minValue, setMinValue] = createSignal(0);
  const [maxValue, setMaxValue] = createSignal(100);
  const [maxDataValue, setMaxDataValue] = createSignal(100); // Actual maximum value from data (no padding)
  let maxDataValueSet = false; // Flag to track if maxDataValue has been set (for non-live mode)
  
  // Delta gauge signals
  const [twoMinuteMean, setTwoMinuteMean] = createSignal<number | null>(null);
  const [deltaValue, setDeltaValue] = createSignal(0);
  const [deltaMin, setDeltaMin] = createSignal(0);
  const [deltaMax, setDeltaMax] = createSignal(0);
  const [hasTwoMinutesData, setHasTwoMinutesData] = createSignal(false);
  
  // Live mode only: hold current row when not using dataRow from parent
  const [liveCurrentRow, setLiveCurrentRow] = createSignal<any>({});
  const [liveGaugeData, setLiveGaugeData] = createSignal<any[]>([]);

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
    
    // Try each variation
    for (const variant of variations) {
      if (dataPoint[variant] !== undefined && dataPoint[variant] !== null) {
        const value = Number(dataPoint[variant]);
        if (!isNaN(value) && isFinite(value)) {
          return value;
        }
      }
    }
    
    // If no direct match, try case-insensitive key search
    const dataKeys = Object.keys(dataPoint);
    const matchingKey = dataKeys.find(key => 
      key.toLowerCase() === channelName.toLowerCase() ||
      key.toLowerCase().replace(/_/g, '') === channelName.toLowerCase().replace(/_/g, '')
    );
    
    if (matchingKey) {
      const value = Number(dataPoint[matchingKey]);
      if (!isNaN(value) && isFinite(value)) {
        return value;
      }
    }
    
    return null;
  };

  // Get threshold value (from channel or fixed)
  const getThresholdValue = (dataPoint: any, configKey: string): number | null => {
    const configValue = config?.[configKey];
    if (configValue == null) return null;
    
    // If it's a number, use it as fixed value
    if (typeof configValue === 'number') return configValue;
    
    // If it's a string, treat it as channel name
    if (typeof configValue === 'string') {
      return getValueFromData(dataPoint, configValue);
    }
    
    return null;
  };

  // Calculate 2-minute rolling mean from data points before currentTime
  // Optimized with binary search for O(log n) lookup instead of O(n) filter
  const calculateTwoMinuteMean = (currentTime, data, valueChannel) => {
    if (!currentTime || !data || data.length === 0) {
      return { mean: null, hasTwoMinutes: false };
    }

    try {
      const currentTimeMs = new Date(currentTime).getTime();
      if (isNaN(currentTimeMs)) {
        return { mean: null, hasTwoMinutes: false };
      }

      const twoMinutesMs = 2 * 60 * 1000; // 2 minutes in milliseconds
      const windowStart = currentTimeMs - twoMinutesMs;

      // Use binary search to find the start of the window (O(log n) instead of O(n))
      let left = 0;
      let right = data.length - 1;
      let startIdx = data.length; // Default to end if no valid start found
      
      while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const midTime = new Date(data[mid].Datetime ?? data[mid].datetime).getTime();
        
        if (isNaN(midTime)) {
          left = mid + 1;
          continue;
        }
        
        if (midTime >= windowStart) {
          startIdx = mid;
          right = mid - 1;
        } else {
          left = mid + 1;
        }
      }

      // Collect values from startIdx to end (all points within window)
      const values = [];
      let firstTime = null;
      let lastTime = null;
      
      for (let i = startIdx; i < data.length; i++) {
        const point = data[i];
        const pointTime = new Date(point.Datetime ?? point.datetime).getTime();
        
        if (isNaN(pointTime)) continue;
        
        // Stop if we've gone past the current time
        if (pointTime > currentTimeMs) break;
        
        if (pointTime >= windowStart && pointTime <= currentTimeMs) {
          const value = getValueFromData(point, valueChannel);
          if (value != null) {
            values.push(value);
            if (firstTime === null) firstTime = pointTime;
            lastTime = pointTime;
          }
        }
      }

      if (values.length === 0) {
        return { mean: null, hasTwoMinutes: false };
      }

      // Calculate mean
      const mean = values.reduce((sum, val) => sum + val, 0) / values.length;

      // Check if we have at least 2 minutes of time span
      const timeSpan = lastTime && firstTime ? lastTime - firstTime : 0;
      const hasTwoMinutes = timeSpan >= twoMinutesMs * 0.9; // Allow 90% of 2 minutes as threshold

      return { mean, hasTwoMinutes };
    } catch (error: any) {
      logError('❌ Donut180: Error calculating 2-minute mean:', error);
      return { mean: null, hasTwoMinutes: false };
    }
  };

  // Calculate gauge color based on delta value
  const calculateDeltaColor = (delta) => {
    if (delta > 0) {
      return "#ef4444"; // Red - current > mean
    } else if (delta < 0) {
      return "#10b981"; // Green - current < mean
    } else {
      return "#6b7280"; // Gray - current === mean
    }
  };

  // Effective row: from parent (dataRow) or live mode (liveCurrentRow)
  const effectiveRow = (): any => {
    if (props.dataRow != null) {
      const r = typeof props.dataRow === 'function' ? props.dataRow() : props.dataRow;
      return r ?? {};
    }
    return liveCurrentRow() ?? {};
  };

  // Data for 2-minute mean: from parent (timeseriesData) or live mode (liveGaugeData)
  const allDataForMean = (): any[] => {
    const ts = props.timeseriesData;
    if (ts != null) {
      return Array.isArray(ts) ? ts : (typeof ts === 'function' ? ts() : []);
    }
    return liveGaugeData();
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
        setLiveGaugeData(liveData);
      }
    }
  });
  
  // Calculate maxDataValue from all data when we have it (timeseriesData or liveGaugeData)
  createEffect(() => {
    const allData = allDataForMean();
    const valueChannel = config?.valueChannel || config?.channel || 'Bsp_kts';
    
    if (allData && allData.length > 0) {
      const allValues = allData
        .map((d: any) => getValueFromData(d, valueChannel))
        .filter((v: number | null) => v != null);
      
      if (allValues.length > 0) {
        const dataMax = Math.max(...(allValues as number[]));
        if (liveMode || !maxDataValueSet) {
          setMaxDataValue(dataMax);
          maxDataValueSet = true;
        }
      }
    }
  });
  
  // Update values from current row and calculate delta (dataRow from Overlay or liveCurrentRow)
  createEffect(() => {
    const row = effectiveRow();
    if (!row || Object.keys(row).length === 0) {
      setIsLoading(props.dataRow == null && !liveMode);
      return;
    }

    try {
      const valueChannel = config?.valueChannel || config?.channel || bspName();
      const value = getValueFromData(row, valueChannel);
      
      if (value != null) {
        setCurrentValue(value);
        
        const currentTime = row.Datetime ?? row.datetime;
        const allData = allDataForMean();
        
        // Calculate 2-minute rolling mean
        if (allData && allData.length > 0 && currentTime) {
          const meanResult = calculateTwoMinuteMean(currentTime, allData, valueChannel);
          setTwoMinuteMean(meanResult.mean);
          setHasTwoMinutesData(meanResult.hasTwoMinutes);
          
          // Calculate delta (reversed: mean - value)
          if (meanResult.mean != null) {
            const delta = meanResult.mean - value;
            setDeltaValue(delta);
            
            // Optimized delta range calculation - use a sliding window approach instead of calculating mean for every point
            // Sample data points at intervals to estimate delta range, or use a more efficient method
            const allValues = allData
              .map(d => getValueFromData(d, valueChannel))
              .filter(v => v != null);
            
            if (allValues.length > 0) {
              // Use a more efficient approach: calculate mean for a sample of points instead of all
              // Or use the overall data range as a proxy for delta range
              const dataMin = Math.min(...allValues);
              const dataMax = Math.max(...allValues);
              const dataRange = dataMax - dataMin;
              
              // Estimate delta range based on data variability
              // Delta can be roughly estimated as a percentage of the data range
              // Use a conservative estimate: delta range is typically 10-20% of data range
              const estimatedDeltaRange = Math.max(dataRange * 0.15, Math.abs(delta) * 2, 1);
              
              // Center the range around zero, with padding
              const padding = estimatedDeltaRange * 0.1;
              setDeltaMin(-estimatedDeltaRange - padding);
              setDeltaMax(estimatedDeltaRange + padding);
            } else {
              // Fallback: use current delta as range
              const absDelta = Math.abs(delta);
              setDeltaMin(-Math.max(absDelta, 1));
              setDeltaMax(Math.max(absDelta, 1));
            }
            
            // Set color based on delta
            const color = calculateDeltaColor(delta);
            setGaugeColor(color);
          } else {
            // No mean available yet
            setDeltaValue(0);
            setGaugeColor("#6b7280"); // Gray
          }
        } else {
          setDeltaValue(0);
          setGaugeColor("#6b7280"); // Gray
        }
        
        setIsLoading(false);
      } else {
        logWarn('Donut180: Could not extract value from data using channel:', valueChannel);
        setIsLoading(true);
      }
    } catch (error: any) {
      logError('Donut180: Error processing data:', error);
      setIsLoading(true);
    }
  });

  // Draw gauge using D3
  const drawGauge = () => {
    if (!containerRef || isLoading()) return;
    
    const container = containerRef;
    // Use prop height if provided, otherwise use container dimensions
    const containerWidth = container.clientWidth || 300;
    const containerHeight = container.clientHeight || 300;
    const hasCustomHeight = propHeight ?? config?.height;
    const gaugeHeight = hasCustomHeight ? height : containerHeight;
    const gaugeWidth = hasCustomHeight ? height : containerWidth; // Use height for both dimensions (square)
    const hasLabelBelow = config?.labelPosition === 'bottom' && (config?.label ?? config?.valueChannel ?? config?.channel);
    const labelHeight = hasLabelBelow ? 30 * (height / 150) : 0; // Scale label height
    const availableHeight = gaugeHeight - labelHeight;
    const size = Math.min(gaugeWidth, availableHeight);
    const radius = size / 2 - 15 * (height / 150); // Scale margin with height
    // Center the gauge properly - scale the offset proportionally
    const centerX = gaugeWidth / 2; // Center horizontally
    const centerY = (availableHeight / 2) + (labelHeight > 0 ? 0 : 0);
    
    // Clear previous SVG
    d3.select(container).selectAll("svg").remove();
    
    // Create SVG
    svg = d3.select(container)
      .append("svg")
      .attr("width", gaugeWidth)
      .attr("height", gaugeHeight);
    
    gaugeGroup = svg.append("g")
      .attr("transform", `translate(${centerX}, ${centerY})`);
    
    const delta = deltaValue();
    const deltaMinVal = deltaMin();
    const deltaMaxVal = deltaMax();
    const color = gaugeColor();
    const hasTwoMinutes = hasTwoMinutesData();
    
    // Create arc generator for gauge - 180° arc rotated 180° from previous position
    // Previous: 180° to 0° (passing through 90°), zero at 90° (top)
    // Rotated 180°: 0° to 180° (passing through 270°), zero at 270° (bottom)
    // D3 coordinate system: 0° = top, positive clockwise
    // Standard: 0° = right, positive counterclockwise
    // Conversion: D3_angle = (90 - standard_angle) * π/180
    // 0° standard = (90 - 0) * π/180 = π/2 radians (right side)
    // 180° standard = (90 - 180) * π/180 = -π/2 radians (left side)
    // 270° standard = (90 - 270) * π/180 = -π radians (center/bottom - zero point)
    // For D3 arc drawing (clockwise), we need: startAngle < endAngle
    // So we use: startAngle = -π/2 (left), endAngle = π/2 (right) to draw counterclockwise visually
    // But D3 will draw clockwise, so we need to go the long way: -π/2 → -π → π → π/2
    // Actually, to draw from right to left (counterclockwise), we use: startAngle = π/2, endAngle = 3π/2
    const startAngle = Math.PI / 2; // 0° standard (right side) = π/2 D3
    const endAngle = (3 * Math.PI) / 2; // 180° standard (left side) = 3π/2 D3 (going clockwise from right)
    const zeroAngle = Math.PI; // 270° standard (center/bottom) = π D3
    
    // Arc for border/outline (color zones)
    const borderArc = d3.arc()
      .innerRadius(radius * 0.65)
      .outerRadius(radius)
      .startAngle(startAngle)
      .endAngle(endAngle)
      .cornerRadius(2);
    
    // Arc for filled value indicator (thinner, inside the border)
    // Don't set startAngle/endAngle here - they come from the datum
    const filledArc = d3.arc()
      .innerRadius(radius * 0.7)
      .outerRadius(radius * 0.95)
      .cornerRadius(2);
    
    // Draw border arc (full 180° span)
    gaugeGroup.append("path")
      .datum({ startAngle: startAngle, endAngle: endAngle })
      .attr("d", borderArc)
      .attr("fill", "none")
      .attr("stroke", color)
      .attr("stroke-width", 1)
      .attr("opacity", 0.9);
    
    // Calculate filled arc based on delta value
    // Delta range: [deltaMinVal, deltaMaxVal]
    // Zero point is at zeroAngle (270° = π in D3, center/bottom)
    // Arc spans from startAngle (0° = π/2, right) to endAngle (180° = 3π/2, left) going clockwise
    // Positive delta extends from zeroAngle toward endAngle (left side, toward 180°)
    // Negative delta extends from startAngle toward zeroAngle (right side, toward 0°)
    
    let filledStartAngle = zeroAngle;
    let filledEndAngle = zeroAngle;
    const arcOpacity = hasTwoMinutes ? 1.0 : 0.3;
    
    if (delta !== 0 && deltaMinVal !== deltaMaxVal) {
      // Calculate the total arc span
      const totalSpan = endAngle - startAngle; // π radians (180°)
      
      // Map delta to angle position
      // deltaMinVal -> startAngle (π/2, right side)
      // 0 -> zeroAngle (π, center/bottom)
      // deltaMaxVal -> endAngle (3π/2, left side)
      
      if (delta > 0) {
        // Positive delta: fill from zeroAngle toward endAngle (left side, toward 180°)
        // Map delta from [0, deltaMaxVal] to [zeroAngle, endAngle]
        const positiveRange = deltaMaxVal;
        if (positiveRange > 0) {
          const ratio = Math.min(1, delta / positiveRange);
          filledStartAngle = zeroAngle;
          filledEndAngle = zeroAngle + (ratio * (endAngle - zeroAngle));
        }
      } else if (delta < 0) {
        // Negative delta: fill from startAngle toward zeroAngle (right side, toward 0°)
        // Map delta from [deltaMinVal, 0] to [startAngle, zeroAngle]
        const negativeRange = Math.abs(deltaMinVal);
        if (negativeRange > 0) {
          const ratio = Math.min(1, Math.abs(delta) / negativeRange);
          filledStartAngle = startAngle + ((1 - ratio) * (zeroAngle - startAngle));
          filledEndAngle = zeroAngle;
        }
      }
    }
    
    // Draw filled arc showing delta
    if (delta !== 0) {
      // Ensure angles are in correct order for D3 arc
      const actualStart = Math.min(filledStartAngle, filledEndAngle);
      const actualEnd = Math.max(filledStartAngle, filledEndAngle);
      
      gaugeGroup.append("path")
        .datum({ startAngle: actualStart, endAngle: actualEnd })
        .attr("d", filledArc)
        .attr("fill", color)
        .attr("opacity", arcOpacity);
    }
    
    // Add value text in center
    const formatValue = (val) => {
      if (config?.format === 'integer') {
        return Math.round(val).toLocaleString();
      } else if (config?.format === 'decimal') {
        return val.toFixed(1);
      } else if (config?.format === 'percentage') {
        return `${val.toFixed(1)}%`;
      }
      return val.toFixed(1);
    };
    
    // Get current value for display
    const current = currentValue();
    const valueText = formatValue(current);
    const deltaText = formatValue(delta);
    
    // Scale font size with height: at 100px height, use smaller font; at 150px, use larger font
    // Font size scales proportionally: ~16px at 100px height, ~24px at 150px height
    const fontSize = Math.max(12 * (height / 150), Math.min(radius * 0.4, size * 0.16)); // Responsive font size for main value scaled with height
    const deltaFontSize = fontSize * 0.6; // Smaller font for delta (60% of main font size)
    
    // Create text group positioned 5px higher to make room for both values
    const textGroup = gaugeGroup.append("g")
      .attr("transform", `translate(0, -5)`);
    
    // Display current value (main text, centered)
    textGroup.append("text")
      .attr("text-anchor", "middle")
      .attr("x", 0)
      .attr("dy", fontSize * 0.2)
      .attr("font-size", `${fontSize}px`)
      .attr("font-weight", "700")
      .attr("fill", color)
      .text(valueText);
    
    // Display delta value below (smaller text, centered)
    textGroup.append("text")
      .attr("text-anchor", "middle")
      .attr("x", 0)
      .attr("dy", fontSize * 0.2 + fontSize * 0.8) // Position below main value
      .attr("font-size", `${deltaFontSize}px`)
      .attr("font-weight", "500")
      .attr("fill", color)
      .attr("opacity", 0.8)
      .text(deltaText);
  };

  // Redraw gauge when values change
  createEffect(() => {
    // Track all dependencies that affect the gauge
    const loading = isLoading();
    const delta = deltaValue();
    const color = gaugeColor();
    const hasTwoMinutes = hasTwoMinutesData();
    
    if (!loading) {
      drawGauge();
    }
  });

  // Handle resize
  let resizeObserver = null;
  onMount(() => {
    if (containerRef && window.ResizeObserver) {
      resizeObserver = new ResizeObserver(() => {
        drawGauge();
      });
      resizeObserver.observe(containerRef);
    }
  });

  onCleanup(() => {
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    if (svg) {
      svg.remove();
    }
  });

  // Wrap in media-container if height is specified
  const containerStyle = (propHeight ?? config?.height) 
    ? `width: ${height}px; height: ${height}px; overflow: hidden; background-color: ${hexToRgba(backgroundColor, opacity)}; border-radius: ${6 * (height / 150)}px;` 
    : `width: 100%; height: 100%; overflow: hidden; background-color: ${hexToRgba(backgroundColor, opacity)}; border-radius: 6px;`;

  // Calculate responsive label font size based on height
  // At 100px height: ~10px, at 150px height: ~14px (0.875rem)
  const labelFontSize = (propHeight ?? config?.height) 
    ? `${Math.max(9 * (height / 150), height * 0.093)}px`
    : "0.875rem";
  
  // Calculate responsive padding for label positioning (smaller padding at smaller heights)
  const labelPadding = (propHeight ?? config?.height)
    ? `${Math.max(4 * (height / 150), height * 0.08)}px`
    : "10px";
  
  // Calculate gauge background color with 0.3 more opacity (capped at 1.0)
  const gaugeBackgroundOpacity = Math.min(1.0, opacity + 0.2);
  const gaugeBackgroundColor = hexToRgba(backgroundColor, gaugeBackgroundOpacity);

  return (
    <div class="media-container" style={containerStyle}>
      <div class="gauge-component" style={`position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; overflow: hidden; background-color: ${gaugeBackgroundColor}; border-radius: 6px;`}>
        {/* Single display label: custom label when provided, otherwise channel name */}
        <Show when={config?.labelPosition !== 'bottom' && (config?.label ?? config?.valueChannel ?? config?.channel ?? 'Bsp_kts')}>
          <div style={`position: absolute; top: ${labelPadding}; right: ${labelPadding}; z-index: 10; font-size: ${labelFontSize}; font-weight: 500; color: ${gaugeColor()}; text-align: right; pointer-events: none;`}>
            {config?.label ?? config?.valueChannel ?? config?.channel ?? 'Bsp_kts'}
          </div>
        </Show>
        
        <Show when={isLoading()}>
          <div style="display: flex; align-items: center; justify-content: center; height: 100%;">
            <div style="text-align: center;">
              <div class="spinner" style={{ 
                "width": `${40 * (height / 150)}px`, 
                "height": `${40 * (height / 150)}px`, 
                "border": `${3 * (height / 150)}px solid #374151`, 
                "border-top": `${3 * (height / 150)}px solid #3b82f6`, 
                "border-radius": "50%", 
                "animation": "spin 1s linear infinite", 
                "margin": "0 auto"
              }}></div>
              <div style={{ "margin-top": `${10 * (height / 150)}px`, "font-size": `${14 * (height / 150)}px`, "color": "#9ca3af" }}>Loading...</div>
            </div>
          </div>
        </Show>
        
        <div
          ref={containerRef}
          style="flex: 1; width: 100%; min-height: 0; overflow: hidden; border-radius: 6px;"
        />
        
        {/* Label below gauge - only when position is explicitly bottom */}
        <Show when={config?.labelPosition === 'bottom' && (config?.label ?? config?.valueChannel ?? config?.channel ?? 'Bsp_kts')}>
          <div style={`margin-top: 8px; font-size: ${labelFontSize}; font-weight: 500; color: ${gaugeColor()}; text-align: center;`}>
            {config?.label ?? config?.valueChannel ?? config?.channel ?? 'Bsp_kts'}
          </div>
        </Show>
        
        <style>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </div>
  );
}

