// @ts-nocheck
import { createSignal, createEffect, onCleanup } from "solid-js";
import * as d3 from "d3";
import { selectedTime, playbackSpeed, isPlaying, smoothPlaybackTimeForTrack } from "../../../../store/playbackStore";
import { persistantStore } from "../../../../store/persistantStore";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { getInterpolatedPointAtTime } from "../../../../utils/trackInterpolation";
import { warn, error as logError, debug } from "../../../../utils/console";
import { getData } from "../../../../utils/global";
import { apiEndpoints } from "@config/env";

// Import mapboxgl dynamically
let mapboxgl: any = null;

// Initialize mapboxgl
const initMapboxgl = async () => {
  if (!mapboxgl) {
    try {
      const mapboxModule = await import("mapbox-gl");
      mapboxgl = mapboxModule.default || mapboxModule;
    } catch (error) {
      logError('Failed to import mapbox-gl:', error);
    }
  }
  return mapboxgl;
};

export interface TrackPoint {
  Datetime: Date;
  Lat: number;
  Lng: number;
  Twd: number;
  Twa: number;
  Tws: number;
  Bsp: number;
  Hdg: number;
  Grade: number;
  Vmg_perc: number;
  event_id: number;
  [key: string]: any;
}

export interface BoatAnimationConfig {
  sourceId?: number; // Source ID for unique boat overlay identification
  sourceName?: string; // Source name for display
  samplingFrequency: number;
  transitionDuration?: number;
  easing?: d3.EaseFunction;
  pauseOnSelection?: boolean;
  sourceColor?: string;
  /** When true and animation stopped, emphasize label (e.g. double font size) */
  isHovered?: () => boolean;
  /** When true (hovered or selected boat), emphasize label; persists during animation when selected */
  isHighlighted?: () => boolean;
  onHover?: () => void;
  onLeave?: () => void;
}

// Function to get boat path based on class icon type
const getBoatPath = (): string => {
  const { selectedClassIcon } = persistantStore;
  const iconValue = selectedClassIcon();
  // Trim and lowercase for comparison, handle null/undefined/empty strings
  const iconType = (iconValue && typeof iconValue === 'string' && iconValue.trim() !== '') 
    ? iconValue.trim().toLowerCase() 
    : 'monohull';
  
  debug('[getBoatPath] Icon check:', { 
    iconValue, 
    iconType, 
    willUseMultihull: iconType === 'multihull',
    isString: typeof iconValue === 'string',
    trimmed: iconValue && typeof iconValue === 'string' ? iconValue.trim() : 'N/A'
  });
  
  if (iconType === 'multihull') {
    debug('[getBoatPath] Using multihull path');
    // Multihull coordinates scaled to be 2x wider than monohull, centered at (0,0)
    // Original coordinates: [0, 4], [2, 0], [2, 2], [2.5, 4], [3, 2], [3, -4], [-3, -4], [-3, 2], [-2.5, 4], [-2,2], [-2, 0], [0, 4]
    // Scale: x by 2.666 (1.333 * 2 for 2x width), y by 3 (24/8) to match monohull height
    // Offset y by +12 to center vertically at (0,0) - multihull goes from y=-12 to y=12 (same as monohull)
    return "M0 12 L5.332 0 L5.332 6 L6.665 12 L8 6 L8 -12 L-8 -12 L-8 6 L-6.665 12 L-5.332 6 L-5.332 0 Z";
  }
  
  debug('[getBoatPath] Using monohull path (default)');
  // Default monohull path
  return "M0 -12 L-4 -12 L-4 0 L-2 8 L0 12 L2 8 L4 0 L4 -12 Z";
};

// Function to get source color from project settings
const getSourceColorFromApi = async (): Promise<string> => {
  try {
    const { selectedClassName, selectedProjectId, selectedSourceId, selectedClassIcon } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const sourceId = selectedSourceId();
    
    if (!className || !projectId || !sourceId) {
      return "darkblue"; // Default color
    }
    
    const response = await getData(
      `${apiEndpoints.app.sources}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}`
    );
    
    if (response.success && response.data) {
      const source = response.data.find((s: any) => s.source_id === sourceId);
      return source?.color || "darkblue";
    }
    
    return "darkblue"; // Default color
  } catch (error) {
    debug('Error fetching source color:', error);
    return "darkblue"; // Default color
  }
};

// Prefer explicit color from config; fallback to API
const resolveSourceColor = async (cfg: BoatAnimationConfig): Promise<string> => {
  if (cfg && cfg.sourceColor) return cfg.sourceColor;
  return await getSourceColorFromApi();
};

