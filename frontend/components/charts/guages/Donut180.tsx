import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import * as d3 from "d3";
import { warn as logWarn, error as logError } from "../../../utils/console";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";

interface Donut180Props {
  config?: any;
  liveMode?: boolean;
  sourceMode?: string;
  selectedSourceIds?: () => Set<string>;
  height?: number;
  backgroundColor?: string;
  opacity?: number;
  /** When provided (e.g. from Overlay), use this row for current value. Updates when selectedTime changes. */
  dataRow?: any;
  /** Live mode: real-time data array (or accessor). */
  liveData?: any[] | (() => any[]);
}

export default function Donut(props: Donut180Props) {
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
  const [gaugeColor, setGaugeColor] = createSignal("#10b981"); // Default green
  const [isLoading, setIsLoading] = createSignal(true);
  const [minValue, setMinValue] = createSignal(0);
  const [maxValue, setMaxValue] = createSignal(100);
  
  const [liveGaugeData, setLiveGaugeData] = createSignal<any[]>([]);
  const [liveCurrentRow, setLiveCurrentRow] = createSignal<any>({});

  const effectiveRow = (): any => {
    if (props.dataRow != null) {
      const r = typeof props.dataRow === 'function' ? props.dataRow() : props.dataRow;
      return r ?? {};
    }
    return liveCurrentRow() ?? {};
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
  
  // Calculate min/max from live data or use config values (when dataRow from parent, config used in row effect)
  createEffect(() => {
    const allData = liveGaugeData();
    const valueChannel = config?.valueChannel || config?.channel || 'Bsp';
    
    // Use config min/max if provided
    if (config?.minValue != null) {
      setMinValue(config.minValue);
    }
    if (config?.maxValue != null) {
      setMaxValue(config.maxValue);
    }
    
    // If no config values, calculate from data
    if ((config?.minValue == null || config?.maxValue == null) && allData && allData.length > 0) {
      const allValues = allData
        .map(d => getValueFromData(d, valueChannel))
        .filter(v => v != null);
      
      if (allValues.length > 0) {
        if (config?.minValue == null) {
          const dataMin = Math.min(...allValues);
          setMinValue(dataMin);
        }
        if (config?.maxValue == null) {
          const dataMax = Math.max(...allValues);
          setMaxValue(dataMax);
        }
      }
    }
  });
  
  // Update values from effective row (dataRow from Overlay or liveCurrentRow)
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
        if (value < 0) {
          setGaugeColor("#ef4444");
        } else {
          setGaugeColor("#10b981");
        }
        // When dataRow from parent, ensure min/max from config for arc scale
        if (props.dataRow != null) {
          if (config?.minValue != null) setMinValue(config.minValue);
          if (config?.maxValue != null) setMaxValue(config.maxValue);
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
    
    const current = currentValue();
    const minVal = minValue();
    const maxVal = maxValue();
    const color = gaugeColor();
    
    // Create arc generator for gauge - 180° arc
    // D3 coordinate system: 0° = top, positive clockwise
    // Zero point is at bottom (270° = π in D3)
    // Right side (0° standard) = π/2 D3
    // Left side (180° standard) = 3π/2 D3
    const startAngle = Math.PI / 2; // Right side = π/2 D3
    const endAngle = (3 * Math.PI) / 2; // Left side = 3π/2 D3 (going clockwise from right)
    const zeroAngle = Math.PI; // Zero point (center/bottom) = π D3
    
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
    
    // Calculate filled arc based on value
    // Zero point is at zeroAngle (270° = π in D3, center/bottom)
    // Arc spans from startAngle (π/2, right) to endAngle (3π/2, left) going clockwise
    // Positive values extend from zeroAngle toward startAngle (right side, counterclockwise)
    // Negative values extend from zeroAngle toward endAngle (left side, clockwise)
    
    let filledStartAngle = zeroAngle;
    let filledEndAngle = zeroAngle;
    
    if (current !== 0) {
      // Determine the range for mapping
      // If both min and max are on the same side of zero, use the full range
      // Otherwise, use the appropriate side's range
      let range = 0;
      let absValue = Math.abs(current);
      
      if (current > 0) {
        // Positive value: extend right (toward startAngle, counterclockwise from zeroAngle)
        // Use maxVal if positive, otherwise use current as the range
        range = maxVal > 0 ? maxVal : Math.max(absValue, 1);
        if (range > 0) {
          const ratio = Math.min(1, absValue / range);
          // From zeroAngle going counterclockwise (negative direction) toward startAngle
          filledStartAngle = zeroAngle - (ratio * (zeroAngle - startAngle));
          filledEndAngle = zeroAngle;
        }
      } else {
        // Negative value: extend left (toward endAngle, clockwise from zeroAngle)
        // Use minVal if negative, otherwise use current as the range
        range = minVal < 0 ? Math.abs(minVal) : Math.max(absValue, 1);
        if (range > 0) {
          const ratio = Math.min(1, absValue / range);
          // From zeroAngle going clockwise (positive direction) toward endAngle
          filledStartAngle = zeroAngle;
          filledEndAngle = zeroAngle + (ratio * (endAngle - zeroAngle));
        }
      }
    }
    
    // Draw filled arc showing value
    if (current !== 0) {
      // Ensure angles are in correct order for D3 arc
      const actualStart = Math.min(filledStartAngle, filledEndAngle);
      const actualEnd = Math.max(filledStartAngle, filledEndAngle);
      
      gaugeGroup.append("path")
        .datum({ startAngle: actualStart, endAngle: actualEnd })
        .attr("d", filledArc)
        .attr("fill", color)
        .attr("opacity", 1.0);
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
    const valueText = formatValue(current);
    
    // Scale font size with height: at 100px height, use smaller font; at 150px, use larger font
    // Font size scales proportionally: ~16px at 100px height, ~24px at 150px height
    const fontSize = Math.max(12 * (height / 150), Math.min(radius * 0.4, size * 0.16)); // Responsive font size scaled with height
    
    // Display current value (centered)
    gaugeGroup.append("text")
      .attr("text-anchor", "middle")
      .attr("x", 0)
      .attr("dy", fontSize * 0.2)
      .attr("font-size", `${fontSize}px`)
      .attr("font-weight", "700")
      .attr("fill", color)
      .text(valueText);
  };

  // Redraw gauge when values change
  createEffect(() => {
    // Track all dependencies that affect the gauge
    const loading = isLoading();
    const current = currentValue();
    const minVal = minValue();
    const maxVal = maxValue();
    const color = gaugeColor();
    
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
        <Show when={config?.labelPosition !== 'bottom' && (config?.label ?? config?.valueChannel ?? config?.channel ?? bspName())}>
          <div style={`position: absolute; top: ${labelPadding}; right: ${labelPadding}; z-index: 10; font-size: ${labelFontSize}; font-weight: 500; color: ${gaugeColor()}; text-align: right; pointer-events: none;`}>
            {config?.label ?? config?.valueChannel ?? config?.channel ?? bspName()}
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
        <Show when={config?.labelPosition === 'bottom' && (config?.label ?? config?.valueChannel ?? config?.channel ?? bspName())}>
          <div style={`margin-top: 8px; font-size: ${labelFontSize}; font-weight: 500; color: ${gaugeColor()}; text-align: center;`}>
            {config?.label ?? config?.valueChannel ?? config?.channel ?? bspName()}
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

