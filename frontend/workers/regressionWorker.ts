// Regression calculations worker to prevent UI blocking
interface RegressionDataPoint {
  x: number;
  y: number;
}

interface RegressionOptions {
  id?: string;
  xDomain?: [number, number];
  bandwidth?: number;
  degree?: number;
  numPoints?: number;
}

interface LinearRegressionResult {
  points: RegressionDataPoint[];
  slope: number;
  intercept: number;
  r2: number;
}

interface LoessRegressionResult {
  points: RegressionDataPoint[];
  bandwidth: number;
}

interface PolynomialRegressionResult {
  points: RegressionDataPoint[];
  degree: number;
}

interface WorkerMessage {
  type: 'linear' | 'loess' | 'polynomial';
  data: RegressionDataPoint[];
  options: RegressionOptions;
}

interface WorkerResponse {
  success: boolean;
  result?: LinearRegressionResult | LoessRegressionResult | PolynomialRegressionResult | null;
  error?: string;
  type: string;
  id?: string;
}

self.onmessage = function(e: MessageEvent<WorkerMessage>) {
  const { type, data, options } = e.data;
  
  try {
    let result: LinearRegressionResult | LoessRegressionResult | PolynomialRegressionResult | null = null;
    
    switch (type) {
      case 'linear':
        result = calculateLinearRegression(data, options);
        break;
      case 'loess':
        result = calculateLoessRegression(data, options);
        break;
      case 'polynomial':
        result = calculatePolynomialRegression(data, options);
        break;
      default:
        throw new Error(`Unknown regression type: ${type}`);
    }
    
    const response: WorkerResponse = {
      success: true,
      result: result,
      type: type,
      id: options.id
    };
    
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      type: type,
      id: options.id
    };
    
    self.postMessage(response);
  }
};

// Linear regression calculation
function calculateLinearRegression(data: RegressionDataPoint[], options: RegressionOptions = {}): LinearRegressionResult | null {
  if (!data || data.length < 2) return null;
  
  const validData = data.filter(d => 
    d.x !== undefined && d.x !== null && 
    d.y !== undefined && d.y !== null && 
    !isNaN(d.x) && !isNaN(d.y)
  );
  
  if (validData.length < 2) return null;
  
  const xValues = validData.map(d => d.x);
  const yValues = validData.map(d => d.y);
  const xMean = xValues.reduce((sum, x) => sum + x, 0) / xValues.length;
  const yMean = yValues.reduce((sum, y) => sum + y, 0) / yValues.length;
  
  let numerator = 0;
  let denominator = 0;
  
  for (let i = 0; i < validData.length; i++) {
    const xDiff = xValues[i] - xMean;
    const yDiff = yValues[i] - yMean;
    numerator += xDiff * yDiff;
    denominator += xDiff * xDiff;
  }
  
  const slope = denominator !== 0 ? numerator / denominator : 0;
  const intercept = yMean - slope * xMean;
  const lineFunction = (x: number) => slope * x + intercept;
  
  // Calculate R²
  const r2 = calculateR2(validData, slope, intercept);
  
  const xDomain = options.xDomain || [Math.min(...xValues), Math.max(...xValues)];
  
  return {
    points: [
      { x: xDomain[0], y: lineFunction(xDomain[0]) },
      { x: xDomain[1], y: lineFunction(xDomain[1]) }
    ],
    slope: slope,
    intercept: intercept,
    r2: r2
  };
}

// R² calculation
function calculateR2(data: RegressionDataPoint[], slope: number, intercept: number): number {
  const yValues = data.map(d => d.y);
  const yMean = yValues.reduce((sum, y) => sum + y, 0) / yValues.length;
  
  const ssTot = yValues.reduce((sum, y) => sum + Math.pow(y - yMean, 2), 0);
  const ssRes = data.reduce((sum, d) => sum + Math.pow(d.y - (slope * d.x + intercept), 2), 0);
  
  return ssTot > 0 ? 1 - (ssRes / ssTot) : 0;
}