export function useBoatAnimation(config: BoatAnimationConfig) {
  // Get dynamic channel names from store
  const { latName, lngName, hdgName } = defaultChannelsStore;
  const { selectedClassIcon, selectedClassSizeM } = persistantStore;
  
  // Helper function to get Lat/Lng values with case-insensitive fallback
  const getLat = (d: any): number | undefined => {
    if (!d) return undefined;
    const latField = latName();
    const val = d[latField] ?? d[latField.toLowerCase()] ?? d[latField.toUpperCase()] ?? d.Lat ?? d.lat;
    if (val === undefined || val === null) return undefined;
    const numVal = Number(val);
    return isNaN(numVal) ? undefined : numVal;
  };
  
  const getLng = (d: any): number | undefined => {
    if (!d) return undefined;
    const lngField = lngName();
    const val = d[lngField] ?? d[lngField.toLowerCase()] ?? d[lngField.toUpperCase()] ?? d.Lng ?? d.lng;
    if (val === undefined || val === null) return undefined;
    const numVal = Number(val);
    return isNaN(numVal) ? undefined : numVal;
  };
  
  // Helper function to get Hdg value with case-insensitive fallback
  const getHdg = (d: any): number | undefined => {
    if (!d) return undefined;
    const hdgField = hdgName();
    const val = d[hdgField] ?? d[hdgField.toLowerCase()] ?? d[hdgField.toUpperCase()] ?? d.Hdg ?? d.hdg;
    if (val === undefined || val === null) return undefined;
    const numVal = Number(val);
    return isNaN(numVal) ? undefined : numVal;
  };


  // Helper function to calculate label flip rotation (180° when upside down for readability)
  const calculateLabelFlip = (boatRotation: number): number => {
    // Normalize rotation to 0-360 range
    const normalizedRotation = ((boatRotation % 360) + 360) % 360;
    // Flip 180° when text would be upside down (between 90° and 270°)
    if (normalizedRotation > 90 && normalizedRotation < 270) {
      return 180;
    }
    return 0;
  };

  // Helper function to update label rotation for readability
  const updateLabelRotation = (boatRotation: number) => {
    const boat = boatIcon();
    if (!boat) return;
    
    const sourceNameText = boat.select(".boat-source-name");
    if (!sourceNameText.empty()) {
      const flipRotation = calculateLabelFlip(boatRotation);
      sourceNameText.attr("transform", `rotate(${flipRotation})`);
    }
  };
  const [boatIcon, setBoatIcon] = createSignal<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const [isAnimating, setIsAnimating] = createSignal(false);
  const [lastUpdateTime, setLastUpdateTime] = createSignal(0);
  const [isAnimationLocked, setIsAnimationLocked] = createSignal(false);
  const [suppressAnimationUntilTs, setSuppressAnimationUntilTs] = createSignal(0);
  const [transitionStartTime, setTransitionStartTime] = createSignal(0);
  const [currentTransitionDuration, setCurrentTransitionDuration] = createSignal(0);
  const [trackData, setTrackData] = createSignal<TrackPoint[]>([]);
  let lastDiscretePointIndex = -1;
  let lastDiscreteDataLength = 0;

  // Initialize mapboxgl when hook is created
  initMapboxgl();

  // Helper function to get timestamp from data point
  const getTimestamp = (d: TrackPoint): Date => {
    if (!d) return new Date(0);
    
    const timestamp = d.Datetime || d.timestamp || d.time || d.datetime;
    
    if (!timestamp) return new Date(0);
    
    if (timestamp instanceof Date) return timestamp;
    if (typeof timestamp === 'number') return new Date(timestamp);
    if (typeof timestamp === 'string') {
      const parsed = new Date(timestamp);
      if (!isNaN(parsed.getTime())) return parsed;
    }
    
    return new Date(0);
  };

  // Calculate dynamic transition duration based on detected frequency
  // Transition duration MUST be shorter than polling interval to prevent flashing
  // At higher speeds, polling interval gets shorter, so transition must be proportionally shorter
  const TRANSITION_MULTIPLIER_1X = 0.95; // Use 95% of polling interval at 1x for slower, more gradual animation
  const TRANSITION_MULTIPLIER_HIGH_SPEED = 0.85; // Use 85% of polling interval at higher speeds to ensure completion before next update
  
  // Quick synchronous frequency calculation from first few data points
  const calculateFrequencySync = (data: TrackPoint[]): number | null => {
    if (!data || data.length < 2) return null;
    
    // Use first 100 points (or all if less) for quick calculation
    const sampleSize = Math.min(100, data.length);
    const sample = data.slice(0, sampleSize);
    
    const intervals: number[] = [];
    for (let i = 1; i < sample.length; i++) {
      const time1 = getTimestamp(sample[i - 1]).getTime();
      const time2 = getTimestamp(sample[i]).getTime();
      if (time1 > 0 && time2 > 0 && time2 > time1) {
        intervals.push(time2 - time1);
      }
    }
    
    if (intervals.length === 0) return null;
    
    // Calculate average interval (median is more robust but average is faster)
    const sum = intervals.reduce((a, b) => a + b, 0);
    const averageInterval = sum / intervals.length;
    
    return averageInterval;
  };
  
  const calculateTransitionDuration = (speed: number = 1, data?: TrackPoint[]): number => {
    // Use samplingFrequency from config (1Hz for non-live, computed for live)
    // Convert Hz to milliseconds: interval = 1000 / frequency
    let baseInterval = 1000 / config.samplingFrequency; // Default: 1000ms for 1Hz
    
    // For live data, if samplingFrequency is not available, compute from data
    if (data && data.length >= 2 && (!config.samplingFrequency || config.samplingFrequency <= 0)) {
      const syncInterval = calculateFrequencySync(data);
      if (syncInterval) {
        baseInterval = syncInterval;
      }
    }
    
    // Use same fallback logic: 1000ms default for 1Hz data
    baseInterval = baseInterval || 1000;
    const pollingInterval = Math.max(50, baseInterval / Math.max(1, speed));
    
    // Transition duration must be SHORTER than polling interval to prevent flashing
    // At 1x speed: use 90% of polling interval for smooth animation
    // At higher speeds: use 85% to ensure transition completes before next update
    const multiplier = speed <= 1 ? TRANSITION_MULTIPLIER_1X : TRANSITION_MULTIPLIER_HIGH_SPEED;
    const duration = pollingInterval * multiplier;
    
    // Ensure minimum duration of 50ms for very fast speeds
    return Math.max(50, duration);
  };

  // Interpolate between two data points based on time
  const interpolateDataPoint = (point1: TrackPoint, point2: TrackPoint, targetTime: Date): TrackPoint => {
    const time1 = getTimestamp(point1).getTime();
    const time2 = getTimestamp(point2).getTime();
    const targetTimeMs = targetTime.getTime();
    
    // If target time is exactly at one of the points, return that point
    if (targetTimeMs <= time1) return point1;
    if (targetTimeMs >= time2) return point2;
    
    // Calculate interpolation factor (0 to 1)
    const factor = (targetTimeMs - time1) / (time2 - time1);
    
    
    // Interpolate all numeric properties
    const point1Lat = getLat(point1);
    const point1Lng = getLng(point1);
    const point2Lat = getLat(point2);
    const point2Lng = getLng(point2);
    
    if (point1Lat === undefined || point1Lng === undefined || point2Lat === undefined || point2Lng === undefined) {
      // If coordinates are missing, return the closest point
      return targetTimeMs - time1 < time2 - targetTimeMs ? point1 : point2;
    }
    
    const point1Hdg = getHdg(point1);
    const point2Hdg = getHdg(point2);
    const point1Twd = point1.Twd ?? point1.twd;
    const point2Twd = point2.Twd ?? point2.twd;
    
    // Get default TWA channel name for consistent TWA field access
    const defaultTwaName = defaultChannelsStore.twaName();
    const point1Twa = point1[defaultTwaName] ?? point1.Twa ?? point1.twa;
    const point2Twa = point2[defaultTwaName] ?? point2.Twa ?? point2.twa;
    
    const point1Tws = point1.Tws ?? point1.tws;
    const point2Tws = point2.Tws ?? point2.tws;
    const point1Bsp = point1.Bsp ?? point1.bsp;
    const point2Bsp = point2.Bsp ?? point2.bsp;
    
    const interpolated: TrackPoint = {
      Datetime: targetTime,
      Lat: point1Lat + (point2Lat - point1Lat) * factor,
      Lng: point1Lng + (point2Lng - point1Lng) * factor,
      Twd: interpolateAngle(point1Twd, point2Twd, factor),
      Twa: interpolateAngle(point1Twa, point2Twa, factor),
      Tws: point1Tws + (point2Tws - point1Tws) * factor,
      Bsp: point1Bsp + (point2Bsp - point1Bsp) * factor,
      Hdg: point1Hdg !== undefined && point2Hdg !== undefined ? interpolateAngle(point1Hdg, point2Hdg, factor) : (point1Hdg ?? point2Hdg ?? 0),
      Grade: point1.Grade + (point2.Grade - point1.Grade) * factor,
      Vmg_perc: point1.Vmg_perc + (point2.Vmg_perc - point1.Vmg_perc) * factor,
      event_id: point1.event_id, // Keep the first point's event_id
      ...point1 // Copy any other properties from the first point
    };
    
    return interpolated;
  };

  // Helper function to interpolate angles (handles 0-360 degree wrapping)
  const interpolateAngle = (angle1: number, angle2: number, factor: number): number => {
    let diff = angle2 - angle1;
    
    // Handle angle wrapping (e.g., 350° to 10° should go through 0°)
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    
    const interpolated = angle1 + diff * factor;
    
    // Ensure result is in 0-360 range
    return ((interpolated % 360) + 360) % 360;
  };

  // Calculate boat size based on zoom level (22 meters at appropriate zoom)
  // Boat starts at default small size and only scales up when real aspect ratio would be larger
  const calculateBoatSize = (map: any): number => {
    if (!map) return 1;
    
    const zoom = map.getZoom();
    const center = map.getCenter();
    const latitude = center ? center.lat : 0;
    
    // More accurate meters per pixel calculation using latitude
    const metersPerPixel = 156543.03392 * Math.cos(latitude * Math.PI / 180) / Math.pow(2, zoom);
    
    // Use selectedClassSizeM if available, otherwise fall back to default 22 meters
    const sizeM = selectedClassSizeM();
    const targetMeters = (sizeM !== null && sizeM !== undefined && !isNaN(sizeM) && sizeM > 0) 
      ? sizeM 
      : 22; // Default 22 meters boat length
    
    const targetPixels = targetMeters / metersPerPixel;
    
    // Scale factor based on target pixels vs current boat size (base size is ~24 pixels)
    const baseSize = 24; // Base boat size in pixels
    const realAspectRatioScale = targetPixels / baseSize;
    
    // Default small size - boat always starts at this size
    const defaultScale = 0.75; // Default 75% of base size (reduced by 25% from 1.0)
    
    // Only use real aspect ratio scale if it's larger than default
    // This means boat stays at default size when zoomed out, and grows when zoomed in
    let finalScale = Math.max(defaultScale, realAspectRatioScale);
    
    // Apply maximum size limit to prevent boat from getting too large
    const absoluteMaxScale = 12.0; // Absolute maximum scale
    finalScale = Math.min(absoluteMaxScale, finalScale);
    
    // Apply 25% size reduction for multihull boats (multiply by 0.75)
    const iconValue = selectedClassIcon();
    const iconType = (iconValue && typeof iconValue === 'string' && iconValue.trim() !== '') 
      ? iconValue.trim().toLowerCase() 
      : 'monohull';
    if (iconType === 'multihull') {
      finalScale = finalScale * 0.75;
    }
    
    return finalScale;
  };

  // Update boat position with smooth transition (includes halo effect)
  const updateBoatPosition = (point: TrackPoint, map: any) => {
    const boat = boatIcon();
    if (!boat || !map) return;

    // Get coordinates using dynamic channel names
    const pointLat = getLat(point);
    const pointLng = getLng(point);
    
    // Safety check for missing coordinates
    if (pointLat === undefined || pointLng === undefined || isNaN(pointLat) || isNaN(pointLng)) {
      warn('Boat animation: Missing or invalid coordinates:', { Lng: pointLng, Lat: pointLat });
      return;
    }

    // Use D3 projection that syncs with map transformations
    const { projection, mapBearing, mapPitch } = boat.projection();
    const projectedPoint = projection([pointLng, pointLat]);
    
    // Use the projected point directly (no offset for now)
    const adjustedMapPoint = {
      x: projectedPoint[0],
      y: projectedPoint[1]
    };
    
    // Calculate dynamic boat size based on zoom level
    const boatScale = calculateBoatSize(map);
    
    // Get current transform to calculate smooth rotation
    const currentTransform = boat.attr("transform");
    const currentRotation = currentTransform ? 
      parseFloat(currentTransform.match(/rotate\(([^)]+)\)/)?.[1] || "0") : 0;
    
    // Calculate target rotation including map bearing (from projection)
    // Note: Map bearing might need to be negated depending on coordinate system
    // Get Hdg using dynamic channel name
    const hdg = getHdg(point);
    if (hdg === undefined || hdg === null || isNaN(hdg) || !Number.isFinite(hdg)) {
      warn('Boat animation: Missing or invalid Hdg value, using 0', { hdg });
      return; // Skip rotation update if heading is invalid
    }
    
    const targetRotation = hdg + 180 - mapBearing;
    
    
    // Handle rotation wrapping (e.g., 350° to 10° should go through 0°)
    let rotationDiff = targetRotation - currentRotation;
    if (rotationDiff > 180) rotationDiff -= 360;
    if (rotationDiff < -180) rotationDiff += 360;
    const finalRotation = currentRotation + rotationDiff;
    
    // Calculate transition duration
    const transitionDuration = config.transitionDuration || calculateTransitionDuration();
    
    // Interrupt any existing transition and start new one
    boat.interrupt();
    
    // Get current position for immediate heading update (reuse currentTransform from above)
    const currentX = currentTransform ? 
      parseFloat(currentTransform.match(/translate\(([^,]+)/)?.[1] || "0") : adjustedMapPoint.x;
    const currentY = currentTransform ? 
      parseFloat(currentTransform.match(/translate\([^,]+,([^)]+)\)/)?.[1] || "0") : adjustedMapPoint.y;
    const currentScale = currentTransform ? 
      parseFloat(currentTransform.match(/scale\(([^)]+)\)/)?.[1] || "1") : boatScale;
    
    // Immediately update heading (no transition)
    boat.attr("transform", `translate(${currentX}, ${currentY}) scale(${currentScale}) rotate(${finalRotation})`);
    
    // Update label flip rotation for readability
    updateLabelRotation(finalRotation);
    
    // Add subtle visual feedback for animation changes (smaller effect than manual)
    const animationScale = boatScale * 1.2; // Subtle size increase for animation
    
    // Smoothly transition the position with subtle scale effect
    boat
      .transition()
      .duration(transitionDuration)
      .ease(config.easing || d3.easeQuadInOut)
      .attr("transform", `translate(${adjustedMapPoint.x}, ${adjustedMapPoint.y}) scale(${animationScale}) rotate(${finalRotation})`)
      .on("end", () => {
        // Return to normal scale after animation (very quick)
        boat
          .transition()
          .duration(50)
          .ease(d3.easeCubicOut)
          .attr("transform", `translate(${adjustedMapPoint.x}, ${adjustedMapPoint.y}) scale(${boatScale}) rotate(${finalRotation})`);
      });
    
    // Update label flip rotation for readability
    updateLabelRotation(finalRotation);
  };

  // Update boat position with smooth transition (NO halo effect - for animation only)
  const updateBoatPositionAnimated = (point: TrackPoint, map: any) => {
    const boat = boatIcon();
    if (!boat || !map) {
      warn('updateBoatPositionAnimated: Missing boat or map', { boat: !!boat, map: !!map });
      return;
    }

    // Get coordinates using dynamic channel names
    const pointLat = getLat(point);
    const pointLng = getLng(point);
    
    // Safety check for missing coordinates
    if (pointLat === undefined || pointLng === undefined || isNaN(pointLat) || isNaN(pointLng)) {
      warn('Boat animation: Missing or invalid coordinates:', { Lng: pointLng, Lat: pointLat });
      return;
    }

    try {
      // If we've just snapped due to a manual change, suppress transition briefly
      if (Date.now() < suppressAnimationUntilTs()) {
        const snapPoint = map.project([pointLng, pointLat]);
        if (snapPoint && !isNaN(snapPoint.x) && !isNaN(snapPoint.y)) {
          const snapScale = calculateBoatSize(map);
          const snapBearing = map.getBearing ? map.getBearing() : 0;
          const snapHdg = getHdg(point);
          if (snapHdg === undefined || isNaN(snapHdg)) {
            boat.interrupt();
            boat.attr("transform", `translate(${snapPoint.x}, ${snapPoint.y}) scale(${snapScale}) rotate(0)`);
            return;
          }
          const snapRotation = snapHdg + 180 - snapBearing;
          boat.interrupt();
          boat.attr("transform", `translate(${snapPoint.x}, ${snapPoint.y}) scale(${snapScale}) rotate(${snapRotation})`);
        }
        return;
      }
      // Use map.project() directly like the track does - this automatically handles map transformations
      const mapPoint = map.project([pointLng, pointLat]);
      
      // Validate projected point
      if (!mapPoint || isNaN(mapPoint.x) || isNaN(mapPoint.y)) {
        warn('Boat animation: Invalid projected coordinates:', mapPoint);
        return;
      }
      
      // Use the map projected point directly
      const adjustedMapPoint = {
        x: mapPoint.x,
        y: mapPoint.y
      };
      
      // Removed frequent coordinate projection log
      
      // Calculate dynamic boat size based on zoom level
      const boatScale = calculateBoatSize(map);
      
      // Calculate target rotation including map bearing
      const mapBearing = map.getBearing ? map.getBearing() : 0;
      // Get Hdg using dynamic channel name
      const hdg = getHdg(point);
      if (hdg === undefined || hdg === null || isNaN(hdg) || !Number.isFinite(hdg)) {
        warn('Boat animation: Missing or invalid Hdg value, skipping update', { hdg });
        return; // Skip rotation update if heading is invalid
      }
      const targetRotation = hdg + 180 - mapBearing;
      
      // Calculate transition duration based on playback speed
      const speed = typeof playbackSpeed === 'function' ? playbackSpeed() : 1;
      // Use samplingFrequency from config (1Hz for non-live, computed for live)
      const baseInterval = 1000 / config.samplingFrequency; // Convert Hz to ms
      
      // Calculate transition duration using the shared function
      // This ensures manual updates and playback use the same calculation
      // At 1x speed: always 1.0 (1 step per second)
      // At speeds > 1x: uses TRANSITION_OFFSET_GLOBAL
      // Pass data for synchronous frequency calculation if samplingFrequency not available
      let transitionDuration = calculateTransitionDuration(speed, trackData());
      
      // Safety check: ensure transition duration is valid
      if (!transitionDuration || transitionDuration <= 0 || isNaN(transitionDuration)) {
        warn('BoatAnimation: Invalid transition duration, using fallback', { transitionDuration, speed, baseInterval });
        transitionDuration = baseInterval; // Fallback to base interval
      }
      
      const pollingInterval = Math.max(50, baseInterval / Math.max(1, speed));
      // Removed frequent animation parameters log - fires every frame
      
      // Clever interruption strategy:
      // 1. Calculate how much of previous transition was completed
      // 2. Adjust duration intelligently based on progress
      // 3. D3 automatically handles position handoff when we interrupt and start new transition
      const now = Date.now();
      const elapsed = transitionStartTime() > 0 ? now - transitionStartTime() : 0;
      const prevDuration = currentTransitionDuration();
      const progress = prevDuration > 0 ? Math.min(1, elapsed / prevDuration) : 0;
      
      // Use the calculated transition duration directly - don't adjust based on progress
      // The interruption will happen naturally when the next update arrives
      // This ensures TRANSITION_OFFSET actually controls the duration
      let adjustedDuration = transitionDuration;
      
      // Only adjust if we're very early in a transition (<20%) - then we can use full duration
      // Otherwise, use the calculated duration to respect TRANSITION_OFFSET
      if (progress > 0.2 && progress < 0.5 && prevDuration > 0) {
        // Early-mid transition: use remaining time to maintain smoothness
        const remainingTime = prevDuration * (1 - progress);
        adjustedDuration = Math.max(remainingTime, transitionDuration * 0.8);
      }
      
      // Safety check: ensure adjusted duration is valid
      if (!adjustedDuration || adjustedDuration <= 0 || isNaN(adjustedDuration)) {
        warn('BoatAnimation: Invalid adjusted duration, using transitionDuration', { adjustedDuration, transitionDuration });
        adjustedDuration = transitionDuration;
      }
      
      // Removed frequent transition start log - fires every frame
      
      // Interrupt current transition (D3 automatically preserves current interpolated position)
      boat.interrupt();
      
      // Track transition start time and duration
      setTransitionStartTime(now);
      setCurrentTransitionDuration(adjustedDuration);
      
      // Use smooth transition with adjusted duration for seamless handoff
      boat
        .transition()
        .duration(adjustedDuration)
        .ease(config.easing || d3.easeLinear)
        .attr("transform", `translate(${adjustedMapPoint.x}, ${adjustedMapPoint.y}) scale(${boatScale}) rotate(${targetRotation})`)
        .on("end", () => {
          setTransitionStartTime(0); // Reset when transition completes
        });
      
      // Update label flip rotation for readability
      updateLabelRotation(targetRotation);
        
    } catch (error) {
      warn('Boat animation: Error in updateBoatPositionAnimated:', error);
    }
  };

  // Playback ticks every 100ms; step = 0.1 * speed s per tick. Scale transition with speed so the boat
  // glides smoothly over the larger step (not a snap): longer transition at 2x/3x/4x so motion stays smooth.
  const BOAT_TICK_MS = 100;
  const updateBoatPositionSmooth = (point: TrackPoint, map: any) => {
    const boat = boatIcon();
    if (!boat || !map) return;

    const pointLat = getLat(point);
    const pointLng = getLng(point);
    if (pointLat === undefined || pointLng === undefined || isNaN(pointLat) || isNaN(pointLng)) return;

    try {
      const mapPoint = map.project([pointLng, pointLat]);
      if (!mapPoint || isNaN(mapPoint.x) || isNaN(mapPoint.y)) return;

      const boatScale = calculateBoatSize(map);
      const mapBearing = map.getBearing ? map.getBearing() : 0;
      const hdg = getHdg(point);
      if (hdg === undefined || hdg === null || isNaN(hdg) || !Number.isFinite(hdg)) return;
      const targetRotation = hdg + 180 - mapBearing;

      const speed = Math.max(1, playbackSpeed());
      const durationMs = Math.min(500, Math.round(BOAT_TICK_MS * speed));

      boat.interrupt();
      boat
        .transition()
        .duration(durationMs)
        .ease(d3.easeLinear)
        .attr("transform", `translate(${mapPoint.x}, ${mapPoint.y}) scale(${boatScale}) rotate(${targetRotation})`)
        .on("end", () => updateLabelRotation(targetRotation));
      updateLabelRotation(targetRotation);
    } catch (error) {
      warn('Boat animation: Error in updateBoatPositionSmooth:', error);
    }
  };

  // Check if a point is visible in the current map viewport
  const isPointInViewport = (point: TrackPoint, map: any): boolean => {
    const pointLat = getLat(point);
    const pointLng = getLng(point);
    if (!map || pointLat === undefined || pointLng === undefined) return false;
    
    try {
      // Get the map's current bounds
      const bounds = map.getBounds();
      
      // Check if the point is within the visible bounds
      const isWithinBounds = 
        pointLng >= bounds.getWest() && 
        pointLng <= bounds.getEast() && 
        pointLat >= bounds.getSouth() && 
        pointLat <= bounds.getNorth();
      
      return isWithinBounds;
    } catch (error) {
      // If there's an error getting bounds, assume point is not visible
      return false;
    }
  };

  // Update boat position immediately without transition (for manual changes)
  const updateBoatPositionImmediate = async (point: TrackPoint, map: any, showHalo: boolean = true) => {
    const boat = boatIcon();
    if (!boat || !map) return;

    // Get coordinates using dynamic channel names
    const pointLat = getLat(point);
    const pointLng = getLng(point);
    
    // Safety check for missing coordinates
    if (pointLat === undefined || pointLng === undefined || isNaN(pointLat) || isNaN(pointLng)) {
      warn('Boat animation: Missing or invalid coordinates:', { Lng: pointLng, Lat: pointLat });
      return;
    }

    // Only center the map if the boat is outside the current viewport
    const isBoatVisible = isPointInViewport(point, map);
    
    if (!isBoatVisible) {
      map.flyTo({
        center: [pointLng, pointLat],
        zoom: Math.max(map.getZoom(), 14), // Ensure minimum zoom level
        duration: 1000, // 1 second smooth transition
        essential: true
      });
    }

    try {
      // Use map.project() directly like the track does - this automatically handles map transformations
      const mapPoint = map.project([pointLng, pointLat]);
      
      // Validate projected point
      if (!mapPoint || isNaN(mapPoint.x) || isNaN(mapPoint.y)) {
        warn('Boat animation: Invalid projected coordinates:', mapPoint);
        return;
      }
      
      // Use the map projected point directly
      const adjustedMapPoint = {
        x: mapPoint.x,
        y: mapPoint.y
      };
      
      // Calculate dynamic boat size based on zoom level
      const boatScale = calculateBoatSize(map);
      
      // Calculate target rotation including map bearing
      const mapBearing = map.getBearing ? map.getBearing() : 0;
      // Get Hdg using dynamic channel name
      const hdg = getHdg(point);
      if (hdg === undefined || hdg === null || isNaN(hdg) || !Number.isFinite(hdg)) {
        warn('Boat animation: Missing or invalid Hdg value, skipping update', { hdg });
        return; // Skip rotation update if heading is invalid
      }
      const targetRotation = hdg + 180 - mapBearing;
      
      // Get source color for halo
      const sourceColor = await resolveSourceColor(config);
      
      // Interrupt any existing transition
      boat.interrupt();
      
      // Set boat to final position immediately (no transition)
      boat.attr("transform", `translate(${adjustedMapPoint.x}, ${adjustedMapPoint.y}) scale(${boatScale}) rotate(${targetRotation})`);
      
      // Update label flip rotation for readability
      updateLabelRotation(targetRotation);
      
      // Suppress subsequent animation for a short period to avoid immediate transition override
      setSuppressAnimationUntilTs(Date.now() + 400);
      
      if (showHalo) {
        // Add source color halo effect as a simple circle
        const halo = boat.select(".boat-halo");
        if (halo.empty()) {
          // Create halo circle if it doesn't exist
          const fixedHaloSize = 50; // Fixed 50px halo size (diameter)
          const haloRadius = fixedHaloSize / 2; // 25px radius
          boat.insert("circle", ":first-child")
            .attr("class", "boat-halo")
            .attr("r", haloRadius)
            .attr("cx", 0)
            .attr("cy", 0)
            .attr("fill", sourceColor)
            .attr("stroke", sourceColor)
            .attr("stroke-width", "4")
            .attr("opacity", 0.5); // Start at full opacity
        }
        
        // Halo is centered on the boat position (no translation needed)
        // The circle is already positioned at (0,0) which is the boat's center
        const haloElement = boat.select(".boat-halo");
        
        // Keep halo at full opacity for 1.4 seconds, then fade out over 0.7 seconds (30% reduction)
        haloElement
          .transition()
          .delay(1400) // Wait 1.4 seconds at full opacity (reduced from 2 seconds)
          .duration(700) // 0.7 seconds fade out (reduced from 1 second)
          .ease(d3.easeCubicOut)
          .attr("opacity", 0) // Fade from 1.0 to 0
          .on("end", () => {
            // Remove halo after animation completes
            haloElement.remove();
          });
      }
        
    } catch (error) {
      warn('Boat animation: Error in updateBoatPositionImmediate:', error);
    }
  };

  // Update boat position with a fixed-duration transition (for scrubbing timeline: smooth glide to new timestamp).
  const updateBoatPositionWithTransition = (point: TrackPoint, map: any, durationMs: number) => {
    const boat = boatIcon();
    if (!boat || !map) return;

    const pointLat = getLat(point);
    const pointLng = getLng(point);
    if (pointLat === undefined || pointLng === undefined || isNaN(pointLat) || isNaN(pointLng)) return;

    try {
      const mapPoint = map.project([pointLng, pointLat]);
      if (!mapPoint || isNaN(mapPoint.x) || isNaN(mapPoint.y)) return;

      const boatScale = calculateBoatSize(map);
      const mapBearing = map.getBearing ? map.getBearing() : 0;
      const hdg = getHdg(point);
      const targetRotation =
        hdg !== undefined && hdg !== null && !isNaN(hdg) && Number.isFinite(hdg)
          ? hdg + 180 - mapBearing
          : 0;

      boat.interrupt();
      boat
        .transition()
        .duration(Math.max(50, durationMs))
        .ease(d3.easeQuadInOut)
        .attr("transform", `translate(${mapPoint.x}, ${mapPoint.y}) scale(${boatScale}) rotate(${targetRotation})`)
        .on("end", () => updateLabelRotation(targetRotation));
      updateLabelRotation(targetRotation);
    } catch (error) {
      warn('Boat animation: Error in updateBoatPositionWithTransition:', error);
    }
  };

  /** Reset discrete-playback state so next play starts from a clean transition. Call when playback stops or data changes. */
  const resetDiscretePlaybackState = () => {
    lastDiscretePointIndex = -1;
    lastDiscreteDataLength = 0;
  };

  /**
   * When playing: use discrete 1Hz points only (no interpolation). Transition only when the current 1Hz point index
   * changes, with duration = 1000/speed ms so 2x = 500ms, 4x = 250ms, etc.
   */
  const animateToDiscretePointWhenPlaying = (data: TrackPoint[], map: any) => {
    const boat = boatIcon();
    if (!data || data.length === 0 || !map || !boat) return;

    setTrackData(data);

    if (data.length !== lastDiscreteDataLength) {
      lastDiscreteDataLength = data.length;
      lastDiscretePointIndex = -1;
    }

    const currentTime = smoothPlaybackTimeForTrack();
    const currentMs = currentTime instanceof Date ? currentTime.getTime() : 0;
    if (!currentMs) return;

    const sorted = [...data].sort(
      (a, b) => getTimestamp(a).getTime() - getTimestamp(b).getTime()
    );
    let index = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (getTimestamp(sorted[i]).getTime() <= currentMs) index = i;
    }
    if (index < 0) index = 0;

    if (index === lastDiscretePointIndex) return;
    lastDiscretePointIndex = index;

    const point = sorted[index] as TrackPoint;
    const pointLat = getLat(point);
    const pointLng = getLng(point);
    if (pointLat === undefined || pointLng === undefined || isNaN(pointLat) || isNaN(pointLng)) return;

    try {
      const mapPoint = map.project([pointLng, pointLat]);
      if (!mapPoint || isNaN(mapPoint.x) || isNaN(mapPoint.y)) return;

      const boatScale = calculateBoatSize(map);
      const mapBearing = map.getBearing ? map.getBearing() : 0;
      const hdg = getHdg(point);
      const targetRotation =
        hdg !== undefined && hdg !== null && !isNaN(hdg) && Number.isFinite(hdg)
          ? hdg + 180 - mapBearing
          : 0;

      const speed = Math.max(0.25, playbackSpeed());
      const durationMs = Math.max(50, Math.min(2000, Math.round(1000 / speed)));

      boat.interrupt();
      boat
        .transition()
        .duration(durationMs)
        .ease(d3.easeLinear)
        .attr("transform", `translate(${mapPoint.x}, ${mapPoint.y}) scale(${boatScale}) rotate(${targetRotation})`)
        .on("end", () => updateLabelRotation(targetRotation));
      updateLabelRotation(targetRotation);
    } catch (error) {
      warn('Boat animation: Error in animateToDiscretePointWhenPlaying:', error);
    }
  };

  // Animate boat to closest point in data (smooth transition between discrete points)
  const animateToClosestPoint = (data: TrackPoint[], map: any, targetTime: Date, isManualChange: boolean = false) => {
    if (!data || data.length === 0 || !map) {
      warn('BoatAnimation: Missing data or map', { dataLength: data?.length, mapExists: !!map });
      return;
    }

    setTrackData(data);

    // Find the closest point to the target time - smooth transitions between discrete points
    const targetPoint = data.reduce((prev, curr) =>
      Math.abs(getTimestamp(curr).getTime() - targetTime.getTime()) <
      Math.abs(getTimestamp(prev).getTime() - targetTime.getTime()) ? curr : prev
    );

    if (targetPoint) {
      if (isManualChange) {
        updateBoatPositionImmediate(targetPoint, map);
      } else {
        updateBoatPositionAnimated(targetPoint, map);
      }
    } else {
      warn('BoatAnimation: No target point found');
    }
  };

  // Interpolation options for shared util (matches hook getters)
  const interpolateOptions = {
    getTimestamp: (d: any) => getTimestamp(d),
    getLat,
    getLng,
    getHdg,
  };

  // Update boat to interpolated position at throttled time (~10fps, same as multiboat).
  // Interpolation + 100ms linear transition gives continuous smooth glide.
  const animateToSmoothPoint = (data: TrackPoint[], map: any) => {
    if (!data || data.length === 0 || !map) return;
    setTrackData(data);
    const t = smoothPlaybackTimeForTrack();
    const point = getInterpolatedPointAtTime(data, t, interpolateOptions);
    if (point) updateBoatPositionSmooth(point, map);
  };

  // Create boat icon with map-synced projection
  const createBoatIcon = async (mapContainer: HTMLElement, map: any) => {
    debug('[useBoatAnimation] createBoatIcon called', {
      sourceId: config.sourceId,
      hasMapContainer: !!mapContainer,
      hasMap: !!map
    });
    
    // Use source ID to create unique boat overlay per source
    const sourceId = config.sourceId !== undefined ? config.sourceId : 'default';
    const overlayClass = `boat-overlay-${sourceId}`;
    
    // Check if boat icon already exists for this source (check both signal and DOM)
    const existingBoat = boatIcon();
    const existingOverlay = d3.select(`.${overlayClass}`);
    const existingBoatInOverlay = existingOverlay.select('.boat-icon');
    
    // If we have an existing boat in the DOM, reuse it even if signal is null
    if (existingBoatInOverlay.node()) {
      debug('[useBoatAnimation] Reusing existing boat from DOM');
      // Reuse existing boat from DOM
      const boatElement = existingBoatInOverlay.node() as any;
      const boatD3 = d3.select(boatElement);
      
      // Update the signal to point to the existing boat
      if (!existingBoat) {
        setBoatIcon(boatD3);
      }
      
      return boatD3;
    }
    
    // If signal has boat but DOM doesn't, use the signal boat
    if (existingBoat && existingBoat.node()) {
      debug('[useBoatAnimation] Reusing existing boat from signal');
      return existingBoat;
    }
    
    // Remove any stale boat icon for THIS source only (in case of orphaned overlay)
    d3.select(`.${overlayClass}`).remove();
    
    // Get source color
    debug('[useBoatAnimation] Resolving source color...');
    let sourceColor: string;
    try {
      sourceColor = await resolveSourceColor(config);
      debug('[useBoatAnimation] Source color resolved:', sourceColor);
    } catch (error) {
      warn('[useBoatAnimation] Error resolving source color, using default:', error);
      sourceColor = "darkblue";
    }
    
    // Create SVG overlay for boat - attach to mapboxgl-canvas-container like RaceCourseLayer
    let container: HTMLElement | null = null;
    try {
      container = map.getCanvasContainer() as HTMLElement;
      debug('[useBoatAnimation] Got canvas container from map');
    } catch (e) {
      debug('[useBoatAnimation] Failed to get canvas container from map, using fallback:', e);
      // Fallback to mapContainer
    }
    
    if (!container) {
      // Fallback to mapContainer
      container = mapContainer;
      debug('[useBoatAnimation] Using mapContainer as fallback');
    }
    
    if (!container) {
      warn('[useBoatAnimation] No container available for boat icon');
      return;
    }
    
    const mapRect = container.getBoundingClientRect();
    const clientWidth = container.clientWidth || mapRect.width;
    const clientHeight = container.clientHeight || mapRect.height;
    const width = mapRect.width || clientWidth || 0;
    const height = mapRect.height || clientHeight || 0;
    
    debug('[useBoatAnimation] Creating SVG overlay', { width, height, overlayClass });
    
    // Create SVG overlay for boat with unique class per source
    const svg = d3.select(container)
      .append("svg")
      .attr("class", `boat-overlay ${overlayClass}`)
      .attr("data-source-id", sourceId)
      .attr("width", width || 800)
      .attr("height", height || 600)
      .style("position", "absolute")
      .style("top", "0")
      .style("left", "0")
      .style("width", "100%")
      .style("height", "100%")
      .style("pointer-events", "none")
      .style("z-index", "1000");

    // Create boat icon group
    const boat = svg.append("g")
      .attr("class", "boat-icon")
      .style("opacity", 0);

    // Enable pointer-events and hover callbacks when provided (fleet map: path highlight + label emphasis when stopped)
    if (config.onHover != null || config.onLeave != null) {
      boat.style("pointer-events", "all").style("cursor", "pointer");
      boat.on("mouseenter", () => config.onHover?.());
      boat.on("mouseleave", () => config.onLeave?.());
    }

    debug('[useBoatAnimation] Creating boat shape with color:', sourceColor);
    
    const boatPath = getBoatPath();
    
    // Create a group for the boat paths (main boat and shadow) to center them within the halo
    const boatPathsGroup = boat.append("g")
      .attr("class", "boat-paths");
    
    // Create boat shape with source color
    boatPathsGroup.append("path")
      .attr("d", boatPath)
      .attr("class", "boat-icon")
      .attr("fill", sourceColor)
      .attr("stroke", "white")
      .attr("stroke-width", "1");

    // Add boat shadow
    boatPathsGroup.append("path")
      .attr("d", boatPath)
      .attr("fill", "rgba(0,0,0,0.3)")
      .attr("transform", "translate(1,1)");

    // Add source name label (11px white text, positioned to the right of boat)
    // Label rotates with boat, but flips 180° when upside down for readability
    boat.append("text")
      .attr("class", "boat-source-name")
      .attr("x", 12) // Position to the right of boat
      .attr("y", 0) // Slightly above center
      .attr("font-size", "11px")
      .attr("fill", "white")
      .attr("stroke", "black")
      .attr("stroke-width", "0.5px")
      .attr("stroke-opacity", "0.8")
      .attr("paint-order", "stroke")
      .attr("transform", "rotate(0)") // Will be updated to flip when upside down
      .style("pointer-events", "none")
      .text(config.sourceName || "");

    // Create a projection function that syncs with map transformations
  const updateProjection = () => {
    try {
      const mapCenter = map.getCenter();
      const mapZoom = map.getZoom();
      const mapBearing = map.getBearing ? map.getBearing() : 0;
      const mapPitch = map.getPitch ? map.getPitch() : 0;
      
      // Get map container dimensions
      const containerWidth = mapContainer.offsetWidth || mapContainer.clientWidth;
      const containerHeight = mapContainer.offsetHeight || mapContainer.clientHeight;
      
      // Create a projection that matches the map's current state
      // Use the same projection as Mapbox GL JS (Web Mercator)
      const projection = d3.geoMercator()
        .center([mapCenter.lng, mapCenter.lat])
        .scale(Math.pow(2, mapZoom) * 512) // Scale to match mapbox zoom
        .translate([containerWidth / 2, containerHeight / 2]);
      
      return { projection, mapBearing, mapPitch };
    } catch (error) {
      warn('BoatAnimation: Error updating projection:', error);
      // Return a fallback projection
      return {
        projection: d3.geoMercator()
          .center([0, 0])
          .scale(512)
          .translate([400, 300]),
        mapBearing: 0,
        mapPitch: 0
      };
    }
  };

    // Store projection function and boat reference
    boat.projection = updateProjection;
    setBoatIcon(boat);
    
    // Store globally for compatibility
    window.mapBoatIcon = boat;
    
    return boat;
  };

  // Show/hide boat icon (labels are children of boat, so they inherit visibility)
  const setBoatVisibility = (visible: boolean) => {
    const boat = boatIcon();
    if (boat) {
      const newOpacity = visible ? 1 : 0;
      boat.style("opacity", newOpacity);
    }
  };

  // Handle boat click events
  const addBoatClickHandler = (onClick: (point: TrackPoint) => void, getCurrentPoint?: () => TrackPoint | null) => {
    const boat = boatIcon();
    if (boat) {
      boat.style("pointer-events", "all")
        .style("cursor", "pointer")
        .on("click", (event) => {
          event.stopPropagation();
          const point = getCurrentPoint?.() ?? null;
          if (point) onClick(point);
        });
    }
  };

  // Handle map rotation changes
  const handleMapRotation = (map: any, currentData: TrackPoint[], currentTime: Date) => {
    if (currentData && currentData.length > 0 && currentTime) {
      // Find the closest point to current time
      const closestPoint = currentData.reduce((prev, curr) =>
        Math.abs(getTimestamp(curr).getTime() - currentTime.getTime()) < 
        Math.abs(getTimestamp(prev).getTime() - currentTime.getTime()) ? curr : prev
      );
      
      if (closestPoint) {
        // Update boat position with current rotation
        updateBoatPosition(closestPoint, map);
      }
    }
  };

  // Force boat rotation update (useful for immediate updates)
  const forceBoatRotationUpdate = (map: any, currentData: TrackPoint[], currentTime: Date) => {
    if (currentData && currentData.length > 0 && currentTime) {
      const closestPoint = currentData.reduce((prev, curr) =>
        Math.abs(getTimestamp(curr).getTime() - currentTime.getTime()) < 
        Math.abs(getTimestamp(prev).getTime() - currentTime.getTime()) ? curr : prev
      );
      
      if (closestPoint) {
        const boat = boatIcon();
        if (boat && map) {
          const closestLat = getLat(closestPoint);
          const closestLng = getLng(closestPoint);
          if (closestLat === undefined || closestLng === undefined) return;
          const mapPoint = map.project([closestLng, closestLat]);
          const mapBearing = map.getBearing ? map.getBearing() : 0;
          // Get Hdg using dynamic channel name
          const hdg = getHdg(closestPoint);
          if (hdg === undefined || hdg === null || isNaN(hdg) || !Number.isFinite(hdg)) {
            warn('Boat animation: Missing or invalid Hdg value, skipping update', { hdg });
            return; // Skip rotation update if heading is invalid
          }
          const targetRotation = hdg + 180 + mapBearing;
          const boatScale = calculateBoatSize(map); // Use proper zoom-based boat size calculation
      
          // Immediate update without transition
          boat.attr("transform", `translate(${mapPoint.x}, ${mapPoint.y}) scale(${boatScale}) rotate(${targetRotation})`);
          
          // Update label flip rotation for readability
          updateLabelRotation(targetRotation);
        }
      }
    }
  };


  // Clean up boat icon (labels are children, so they're removed with boat)
  const cleanupBoat = () => {
    const boat = boatIcon();
    const sourceId = config.sourceId !== undefined ? config.sourceId : 'default';
    const overlayClass = `boat-overlay-${sourceId}`;
    
    // Remove ALL boat overlays for this source (in case of duplicates)
    const allOverlays = d3.selectAll(`.${overlayClass}`);
    allOverlays.remove();
    
    if (boat) {
      boat.remove();
    }
    
    setBoatIcon(null);
    delete window.mapBoatIcon;
  };
  
  // Clean up duplicate boat overlays for this source (keep only one)
  const cleanupDuplicateBoats = () => {
    const sourceId = config.sourceId !== undefined ? config.sourceId : 'default';
    const overlayClass = `boat-overlay-${sourceId}`;
    const allOverlays = d3.selectAll(`.${overlayClass}`);
    const overlayNodes = allOverlays.nodes();
    
    // If we have more than one overlay, remove all except the first one
    if (overlayNodes.length > 1) {
      // Keep the first overlay, remove the rest
      for (let i = 1; i < overlayNodes.length; i++) {
        d3.select(overlayNodes[i]).remove();
      }
      
      // Update the signal to point to the remaining overlay
      const remainingOverlay = d3.select(overlayNodes[0]);
      const remainingBoat = remainingOverlay.select('.boat-icon');
      if (remainingBoat.node()) {
        setBoatIcon(remainingBoat);
      }
    }
  };

  // Reactive effect to update boat path when class icon changes
  createEffect(() => {
    const icon = selectedClassIcon();
    const boat = boatIcon();
    
    if (!boat) return; // Boat not created yet
    
    debug('[useBoatAnimation] Class icon changed, updating boat path:', { icon, boatExists: !!boat });
    
    const newPath = getBoatPath();
    
    // Update boat paths (main path and shadow) - exclude the halo which is now a circle
    // The boat group contains: boat-paths group (with main path and shadow), and halo circle (class="boat-halo")
    const boatPathsGroup = boat.select(".boat-paths");
    if (!boatPathsGroup.empty()) {
      boatPathsGroup.selectAll('path').attr('d', newPath);
    }
    
    debug('[useBoatAnimation] Updated boat paths:', { 
      pathCount: boatPathsGroup.selectAll('path').size(),
      newPath 
    });
  });

  // When boat is highlighted (hovered when stopped, or selected), double label font size; otherwise default
  createEffect(() => {
    const boat = boatIcon();
    if (!boat) return;
    const emphasize = Boolean(config.isHighlighted?.());
    const sourceNameText = boat.select(".boat-source-name");
    if (!sourceNameText.empty()) {
      sourceNameText.attr("font-size", emphasize ? "22px" : "11px");
    }
  });

  onCleanup(() => {
    cleanupBoat();
  });

  return {
    boatIcon: boatIcon,
    isAnimating: isAnimating,
    isAnimationLocked: isAnimationLocked,
    createBoatIcon,
    updateBoatPosition,
    updateBoatPositionAnimated,
    updateBoatPositionImmediate,
    updateBoatPositionWithTransition,
    animateToClosestPoint,
    animateToSmoothPoint,
    animateToDiscretePointWhenPlaying,
    resetDiscretePlaybackState,
    setBoatVisibility,
    addBoatClickHandler,
    handleMapRotation,
    forceBoatRotationUpdate,
    cleanupBoat,
    cleanupDuplicateBoats,
    calculateBoatSize // Export so BoatLayer can use it for zoom updates
  };
}
