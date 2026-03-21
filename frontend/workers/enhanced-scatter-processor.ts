/**
 * Enhanced Scatter Data Processor
 * 
 * Handles density optimization per color group and weighted regression calculations
 */

import { log, error as logError } from '../utils/console';

// Types for enhanced scatter processing
interface EnhancedScatterConfig {
  xField: string;
  yField: string;
  colorField?: string;
  colorType?: 'DEFAULT' | 'TACK' | 'GRADE' | 'UW/DW';
  maxPoints?: number;
  regressionMethod?: 'None' | 'Linear' | 'Poly 2' | 'Poly 3' | 'Loess 0.3' | 'Loess 0.5';
  tableRange?: { min: number; max: number; step: number };
  skipOptimization?: boolean;
}

interface DensityOptimizedGroup {
  groupName: string;
  color: string;
  data: any[];
  density: number;
  regression?: any;
  tableValues?: { x: number; y: number }[];
}

interface EnhancedScatterResult {
  groups: DensityOptimizedGroup[];
  totalProcessedCount: number;
  totalValidDataCount: number;
  optimizationStats: {
    originalCount: number;
    optimizedCount: number;
    groupsProcessed: number;
  };
}

interface EnhancedScatterMessage {
  id: string;
  type: 'PROCESS_ENHANCED_SCATTER';
  data: any[];
  config: EnhancedScatterConfig;
}

interface EnhancedScatterResponse {
  id: string;
  type: 'ENHANCED_SCATTER_PROCESSED';
  success: boolean;
  result?: EnhancedScatterResult;
  error?: string;
}

// Resolve TWA from point using default channel (Twa_deg) and common fallbacks.
// unifiedDataStore normalizes to Twa_deg and removes Twa, so we must check Twa_deg.
function getTwaFromPoint(point: any): number {
  return point.Twa ?? point.twa ?? point.Twa_deg ?? point.twa_deg ?? point.TWA ?? 0;
}

// Helper function to group data by color type
function groupDataByColorType(data: any[], colorType: string): { [key: string]: any[] } {
  const groups: { [key: string]: any[] } = {};
  
  data.forEach(point => {
    let groupKey = 'ALL';
    
    switch (colorType) {
      case 'TACK':
        groupKey = getTwaFromPoint(point) > 0 ? 'STBD' : 'PORT';
        break;
      case 'GRADE':
        // Use normalized field name first (unifiedDataStore normalizes metadata)
        const grade = point.grade ?? point.Grade ?? point.GRADE ?? 0;
        // Skip GRADE_0 (exclude from regression calculations)
        if (grade === 0) {
          groupKey = 'SKIP'; // Special key for excluded data
        } else {
          groupKey = `GRADE_${grade}`;
        }
        break;
      case 'UW/DW':
        const absTwa = Math.abs(getTwaFromPoint(point));
        if (absTwa < 75) groupKey = 'UPWIND';
        else if (absTwa >= 75 && absTwa <= 120) groupKey = 'REACHING';
        else groupKey = 'DOWNWIND';
        break;
      default:
        groupKey = 'ALL';
    }
    
    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }
    groups[groupKey].push(point);
  });
  
  return groups;
}

