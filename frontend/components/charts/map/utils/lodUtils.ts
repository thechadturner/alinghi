/**
 * Level-of-Detail (LOD) utility functions for map rendering
 * Provides zoom-based sampling and viewport filtering to improve performance
 */

/**
 * Get sampling rate based on zoom level
 * Higher zoom levels = lower sampling rate (more points)
 * Lower zoom levels = higher sampling rate (fewer points)
 * Full resolution (1x) only at zoom >= 16
 */
export function getSampleRate(zoomLevel: number): number {
  if (zoomLevel >= 16) return 1;      // Full resolution
  if (zoomLevel >= 14) return 2;      // Every 2nd point
  if (zoomLevel >= 12) return 4;      // Every 4th point
  if (zoomLevel >= 10) return 8;      // Every 8th point
  if (zoomLevel >= 8) return 16;      // Every 16th point
  if (zoomLevel >= 6) return 32;      // Every 32nd point
  if (zoomLevel >= 4) return 64;      // Every 64th point
  return 128;                          // Every 128th point
}

/**
 * Calculate expanded viewport bounds with 2x buffer
 * This prevents pop-in/pop-out effects at viewport edges
 */
export function getExpandedViewportBounds(map: any) {
  if (!map) return null;
  
  try {
    const bounds = map.getBounds();
    if (!bounds) return null;
    
    const latRange = bounds.getNorth() - bounds.getSouth();
    const lngRange = bounds.getEast() - bounds.getWest();
    
    // 2x buffer = expand by 100% in each direction
    return {
      minLat: bounds.getSouth() - latRange,
      maxLat: bounds.getNorth() + latRange,
      minLng: bounds.getWest() - lngRange,
      maxLng: bounds.getEast() + lngRange
    };
  } catch (e) {
    return null;
  }
}

/**
 * Check if a track point is within viewport bounds
 */
export function isPointInViewport(
  point: any, 
  bounds: any, 
  getLat: (p: any) => number | undefined, 
  getLng: (p: any) => number | undefined
): boolean {
  if (!point || !bounds) return false;
  const lat = getLat(point);
  const lng = getLng(point);
  if (lat === undefined || lng === undefined) return false;
  return lat >= bounds.minLat && lat <= bounds.maxLat &&
         lng >= bounds.minLng && lng <= bounds.maxLng;
}

/**
 * Check if a point contains maneuver data (case-insensitive)
 */
function hasManeuverType(point: any): boolean {
  if (!point) return false;
  // Check for Maneuver_type, maneuver_type, or any variation
  return point.Maneuver_type !== undefined || 
         point.maneuver_type !== undefined ||
         point.ManeuverType !== undefined ||
         point.maneuverType !== undefined;
}

/**
 * Sample a track based on the sample rate
 * Also applies maximum point limit at very low zoom levels
 * ALWAYS includes points with Maneuver_type to preserve important events
 */
export function sampleTrack(track: any[], sampleRate: number, zoomLevel: number): any[] {
  if (!track || track.length === 0) return track;
  if (sampleRate === 1) return track; // No sampling needed
  
  let sampled = [];
  for (let i = 0; i < track.length; i++) {
    // Always include points with maneuver data, regardless of sample rate
    if (i % sampleRate === 0 || hasManeuverType(track[i])) {
      sampled.push(track[i]);
    }
  }
  
  // Always include last point to complete the track
  if (sampled.length === 0 || sampled[sampled.length - 1] !== track[track.length - 1]) {
    sampled.push(track[track.length - 1]);
  }

  // Apply maximum point limit for very low zoom levels
  // Note: Even at very low zoom, we still preserve maneuver points
  let maxPoints = Infinity;
  if (zoomLevel < 8) {
    maxPoints = 100;
  }
  if (zoomLevel < 6) {
    maxPoints = 50;
  }

  if (sampled.length > maxPoints) {
    const reductionFactor = Math.ceil(sampled.length / maxPoints);
    const furtherSampled = [];
    for (let i = 0; i < sampled.length; i++) {
      // Always include points with maneuver data, even when applying max point limit
      if (i % reductionFactor === 0 || hasManeuverType(sampled[i])) {
        furtherSampled.push(sampled[i]);
      }
    }
    // Ensure the last point is always included
    if (furtherSampled.length === 0 || furtherSampled[furtherSampled.length - 1] !== sampled[sampled.length - 1]) {
      furtherSampled.push(sampled[sampled.length - 1]);
    }
    sampled = furtherSampled;
  }
  
  return sampled;
}

