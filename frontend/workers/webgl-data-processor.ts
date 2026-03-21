/**
 * WebGL Data Processor Worker
 * 
 * Handles heavy data processing for WebGL rendering:
 * - Coordinate transformation using D3 scales or Mapbox projection
 * - Gap detection and segment building
 * - Buffer data preparation (positions, colors, indices)
 */

import type { WorkerMessage, WorkerResponse } from './types';

interface WebGLDataProcessingMessage extends WorkerMessage {
  type: 'PROCESS_WEBGL_DATA';
  data: any[];
  config: {
    sourceId: number;
    color: string;
    // For time series (2D canvas)
    xScale?: {
      domain: [number, number];
      range: [number, number];
    };
    yScale?: {
      domain: [number, number];
      range: [number, number];
    };
    resolution?: [number, number];
    // For tracks (Mapbox)
    isGeo?: boolean;
    // Gap detection
    gapThresholdMs?: number;
  };
}

interface ProcessedWebGLData {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint16Array;
  pointCount: number;
  segmentCount: number;
}

interface WebGLDataProcessingResponse extends WorkerResponse<ProcessedWebGLData> {
  id: string;
  type: 'success' | 'error';
  result?: ProcessedWebGLData;
  error?: string;
  duration: number;
}

/**
 * Convert hex color to RGB float array
 */
function hexToRgbFloat(hex: string): [number, number, number] {
  const cleanHex = hex.replace('#', '');
  const r = parseInt(cleanHex.substring(0, 2), 16) / 255;
  const g = parseInt(cleanHex.substring(2, 4), 16) / 255;
  const b = parseInt(cleanHex.substring(4, 6), 16) / 255;
  return [r, g, b];
}

/**
 * Linear scale function (D3 scaleLinear equivalent)
 */
function linearScale(domain: [number, number], range: [number, number]): (value: number) => number {
  const domainMin = domain[0];
  const domainMax = domain[1];
  const rangeMin = range[0];
  const rangeMax = range[1];
  const domainSpan = domainMax - domainMin;
  const rangeSpan = rangeMax - rangeMin;

  if (domainSpan === 0) {
    return () => rangeMin;
  }

  return (value: number) => {
    const normalized = (value - domainMin) / domainSpan;
    return rangeMin + normalized * rangeSpan;
  };
}

/**
 * Get timestamp from data point
 */
function getTimestamp(d: any): number | undefined {
  if (!d) return undefined;
  const timestamp = d.Datetime || d.timestamp || d.time || d.datetime;
  if (!timestamp) return undefined;
  if (timestamp instanceof Date) return timestamp.getTime();
  if (typeof timestamp === 'number') return timestamp;
  if (typeof timestamp === 'string') {
    const parsed = new Date(timestamp).getTime();
    return isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Process data for WebGL rendering
 */
function processWebGLData(
  data: any[],
  config: WebGLDataProcessingMessage['config']
): ProcessedWebGLData {
  const gapThresholdMs = config.gapThresholdMs ?? 3000;
  const color = hexToRgbFloat(config.color);
  const isGeo = config.isGeo ?? false;

  // Prepare arrays (estimate size)
  const maxPoints = data.length;
  const positions = new Float32Array(maxPoints * 2);
  const colors = new Float32Array(maxPoints * 3);
  const indices: number[] = [];

  let pointCount = 0;
  let lastValidIndex = -1;

  // Create scale functions if provided
  const xScale = config.xScale ? linearScale(config.xScale.domain, config.xScale.range) : null;
  const yScale = config.yScale ? linearScale(config.yScale.domain, config.yScale.range) : null;

  for (let i = 0; i < data.length; i++) {
    const point = data[i];
    
    // Extract coordinates
    let x: number, y: number;
    
    if (isGeo) {
      const lng = point.Lng ?? point.lng;
      const lat = point.Lat ?? point.lat;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        continue; // Skip invalid points
      }
      x = lng;
      y = lat;
    } else {
      // Time series: need to transform using scales
      if (!xScale || !yScale) {
        continue; // Can't process without scales
      }

      const timestamp = getTimestamp(point);
      if (timestamp === undefined) {
        continue;
      }

      // Get y value (default to Bsp for time series)
      const yValue = point.Bsp ?? point.bsp ?? 0;
      if (!Number.isFinite(yValue)) {
        continue;
      }

      x = xScale(timestamp);
      y = yScale(yValue);
    }

    // Check if coordinates are valid
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }

    // Add position
    positions[pointCount * 2] = x;
    positions[pointCount * 2 + 1] = y;

    // Add color
    colors[pointCount * 3] = color[0];
    colors[pointCount * 3 + 1] = color[1];
    colors[pointCount * 3 + 2] = color[2];

    // Add index (create line segment if we have a previous point)
    if (lastValidIndex >= 0) {
      // Check for gap
      const currentTimestamp = getTimestamp(point);
      const lastTimestamp = getTimestamp(data[lastValidIndex]);
      
      if (currentTimestamp !== undefined && lastTimestamp !== undefined) {
        const gap = currentTimestamp - lastTimestamp;
        if (gap > gapThresholdMs) {
          // Gap detected, don't connect
          lastValidIndex = -1;
        }
      }

      if (lastValidIndex >= 0) {
        indices.push(lastValidIndex);
        indices.push(pointCount);
      }
    }

    lastValidIndex = pointCount;
    pointCount++;
  }

  // Convert indices to Uint16Array
  const indexArray = new Uint16Array(indices);

  // Trim arrays to actual size
  const finalPositions = new Float32Array(positions.buffer, 0, pointCount * 2);
  const finalColors = new Float32Array(colors.buffer, 0, pointCount * 3);

  return {
    positions: finalPositions,
    colors: finalColors,
    indices: indexArray,
    pointCount,
    segmentCount: indices.length / 2
  };
}

// Worker message handler
self.onmessage = (event: MessageEvent<WebGLDataProcessingMessage>) => {
  const { id, type, data, config } = event.data;

  if (type === 'PROCESS_WEBGL_DATA') {
    try {
      const startTime = performance.now();
      const result = processWebGLData(data, config);
      const duration = performance.now() - startTime;

      const response: WebGLDataProcessingResponse = {
        id,
        type: 'success',
        result,
        duration,
        success: true
      };

      self.postMessage(response);
    } catch (error: any) {
      const duration = performance.now();
      const response: WebGLDataProcessingResponse = {
        id,
        type: 'error',
        error: error?.message || 'Unknown error processing WebGL data',
        duration,
        success: false
      };

      self.postMessage(response);
    }
  }
};