// Density optimization using spatial clustering
function optimizeDensity(data: any[], maxPoints: number, xScale: any, yScale: any): any[] {
  if (!data || data.length === 0) return [];
  if (data.length <= maxPoints) return data;
  
  // Convert data to screen coordinates for spatial analysis
  const screenPoints = data.map((point, idx) => ({
    ...point,
    screenX: xScale(point.x),
    screenY: yScale(point.y),
    originalIndex: idx
  }));
  
  // Define clustering parameters
  const clusterRadius = 3; // Pixels
  const minClusterSize = 2;
  
  // Create spatial grid for efficient clustering
  const gridSize = clusterRadius * 2;
  const grid = new Map();
  
  // Place points in grid cells
  screenPoints.forEach(point => {
    const gridX = Math.floor(point.screenX / gridSize);
    const gridY = Math.floor(point.screenY / gridSize);
    const key = `${gridX},${gridY}`;
    
    if (!grid.has(key)) {
      grid.set(key, []);
    }
    grid.get(key).push(point);
  });
  
  // Process clusters and create density-based representation
  const processedPoints = [];
  const processedIndices = new Set();
  
  // Process each grid cell
  for (const [key, cellPoints] of grid) {
    if (cellPoints.length >= minClusterSize) {
      // This is a cluster - create density representation
      const clusterCenter = {
        x: cellPoints.reduce((sum, p) => sum + p.x, 0) / cellPoints.length,
        y: cellPoints.reduce((sum, p) => sum + p.y, 0) / cellPoints.length,
        density: cellPoints.length,
        clusterSize: cellPoints.length,
        // Preserve first point's metadata
        ...cellPoints[0]
      };
      
      // Add cluster center with density information
      processedPoints.push({
        ...clusterCenter,
        isCluster: true,
        opacity: Math.min(0.9, 0.15 + (cellPoints.length * 0.03))
      });
      
      // Mark all points in this cluster as processed
      cellPoints.forEach(point => processedIndices.add(point.originalIndex));
    } else {
      // Single point or small group - add individual points
      cellPoints.forEach(point => {
        if (!processedIndices.has(point.originalIndex)) {
          processedPoints.push({
            ...point,
            isCluster: false,
            opacity: 0.1
          });
          processedIndices.add(point.originalIndex);
        }
      });
    }
  }
  
  // If we still have too many points, apply intelligent sampling
  if (processedPoints.length > maxPoints) {
    // Sort by density (clusters first, then individual points)
    processedPoints.sort((a, b) => {
      if (a.isCluster && !b.isCluster) return -1;
      if (!a.isCluster && b.isCluster) return 1;
      return (b.density || 1) - (a.density || 1);
    });
    
    // Keep all clusters and sample individual points
    const clusters = processedPoints.filter(p => p.isCluster);
    const individuals = processedPoints.filter(p => !p.isCluster);
    
    const remainingSlots = maxPoints - clusters.length;
    const sampleStep = Math.ceil(individuals.length / remainingSlots);
    
    const sampledIndividuals = individuals.filter((_, index) => index % sampleStep === 0);
    
    return [...clusters, ...sampledIndividuals];
  }
  
  return processedPoints;
}

// Weighted regression calculation
function calculateWeightedRegression(data: any[], method: string, xDomain: [number, number]): any {
  if (!data || data.length < 2) return null;
  
  const validData = data.filter(d => 
    d.x !== undefined && d.x !== null && 
    d.y !== undefined && d.y !== null && 
    !isNaN(d.x) && !isNaN(d.y)
  );
  
  if (validData.length < 2) return null;
  
  // Calculate weights based on density
  const weights = validData.map(d => d.density || 1);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const normalizedWeights = weights.map(w => w / totalWeight);
  
  switch (method) {
    case 'Linear':
      return calculateWeightedLinearRegression(validData, normalizedWeights, xDomain);
    case 'Poly 2':
      return calculateWeightedPolynomialRegression(validData, normalizedWeights, xDomain, 2);
    case 'Poly 3':
      return calculateWeightedPolynomialRegression(validData, normalizedWeights, xDomain, 3);
    case 'Loess 0.3':
      return calculateWeightedLoessRegression(validData, normalizedWeights, xDomain, 0.3);
    case 'Loess 0.5':
      return calculateWeightedLoessRegression(validData, normalizedWeights, xDomain, 0.5);
    default:
      return null;
  }
}

