/**
 * D3 Calculations Processor Worker
 * 
 * Handles heavy D3 statistical calculations and data processing including:
 * - Probability calculations (standard, categorical, histogram)
 * - Statistical operations (mean, deviation, median, skewness)
 * - Data binning and histogram generation
 * - Scale calculations (time, linear)
 * - Data extent and range calculations
 */

import type { 
  WorkerMessage, 
  WorkerResponse, 
  D3CalculationsConfig,
  D3CalculationsResult
} from './types';

interface D3CalculationsMessage extends WorkerMessage {
  type: 'PROCESS_D3_CALCULATIONS';
  data: any[];
  config: D3CalculationsConfig;
}

interface D3CalculationsResponse extends WorkerResponse {
  result: D3CalculationsResult;
}

// Helper function to safely calculate min/max without stack overflow
function safeMinMax(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  if (values.length === 1) return { min: values[0], max: values[0] };
  
  // Use reduce to avoid stack overflow with large arrays
  const min = values.reduce((acc, val) => Math.min(acc, val), values[0]);
  const max = values.reduce((acc, val) => Math.max(acc, val), values[0]);
  return { min, max };
}

// Worker message handler
self.onmessage = (event: MessageEvent<D3CalculationsMessage>) => {
  const { type, data, config } = event.data;
  
  if (type === 'PROCESS_D3_CALCULATIONS') {
    try {
      const result = processD3Calculations(data, config);
      
      self.postMessage({
        id: event.data.id,
        type: 'D3_CALCULATIONS_PROCESSED',
        success: true,
        result,
        timestamp: Date.now()
      });
    } catch (error) {
      self.postMessage({
        id: event.data.id,
        type: 'D3_CALCULATIONS_PROCESSED',
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now()
      });
    }
  }
};

/**
 * Process D3 calculations based on operation type
 */
function processD3Calculations(data: any[], config: D3CalculationsConfig): D3CalculationsResult {
  const startTime = performance.now();
  
  if (!data || data.length === 0) {
    return {
      processedData: [],
      statistics: {
        mean: 0,
        stdDev: 0,
        median: 0,
        min: 0,
        max: 0,
        range: 0
      },
      scales: {},
      processingTime: 0
    };
  }

  let processedData: any[] = [];
  let statistics = {
    mean: 0,
    stdDev: 0,
    median: 0,
    min: 0,
    max: 0,
    range: 0,
    skewness: undefined as number | undefined
  };
  let scales: any = {};

  switch (config.operation) {
    case 'PROBABILITY':
      processedData = computeProbability(data, config.options);
      statistics = calculateStatistics(data, config.options);
      break;
      
    case 'HISTOGRAM':
      processedData = computeHistogram(data, config.options);
      statistics = calculateStatistics(data, config.options);
      break;
      
    case 'CATEGORICAL_PROBABILITY':
      processedData = computeCategoricalProbability(data, config.options);
      statistics = calculateStatistics(data, config.options);
      break;
      
    case 'SCALE_CALCULATIONS':
      scales = calculateScales(data, config.options);
      processedData = data; // Return original data for scale calculations
      break;
      
    default:
      throw new Error(`Unknown D3 calculation operation: ${config.operation}`);
  }

  const processingTime = performance.now() - startTime;

  return {
    processedData,
    statistics,
    scales,
    processingTime
  };
}

/**
 * Compute probability data with binning
 */
