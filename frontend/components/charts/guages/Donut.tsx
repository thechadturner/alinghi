import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import * as d3 from "d3";
import { warn as logWarn, error as logError } from "../../../utils/console";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";

interface DonutProps {
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

export default function Donut(props: DonutProps) {
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
  
  const [dataMinValue, setDataMinValue] = createSignal<number | null>(null);
  const [dataMaxValue, setDataMaxValue] = createSignal<number | null>(null);
  
  const [liveGaugeData, setLiveGaugeData] = createSignal<any[]>([]);
  const [liveCurrentRow, setLiveCurrentRow] = createSignal<any>({});

  const effectiveRow = (): any => {
    if (props.dataRow != null) {
      const r = typeof props.dataRow === 'function' ? props.dataRow() : props.dataRow;
      return r ?? {};
    }
    return liveCurrentRow() ?? {};
  };

  const allDataForMinMax = (): any[] => liveGaugeData();

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

  // Calculate gauge color based on mode and thresholds
  const calculateGaugeColor = (value: number, mode: string, target: number | null, warning: number | null, alarm: number | null, min: number, max: number): string => {
    if (mode === 'target') {
      if (target == null) return "#10b981"; // Default green if no target
      
      const tolerance = Math.abs(target * 0.05); // 5% tolerance
      const diff = Math.abs(value - target);
      
      if (diff <= tolerance) {
        return "#10b981"; // Green - on target within 5%
      } else if (value > target) {
        return "#ef4444"; // Red - over target
      } else {
        return "#3b82f6"; // Blue - under target
      }
    } else if (mode === 'alarm') {
      if (warning == null && alarm == null) return "#10b981"; // Default green
      
      // Use provided thresholds or calculate defaults
      const warnThreshold = warning;
      const alarmThreshold = alarm;
      
      // If we have both thresholds
      if (alarmThreshold != null && warnThreshold != null) {
        if (value >= alarmThreshold) {
          return "#ef4444"; // Red - over alarm
        } else if (value >= warnThreshold) {
          // Check if near alarm (within 10% of alarm threshold)
          const nearAlarmThreshold = alarmThreshold * 0.9;
          if (value >= nearAlarmThreshold) {
            return "#f97316"; // Orange - over warning and near alarm
          } else {
            return "#eab308"; // Yellow - over warning but under alarm
          }
        } else {
          return "#10b981"; // Green - under warning
        }
      } else if (alarmThreshold != null) {
        // Only alarm threshold provided
        if (value >= alarmThreshold) {
          return "#ef4444"; // Red - over alarm
        } else {
          return "#10b981"; // Green - under alarm
        }
      } else if (warnThreshold != null) {
        // Only warning threshold provided
        if (value >= warnThreshold) {
          return "#eab308"; // Yellow - over warning
        } else {
          return "#10b981"; // Green - under warning
        }
      }
      
      return "#10b981"; // Default green
    } else {
      // Auto mode or no mode specified - use gradient based on position in range
      if (min != null && max != null && max !== min) {
        const ratio = (value - min) / (max - min);
        
        // Green (0-0.5) -> Yellow (0.5-0.75) -> Orange (0.75-0.9) -> Red (0.9-1.0)
        if (ratio <= 0.5) {
          return "#10b981"; // Green
        } else if (ratio <= 0.75) {
          return "#eab308"; // Yellow
        } else if (ratio <= 0.9) {
          return "#f97316"; // Orange
        } else {
          return "#ef4444"; // Red
        }
      }
      
      return "#10b981"; // Default green
    }
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
  
  // Calculate min/max from live data (when not using dataRow from parent)
  createEffect(() => {
    const allData = allDataForMinMax();
    const valueChannel = config?.valueChannel || config?.channel || bspName();
    
    if (allData && allData.length > 0) {
      // Efficient min/max calculation: iterate once through data
      let currentMin = dataMinValue();
      let currentMax = dataMaxValue();
      let hasValidValues = false;
      
      // If we don't have min/max yet, calculate from all data
      // Otherwise, only check new values (for live mode) or recalculate if needed
      if (currentMin === null || currentMax === null || liveMode) {
        // For efficiency, iterate once and track min/max
        for (let i = 0; i < allData.length; i++) {
          const value = getValueFromData(allData[i], valueChannel);
          if (value != null) {
            hasValidValues = true;
            if (currentMin === null || value < currentMin) {
              currentMin = value;
            }
            if (currentMax === null || value > currentMax) {
              currentMax = value;
            }
          }
        }
        
        if (hasValidValues) {
          setDataMinValue(currentMin);
          setDataMaxValue(currentMax);
          
          // Also update maxDataValue for backward compatibility
          if (liveMode || !maxDataValueSet) {
            setMaxDataValue(currentMax);
            maxDataValueSet = true;
          }
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
        
        const target = getThresholdValue(row, 'targetChannel') ?? config?.targetValue;
        const warning = getThresholdValue(row, 'warningChannel') ?? config?.warningValue;
        const alarm = getThresholdValue(row, 'alarmChannel') ?? config?.alarmValue;
        
        setTargetValue(target);
        setWarningValue(warning);
        setAlarmValue(alarm);
        
        const dataMin = dataMinValue();
        const dataMax = dataMaxValue();
        const hasDataRange = dataMin != null && dataMax != null;
        
        if (hasDataRange) {
          const mode = config?.mode;
          if (!mode || mode === 'auto') {
            const padding = Math.max((dataMax! - dataMin!) * 0.05, (dataMax! - dataMin!) * 0.1 || Math.abs(dataMax!) * 0.01 || 1);
            const calculatedMin = dataMin! - padding;
            const calculatedMax = dataMax! + padding;
            if (config?.minValue == null) setMinValue(calculatedMin);
            else setMinValue(config.minValue);
            if (config?.maxValue == null) setMaxValue(calculatedMax);
            else setMaxValue(config.maxValue);
          } else {
            const padding = (dataMax! - dataMin!) * 0.1 || 1;
            setMinValue(config?.minValue ?? (dataMin! - padding));
            setMaxValue(config?.maxValue ?? (dataMax! + padding));
          }
        } else {
          // dataRow from parent: use config min/max or derive from value
          const configMin = config?.minValue;
          const configMax = config?.maxValue;
          const fallbackMax = Math.max(value * 1.2, 100);
          setMinValue(configMin ?? 0);
          setMaxValue(configMax ?? fallbackMax);
          if (!maxDataValueSet) {
            setMaxDataValue(configMax ?? fallbackMax);
            maxDataValueSet = true;
          }
        }
        
        const mode = config?.mode || 'auto';
        const currentMin = minValue();
        const currentMax = maxValue();
        const color = calculateGaugeColor(value, mode, target, warning, alarm, currentMin, currentMax);
        setGaugeColor(color);
        
        setIsLoading(false);
      } else {
        logWarn('Donut: Could not extract value from data using channel:', valueChannel);
        setIsLoading(true);
      }
    } catch (error: any) {
      logError('Donut: Error processing data:', error);
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
    const min = minValue();
    const max = maxValue();
    const maxData = maxDataValue(); // Actual maximum from data (for filled arc)
    const color = gaugeColor();
    const mode = config?.mode || 'auto';
    const warning = warningValue();
    const alarm = alarmValue();
    
    // Create arc generator for gauge - car speedometer style (245° from 140° to 365°)
    // Rotated 60° to the right (add 60 to both angles)
    // Convert standard math angles to D3 coordinate system
    // D3: 0° = top, positive clockwise
    // Standard: 0° = right, positive counterclockwise
    // 140° standard = (140 - 90) * PI/180 = 0.873 rad in D3
    // 365° standard = (365 - 90) * PI/180 = 4.799 rad in D3 (wraps to 0.087 rad)
    // Arc spans 245° total
    // Rotate 60° right: add 60 to both angles
    const startAngleDeg = 140 + 60; // 200°
    const endAngleDeg = 365 + 60; // 425° (wraps to 65°)
    const startAngle = ((startAngleDeg - 90) * Math.PI) / 180;
    const endAngle = ((endAngleDeg - 90) * Math.PI) / 180;
    
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
    
    // Draw single border with active color (1px, same color as current value)
    gaugeGroup.append("path")
      .datum({ startAngle: startAngle, endAngle: endAngle })
      .attr("d", borderArc)
      .attr("fill", "none")
      .attr("stroke", color) // Use active color
      .attr("stroke-width", 1)
      .attr("opacity", 0.9);
    
    // Calculate angle for current value as percentage of actual data max
    // Value percentage = current / maxData (actual maximum from data, not padded)
    const valuePercentage = maxData > 0 ? Math.min(1, Math.max(0, current / maxData)) : 0;
    
    // Calculate the arc span (handle wrapping)
    let arcSpan = endAngle - startAngle;
    if (arcSpan < 0) {
      arcSpan = (2 * Math.PI) + arcSpan; // Handle negative span (wraps around)
    }
    
    const valueEndAngle = startAngle + (valuePercentage * arcSpan);
    
    // Draw filled arc showing value as percentage of max data value
    // The arc starts from startAngle and extends based on current/maxData
    if (valuePercentage > 0) {
      gaugeGroup.append("path")
        .datum({ startAngle: startAngle, endAngle: valueEndAngle })
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
    
    const valueText = formatValue(current);
    // Scale font size with height: at 100px height, use smaller font; at 150px, use larger font
    // Font size scales proportionally: ~16px at 100px height, ~24px at 150px height
    const fontSize = Math.max(12 * (height / 150), Math.min(radius * 0.4, size * 0.16)); // Responsive font size scaled with height
    
    // Position number in the center
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
    const maxData = maxDataValue();
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

  // Single display label: custom label when provided, otherwise channel name (avoids duplicate labels)
  const displayLabel = () => config?.label ?? config?.valueChannel ?? config?.channel ?? bspName();

  return (
    <div class="media-container" style={containerStyle}>
      <div class="gauge-component" style={`position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; overflow: hidden; background-color: ${gaugeBackgroundColor}; border-radius: 6px;`}>
        {/* Label in upper right when position is not bottom */}
        <Show when={config?.labelPosition !== 'bottom' && displayLabel()}>
          <div style={`position: absolute; top: ${labelPadding}; right: ${labelPadding}; z-index: 10; font-size: ${labelFontSize}; font-weight: 500; color: ${gaugeColor()}; text-align: right; pointer-events: none;`}>
            {displayLabel()}
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
        
        {/* Label below gauge - only when position is explicitly bottom (avoids duplicate with top-right) */}
        <Show when={config?.labelPosition === 'bottom' && displayLabel()}>
          <div style={`margin-top: 8px; font-size: ${labelFontSize}; font-weight: 500; color: ${gaugeColor()}; text-align: center;`}>
            {displayLabel()}
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