// Weighted linear regression
function calculateWeightedLinearRegression(data: any[], weights: number[], xDomain: [number, number]): any {
  const n = data.length;
  
  // Calculate weighted means
  const xMean = data.reduce((sum, d, i) => sum + d.x * weights[i], 0);
  const yMean = data.reduce((sum, d, i) => sum + d.y * weights[i], 0);
  
  // Calculate weighted covariance and variance
  let numerator = 0;
  let denominator = 0;
  
  for (let i = 0; i < n; i++) {
    const xDiff = data[i].x - xMean;
    const yDiff = data[i].y - yMean;
    const weight = weights[i];
    
    numerator += weight * xDiff * yDiff;
    denominator += weight * xDiff * xDiff;
  }
  
  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;
  
  // Calculate R²
  let ssRes = 0;
  let ssTot = 0;
  
  for (let i = 0; i < n; i++) {
    const predicted = slope * data[i].x + intercept;
    const residual = data[i].y - predicted;
    const total = data[i].y - yMean;
    
    ssRes += weights[i] * residual * residual;
    ssTot += weights[i] * total * total;
  }
  
  const r2 = ssTot !== 0 ? 1 - (ssRes / ssTot) : 0;
  
  // Generate points for the line
  const points = [
    { x: xDomain[0], y: slope * xDomain[0] + intercept },
    { x: xDomain[1], y: slope * xDomain[1] + intercept }
  ];
  
  return {
    slope,
    intercept,
    r2,
    points
  };
}

// Weighted polynomial regression
function calculateWeightedPolynomialRegression(data: any[], weights: number[], xDomain: [number, number], degree: number): any {
  // Simplified implementation - for production, use proper weighted polynomial regression
  const n = data.length;
  const xValues = data.map(d => d.x);
  const yValues = data.map(d => d.y);
  
  // Create weighted design matrix
  const X = [];
  const y = [];
  
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j <= degree; j++) {
      row.push(Math.pow(xValues[i], j));
    }
    X.push(row);
    y.push(yValues[i] * Math.sqrt(weights[i]));
  }
  
  // Apply weights to design matrix
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= degree; j++) {
      X[i][j] *= Math.sqrt(weights[i]);
    }
  }
  
  // Solve using normal equations (simplified)
  const coefficients = solvePolynomialSystem(X, y, degree + 1);
  
  // Generate points for the curve
  const numPoints = 50;
  const points = [];
  for (let i = 0; i <= numPoints; i++) {
    const x = xDomain[0] + (i / numPoints) * (xDomain[1] - xDomain[0]);
    let y = 0;
    for (let j = 0; j <= degree; j++) {
      y += coefficients[j] * Math.pow(x, j);
    }
    points.push({ x, y });
  }
  
  return {
    coefficients,
    points,
    degree
  };
}

// Weighted LOESS regression (simplified)
function calculateWeightedLoessRegression(data: any[], weights: number[], xDomain: [number, number], bandwidth: number = 0.3): any {
  const numPoints = 50;
  const points = [];
  
  for (let i = 0; i <= numPoints; i++) {
    const x = xDomain[0] + (i / numPoints) * (xDomain[1] - xDomain[0]);
    
    // Calculate weighted local regression
    let numerator = 0;
    let denominator = 0;
    
    for (let j = 0; j < data.length; j++) {
      const distance = Math.abs(data[j].x - x) / (xDomain[1] - xDomain[0]);
      const weight = weights[j] * Math.max(0, 1 - Math.pow(distance / bandwidth, 3));
      
      numerator += weight * data[j].y;
      denominator += weight;
    }
    
    const y = denominator > 0 ? numerator / denominator : 0;
    points.push({ x, y });
  }
  
  return {
    points,
    bandwidth
  };
}

// Solve polynomial system (simplified)
function solvePolynomialSystem(X: number[][], y: number[], n: number): number[] {
  // Proper least squares solution using normal equations
  const m = X.length; // number of data points
  
  // Create X^T * X matrix
  const XTX = [];
  for (let i = 0; i < n; i++) {
    XTX[i] = [];
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < m; k++) {
        sum += X[k][i] * X[k][j];
      }
      XTX[i][j] = sum;
    }
  }
  
  // Create X^T * y vector
  const XTy = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < m; j++) {
      sum += X[j][i] * y[j];
    }
    XTy[i] = sum;
  }
  
  // Solve (X^T * X) * coefficients = X^T * y using Gaussian elimination
  return solveLinearSystem(XTX, XTy);
}