// LOESS regression calculation
function calculateLoessRegression(data: RegressionDataPoint[], options: RegressionOptions = {}): LoessRegressionResult | null {
  if (!data || data.length < 2) return null;

  const validData = data.filter(d =>
    d.x !== undefined && d.x !== null &&
    d.y !== undefined && d.y !== null &&
    !isNaN(d.x) && !isNaN(d.y)
  );
  
  if (validData.length < 2) return null;

  const xValues = validData.map(d => d.x);
  const yValues = validData.map(d => d.y);
  const n = xValues.length;
  const bandwidth = options.bandwidth || 0.5;
  const xDomain = options.xDomain || [Math.min(...xValues), Math.max(...xValues)];
  
  // Limit number of points for performance - max 50 points for large datasets
  const maxPoints = Math.min(50, Math.max(20, Math.floor(n / 10)));
  const numPoints = Math.min(options.numPoints || 50, maxPoints);
  
  const smoothedPoints: RegressionDataPoint[] = [];
  const step = (xDomain[1] - xDomain[0]) / (numPoints - 1);

  for (let i = 0; i < numPoints; i++) {
    const xi = xDomain[0] + i * step;

    // Compute distances
    const distances = xValues.map(xj => Math.abs(xj - xi));

    // Sort and select neighbors
    const sortedIndices = distances
      .map((d, idx) => ({ d, idx }))
      .sort((a, b) => a.d - b.d)
      .map(obj => obj.idx);

    const k = Math.floor(bandwidth * n);
    const neighbors = sortedIndices.slice(0, k);
    const maxDist = distances[neighbors[neighbors.length - 1]];

    // Tricube weights
    const weights = neighbors.map(j => {
      const u = distances[j] / maxDist;
      return Math.pow(1 - Math.pow(u, 3), 3);
    });

    // Weighted linear regression
    let sumW = 0, sumWX = 0, sumWY = 0, sumWXX = 0, sumWXY = 0;
    
    for (let j = 0; j < neighbors.length; j++) {
      const idx = neighbors[j];
      const w = weights[j];
      const xj = xValues[idx];
      const yj = yValues[idx];

      sumW += w;
      sumWX += w * xj;
      sumWY += w * yj;
      sumWXX += w * xj * xj;
      sumWXY += w * xj * yj;
    }

    const denom = sumW * sumWXX - sumWX * sumWX;
    const beta = denom !== 0 ? (sumW * sumWXY - sumWX * sumWY) / denom : 0;
    const alpha = (sumWY - beta * sumWX) / sumW;

    smoothedPoints.push({ x: xi, y: alpha + beta * xi });
  }

  return {
    points: smoothedPoints,
    bandwidth: bandwidth
  };
}

