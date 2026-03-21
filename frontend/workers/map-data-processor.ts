/**
 * Map Data Processor Worker
 * 
 * Handles 2Hz map data processing including:
 * - JSON data parsing and validation
 * - Geographic data processing
 * - Map-specific data transformations
 * - Performance optimization for 2Hz updates
 */

import { warn } from '../utils/console';

import type { 
  WorkerMessage, 
  WorkerResponse, 
  MapDataItem, 
  MapProcessingResult,
  MapMetadata,
  MapBounds,
  MapStatistics
} from './types';

interface MapProcessingConfig {
  validate?: boolean;
  transform?: boolean;
  optimize?: boolean;
  maxPoints?: number;
  timeWindow?: number;
  addBearing?: boolean;
  addSpeed?: boolean;
  addDistance?: boolean;
  addElevation?: boolean;
  smoothPath?: boolean;
}

// Worker message handler
self.onmessage = function(e: MessageEvent<WorkerMessage<MapDataItem[], MapProcessingConfig>>) {
  const { id, type, data, config } = e.data;
  
  try {
    let result: MapProcessingResult;
    
    switch (type) {
      case 'map-data-processor':
        result = processMapData(data, config);
        break;
      default:
        throw new Error(`Unknown task type: ${type}`);
    }
    
    // Send result back to main thread
    const response: WorkerResponse<MapProcessingResult> = {
      id,
      type: 'success',
      result,
      duration: Date.now() - e.data.timestamp
    };
    self.postMessage(response);
    
  } catch (error) {
    // Send error back to main thread
    const response: WorkerResponse = {
      id,
      type: 'error',
      error: (error as Error).message,
      duration: Date.now() - e.data.timestamp
    };
    self.postMessage(response);
  }
};

/**
 * Process 2Hz map data
 */
function processMapData(data: MapDataItem[], config: MapProcessingConfig = {}): MapProcessingResult {
  const {
    validate = true,
    transform = true,
    optimize = true,
    maxPoints = 2000,
    timeWindow = 300000 // 5 minutes in milliseconds
  } = config;

  if (!Array.isArray(data)) {
    throw new Error('Map data must be an array');
  }

  let processedData = [...data];

  // Validate data structure
  if (validate) {
    processedData = validateMapData(processedData);
  }

  // Transform data for map visualization
  if (transform) {
    processedData = transformMapData(processedData, config);
  }

  // Optimize for 2Hz updates
  if (optimize) {
    processedData = optimizeMapData(processedData, maxPoints, timeWindow);
  }

  return {
    data: processedData,
    metadata: {
      originalSize: data.length,
      processedSize: processedData.length,
      frequency: '1Hz', // Fixed 1Hz for map data
      lastUpdate: Date.now(),
      bounds: calculateBounds(processedData),
      statistics: calculateMapStatistics(processedData)
    }
  };
}

/**
 * Validate map data structure
 */
function validateMapData(data: MapDataItem[]): MapDataItem[] {
  return data.filter(item => {
    // Always retain records with Maneuver_type (important for display)
    if (item.Maneuver_type !== undefined && item.Maneuver_type !== null && item.Maneuver_type !== '') {
      return true;
    }
    
    // Check for required map fields for regular data points (use original field names)
    const hasLocation = (item.Lat !== undefined && item.Lng !== undefined);
    
    const hasTimestamp = item.Datetime !== undefined;
    
    if (!hasLocation) {
      warn('Map data item missing location coordinates:', item);
      return false;
    }
    
    if (!hasTimestamp) {
      warn('Map data item missing timestamp:', item);
      return false;
    }
    
    return true;
  }).map(item => {
    // Only convert Datetime string to Date object, keep all other field names as-is
    const processed: MapDataItem = { ...item };
    
    // Convert Datetime string to Date object if needed
    if (processed.Datetime !== undefined) {
      processed.Datetime = processed.Datetime instanceof Date ? 
        processed.Datetime : 
        new Date(processed.Datetime);
    }
    
    return processed;
  });
}

