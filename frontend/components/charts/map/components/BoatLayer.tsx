// @ts-nocheck
import { createEffect, onMount, onCleanup } from "solid-js";
import { selectedTime, isManualTimeChange, isPlaying, timeWindow, playbackSpeed } from "../../../../store/playbackStore";
import { useBoatAnimation } from "../hooks/useBoatAnimation";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";
import { warn, debug } from "../../../../utils/console";

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

export interface BoatLayerProps {
  sourceId?: number; // Source ID for unique boat overlay identification
  sourceName?: string; // Source name for display
  data: TrackPoint[];
  fullData?: TrackPoint[]; // Full unfiltered data (for speed change positioning)
  map: any;
  mapContainer: HTMLElement;
  samplingFrequency: number;
  onBoatClick?: (point: TrackPoint) => void;
  transitionDuration?: number;
  easing?: any;
  color?: string;
  /** When true and animation stopped, show emphasized label and path highlight */
  isHovered?: boolean;
  /** When true (hovered or selected boat), show emphasized label; persists during animation when selected */
  isHighlighted?: boolean;
  onHover?: () => void;
  onLeave?: () => void;
}

export default function BoatLayer(props: BoatLayerProps) {
  debug('[BoatLayer] Component mounted', {
    hasMap: !!props.map,
    hasMapContainer: !!props.mapContainer,
    dataLength: props.data?.length || 0,
    sourceId: props.sourceId,
    sourceName: props.sourceName
  });
  
  // Get dynamic channel names from store
  const { latName, lngName, hdgName } = defaultChannelsStore;
  
  // Helper function to get Lat/Lng values with case-insensitive fallback
  const getLat = (d: any): number | undefined => {
    if (!d) return undefined;
    const latField = latName();
    const val = d[latField];
    if (val === undefined || val === null) return undefined;
    const numVal = Number(val);
    return isNaN(numVal) ? undefined : numVal;
  };
  
  const getLng = (d: any): number | undefined => {
    if (!d) return undefined;
    const lngField = lngName();
    const val = d[lngField];
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
  
  const { 
    boatIcon,
    createBoatIcon, 
    updateBoatPosition, 
    animateToClosestPoint,
    animateToSmoothPoint,
    animateToDiscretePointWhenPlaying,
    resetDiscretePlaybackState,
    updateBoatPositionImmediate,
    setBoatVisibility,
    addBoatClickHandler,
    handleMapRotation,
    forceBoatRotationUpdate,
    cleanupBoat,
    cleanupDuplicateBoats,
    calculateBoatSize
  } = useBoatAnimation({
    sourceId: props.sourceId,
    sourceName: props.sourceName,
    samplingFrequency: props.samplingFrequency,
    transitionDuration: props.transitionDuration,
    easing: props.easing,
    sourceColor: props.color,
    isHovered: () => props.isHovered ?? false,
    isHighlighted: () => props.isHighlighted ?? false,
    onHover: props.onHover,
    onLeave: props.onLeave
  });

  // Track the last processed time to prevent duplicate animations
  let lastProcessedTime = null;
  // Track the last playback speed to detect speed changes
  let lastPlaybackSpeed = playbackSpeed();
  // Track the last playing state to detect play/pause changes
  let lastPlayingState = isPlaying();

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


  // Track if boat icon has been created to prevent multiple creations
  let boatIconCreated = false;
  
  // Effect to create boat icon when map is ready (only once per component instance)
  createEffect(() => {
    // Only create boat icon if it doesn't exist yet
    if (props.map && props.mapContainer && !boatIconCreated) {
      const existingBoat = boatIcon();
      if (existingBoat) {
        // Boat already exists, just mark as created
        boatIconCreated = true;
        return;
      }
      
      boatIconCreated = true; // Mark as created before async call to prevent duplicates
      createBoatIcon(props.mapContainer, props.map).then((boat) => {
        setBoatVisibility(true);
        
        if (props.onBoatClick) {
          const getCurrentPoint = () => {
            const currentTime = selectedTime();
            const data = (props.fullData && props.fullData.length > 0) ? props.fullData : props.data;
            if (!currentTime || !data || data.length === 0) return null;
            const point = data.reduce((prev, curr) =>
              Math.abs(getTimestamp(curr).getTime() - currentTime.getTime()) <
              Math.abs(getTimestamp(prev).getTime() - currentTime.getTime()) ? curr : prev
            );
            return { ...point, source_id: props.sourceId } as TrackPoint;
          };
          addBoatClickHandler(props.onBoatClick, getCurrentPoint);
        }
        
        // Immediately position boat at correct location when icon is created
        const currentTime = selectedTime();
        if (currentTime && props.data && props.data.length > 0) {
          // Use fullData if available (unfiltered), otherwise use filtered data
          const searchData = (props.fullData && props.fullData.length > 0) ? props.fullData : props.data;
          
          if (searchData && searchData.length > 0) {
            // Find closest point to current time
            const targetPoint = searchData.reduce((prev, curr) =>
              Math.abs(getTimestamp(curr).getTime() - currentTime.getTime()) < 
              Math.abs(getTimestamp(prev).getTime() - currentTime.getTime()) ? curr : prev
            );
            
            if (targetPoint) {
              // Immediately position boat without transition on initial creation
              updateBoatPositionImmediate(targetPoint, props.map, false);
              lastProcessedTime = currentTime;
            }
          }
        }
      }).catch((error) => {
        // If creation fails, reset flag so it can be retried
        warn('[BoatLayer] Failed to create boat icon:', error);
        boatIconCreated = false;
      });
    }
  });

  // Effect to immediately position boat when playback state changes (play/pause) or speed changes
  createEffect(() => {
    const currentSpeed = playbackSpeed();
    const isCurrentlyPlaying = isPlaying();
    const currentTime = selectedTime();
    
    // If playback state changed (started or stopped), immediately position boat
    const playbackStateChanged = isCurrentlyPlaying !== lastPlayingState;
    const speedChanged = currentSpeed !== lastPlaybackSpeed;
    
    // Check if boat icon exists before attempting to position
    const boat = boatIcon();
    if (!boat) {
      // Update tracked state even if boat isn't ready yet
      if (playbackStateChanged) {
        lastPlayingState = isCurrentlyPlaying;
      }
      if (speedChanged) {
        lastPlaybackSpeed = currentSpeed;
      }
      return; // Boat icon not ready yet, skip positioning
    }
    
    if ((playbackStateChanged || (speedChanged && isCurrentlyPlaying)) && props.map && currentTime) {
      // Use fullData if available (unfiltered), otherwise use filtered data
      const searchData = (props.fullData && props.fullData.length > 0) ? props.fullData : props.data;
      
      if (searchData && searchData.length > 0) {
        // Find closest point to current time
        const targetPoint = searchData.reduce((prev, curr) =>
          Math.abs(getTimestamp(curr).getTime() - currentTime.getTime()) < 
          Math.abs(getTimestamp(prev).getTime() - currentTime.getTime()) ? curr : prev
        );
        
        if (targetPoint) {
          // Immediately position boat without transition when playback state or speed changes
          updateBoatPositionImmediate(targetPoint, props.map, false);
          lastProcessedTime = currentTime; // Update last processed time to prevent duplicate animation
        }
      }
    }
    
    // Update tracked state
    if (playbackStateChanged) {
      lastPlayingState = isCurrentlyPlaying;
    }
    if (speedChanged) {
      lastPlaybackSpeed = currentSpeed;
    }
  });

  // Effect to animate boat when selectedTime changes
  createEffect(() => {
    const currentTime = selectedTime();
    const isManual = isManualTimeChange();
    const isCurrentlyPlaying = isPlaying();
    const currentTimeWindow = timeWindow();
    const currentSpeed = playbackSpeed();
    
    // Clean up any duplicate boat overlays before positioning
    // This ensures we only have one boat per source when selectedTime changes
    cleanupDuplicateBoats();
    
    // Skip if playback state or speed just changed (handled by state change effect above)
    const playbackStateChanged = isCurrentlyPlaying !== lastPlayingState;
    const speedChanged = currentSpeed !== lastPlaybackSpeed;
    
    if ((playbackStateChanged || (speedChanged && isCurrentlyPlaying)) && props.map) {
      // Update tracked state
      if (playbackStateChanged) {
        lastPlayingState = isCurrentlyPlaying;
      }
      if (speedChanged) {
        lastPlaybackSpeed = currentSpeed;
      }
      return; // Let the state change effect handle positioning
    }
    
    // Debug logging to track manual vs automatic changes
    if (currentTime && props.map && props.data && props.data.length > 0) {
      // Determine if there is valid data near the selected time; otherwise hide the boat
      const closest = (Array.isArray(props.data) && props.data.length > 0)
        ? props.data.reduce((prev, curr) =>
            Math.abs(getTimestamp(curr).getTime() - currentTime.getTime()) < 
            Math.abs(getTimestamp(prev).getTime() - currentTime.getTime()) ? curr : prev
          )
        : null;
      const closestDelta = closest ? Math.abs(getTimestamp(closest).getTime() - currentTime.getTime()) : Number.POSITIVE_INFINITY;
      // Tolerance based on samplingFrequency (default to 1s if missing); allow a small multiple when playing
      const samplesPerSecond = props.samplingFrequency && Number.isFinite(props.samplingFrequency) ? props.samplingFrequency : 1;
      const baseToleranceMs = Math.max(500, Math.round(1000 / Math.max(0.001, samplesPerSecond)) * 3);
      const toleranceMs = isCurrentlyPlaying ? baseToleranceMs * 2 : baseToleranceMs;
      if (!closest || closestDelta > toleranceMs) {
        setBoatVisibility(false);
        return;
      }
      setBoatVisibility(true);
      
      // When playing, boat is driven by smoothPlaybackTime in the dedicated effect below
      if (isCurrentlyPlaying) {
        return;
      }

      // When user is dragging/clicking timeline: update boat immediately so it stays in sync with track (no delay).
      // When change is programmatic: keep 50ms delay to avoid race conditions.
      const applyPosition = (targetPoint: TrackPoint | null) => {
        if (!targetPoint) return;
        lastProcessedTime = currentTime;
        const skipHaloFlag = typeof window !== 'undefined' && (window as any).skipBoatHaloOnce;
        const shouldShowHalo = isManual && !isCurrentlyPlaying && !skipHaloFlag;
        updateBoatPositionImmediate(targetPoint, props.map, shouldShowHalo);
        if (skipHaloFlag) {
          try { delete (window as any).skipBoatHaloOnce; } catch {}
        }
      };

      if (isManual) {
        // Manual time change (drag/click): run inline so boat updates in same tick as track
        const targetPoint = (Array.isArray(props.data) && props.data.length > 0)
          ? props.data.reduce((prev, curr) =>
              Math.abs(getTimestamp(curr).getTime() - currentTime.getTime()) <
              Math.abs(getTimestamp(prev).getTime() - currentTime.getTime()) ? curr : prev
            )
          : null;
        applyPosition(targetPoint);
      } else {
        setTimeout(() => {
          const latestTime = selectedTime();
          if (latestTime && latestTime.getTime() === currentTime.getTime()) {
            if (lastProcessedTime && lastProcessedTime.getTime() === currentTime.getTime()) return;
            const targetPoint = (Array.isArray(props.data) && props.data.length > 0)
              ? props.data.reduce((prev, curr) =>
                  Math.abs(getTimestamp(curr).getTime() - currentTime.getTime()) <
                  Math.abs(getTimestamp(prev).getTime() - currentTime.getTime()) ? curr : prev
                )
              : null;
            applyPosition(targetPoint);
          }
        }, 50); // Delay for programmatic updates to avoid race conditions
      }
    }
  });

  // Effect: when playing, drive boat with discrete 1Hz points only (no interpolation); transition only when index changes, duration = 1000/speed ms
  createEffect(() => {
    if (!isPlaying()) {
      resetDiscretePlaybackState();
      return;
    }
    const boat = boatIcon();
    if (!boat || !props.map) return;
    const searchData = (props.fullData && props.fullData.length > 0) ? props.fullData : props.data;
    if (!searchData || searchData.length === 0) return;
    animateToDiscretePointWhenPlaying(searchData, props.map);
  });

  // Effect to show/hide boat based on data availability and initialize position
  createEffect(() => {
    if (props.data && props.data.length > 0) {
      setBoatVisibility(true);
      
      // If boat icon exists but hasn't been positioned yet, position it immediately
      const boat = boatIcon();
      if (boat && props.map) {
        const currentTime = selectedTime();
        if (currentTime) {
          // Use fullData if available (unfiltered), otherwise use filtered data
          const searchData = (props.fullData && props.fullData.length > 0) ? props.fullData : props.data;
          
          if (searchData && searchData.length > 0) {
            // Find closest point to current time
            const targetPoint = searchData.reduce((prev, curr) =>
              Math.abs(getTimestamp(curr).getTime() - currentTime.getTime()) < 
              Math.abs(getTimestamp(prev).getTime() - currentTime.getTime()) ? curr : prev
            );
            
            if (targetPoint) {
              // Check if boat is already positioned (has a transform attribute)
              const currentTransform = boat.attr("transform");
              if (!currentTransform || currentTransform === "translate(0,0) scale(1) rotate(180)") {
                // Boat not positioned yet, position it immediately without transition
                updateBoatPositionImmediate(targetPoint, props.map, false);
                lastProcessedTime = currentTime;
              }
            }
          }
        }
      }
    } else {
      setBoatVisibility(false);
    }
  });

  // No need to monitor playing state - user always controls map

  // Effect to handle map movement and rotation changes
  createEffect(() => {
    if (props.map && props.data && props.data.length > 0) {
      // Update boat position when map moves (like track does)
      // Skip immediate updates when playing to avoid flashing - let transitions handle it
      const updateBoatPosition = () => {
        // When playing, don't immediately position boat on map render events
        // This prevents flashing - the transition animation will handle positioning
        const isCurrentlyPlaying = isPlaying();
        if (isCurrentlyPlaying) {
          return;
        }
        
        const currentTime = selectedTime();
        if (currentTime) {
          // Find the closest point to current time
          const targetPoint = (Array.isArray(props.data) && props.data.length > 0)
            ? props.data.reduce((prev, curr) =>
                Math.abs(getTimestamp(curr).getTime() - currentTime.getTime()) < 
                Math.abs(getTimestamp(prev).getTime() - currentTime.getTime()) ? curr : prev
              )
            : null;
          
          if (targetPoint) {
            // Update boat position immediately without transition
            const boat = boatIcon();
            if (boat && props.map) {
              const lng = getLng(targetPoint);
              const lat = getLat(targetPoint);
              if (lng === undefined || lat === undefined || !Number.isFinite(lng) || !Number.isFinite(lat)) {
                return; // Skip if coordinates are invalid
              }
              const mapPoint = props.map.project([lng, lat]);
              if (mapPoint && !isNaN(mapPoint.x) && !isNaN(mapPoint.y)) {
                const mapBearing = props.map.getBearing ? props.map.getBearing() : 0;
                // Get Hdg using dynamic channel name
                const hdg = getHdg(targetPoint);
                if (hdg === undefined || hdg === null || isNaN(hdg) || !Number.isFinite(hdg)) {
                  // Skip rotation update if heading is invalid, but still update position
                  const boatScale = calculateBoatSize(props.map);
                  boat.attr("transform", `translate(${mapPoint.x}, ${mapPoint.y}) scale(${boatScale}) rotate(0)`);
                  return;
                }
                const targetRotation = hdg + 180 - mapBearing;
                const boatScale = calculateBoatSize(props.map);
                
                // Update position immediately
                boat.attr("transform", `translate(${mapPoint.x}, ${mapPoint.y}) scale(${boatScale}) rotate(${targetRotation})`);
                
                // Labels rotate with boat automatically (they're children of boat group)
              }
            }
          }
        }
      };

      // Set up event listeners for map changes - use Mapbox GL JS events
      // Use 'render' event for smooth, frame-synced updates during map movements (like TrackLayer)
      props.map.on('render', updateBoatPosition);
      
      // Also listen to end events for final positioning
      props.map.on('moveend', updateBoatPosition);
      props.map.on('zoomend', updateBoatPosition);
      props.map.on('rotateend', updateBoatPosition);
      props.map.on('pitchend', updateBoatPosition);
      props.map.on('viewreset', updateBoatPosition);
      
      // Cleanup listeners
      return () => {
        props.map.off('render', updateBoatPosition);
        props.map.off('moveend', updateBoatPosition);
        props.map.off('zoomend', updateBoatPosition);
        props.map.off('rotateend', updateBoatPosition);
        props.map.off('pitchend', updateBoatPosition);
        props.map.off('viewreset', updateBoatPosition);
      };
    }
  });

  onCleanup(() => {
    // Only cleanup if this component is actually unmounting (not just updating)
    // The boat icon should persist across selectedTime changes
    // Only remove it when the component is truly being destroyed
    if (boatIconCreated) {
      cleanupBoat();
      boatIconCreated = false;
    }
  });

  return null; // This component doesn't render JSX, it manages D3 overlays
}