// Polynomial regression calculation
function calculatePolynomialRegression(data: RegressionDataPoint[], options: RegressionOptions = {}): PolynomialRegressionResult | null {
  const degree = options.degree || 2;
  
  if (!data || data.length < degree + 1) return null;

  const validData = data.filter(d =>
    d.x !== undefined && d.x !== null &&
    d.y !== undefined && d.y !== null &&
    !isNaN(d.x) && !isNaN(d.y)
  );
  
  if (validData.length < degree + 1) return null;

  // Limit degree based on data size to prevent overfitting
  const maxDegree = Math.min(degree, Math.floor(validData.length / 3), 3);
  const actualDegree = Math.max(1, maxDegree);

  const xValues = validData.map(d => d.x);
  const yValues = validData.map(d => d.y);
  const n = xValues.length;

  try {
    // Normalize x values to improve numerical stability
    const xMean = xValues.reduce((sum, x) => sum + x, 0) / n;
    const xVariance = xValues.reduce((sum, x) => sum + Math.pow(x - xMean, 2), 0) / n;
    const xStd = Math.sqrt(xVariance) || 1;
    const normalizedX = xValues.map(x => (x - xMean) / xStd);

    // Construct Vandermonde matrix with normalized x values
    const X = normalizedX.map(x => {
      const row: number[] = [];
      for (let i = 0; i <= actualDegree; i++) {
        row.push(Math.pow(x, i));
      }
      return row;
    });

    // Transpose of X
    const XT: number[][] = [];
    for (let col = 0; col <= actualDegree; col++) {
      const column: number[] = [];
      for (let row = 0; row < n; row++) {
        column.push(X[row][col]);
      }
      XT.push(column);
    }

    // XT * X
    const XT_X: number[][] = [];
    for (let i = 0; i <= actualDegree; i++) {
      const row: number[] = [];
      for (let j = 0; j <= actualDegree; j++) {
        let sum = 0;
        for (let k = 0; k < n; k++) {
          sum += XT[i][k] * X[k][j];
        }
        row.push(sum);
      }
      XT_X.push(row);
    }

    // XT * Y
    const XT_Y: number[] = [];
    for (let i = 0; i <= actualDegree; i++) {
      let sum = 0;
      for (let k = 0; k < n; k++) {
        sum += XT[i][k] * yValues[k];
      }
      XT_Y.push(sum);
    }

    // Solve for coefficients using Gaussian elimination
    const coefficients = gaussianElimination(XT_X, XT_Y);
    if (!coefficients) {
      return null;
    }

    // Generate smoothed points
    const xDomain = options.xDomain || [Math.min(...xValues), Math.max(...xValues)];
    
    // Limit number of points for performance - max 50 points for large datasets
    const maxPoints = Math.min(50, Math.max(20, Math.floor(n / 10)));
    const numPoints = Math.min(options.numPoints || 50, maxPoints);
    const step = (xDomain[1] - xDomain[0]) / (numPoints - 1);
    const smoothedPoints: RegressionDataPoint[] = [];
    
    for (let i = 0; i < numPoints; i++) {
      const xi = xDomain[0] + i * step;
      // Normalize xi for polynomial calculation
      const normalizedXi = (xi - xMean) / xStd;
      
      let yi = 0;
      for (let j = 0; j <= actualDegree; j++) {
        yi += coefficients[j] * Math.pow(normalizedXi, j);
      }
      
      // Only check for valid numbers, let the drawing function handle bounds
      if (!isNaN(yi) && isFinite(yi)) {
        smoothedPoints.push({ x: xi, y: yi });
      }
    }

    if (smoothedPoints.length < 10) { // Need minimum points for smooth curve
      return null;
    }

    return {
      points: smoothedPoints,
      degree: actualDegree
    };
  } catch (error) {
    return null;
  }
}

// Gaussian elimination for solving linear systems
function gaussianElimination(A: number[][], b: number[]): number[] | null {
  const m = A.length;
  // Create copies to avoid modifying originals
  const Acopy = A.map(row => [...row]);
  const bcopy = [...b];
  
  for (let i = 0; i < m; i++) {
    // Find pivot
    let maxRow = i;
    for (let k = i + 1; k < m; k++) {
      if (Math.abs(Acopy[k][i]) > Math.abs(Acopy[maxRow][i])) {
        maxRow = k;
      }
    }
    
    // Swap rows
    [Acopy[i], Acopy[maxRow]] = [Acopy[maxRow], Acopy[i]];
    [bcopy[i], bcopy[maxRow]] = [bcopy[maxRow], bcopy[i]];

    // Check for zero pivot
    if (Math.abs(Acopy[i][i]) < 1e-10) {
      return null;
    }

    // Eliminate
    for (let k = i + 1; k < m; k++) {
      const factor = Acopy[k][i] / Acopy[i][i];
      for (let j = i; j < m; j++) {
        Acopy[k][j] -= factor * Acopy[i][j];
      }
      bcopy[k] -= factor * bcopy[i];
    }
  }

  // Back substitution
  const x = Array(m).fill(0);
  for (let i = m - 1; i >= 0; i--) {
    x[i] = bcopy[i];
    for (let j = i + 1; j < m; j++) {
      x[i] -= Acopy[i][j] * x[j];
    }
    x[i] /= Acopy[i][i];
  }
  return x;
}