function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length;
  const augmented = A.map((row, i) => [...row, b[i]]);
  
  // Forward elimination
  for (let i = 0; i < n; i++) {
    // Find pivot
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
        maxRow = k;
      }
    }
    
    // Swap rows
    [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];
    
    // Make all rows below this one 0 in current column
    for (let k = i + 1; k < n; k++) {
      const factor = augmented[k][i] / augmented[i][i];
      for (let j = i; j <= n; j++) {
        augmented[k][j] -= factor * augmented[i][j];
      }
    }
  }
  
  // Back substitution
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = augmented[i][n];
    for (let j = i + 1; j < n; j++) {
      x[i] -= augmented[i][j] * x[j];
    }
    x[i] /= augmented[i][i];
  }
  
  return x;
}

// Generate table values using regression
function generateTableValues(regression: any, tableRange: { min: number; max: number; step: number }): { x: number; y: number }[] {
  if (!regression || !regression.points) return [];
  
  const values = [];
  for (let x = tableRange.min; x <= tableRange.max; x += tableRange.step) {
    // Interpolate y value from regression points
    const y = interpolateRegressionValue(regression.points, x);
    if (y !== null) {
      values.push({ x, y });
    }
  }
  return values;
}

// Interpolate value from regression points
function interpolateRegressionValue(points: { x: number; y: number }[], targetX: number): number | null {
  if (!points || points.length === 0) return null;
  
  // Find surrounding points
  let lowerPoint = null;
  let upperPoint = null;
  
  for (const point of points) {
    if (point.x <= targetX && (!lowerPoint || point.x > lowerPoint.x)) {
      lowerPoint = point;
    }
    if (point.x >= targetX && (!upperPoint || point.x < upperPoint.x)) {
      upperPoint = point;
    }
  }
  
  // Exact match
  if (lowerPoint && lowerPoint.x === targetX) return lowerPoint.y;
  if (upperPoint && upperPoint.x === targetX) return upperPoint.y;
  
  // Interpolate
  if (lowerPoint && upperPoint) {
    const ratio = (targetX - lowerPoint.x) / (upperPoint.x - lowerPoint.x);
    return lowerPoint.y + ratio * (upperPoint.y - lowerPoint.y);
  }
  
  // Extrapolate
  if (lowerPoint && targetX > lowerPoint.x) {
    return lowerPoint.y;
  }
  if (upperPoint && targetX < upperPoint.x) {
    return upperPoint.y;
  }
  
  return null;
}

