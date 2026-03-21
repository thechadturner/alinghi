import { createEffect, onMount, onCleanup } from "solid-js";
import * as d3 from "d3";
import { round } from "../../../../utils/global";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { debug as logDebug } from "../../../../utils/console";

interface WindArrowProps {
  /** True Wind Speed in kph */
  tws?: number;
  /** True Wind Direction in degrees (0-360) */
  twd?: number;
  /** Map instance for getting bearing and canvas container */
  map?: any;
  /** Position of the arrow (x, y) */
  position?: { x: number; y: number };
  /** Map type for determining color bar style */
  maptype?: 'DEFAULT' | 'GRADE' | 'WIND' | 'VMG%' | 'VMG' | 'STATE' | 'MANEUVERS';
  /** Track data for calculating color scale ranges (for VMG and WIND gradients) */
  trackData?: any[];
  /** Selected time for showing indicator on color bar */
  selectedTime?: Date | null;
  /** Map state key for persisting wind rotation (0=north, 1=TWD, 2=TWD+90°, 3=TWD+180°, 4=TWD+270°) */
  objectName?: string;
}

export default function WindArrow(props: WindArrowProps) {
  // Get dynamic channel names from store
  const { twdName, vmgName, vmgPercName } = defaultChannelsStore;
  let windGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  let compassGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  let windText: d3.Selection<SVGTextElement, unknown, null, undefined> | null = null;
  let colorBarGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  let svgSelection: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  let isInitialized = false;
  
  // Store last valid wind values to prevent flickering when data is temporarily unavailable
  let lastValidTws: number | undefined = undefined;
  let lastValidTwd: number | undefined = undefined;

  // Helper function to calculate one-sigma range for dynamic scales
  const getOneSigmaRange = (data: any[], accessor: (p: any) => number): [number, number] => {
    if (!data || data.length === 0) return [0, 1];
    const values = data.map(accessor).filter(v => !isNaN(v) && isFinite(v));
    if (values.length === 0) return [0, 1];
    
    const mean = d3.mean(values) || 0;
    const std = d3.deviation(values) || 0;
    const min = mean - std;
    const max = mean + std;
    
    return [min, max];
  };
  
  // Rotation state: 0 = north up, 1 = TWD (wind to top), 2 = TWD+90°, 3 = TWD+180°, 4 = TWD+270°
  // Use shared key so FleetMap and explore/map remember the same preference
  const WIND_ROTATION_STORAGE_KEY = 'map_wind_rotation_preference';
  const getRotationStateKey = () => WIND_ROTATION_STORAGE_KEY;
  let rotationState = 0; // Default north up; first click aligns wind to top
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(getRotationStateKey());
      if (saved !== null) {
        const v = parseInt(saved, 10);
        if (v >= 0 && v <= 4) rotationState = v;
      }
    }
  } catch {
    // ignore
  }
  
  // Helper function to get TWD value with case-insensitive fallback
  const getTwd = (d: any): number | null => {
    if (!d) return null;
    const twdField = twdName();
    const val = d[twdField] ?? d[twdField.toLowerCase()] ?? d[twdField.toUpperCase()] ?? d.Twd ?? d.twd ?? d.TWD ?? d.cTWD;
    if (val === undefined || val === null || isNaN(Number(val))) return null;
    return Number(val);
  };

  const updatePosition = () => {
    if (!svgSelection || !props.map) return;

    // Get map container dimensions
    const mapContainer = props.map.getContainer ? props.map.getContainer() : null;
    if (!mapContainer) return;

    const mapWidth = mapContainer.offsetWidth || 1400;

    // Update SVG size to match map container
    svgSelection
      .attr("width", mapWidth)
      .attr("height", mapContainer.offsetHeight || 900);

    // Calculate position in upper right corner with padding
    const padding = 20;
    const x = mapWidth - 40; // 10px from right edge
    const y = padding + 40; // Position from top (moved down 10px from original 30)

    // Update wind group position
    if (windGroup) {
      windGroup.attr("transform", `translate(${x}, ${y})`);
    }
    
    // Update color bar position (to the left of wind arrow)
    if (colorBarGroup) {
      const colorBarX = x - 50; // Position to the left of wind arrow
      colorBarGroup.attr("transform", `translate(${colorBarX}, ${y})`);
    }
  };
  
  const updateColorBar = () => {
    if (!colorBarGroup) return;
    
    const maptype = props.maptype;
    
    // Clear existing color bar
    colorBarGroup.selectAll("*").remove();
    
    // Hide color bar if maptype is null, undefined, empty, or not one of the allowed types
    if (!maptype || maptype === null || maptype === undefined || maptype === 'DEFAULT') {
      colorBarGroup.style("opacity", "0");
      colorBarGroup.style("display", "none");
      colorBarGroup.style("visibility", "hidden");
      return;
    }
    
    // Only show color bar for GRADE, WIND, VMG%, and VMG - hide for all other types (including STATE which is discrete)
    const normalizedMaptype = maptype?.toUpperCase();
    if (normalizedMaptype !== 'GRADE' && normalizedMaptype !== 'WIND' && normalizedMaptype !== 'VMG%' && normalizedMaptype !== 'VMG') {
      colorBarGroup.style("opacity", "0");
      colorBarGroup.style("display", "none");
      colorBarGroup.style("visibility", "hidden");
      return;
    }
    
    colorBarGroup.style("opacity", "1");
    colorBarGroup.style("display", "block");
    colorBarGroup.style("visibility", "visible");
    
    const barWidth = 12;
    const barHeight = 60;
    const barX = 0;
    const barY = -30; // Center vertically with compass
    
    // Helper function to find closest data point to selectedTime
    const getValueAtSelectedTime = (): number | null => {
      if (!props.selectedTime || !props.trackData || props.trackData.length === 0) {
        return null;
      }
      
      const selectedTimeMs = props.selectedTime.getTime();
      
      // Find closest point to selectedTime
      let closestPoint: any = null;
      let minDiff = Infinity;
      
      props.trackData.forEach((point: any) => {
        const pointTime = point.Datetime;
        if (!pointTime) return;
        
        const pointDate = pointTime instanceof Date ? pointTime : new Date(pointTime);
        const diff = Math.abs(pointDate.getTime() - selectedTimeMs);
        
        if (diff < minDiff) {
          minDiff = diff;
          closestPoint = point;
        }
      });
      
      if (!closestPoint || minDiff > 5000) return null; // Only use if within 5 seconds
      
      // Get value based on maptype
      if (maptype === 'GRADE') {
        return closestPoint.Grade ?? closestPoint.grade ?? null;
      } else if (maptype === 'VMG%') {
        // Use vmg_perc_name channel
        const vmgPercField = vmgPercName();
        const val = closestPoint[vmgPercField] ?? closestPoint[vmgPercField.toLowerCase()] ?? closestPoint[vmgPercField.toUpperCase()] ?? closestPoint.Vmg_perc ?? closestPoint.vmg_perc;
        return val !== undefined && val !== null && !isNaN(Number(val)) ? Number(val) : null;
      } else if (maptype === 'VMG') {
        // Use vmg_name channel
        const vmgField = vmgName();
        const val = closestPoint[vmgField] ?? closestPoint[vmgField.toLowerCase()] ?? closestPoint[vmgField.toUpperCase()] ?? closestPoint.Vmg ?? closestPoint.vmg;
        return val !== undefined && val !== null && !isNaN(Number(val)) ? Number(val) : null;
      } else if (maptype === 'WIND') {
        return getTwd(closestPoint);
      }
      
      return null;
    };
    
    // Calculate indicator position
    const calculateIndicatorPosition = (): number | null => {
      const value = getValueAtSelectedTime();
      if (value === null || isNaN(value)) return null;
      
      if (maptype === 'GRADE') {
        // GRADE: 0 (bottom) to 4 (top), map to barHeight
        // 0 = bottom (barY + barHeight), 4 = top (barY)
        const normalized = value / 4; // 0 to 1
        return barY + (barHeight * (1 - normalized)); // Invert so 0 is at bottom
      } else if (maptype === 'VMG%') {
        // VMG%: Fixed scale 25% (min) to 125% (max)
        const minVMG = 25;
        const maxVMG = 125;
        const normalized = Math.max(0, Math.min(1, (value - minVMG) / (maxVMG - minVMG)));
        return barY + (barHeight * (1 - normalized)); // Invert so min is at bottom
      } else if (maptype === 'VMG') {
        // VMG: Dynamic scale based on data
        if (!props.trackData || props.trackData.length === 0) return null;
        
        const vmgField = vmgName();
        const vmgValues = props.trackData
          .map((p: any) => {
            const val = p[vmgField] ?? p[vmgField.toLowerCase()] ?? p[vmgField.toUpperCase()] ?? p.Vmg ?? p.vmg;
            return val !== undefined && val !== null ? Number(val) : null;
          })
          .filter((v: number | null): v is number => v !== null && !isNaN(v));
        
        if (vmgValues.length === 0) return null;
        
        const [minVMG, maxVMG] = getOneSigmaRange(props.trackData, (p: any) => {
          const val = p[vmgField] ?? p[vmgField.toLowerCase()] ?? p[vmgField.toUpperCase()] ?? p.Vmg ?? p.vmg;
          return val !== undefined && val !== null ? Number(val) : 0;
        });
        
        // Handle division by zero case
        if (maxVMG === minVMG) {
          // If all values are the same, place indicator at middle
          return barY + (barHeight / 2);
        }
        
        // Clamp normalized value to [0, 1] to ensure indicator stays within bar bounds
        const normalized = Math.max(0, Math.min(1, (value - minVMG) / (maxVMG - minVMG)));
        return barY + (barHeight * (1 - normalized)); // Invert so min is at bottom
      } else if (maptype === 'WIND') {
        // WIND: TWD value, need min/max from trackData
        if (!props.trackData || props.trackData.length === 0) return null;
        
        const twdValues = props.trackData
          .map((p: any) => getTwd(p))
          .filter((v: number | null): v is number => v !== null && v !== undefined && !isNaN(v));
        
        if (twdValues.length === 0) return null;
        
        const minTWD = d3.min(twdValues) || 0;
        const maxTWD = d3.max(twdValues) || 360;
        
        // Normalize value to 0-1 range
        const normalized = (value - minTWD) / (maxTWD - minTWD);
        return barY + (barHeight * (1 - normalized)); // Invert so min is at bottom
      }
      
      return null;
    };
    
    // Add label above the bar (centered) - remove existing first
    const labelFontSize = "8px";
    colorBarGroup.select("text.title-label").remove();
    colorBarGroup
      .append("text")
      .attr("class", "title-label")
      .attr("x", barX + (barWidth / 2))
      .attr("y", barY - 5)
      .attr("text-anchor", "middle")
      .style("font-size", labelFontSize)
      .style("font-weight", "300")
      .style("fill", "white")
      .style("stroke", "none")
      .text(maptype);
    
    if (maptype === 'GRADE') {
      // Three sections: red (low), lightgreen (med), green (high)
      const sectionHeight = barHeight / 3;
      
      // Bottom section - red (low)
      colorBarGroup
        .append("rect")
        .attr("x", barX)
        .attr("y", barY + (sectionHeight * 2))
        .attr("width", barWidth)
        .attr("height", sectionHeight)
        .style("fill", "red")
        .style("stroke", "white")
        .style("stroke-width", 0.5);
      
      // Middle section - lightgreen (med)
      colorBarGroup
        .append("rect")
        .attr("x", barX)
        .attr("y", barY + sectionHeight)
        .attr("width", barWidth)
        .attr("height", sectionHeight)
        .style("fill", "lightgreen")
        .style("stroke", "white")
        .style("stroke-width", 0.5);
      
      // Top section - green (high)
      colorBarGroup
        .append("rect")
        .attr("x", barX)
        .attr("y", barY)
        .attr("width", barWidth)
        .attr("height", sectionHeight)
        .style("fill", "green")
        .style("stroke", "white")
        .style("stroke-width", 0.5);
      
      // Add labels to the left - remove existing first
      const labelFontSize = "8px";
      const labelX = barX - 5;
      colorBarGroup.selectAll("text.value-label").remove();
      
      colorBarGroup
        .append("text")
        .attr("class", "value-label")
        .attr("x", labelX)
        .attr("y", barY + (sectionHeight * 2.7))
        .attr("text-anchor", "end")
        .style("font-size", labelFontSize)
        .style("font-weight", "200")
        .style("fill", "white")
        .style("stroke", "none")
        .text("low");
      
      colorBarGroup
        .append("text")
        .attr("class", "value-label")
        .attr("x", labelX)
        .attr("y", barY + (sectionHeight * 1.7))
        .attr("text-anchor", "end")
        .style("font-size", labelFontSize)
        .style("font-weight", "200")
        .style("fill", "white")
        .style("stroke", "none")
        .text("med");
      
      colorBarGroup
        .append("text")
        .attr("class", "value-label")
        .attr("x", labelX)
        .attr("y", barY + (sectionHeight * 0.7))
        .attr("text-anchor", "end")
        .style("font-size", labelFontSize)
        .style("font-weight", "200")
        .style("fill", "white")
        .style("stroke", "none")
        .text("high");
    } else if (maptype === 'VMG%') {
      // VMG%: Fixed scale 25% (min) to 125% (max)
      // Gradient: blue -> lightblue -> yellow -> red
      const minVMG = 25;
      const maxVMG = 125;
      const gradientId = `vmg-perc-gradient-${Date.now()}`;
      const gradient = colorBarGroup
        .append("defs")
        .append("linearGradient")
        .attr("id", gradientId)
        .attr("x1", "0%")
        .attr("x2", "0%")
        .attr("y1", "100%")
        .attr("y2", "0%");
      
      gradient.append("stop")
        .attr("offset", "0%")
        .attr("stop-color", "blue");
      
      gradient.append("stop")
        .attr("offset", "50%") // 50% of range (75% VMG)
        .attr("stop-color", "lightblue");
      
      gradient.append("stop")
        .attr("offset", "95%") // 95% of range (120% VMG)
        .attr("stop-color", "yellow");
      
      gradient.append("stop")
        .attr("offset", "100%")
        .attr("stop-color", "red");
      
      colorBarGroup
        .append("rect")
        .attr("x", barX)
        .attr("y", barY)
        .attr("width", barWidth)
        .attr("height", barHeight)
        .style("fill", `url(#${gradientId})`)
        .style("stroke", "white")
        .style("stroke-width", 0.5);
      
      // Add labels
      const labelFontSize = "8px";
      const labelX = barX - 5;
      colorBarGroup.selectAll("text.value-label").remove();
      
      colorBarGroup
        .append("text")
        .attr("class", "value-label")
        .attr("x", labelX)
        .attr("y", barY + 5)
        .attr("text-anchor", "end")
        .style("font-size", labelFontSize)
        .style("font-weight", "200")
        .style("fill", "white")
        .style("stroke", "none")
        .text("125%");
      
      colorBarGroup
        .append("text")
        .attr("class", "value-label")
        .attr("x", labelX)
        .attr("y", barY + barHeight - 5)
        .attr("text-anchor", "end")
        .style("font-size", labelFontSize)
        .style("font-weight", "200")
        .style("fill", "white")
        .style("stroke", "none")
        .text("25%");
    } else if (maptype === 'VMG') {
      // VMG: Dynamic scale based on data
      if (!props.trackData || props.trackData.length === 0) return;
      
      const vmgField = vmgName();
      const [minVMG, maxVMG] = getOneSigmaRange(props.trackData, (p: any) => {
        const val = p[vmgField] ?? p[vmgField.toLowerCase()] ?? p[vmgField.toUpperCase()] ?? p.Vmg ?? p.vmg;
        return val !== undefined && val !== null ? Number(val) : 0;
      });
      
      // Ensure we have a valid range
      if (maxVMG === minVMG || !isFinite(minVMG) || !isFinite(maxVMG)) {
        return; // Can't draw bar with invalid range
      }
      
      const gradientId = `vmg-gradient-${Date.now()}`;
      const gradient = colorBarGroup
        .append("defs")
        .append("linearGradient")
        .attr("id", gradientId)
        .attr("x1", "0%")
        .attr("x2", "0%")
        .attr("y1", "100%")
        .attr("y2", "0%");
      
      gradient.append("stop")
        .attr("offset", "0%")
        .attr("stop-color", "blue");
      
      gradient.append("stop")
        .attr("offset", "50%")
        .attr("stop-color", "lightblue");
      
      gradient.append("stop")
        .attr("offset", "95%")
        .attr("stop-color", "yellow");
      
      gradient.append("stop")
        .attr("offset", "100%")
        .attr("stop-color", "red");
      
      colorBarGroup
        .append("rect")
        .attr("x", barX)
        .attr("y", barY)
        .attr("width", barWidth)
        .attr("height", barHeight)
        .style("fill", `url(#${gradientId})`)
        .style("stroke", "white")
        .style("stroke-width", 0.5);
      
      // Add labels with actual min/max values
      const labelFontSize = "8px";
      const labelX = barX - 5;
      colorBarGroup.selectAll("text.value-label").remove();
      
      colorBarGroup
        .append("text")
        .attr("class", "value-label")
        .attr("x", labelX)
        .attr("y", barY + 5)
        .attr("text-anchor", "end")
        .style("font-size", labelFontSize)
        .style("font-weight", "200")
        .style("fill", "white")
        .style("stroke", "none")
        .text(round(maxVMG, 1).toString());
      
      colorBarGroup
        .append("text")
        .attr("class", "value-label")
        .attr("x", labelX)
        .attr("y", barY + barHeight - 5)
        .attr("text-anchor", "end")
        .style("font-size", labelFontSize)
        .style("font-weight", "200")
        .style("fill", "white")
        .style("stroke", "none")
        .text(round(minVMG, 1).toString());
    } else if (maptype === 'WIND') {
      // Gradient: red -> lightgrey -> green (for TWD)
      const gradientId = `wind-gradient-${Date.now()}`;
      const gradient = colorBarGroup
        .append("defs")
        .append("linearGradient")
        .attr("id", gradientId)
        .attr("x1", "0%")
        .attr("x2", "0%")
        .attr("y1", "100%")
        .attr("y2", "0%");
      
      gradient.append("stop")
        .attr("offset", "0%")
        .attr("stop-color", "red");
      
      gradient.append("stop")
        .attr("offset", "50%")
        .attr("stop-color", "lightgrey");
      
      gradient.append("stop")
        .attr("offset", "100%")
        .attr("stop-color", "green");
      
      colorBarGroup
        .append("rect")
        .attr("x", barX)
        .attr("y", barY)
        .attr("width", barWidth)
        .attr("height", barHeight)
        .style("fill", `url(#${gradientId})`)
        .style("stroke", "white")
        .style("stroke-width", 0.5);
      
      // Add labels to the left (same positions as GRADE labels) - remove existing first
      const labelFontSize = "8px";
      const labelX = barX - 5;
      const sectionHeight = barHeight / 3;
      colorBarGroup.selectAll("text.value-label").remove();
      
      // Top label - "right" (same position as "high")
      colorBarGroup
        .append("text")
        .attr("class", "value-label")
        .attr("x", labelX)
        .attr("y", barY + (sectionHeight * 0.7))
        .attr("text-anchor", "end")
        .style("font-size", labelFontSize)
        .style("font-weight", "200")
        .style("fill", "white")
        .style("stroke", "none")
        .text("right");
      
      // Bottom label - "left" (same position as "low")
      colorBarGroup
        .append("text")
        .attr("class", "value-label")
        .attr("x", labelX)
        .attr("y", barY + (sectionHeight * 2.7))
        .attr("text-anchor", "end")
        .style("font-size", labelFontSize)
        .style("font-weight", "200")
        .style("fill", "white")
        .style("stroke", "none")
        .text("left");
    }
    
    // Add indicator line for selectedTime
    const indicatorY = calculateIndicatorPosition();
    if (indicatorY !== null) {
      // Draw horizontal line across the bar
      colorBarGroup
        .append("line")
        .attr("class", "time-indicator")
        .attr("x1", barX - 2) // Extend slightly left of bar
        .attr("x2", barX + barWidth + 2) // Extend slightly right of bar
        .attr("y1", indicatorY)
        .attr("y2", indicatorY)
        .style("stroke", "black")
        .style("stroke-width", 1.5)
        .style("opacity", 0.8);
    }
  };

  // Initialize function that sets up the wind arrow (shared between onMount and updateArrow)
  const initializeWindArrow = () => {
    if (!props.map) {
      logDebug('WindArrow: initializeWindArrow - no map');
      return;
    }
    
    const canvasContainer = props.map?.getCanvasContainer ? props.map.getCanvasContainer() : null;
    if (!canvasContainer) {
      logDebug('WindArrow: initializeWindArrow - no canvasContainer', { 
        hasMap: !!props.map, 
        hasGetCanvasContainer: !!props.map?.getCanvasContainer 
      });
      return;
    }
    
    logDebug('WindArrow: initializeWindArrow - starting initialization');

    let svg = d3.select(canvasContainer).select<SVGSVGElement>("svg.wind-arrow-svg");
    
    if (svg.empty()) {
      const mapContainer = props.map?.getContainer ? props.map.getContainer() : null;
      const mapWidth = mapContainer?.offsetWidth || 1400;
      const mapHeight = mapContainer?.offsetHeight || 900;

      svg = d3.select(canvasContainer)
        .append<SVGSVGElement>("svg")
        .attr("class", "wind-arrow-svg")
        .attr("width", mapWidth)
        .attr("height", mapHeight)
        .style("position", "absolute")
        .style("top", "0")
        .style("left", "0")
        .style("z-index", 2)
        .style("pointer-events", "none");
    }

    svgSelection = svg;
    svg.select("g.wind").remove();
    svg.select("g.color-bar").remove();

    const mapContainer = props.map.getContainer ? props.map.getContainer() : null;
    const mapWidth = mapContainer?.offsetWidth || 1400;
    const padding = 20;
    const x = mapWidth - 40;
    const y = padding + 40;
    const colorBarX = x - 50;

    colorBarGroup = svg
      .append("g")
      .attr("class", "color-bar")
      .attr("transform", `translate(${colorBarX}, ${y})`);

    windGroup = svg
      .append("g")
      .attr("class", "wind")
      .attr("transform", `translate(${x}, ${y})`)
      .style("pointer-events", "all")
      .style("cursor", "pointer");

    windGroup
      .append("text")
      .attr("dy", -28)
      .style("font-size", "12px")
      .style("fill", "white")
      .style("stroke", "none")
      .text("TWD");

    windText = windGroup
      .append("text")
      .attr("class", "wind-speed")
      .attr("dy", 35)
      .style("font-size", "12px")
      .style("fill", "white")
      .style("stroke", "none")
      .text("");

    compassGroup = windGroup
      .append("g")
      .attr("class", "compass");

    compassGroup
      .append("circle")
      .attr("r", 20)
      .style("stroke", "white")
      .style("fill", "none")
      .style("stroke-width", 1);

    compassGroup
      .append("line")
      .attr("x1", 0)
      .attr("x2", 0)
      .attr("y1", 20)
      .attr("y2", -20)
      .style("stroke", "white")
      .style("stroke-width", 2);

    compassGroup
      .append("line")
      .attr("x1", 0)
      .attr("x2", -8)
      .attr("y1", -20)
      .attr("y2", -12)
      .style("stroke", "white")
      .style("stroke-width", 2);

    compassGroup
      .append("line")
      .attr("x1", 0)
      .attr("x2", 8)
      .attr("y1", -20)
      .attr("y2", -12)
      .style("stroke", "white")
      .style("stroke-width", 2);

    windGroup.on("dblclick", () => {
      if (!props.map || props.twd === undefined) return;
      rotationState = 0;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(getRotationStateKey(), '0');
        }
      } catch {
        // ignore
      }
      props.map.easeTo({
        bearing: 0,
        duration: 500
      });
    });

    // Single click: first click → wind direction, then 90° increments, then true north (cycle: 0→1→2→3→4→0)
    windGroup.on("click", () => {
      if (!props.map) return;
      const effectiveTwd = props.twd !== undefined ? props.twd : lastValidTwd;
      if (effectiveTwd === undefined) return;

      rotationState = (rotationState + 1) % 5;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(getRotationStateKey(), String(rotationState));
        }
      } catch {
        // ignore
      }
      let targetBearing = 0;
      if (rotationState === 1) {
        targetBearing = effectiveTwd; // wind from top
      } else if (rotationState === 2) {
        targetBearing = effectiveTwd + 90; // wind from left
      } else if (rotationState === 3) {
        targetBearing = effectiveTwd + 180; // wind from bottom
      } else if (rotationState === 4) {
        targetBearing = effectiveTwd + 270; // wind from right
      }
      // rotationState === 0: true north (targetBearing stays 0)

      while (targetBearing > 180) targetBearing -= 360;
      while (targetBearing < -180) targetBearing += 360;

      props.map.easeTo({
        bearing: targetBearing,
        duration: 500
      });
    });

    // Update arrow when map rotation changes (e.g. after clicking wind arrow to rotate map)
    updateOnMapMoveHandler = () => updateArrow();
    props.map.on("rotate", updateOnMapMoveHandler);
    props.map.on("moveend", updateOnMapMoveHandler);

    isInitialized = true;
    logDebug('WindArrow: initializeWindArrow - initialization complete', { 
      hasWindGroup: !!windGroup, 
      hasColorBarGroup: !!colorBarGroup 
    });
  };

  const updateArrow = () => {
    // Initialize if not already done and map is available
    if (!isInitialized && props.map && props.map.loaded && props.map.loaded()) {
      initializeWindArrow();
    }

    if (!windGroup || !compassGroup || !windText || !props.map) return;

    const tws = props.tws;
    const twd = props.twd;

    // Update last valid values if current values are valid
    if (tws !== undefined && twd !== undefined) {
      lastValidTws = tws;
      lastValidTwd = twd;
    }

    // Use last valid values if current values are undefined
    // Only hide arrow if we've never had valid data
    const effectiveTws = tws !== undefined ? tws : lastValidTws;
    const effectiveTwd = twd !== undefined ? twd : lastValidTwd;

    if (effectiveTws === undefined || effectiveTwd === undefined) {
      // Hide arrow only if we've never had valid data
      windGroup.style("opacity", 0);
      return;
    }

    // Show arrow with last valid values
    windGroup.style("opacity", 1);

    // Get map bearing
    const mapBearing = props.map.getBearing ? props.map.getBearing() : 0;

    // Calculate rotation
    // Wind direction needs to be adjusted for map rotation
    // The arrow points in the direction the wind is coming FROM
    let rotation = effectiveTwd - mapBearing - 180;

    // Normalize rotation to -360 to 360
    while (rotation > 360) rotation -= 360;
    while (rotation < -360) rotation += 360;

    // Update wind speed text
    const twsFormatted = round(effectiveTws, 1) + " kph";
    windText.text(twsFormatted);

    // Update compass rotation
    compassGroup.attr("transform", `rotate(${rotation})`);
  };

  // Store event handlers for cleanup
  let updateOnMapMoveHandler: (() => void) | null = null;
  let updateOnResizeHandler: (() => void) | null = null;

  // Register cleanup at component level
  onCleanup(() => {
    if (props.map && updateOnMapMoveHandler) {
      props.map.off("rotate", updateOnMapMoveHandler);
      props.map.off("moveend", updateOnMapMoveHandler);
    }
    if (props.map && updateOnResizeHandler) {
      props.map.off("resize", updateOnResizeHandler);
    }
    if (updateOnResizeHandler) {
      window.removeEventListener("resize", updateOnResizeHandler);
    }
    if (windGroup) {
      windGroup.remove();
    }
  });

  onMount(() => {
    logDebug('WindArrow: onMount called', { 
      hasMap: !!props.map, 
      mapLoaded: props.map?.loaded?.() 
    });
    
    if (!props.map) {
      logDebug('WindArrow: onMount - no map, returning');
      return;
    }

    // Use shared initialization function
    if (!props.map.loaded()) {
      logDebug('WindArrow: onMount - map not loaded, waiting for load event');
      props.map.once('load', () => {
        logDebug('WindArrow: onMount - map load event received, initializing');
        // Add a small delay to ensure everything is ready
        setTimeout(() => {
          initializeWindArrow();
        }, 100);
      });
      return;
    }

    // Map is already loaded, initialize immediately
    logDebug('WindArrow: onMount - map already loaded, initializing immediately');
    initializeWindArrow();
  });


  // Update arrow and color bar when props change
  createEffect(() => {
    // Ensure initialization happens if map becomes available
    if (!isInitialized && props.map) {
      if (props.map.loaded && props.map.loaded()) {
        initializeWindArrow();
      } else if (props.map.once) {
        // Map not loaded yet, wait for it
        props.map.once('load', () => {
          setTimeout(() => {
            initializeWindArrow();
          }, 100);
        });
      }
    }
    
    updateArrow();
    updateColorBar();
  });

  // Component doesn't render anything - it manipulates DOM directly
  return null;
}