/**
 * Transform data for map visualization
 */
function transformMapData(data: MapDataItem[], config: MapProcessingConfig = {}): MapDataItem[] {
  const {
    addBearing = true,
    addSpeed = true,
    addDistance = true,
    addElevation = false,
    smoothPath = false
  } = config;

  return data.map((item, index) => {
    const transformed: MapDataItem = { ...item };
    
    // Add bearing calculation
    if (addBearing && index > 0) {
      const prev = data[index - 1];
      if (prev.Lat !== undefined && prev.Lng !== undefined && item.Lat !== undefined && item.Lng !== undefined) {
        transformed.bearing = calculateBearing(prev.Lat, prev.Lng, item.Lat, item.Lng);
      }
    }
    
    // Add speed calculation
    if (addSpeed && index > 0) {
      const prev = data[index - 1];
      if (prev.Lat !== undefined && prev.Lng !== undefined && item.Lat !== undefined && item.Lng !== undefined) {
        const distance = calculateDistance(prev.Lat, prev.Lng, item.Lat, item.Lng);
        const timeDiff = (new Date(item.Datetime!).getTime() - new Date(prev.Datetime!).getTime()) / 1000;
        transformed.speed = timeDiff > 0 ? distance / timeDiff : 0;
      }
    }
    
    // Add cumulative distance
    if (addDistance) {
      let totalDistance = 0;
      for (let i = 1; i <= index; i++) {
        const prev = data[i - 1];
        const curr = data[i];
        if (prev.Lat !== undefined && prev.Lng !== undefined && curr.Lat !== undefined && curr.Lng !== undefined) {
          totalDistance += calculateDistance(prev.Lat, prev.Lng, curr.Lat, curr.Lng);
        }
      }
      transformed.cumulativeDistance = totalDistance;
    }
    
    // Add elevation if available
    if (addElevation && item.elevation !== undefined) {
      transformed.elevation = item.elevation;
    }
    
    // Smooth path if requested
    if (smoothPath && index > 0 && index < data.length - 1) {
      const prev = data[index - 1];
      const next = data[index + 1];
      if (prev.Lat !== undefined && prev.Lng !== undefined && 
          item.Lat !== undefined && item.Lng !== undefined &&
          next.Lat !== undefined && next.Lng !== undefined) {
        transformed.Lat = (prev.Lat + item.Lat + next.Lat) / 3;
        transformed.Lng = (prev.Lng + item.Lng + next.Lng) / 3;
      }
    }
    
    return transformed;
  });
}

/**
 * Optimize map data for 2Hz updates
 */
function optimizeMapData(data: MapDataItem[], maxPoints: number, timeWindow: number): MapDataItem[] {
  // If maxPoints is 0, no limit on points
  if (maxPoints === 0 || data.length <= maxPoints) {
    return data;
  }

  // Filter by time window if specified
  let filteredData = data;
  if (timeWindow > 0) {
    const now = Date.now();
    const cutoff = now - timeWindow;
    filteredData = data.filter(item => {
      const timestamp = new Date(item.Datetime!).getTime();
      return timestamp >= cutoff;
    });
  }

  // If still too many points, sample intelligently
  if (filteredData.length > maxPoints) {
    return smartSampleMapData(filteredData, maxPoints);
  }

  return filteredData;
}

/**
 * Smart sampling for map data that preserves important points
 */
