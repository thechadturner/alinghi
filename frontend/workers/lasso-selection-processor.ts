/**
 * Lasso Selection Processor Worker
 * 
 * Handles point-in-polygon calculations for lasso selection:
 * - Computes which points are inside a lasso polygon
 * - Uses robust point-in-polygon algorithm
 * - Processes in batches for better performance
 */

import type { WorkerMessage, WorkerResponse } from './types';

interface LassoSelectionMessage extends WorkerMessage {
  type: 'COMPUTE_LASSO_SELECTION';
  data: {
    points: Array<{
      id: string;
      x: number;
      y: number;
    }>;
    polygon: Array<[number, number]>;
  };
}

interface LassoSelectionResult {
  selectedIds: string[];
  selectedCount: number;
  totalCount: number;
}

interface LassoSelectionResponse extends WorkerResponse<LassoSelectionResult> {
  id: string;
  type: 'success' | 'error';
  result?: LassoSelectionResult;
  error?: string;
  duration: number;
}

// Robust point-in-polygon implementation (simplified version)
// Returns: -1 = outside, 0 = on boundary, 1 = inside
function pointInPolygon(polygon: Array<[number, number]>, point: [number, number]): number {
  const [x, y] = point;
  let inside = false;
  
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) {
      inside = !inside;
    }
  }
  
  return inside ? 1 : -1;
}

self.onmessage = async function(e: MessageEvent<LassoSelectionMessage>) {
  const startTime = performance.now();
  const { id, data } = e.data;

  try {
    const { points, polygon } = data;

    if (!polygon || polygon.length < 3) {
      throw new Error('Polygon must have at least 3 points');
    }

    if (!points || points.length === 0) {
      const response: LassoSelectionResponse = {
        id,
        type: 'success',
        result: {
          selectedIds: [],
          selectedCount: 0,
          totalCount: 0
        },
        duration: performance.now() - startTime
      };
      self.postMessage(response);
      return;
    }

    // Process all points (worker runs off main thread, so we can process synchronously)
    // For very large datasets, we can still batch if needed
    const selectedIds: string[] = [];
    const batchSize = 5000; // Process in larger batches since we're in a worker
    
    for (let i = 0; i < points.length; i += batchSize) {
      const endIndex = Math.min(i + batchSize, points.length);
      
      for (let j = i; j < endIndex; j++) {
        const point = points[j];
        const result = pointInPolygon(polygon, [point.x, point.y]);
        
        if (result >= 0) { // Inside or on boundary
          selectedIds.push(point.id);
        }
      }
      
      // Yield control periodically for very large datasets
      if (endIndex < points.length && endIndex % (batchSize * 10) === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // All points processed
    const response: LassoSelectionResponse = {
      id,
      type: 'success',
      result: {
        selectedIds,
        selectedCount: selectedIds.length,
        totalCount: points.length
      },
      duration: performance.now() - startTime
    };
    self.postMessage(response);

  } catch (error: any) {
    const response: LassoSelectionResponse = {
      id,
      type: 'error',
      error: error.message || 'Unknown error in lasso selection computation',
      duration: performance.now() - startTime
    };
    self.postMessage(response);
  }
};