// Main processing function
export function processEnhancedScatterData(data: any[], config: EnhancedScatterConfig): EnhancedScatterResult {
  const {
    xField = 'x',
    yField = 'y',
    colorType = 'DEFAULT',
    maxPoints = 3000,
    regressionMethod = 'None',
    tableRange = { min: 6, max: 20, step: 1 },
    skipOptimization = false
  } = config;
  
  // Filter valid data
  const validData = data.filter(item => {
    const x = Number(item[xField]);
    const y = Number(item[yField]);
    return !isNaN(x) && !isNaN(y) && x !== null && y !== null;
  });
  
  if (validData.length === 0) {
    return {
      groups: [],
      totalProcessedCount: 0,
      totalValidDataCount: 0,
      optimizationStats: {
        originalCount: data.length,
        optimizedCount: 0,
        groupsProcessed: 0
      }
    };
  }
  
  // Group data by color type
  const groupedData = groupDataByColorType(validData, colorType);
  
  // Process each group
  const groups: DensityOptimizedGroup[] = [];
  let totalOptimizedCount = 0;
  
  // Create scales for density optimization
  const xValues = validData.map(d => d[xField]);
  const yValues = validData.map(d => d[yField]);
  const xDomain = [Math.min(...xValues), Math.max(...xValues)];
  const yDomain = [Math.min(...yValues), Math.max(...yValues)];
  
  const xScale = (x: number) => (x - xDomain[0]) / (xDomain[1] - xDomain[0]) * 800;
  const yScale = (y: number) => (y - yDomain[0]) / (yDomain[1] - yDomain[0]) * 400;
  
  for (const [groupName, groupData] of Object.entries(groupedData)) {
    if (groupData.length === 0) continue;
    
    // Skip excluded groups (like GRADE_0)
    if (groupName === 'SKIP') continue;
    
    // Apply density optimization only if not skipped
    const optimizedData = skipOptimization ? groupData : optimizeDensity(groupData, maxPoints, xScale, yScale);
    
    // Calculate regression if specified
    let regression = null;
    let tableValues = [];
    
    if (regressionMethod !== 'None') {
      log(`🔍 EnhancedScatterWorker: Calculating ${regressionMethod} regression for group ${groupName} with ${optimizedData.length} points`);
      regression = calculateWeightedRegression(optimizedData, regressionMethod, xDomain);
      if (regression) {
        log(`🔍 EnhancedScatterWorker: Regression calculated for group ${groupName}:`, regression);
        tableValues = generateTableValues(regression, tableRange);
        log(`🔍 EnhancedScatterWorker: Generated ${tableValues.length} table values for group ${groupName}`);
      } else {
        log(`🔍 EnhancedScatterWorker: Failed to calculate regression for group ${groupName}`);
      }
    } else {
      log(`🔍 EnhancedScatterWorker: No regression specified for group ${groupName}`);
    }
    
    // Determine group color
    let color = '#1f77b4';
    switch (groupName) {
      case 'PORT': color = '#d62728'; break;
      case 'STBD': color = '#2ca02c'; break;
      case 'UPWIND': color = 'blue'; break;
      case 'REACHING': color = 'orange'; break;
      case 'DOWNWIND': color = 'purple'; break; // Changed from red to purple
      case 'GRADE_0': color = 'lightgray'; break;
      case 'GRADE_1': color = 'red'; break;
      case 'GRADE_2': color = 'lightgreen'; break;
      case 'GRADE_3': color = 'darkgreen'; break;
    }
    
    groups.push({
      groupName,
      color,
      data: optimizedData,
      density: groupData.length,
      regression,
      tableValues
    });
    
    totalOptimizedCount += optimizedData.length;
  }
  
  return {
    groups,
    totalProcessedCount: totalOptimizedCount,
    totalValidDataCount: validData.length,
    optimizationStats: {
      originalCount: data.length,
      optimizedCount: totalOptimizedCount,
      groupsProcessed: groups.length
    }
  };
}

// Worker message handler
self.onmessage = (event: MessageEvent<EnhancedScatterMessage>) => {
  const { id, type, data, config } = event.data;
  
  if (type === 'PROCESS_ENHANCED_SCATTER') {
    log(`Enhanced scatter worker received data processing request with ID: ${id}, data points: ${data.length}`);
    const startTime = performance.now();
    
    try {
      const result = processEnhancedScatterData(data, config);
      const processingTime = performance.now() - startTime;
      
      log(`Enhanced scatter worker completed data processing in ${processingTime.toFixed(2)}ms for ID: ${id}`);
      
      const response: EnhancedScatterResponse = {
        id,
        type: 'ENHANCED_SCATTER_PROCESSED',
        success: true,
        result
      };
      
      self.postMessage(response);
    } catch (error) {
      const processingTime = performance.now() - startTime;
      logError(`Enhanced scatter worker error in data processing after ${processingTime.toFixed(2)}ms for ID: ${id}:`, error);
      
      const response: EnhancedScatterResponse = {
        id,
        type: 'ENHANCED_SCATTER_PROCESSED',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      
      self.postMessage(response);
    }
  }
};