/**
 * Determine if a full redraw is needed based on zoom level crossing even boundaries
 * Only redraws when crossing even zoom boundaries (e.g., 9→10, 11→12, 13→14)
 */
export function shouldRedrawForZoom(currentZoom: number, lastRenderZoom: number | null): boolean {
  if (lastRenderZoom === null) return true; // Always redraw on first render
  
  const currentEven = Math.floor(currentZoom / 2) * 2;
  const lastEven = Math.floor(lastRenderZoom / 2) * 2;
  
  return currentEven !== lastEven;
}

/**
 * Count points within viewport bounds
 * Efficiently counts points that fall within the given viewport bounds
 */
export function countPointsInViewport(
  data: any[],
  viewportBounds: any,
  getLat: (p: any) => number | undefined,
  getLng: (p: any) => number | undefined
): number {
  if (!data || !viewportBounds || data.length === 0) return 0;
  
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (isPointInViewport(data[i], viewportBounds, getLat, getLng)) {
      count++;
    }
  }
  
  return count;
}

/**
 * Get sampling rate based on point density in viewport
 * Returns 1 (no sampling) if below threshold, otherwise returns progressive sampling rates
 * Threshold: 5000 points
 * Progressive rates:
 * - 5000-10000 points: 2x sampling
 * - 10000-20000 points: 4x sampling
 * - 20000-40000 points: 8x sampling
 * - 40000-80000 points: 16x sampling
 * - 80000+ points: 32x sampling
 */
export function getDensitySampleRate(pointCount: number, threshold: number = 5000): number {
  if (pointCount < threshold) return 1;      // No sampling needed
  if (pointCount < 10000) return 2;          // Every 2nd point
  if (pointCount < 20000) return 4;          // Every 4th point
  if (pointCount < 40000) return 8;          // Every 8th point
  if (pointCount < 80000) return 16;         // Every 16th point
  return 32;                                  // Every 32nd point
}

/**
 * Get combined sample rate using the maximum of zoom-based and density-based rates
 * This ensures we use the most aggressive sampling when either condition applies
 * 
 * @param zoomLevel - Current map zoom level
 * @param data - Array of data points to count
 * @param viewportBounds - Viewport bounds (from getExpandedViewportBounds)
 * @param getLat - Function to extract latitude from a point
 * @param getLng - Function to extract longitude from a point
 * @param threshold - Point count threshold for density-based sampling (default: 5000)
 * @returns Object with sampleRate, zoomSampleRate, densitySampleRate, and pointCountInViewport
 */
export function getCombinedSampleRate(
  zoomLevel: number,
  data: any[],
  viewportBounds: any,
  getLat: (p: any) => number | undefined,
  getLng: (p: any) => number | undefined,
  threshold: number = 5000
): { sampleRate: number; zoomSampleRate: number; densitySampleRate: number; pointCountInViewport: number } {
  // Get zoom-based sample rate
  const zoomSampleRate = getSampleRate(zoomLevel);
  
  // Get density-based sample rate
  let densitySampleRate = 1;
  let pointCountInViewport = 0;
  
  if (viewportBounds && data && data.length > 0) {
    pointCountInViewport = countPointsInViewport(data, viewportBounds, getLat, getLng);
    densitySampleRate = getDensitySampleRate(pointCountInViewport, threshold);
  }
  
  // Use the maximum (most aggressive) sample rate
  const sampleRate = Math.max(zoomSampleRate, densitySampleRate);
  
  return {
    sampleRate,
    zoomSampleRate,
    densitySampleRate,
    pointCountInViewport
  };
}