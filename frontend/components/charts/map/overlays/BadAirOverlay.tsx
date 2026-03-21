/**
 * Bad Air Overlay
 * 
 * Visualizes "bad air" zones - areas where wind from other boats may affect performance.
 * Based on track data, calculates wind propagation zones at various speeds and renders
 * them as density contours.
 */

import { createEffect, onCleanup } from "solid-js";
import * as d3 from "d3";
import { BaseOverlayProps } from "./types";
import { debug, warn as logWarn, error as logError } from "../../../../utils/console";
import { selectedTime, timeWindow } from "../../../../store/playbackStore";
import { defaultChannelsStore } from "../../../../store/defaultChannelsStore";

interface BadAirPoint {
  LngLat: { lng: number; lat: number };
}

/**
 * Bad Air Overlay Component
 * 
 * Computes and renders bad air density visualization based on:
 * - Track history with time-based wind propagation
 * - Wind direction (TWD) at each point
 * - Wind speed (TWS) at each point
 * - Time-based decay zones
 */
export default function BadAirOverlay(props: BaseOverlayProps) {
  let badAirGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any> | null = null;
  let badAirData: BadAirPoint[] = [];
  let updateTimeout: ReturnType<typeof setTimeout> | null = null;

  // Get dynamic channel names from store
  const { twdName, twsName, latName, lngName } = defaultChannelsStore;

  // Helper functions to get channel values with case-insensitive fallback
  const getTwd = (d: any): number | undefined => {
    if (!d) return undefined;
    const twdField = twdName();
    const val = d[twdField] ?? d[twdField.toLowerCase()] ?? d[twdField.toUpperCase()] ?? d.TWD ?? d.Twd ?? d.twd;
    if (val === undefined || val === null) return undefined;
    const numVal = Number(val);
    return isNaN(numVal) ? undefined : numVal;
  };

  const getTws = (d: any): number | undefined => {
    if (!d) return undefined;
    const twsField = twsName();
    const val = d[twsField] ?? d[twsField.toLowerCase()] ?? d[twsField.toUpperCase()] ?? d.TWS ?? d.Tws ?? d.tws;
    if (val === undefined || val === null) return undefined;
    const numVal = Number(val);
    return isNaN(numVal) ? undefined : numVal;
  };

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

  /** Time to request bad air for: 1 timestamp behind selected/effective time (e.g. 1s at 1Hz). */
  const getBadAirTime = (): Date | null => {
    const raw = props.effectivePlaybackTime ?? selectedTime();
    if (!raw) return null;
    const stepMs = 1000 / Math.max(0.1, props.samplingFrequency ?? 1);
    return new Date(raw.getTime() - stepMs);
  };

  /**
   * Origin time for bad air = timestamp of the **previous** path point (the point the boat is
   * transitioning *from*). So bad air is drawn behind the boat, not ahead of it.
   * Falls back to getBadAirTime() if there is no previous point in the data.
   */
  const getBadAirOriginFromPreviousPathPoint = (data: BaseOverlayProps['data']): Date | null => {
    const currentTime = props.effectivePlaybackTime ?? selectedTime();
    if (!currentTime || !data || data.length === 0) return getBadAirTime();
    const currentMs = currentTime.getTime();
    const sorted = [...data].sort((a, b) => {
      const aDt = a.Datetime ?? a.datetime;
      const bDt = b.Datetime ?? b.datetime;
      return new Date(aDt).getTime() - new Date(bDt).getTime();
    });
    // Find the latest point with timestamp strictly less than current time = point we're leaving
    let prevPoint: { Datetime?: unknown; datetime?: unknown } | null = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const t = new Date((sorted[i] as any).Datetime ?? (sorted[i] as any).datetime).getTime();
      if (t < currentMs) {
        prevPoint = sorted[i] as { Datetime?: unknown; datetime?: unknown };
        break;
      }
    }
    if (!prevPoint) return getBadAirTime();
    const dt = (prevPoint as any).Datetime ?? (prevPoint as any).datetime;
    return dt ? new Date(dt) : getBadAirTime();
  };

  /**
   * Compute bad air points from track data
   * Based on race.js computeBadAir function
   */
  const computeBadAir = (data: BaseOverlayProps['data'], originTime?: Date | null, isLiveMode?: boolean): BadAirPoint[] => {
    if (!data || data.length === 0) {
      return [];
    }

    badAirData = [];
    
    // Sort data by time (newest first)
    // Handle both uppercase and lowercase field names per repo rules
    const sortedData = [...data].sort((a, b) => {
      const aDt = a.Datetime ?? a.datetime;
      const bDt = b.Datetime ?? b.datetime;
      return new Date(bDt).getTime() - new Date(aDt).getTime();
    });

    // Determine origin time for time-based calculations
    let firstTime: Date | undefined = originTime ? new Date(originTime) : undefined;
    
    // In live mode only: selectedTime might lag behind the newest data point
    // Use the newest data point's timestamp if it's newer than originTime
    // In non-live mode, always use originTime (selectedTime) as-is
    if (isLiveMode) {
      // Get the newest data point's timestamp
      if (sortedData.length > 0) {
        const newestPoint = sortedData[0];
        const newestDatetime = newestPoint.Datetime ?? newestPoint.datetime;
        if (newestDatetime) {
          const newestTime = new Date(newestDatetime);
          // If newest data point is newer than originTime, use it instead
          // This ensures correct time separation in live mode where selectedTime might lag
          if (!firstTime || newestTime.getTime() > firstTime.getTime()) {
            firstTime = newestTime;
          }
        }
      }
    }
    // In non-live mode, firstTime is already set to originTime above (or undefined if not provided)

    let pointsWithRequiredFields = 0;
    let pointsWithTimeSeparation = 0;

    sortedData.forEach((d, index) => {
      // Use dynamic channel names from store with case-insensitive fallback
      const twd = getTwd(d);
      const tws = getTws(d);
      const lng = getLng(d);
      const lat = getLat(d);
      const datetime = d.Datetime ?? d.datetime;

      // Skip if missing required fields
      if (twd === undefined || tws === undefined || lng === undefined || lat === undefined) {
        return;
      }

      pointsWithRequiredFields++;

      // Calculate time separation from origin time
      // firstTime should always be set before loop, but keep safety check
      if (!firstTime) {
        firstTime = new Date(datetime);
      }
      const seconds = (firstTime.getTime() - new Date(datetime).getTime()) / 1000;

      // Only compute bad air for points that have time separation
      // Filter out points more than 180 seconds (3 minutes) in the past
      if (seconds > 0 && seconds <= 180) {
        pointsWithTimeSeparation++;
        // Wind speed ratios to simulate different wind strengths in wake
        const ratios = [1.1, 1.05, 1.0, 0.95, 0.9, 0.85, 0.8, 0.75];

        // Calculate wind direction opposite to boat (wind comes from behind)
        // TWD is true wind direction, so bad air propagates opposite
        const windDirection = normalizeAngle(twd - 180);

        ratios.forEach((ratio) => {
          // Convert TWS from knots to m/s
          const tws_mps = tws * ratio * 0.5144444;
          
          // Calculate distance wind travels in the elapsed time
          const meters = tws_mps * seconds;
          
          // Calculate new position based on distance and bearing
          const newPosition = calculateDestination(
            lat,
            lng,
            meters,
            windDirection
          );

          if (newPosition && !isNaN(newPosition.lat) && !isNaN(newPosition.lng)) {
            badAirData.push({
              LngLat: { lng: newPosition.lng, lat: newPosition.lat }
            });
          }
        });
      }
    });

    // Count points by source to verify all sources are processed
    const pointsBySource = new Map();
    const pointsWithFieldsBySource = new Map();
    
    sortedData.forEach(d => {
      const sourceId = d.source_id || d.source_name || 'unknown';
      pointsBySource.set(sourceId, (pointsBySource.get(sourceId) || 0) + 1);
      
      const twd = getTwd(d);
      const tws = getTws(d);
      const lng = getLng(d);
      const lat = getLat(d);
      
      if (twd !== undefined && tws !== undefined && lng !== undefined && lat !== undefined) {
        pointsWithFieldsBySource.set(sourceId, (pointsWithFieldsBySource.get(sourceId) || 0) + 1);
      }
    });
    
    // Count bad air points by source (approximate - we don't track source in badAirData)
    // But we can count how many points from each source contributed

    
    // Debug logging only when no bad air points are computed despite having data
    if (badAirData.length === 0 && sortedData.length > 0) {
      debug("BadAirOverlay: No bad air points computed", {
        totalPoints: sortedData.length,
        sourcesCount: pointsBySource.size,
        pointsBySource: Object.fromEntries(pointsBySource),
        pointsWithFieldsBySource: Object.fromEntries(pointsWithFieldsBySource),
        pointsWithRequiredFields,
        pointsWithTimeSeparation,
        hasOriginTime: !!firstTime,
        samplePoint: sortedData[0] ? {
          source_id: sortedData[0].source_id,
          source_name: sortedData[0].source_name,
          hasTwd: getTwd(sortedData[0]) !== undefined,
          hasTws: getTws(sortedData[0]) !== undefined,
          hasLat: getLat(sortedData[0]) !== undefined,
          hasLng: getLng(sortedData[0]) !== undefined,
          hasDatetime: !!(sortedData[0].Datetime ?? sortedData[0].datetime),
          twd: getTwd(sortedData[0]),
          tws: getTws(sortedData[0]),
          lat: getLat(sortedData[0]),
          lng: getLng(sortedData[0]),
          datetime: sortedData[0].Datetime ?? sortedData[0].datetime,
          twdField: twdName(),
          twsField: twsName(),
          latField: latName(),
          lngField: lngName()
        } : null
      });
    }

    return badAirData;
  };

  /**
   * Normalize angle to 0-360 range
   */
  const normalizeAngle = (angle: number): number => {
    while (angle < 0) angle += 360;
    while (angle >= 360) angle -= 360;
    return angle;
  };

  /**
   * Calculate destination point from origin, distance, and bearing
   * Uses Haversine formula for great circle navigation
   */
  const calculateDestination = (
    lat: number,
    lng: number,
    distanceMeters: number,
    bearingDegrees: number
  ): { lat: number; lng: number } | null => {
    if (isNaN(lat) || isNaN(lng) || isNaN(distanceMeters) || isNaN(bearingDegrees)) {
      return null;
    }

    const R = 6371000; // Earth radius in meters
    const bearing = (bearingDegrees * Math.PI) / 180;
    const latRad = (lat * Math.PI) / 180;
    const lngRad = (lng * Math.PI) / 180;
    const d = distanceMeters / R; // Angular distance

    const newLat = Math.asin(
      Math.sin(latRad) * Math.cos(d) +
        Math.cos(latRad) * Math.sin(d) * Math.cos(bearing)
    );

    const newLng =
      lngRad +
      Math.atan2(
        Math.sin(bearing) * Math.sin(d) * Math.cos(latRad),
        Math.cos(d) - Math.sin(latRad) * Math.sin(newLat)
      );

    return {
      lat: (newLat * 180) / Math.PI,
      lng: (newLng * 180) / Math.PI
    };
  };

  /**
   * Render bad air density visualization
   */
  const renderBadAir = () => {
    if (!props.enabled || !props.svg || !props.map) {
      // Clear existing visualization
      if (badAirGroup) {
        badAirGroup.remove();
        badAirGroup = null;
      }
      return;
    }

    // Ensure SVG is actually in the DOM
    const svgNode = props.svg.node();
    if (!svgNode || !svgNode.parentNode) {
      debug("BadAirOverlay: SVG not attached to DOM yet");
      return;
    }

    if (badAirData.length === 0) {
      if (badAirGroup) {
        badAirGroup.selectAll("path").remove();
      }
      return;
    }

    // Create or get bad air group
    if (!badAirGroup) {
      // Find or create overlay group in SVG
      const existingGroup = props.svg.select<SVGGElement>("g.badair-overlay");
      if (!existingGroup.empty()) {
        badAirGroup = existingGroup;
      } else {
        badAirGroup = props.svg
          .append<SVGGElement>("g")
          .attr("class", "badair-overlay")
          .style("pointer-events", "none");
      }
    }

    // Clear existing paths
    badAirGroup.selectAll("path").remove();

    // If no data, don't render
    if (badAirData.length === 0) return;

    try {
      // Project bad air points to screen coordinates
      const projectedPoints = badAirData
        .map((d) => {
          try {
            const projected = props.map.project([d.LngLat.lng, d.LngLat.lat]);
            if (projected && !isNaN(projected.x) && !isNaN(projected.y)) {
              return { x: projected.x, y: projected.y };
            }
          } catch (e) {
            // Skip invalid projections
          }
          return null;
        })
        .filter(p => p !== null) as { x: number; y: number }[];

      if (projectedPoints.length === 0) {
        logWarn("BadAirOverlay: No valid projected points");
        return;
      }

      // ——— Contour settings (tweak for look) ———
      // bandwidth: kernel radius in px; higher = smoother, more blended contours (default d3 ~20; was 3 = dotty).
      const CONTOUR_BANDWIDTH = 10;
      // cellSize: grid cell size in px; higher = coarser/smoother contours (d3 default 4).
      const CONTOUR_CELL_SIZE = 4;
      // thresholds: number of contour levels; fewer = broader bands.
      const CONTOUR_THRESHOLDS = 5;

      const densityData = d3
        .contourDensity<{ x: number; y: number }>()
        .x(d => d.x)
        .y(d => d.y)
        .size([props.width, props.height])
        .cellSize(CONTOUR_CELL_SIZE)
        .bandwidth(CONTOUR_BANDWIDTH)
        .thresholds(CONTOUR_THRESHOLDS)(projectedPoints);

      // Calculate color scale based on density
      const dExtent = d3.extent(densityData, d => d.value);
      
      if (!dExtent[0] || !dExtent[1]) {
        logWarn("BadAirOverlay: Invalid density extent");
        return;
      }

      const colorScale = d3
        .scaleLinear<string>()
        .domain([0, dExtent[1] * 0.5])
        .range(["transparent", "rgba(255, 255, 255, 0.8)"]);

      // Render density contours
      const geoPath = d3.geoPath();
      
      badAirGroup
        .selectAll<SVGPathElement, any>("path.badair-contour")
        .data(densityData)
        .enter()
        .append("path")
        .attr("class", "badair-contour")
        .attr("d", geoPath)
        .attr("fill", d => colorScale(d.value))
        .attr("fill-opacity", 0.15)
        .attr("stroke", "none")
        .attr("stroke-width", 0);

    } catch (error) {
      logError("BadAirOverlay: Error rendering bad air:", error);
    }
  };

  /**
   * Update bad air visualization
   */
  const update = () => {
    if (updateTimeout) {
      clearTimeout(updateTimeout);
    }

    // Throttle updates
    updateTimeout = setTimeout(() => {
      if (!props.enabled) {
        if (badAirGroup) {
          badAirGroup.remove();
          badAirGroup = null;
        }
        return;
      }

      const originTime = getBadAirOriginFromPreviousPathPoint(props.data);
      computeBadAir(props.data, originTime, props.liveMode || false);
      
      // Render visualization
      renderBadAir();
    }, 100);
  };

  // Effect: Initialize overlay when enabled - watch for SVG becoming available
  createEffect(() => {
    // Track enabled, svg, map, and data to react to all changes
    // Access the data array itself (not just length) to ensure reactivity
    const enabled = props.enabled;
    const svg = props.svg;
    const map = props.map;
    const data = props.data || [];
    const dataLength = data.length;
    
    if (enabled && svg && map && dataLength > 0) {
      // Ensure SVG node is actually attached to DOM
      const svgNode = svg.node();
      if (!svgNode || !svgNode.parentNode) {
        debug("BadAirOverlay: SVG node not ready, will retry");
        // Retry after a short delay
        setTimeout(() => {
          if (props.enabled && props.svg?.node()?.parentNode) {
            computeBadAir(props.data, getBadAirOriginFromPreviousPathPoint(props.data), props.liveMode || false);
            update();
          }
        }, 100);
        return;
      }

      computeBadAir(props.data, getBadAirOriginFromPreviousPathPoint(props.data), props.liveMode || false);
      
      // Only warn if we have data but no bad air points computed
      if (props.data.length > 0 && badAirData.length === 0) {
        const samplePoint = props.data[0];
        logWarn("BadAirOverlay: No bad air points computed despite having data", {
          dataLength: props.data.length,
          samplePoint: {
            hasTwd: getTwd(samplePoint) !== undefined,
            hasTws: getTws(samplePoint) !== undefined,
            hasLat: getLat(samplePoint) !== undefined,
            hasLng: getLng(samplePoint) !== undefined,
            hasDatetime: !!(samplePoint?.Datetime ?? samplePoint?.datetime),
            twd: getTwd(samplePoint),
            tws: getTws(samplePoint),
            lat: getLat(samplePoint),
            lng: getLng(samplePoint),
            twdField: twdName(),
            twsField: twsName(),
            latField: latName(),
            lngField: lngName(),
            allFields: Object.keys(samplePoint || {}).filter(k => !['timestamp', 'Datetime', 'datetime', 'source_name', 'source_id'].includes(k))
          }
        });
      }
      
      update();
    } else {
      // Clean up when disabled or missing prerequisites
      if (badAirGroup) {
        badAirGroup.remove();
        badAirGroup = null;
      }
    }
  });

  // Effect: Update when data changes
  createEffect(() => {
    if (props.enabled && props.data.length > 0) {
      update();
    }
  });

  // Effect: Watch for SVG to become available and trigger update
  createEffect(() => {
    if (props.enabled && props.svg && props.map && props.data.length > 0) {
      const svgNode = props.svg.node();
      if (svgNode && svgNode.parentNode) {
        // SVG is now ready - compute and render if we haven't already
        if (badAirData.length === 0) {
          computeBadAir(props.data, getBadAirOriginFromPreviousPathPoint(props.data), props.liveMode || false);
          update();
        } else {
          // Just re-render with existing data
          renderBadAir();
        }
      }
    }
  });

  // Effect: Update when selected time or effective time changes (bad air at previous path point)
  createEffect(() => {
    if (props.enabled && props.svg && props.map && props.data.length > 0) {
      const originTime = getBadAirOriginFromPreviousPathPoint(props.data);
      const svgNode = props.svg?.node();

      if (originTime && svgNode && svgNode.parentNode) {
        if (updateTimeout) {
          clearTimeout(updateTimeout);
        }
        computeBadAir(props.data, originTime, props.liveMode || false);
        renderBadAir();
      }
    }
  });

  // Effect: Update when map moves/zooms (reproject only)
  createEffect(() => {
    if (props.enabled && props.map) {
      const handleMapMove = () => {
        if (badAirGroup && badAirData.length > 0) {
          // Re-render with new projections
          renderBadAir();
        }
      };

      props.map.on("move", handleMapMove);
      props.map.on("zoom", handleMapMove);
      props.map.on("rotate", handleMapMove);

      return () => {
        props.map.off("move", handleMapMove);
        props.map.off("zoom", handleMapMove);
        props.map.off("rotate", handleMapMove);
      };
    }
  });

  // Cleanup
  onCleanup(() => {
    if (updateTimeout) {
      clearTimeout(updateTimeout);
    }
    if (badAirGroup) {
      badAirGroup.remove();
      badAirGroup = null;
    }
  });

  // This component manages SVG rendering via effects
  // Return empty fragment since rendering is handled via D3/SVG
  return <></>;
}