function computeProbability(data: any[], options: any): any[] {
  const binCount = options.binCount || Math.max(1, Math.min(40, Math.ceil(Math.sqrt(data.length))));
  const cumulative = options.cumulative || false;
  const totalCount = options.totalCount || data.length;
  
  // Debug logging removed for cleaner console output
  
  // Calculate extent
  const xValues = data.map(d => d.x).filter(val => !isNaN(val) && val !== null);
  if (xValues.length === 0) return [];
  
  const xMin = safeMinMax(xValues).min;
  const xMax = safeMinMax(xValues).max;
  const xInt = (xMax - xMin) / binCount;
  
  // Debug logging removed for cleaner console output
  
  const output: any[] = [];
  let cumProb = 0;
  
  for (let i = 0; i < binCount; i++) {
    const fMin = xMin + (xInt * i);
    const fMax = xMin + (xInt * (i + 1));
    const fX = (fMin + fMax) / 2;
    
    const fData = data.filter(d => d.x > fMin && d.x < fMax);
    const fCount = fData.length;
    
    // Debug logging removed for cleaner console output
    
    // Calculate TWA extent for this bin
    const twaValues = fData.map(d => d.Twa).filter(val => !isNaN(val) && val !== null);
    let fTwa = 0;
    let fTwa_abs = 0;
    
    if (twaValues.length > 0) {
      const twaMin = safeMinMax(twaValues).min;
      const twaMax = safeMinMax(twaValues).max;
      fTwa = (twaMin + twaMax) / 2;
      fTwa_abs = Math.abs(fTwa);
    }
    
    // Determine position
    let fPos = 'RCH';
    if (fTwa_abs < 75) {
      fPos = 'UW';
    } else if (fTwa_abs > 125) {
      fPos = 'DW';
    }
    
    const prob = fCount / totalCount;
    cumProb += prob;
    
    // Ensure we're working with percentages (0-100)
    const probPercent = Math.round(prob * 100 * 100) / 100; // Round to 2 decimal places
    const cumPercent = Math.round((cumulative ? cumProb : prob) * 100 * 100) / 100;
    
    // Debug logging removed for cleaner console output
    
    output.push({
      X: fX,
      COUNT: fCount,
      PROB: probPercent, // Convert to percentage
      CUM: cumPercent, // Convert to percentage
      TWA: fTwa,
      POS: fPos,
      PERCENT: (fCount / totalCount) * 100
    });
  }
  
  // Debug logging removed for cleaner console output
  
  return output;
}

/**
 * Compute histogram data
 */
function computeHistogram(data: any[], options: any): any[] {
  const binCount = options.binCount || Math.max(1, Math.min(40, Math.ceil(Math.sqrt(data.length))));
  
  const xValues = data.map(d => d.x).filter(val => !isNaN(val) && val !== null);
  if (xValues.length === 0) return [];
  
  const xMin = safeMinMax(xValues).min;
  const xMax = safeMinMax(xValues).max;
  const xInt = (xMax - xMin) / binCount;
  
  const output: any[] = [];
  
  for (let i = 0; i < binCount; i++) {
    const fMin = xMin + (xInt * i);
    const fMax = xMin + (xInt * (i + 1));
    const fX = (fMin + fMax) / 2;
    
    const fData = data.filter(d => d.x > fMin && d.x < fMax);
    const fCount = fData.length;
    
    // Calculate TWA for this bin
    const twaValues = fData.map(d => d.Twa).filter(val => !isNaN(val) && val !== null);
    let fTwa = 0;
    let fTwa_abs = 0;
    
    if (twaValues.length > 0) {
      const twaMin = safeMinMax(twaValues).min;
      const twaMax = safeMinMax(twaValues).max;
      fTwa = (twaMin + twaMax) / 2;
      fTwa_abs = Math.abs(fTwa);
    }
    
    // Determine position
    let fPos = 'RCH';
    if (fTwa_abs < 75) {
      fPos = 'UW';
    } else if (fTwa_abs > 125) {
      fPos = 'DW';
    }
    
    output.push({
      X: fX,
      COUNT: fCount,
      PROB: 0,
      CUM: 0,
      TWA: fTwa,
      POS: fPos,
      PERCENT: (fCount / data.length) * 100
    });
  }
  
  return output;
}

/**
 * Compute categorical probability data
 */