function smartSampleMapData(data: MapDataItem[], targetSize: number): MapDataItem[] {
  if (data.length <= targetSize) {
    return data;
  }

  const step = Math.ceil(data.length / targetSize);
  const sampled: MapDataItem[] = [];

  // Always include first and last points
  sampled.push(data[0]);

  // Sample middle points with smart selection
  for (let i = step; i < data.length - step; i += step) {
    const rangeStart = Math.max(0, i - Math.floor(step / 2));
    const rangeEnd = Math.min(data.length - 1, i + Math.floor(step / 2));

    // Find the point with the most significant change in bearing or speed
    let bestPoint = data[i];
    let maxChange = 0;

    for (let j = rangeStart; j <= rangeEnd; j++) {
      const point = data[j];
      let change = 0;

      // Prioritize maneuver records
      if (point.Maneuver_type !== undefined && point.Maneuver_type !== null && point.Maneuver_type !== '') {
        change += 1000; // High priority for maneuver records
      }

      // Consider bearing change
      if (point.bearing !== undefined && j > 0) {
        const prevBearing = data[j - 1].bearing;
        if (prevBearing !== undefined) {
          const bearingChange = Math.abs(normalizeBearing(point.bearing - prevBearing));
          change += bearingChange;
        }
      }

      // Consider speed change
      if (point.speed !== undefined && j > 0) {
        const prevSpeed = data[j - 1].speed;
        if (prevSpeed !== undefined) {
          const speedChange = Math.abs(point.speed - prevSpeed);
          change += speedChange;
        }
      }

      if (change > maxChange) {
        maxChange = change;
        bestPoint = point;
      }
    }

    sampled.push(bestPoint);
  }

  // Always include the last point
  sampled.push(data[data.length - 1]);

  return sampled;
}

/**
 * Calculate bearing between two points
 */
function calculateBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;

  const y = Math.sin(dLng) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - 
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLng);

  let bearing = Math.atan2(y, x) * 180 / Math.PI;
  return (bearing + 360) % 360;
}

/**
 * Calculate distance between two points (Haversine formula)
 */
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Normalize bearing to 0-360 range
 */
function normalizeBearing(bearing: number): number {
  while (bearing < 0) bearing += 360;
  while (bearing >= 360) bearing -= 360;
  return bearing;
}

/**
 * Calculate map bounds
 */
function calculateBounds(data: MapDataItem[]): MapBounds {
  if (data.length === 0) {
    return { north: 0, south: 0, east: 0, west: 0 };
  }

  let north = data[0].Lat!;
  let south = data[0].Lat!;
  let east = data[0].Lng!;
  let west = data[0].Lng!;

  data.forEach(point => {
    if (point.Lat !== undefined && point.Lng !== undefined) {
      north = Math.max(north, point.Lat);
      south = Math.min(south, point.Lat);
      east = Math.max(east, point.Lng);
      west = Math.min(west, point.Lng);
    }
  });

  return { north, south, east, west };
}

/**
 * Calculate map statistics
 */
function calculateMapStatistics(data: MapDataItem[]): MapStatistics {
  if (data.length === 0) {
    return {
      totalDistance: 0,
      averageSpeed: 0,
      maxSpeed: 0,
      duration: 0,
      pointCount: 0
    };
  }

  let totalDistance = 0;
  let totalSpeed = 0;
  let maxSpeed = 0;
  let speedCount = 0;

  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1];
    const curr = data[i];
    
    if (prev.Lat !== undefined && prev.Lng !== undefined && 
        curr.Lat !== undefined && curr.Lng !== undefined) {
      const distance = calculateDistance(prev.Lat, prev.Lng, curr.Lat, curr.Lng);
      totalDistance += distance;
    }
    
    if (curr.speed !== undefined) {
      totalSpeed += curr.speed;
      maxSpeed = Math.max(maxSpeed, curr.speed);
      speedCount++;
    }
  }

  const startTime = new Date(data[0].Datetime!).getTime();
  const endTime = new Date(data[data.length - 1].Datetime!).getTime();
  const duration = (endTime - startTime) / 1000; // seconds

  return {
    totalDistance,
    averageSpeed: speedCount > 0 ? totalSpeed / speedCount : 0,
    maxSpeed,
    duration,
    pointCount: data.length
  };
}