function computeCategoricalProbability(data: any[], options: any): any[] {
  const binCount = options.binCount || Math.max(1, Math.min(40, Math.ceil(Math.sqrt(data.length))));
  const cumulative = options.cumulative || false;
  const categoryCount = data.length;
  
  const xValues = data.map(d => d.x).filter(val => !isNaN(val) && val !== null);
  if (xValues.length === 0) return [];
  
  const xMin = safeMinMax(xValues).min;
  const xMax = safeMinMax(xValues).max;
  const xInt = (xMax - xMin) / binCount;
  
  const output: any[] = [];
  let cumProb = 0;
  
  for (let i = 0; i < binCount; i++) {
    const fMin = xMin + (xInt * i);
    const fMax = xMin + (xInt * (i + 1));
    const fX = (fMin + fMax) / 2;
    
    const fData = data.filter(d => d.x > fMin && d.x < fMax);
    const fCount = fData.length;
    
    // Calculate TWA for this bin
    const twaValues = fData.map(d => d.Twa).filter(val => !isNaN(val) && val !== null);
    let fTwa = 0;
    let fTwa_abs = 0;
    
    if (twaValues.length > 0) {
      const twaMin = safeMinMax(twaValues).min;
      const twaMax = safeMinMax(twaValues).max;
      fTwa = (twaMin + twaMax) / 2;
      fTwa_abs = Math.abs(fTwa);
    }
    
    // Determine position
    let fPos = 'RCH';
    if (fTwa_abs < 75) {
      fPos = 'UW';
    } else if (fTwa_abs > 125) {
      fPos = 'DW';
    }
    
    const prob = fCount / categoryCount;
    cumProb += prob;
    
    output.push({
      X: fX,
      COUNT: fCount,
      PROB: prob * 100, // Convert to percentage
      CUM: (cumulative ? cumProb : prob) * 100, // Convert to percentage
      TWA: fTwa,
      POS: fPos,
      PERCENT: (fCount / categoryCount) * 100
    });
  }
  
  return output;
}

/**
 * Calculate statistical measures
 */
function calculateStatistics(data: any[], options: any): any {
  const xValues = data.map(d => d.x).filter(val => !isNaN(val) && val !== null);
  
  if (xValues.length === 0) {
    return {
      mean: 0,
      stdDev: 0,
      median: 0,
      min: 0,
      max: 0,
      range: 0,
      skewness: undefined
    };
  }
  
  // Calculate basic statistics
  const mean = xValues.reduce((sum, val) => sum + val, 0) / xValues.length;
  const variance = xValues.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / xValues.length;
  const stdDev = Math.sqrt(variance);
  
  // Calculate median
  const sortedValues = [...xValues].sort((a, b) => a - b);
  const median = sortedValues.length % 2 === 0
    ? (sortedValues[sortedValues.length / 2 - 1] + sortedValues[sortedValues.length / 2]) / 2
    : sortedValues[Math.floor(sortedValues.length / 2)];
  
  const min = safeMinMax(xValues).min;
  const max = safeMinMax(xValues).max;
  const range = max - min;
  
  // Calculate skewness if we have enough data
  let skewness: number | undefined;
  if (xValues.length > 5 && stdDev > 0) {
    const skewValues = xValues.map(val => {
      const normalizedVal = (val - mean) / stdDev;
      return Math.pow(normalizedVal, 3);
    });
    skewness = skewValues.reduce((sum, val) => sum + val, 0) / skewValues.length;
  }
  
  return {
    mean,
    stdDev,
    median,
    min,
    max,
    range,
    skewness
  };
}

/**
 * Calculate scales for chart rendering
 */
function calculateScales(data: any[], options: any): any {
  const scales: any = {};
  
  if (options.scaleType === 'time') {
    // Calculate time extent
    const timeValues = data.map(d => {
      const timestamp = d.Datetime || d.timestamp || d.time;
      return timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
    }).filter(val => !isNaN(val));
    
    if (timeValues.length > 0) {
      const { min, max } = safeMinMax(timeValues);
      scales.extent = [min, max];
    }
  } else if (options.scaleType === 'linear') {
    // Calculate linear scale extent
    const channel = options.channel || 'value';
    const values = data.map(d => d[channel]).filter(val => !isNaN(val) && val !== null);
    
    if (values.length > 0) {
      const { min, max } = safeMinMax(values);
      scales.extent = [min, max * 1.15]; // 15% padding
    }
  }
  
  return scales;
}
