// Grid data processor web worker
interface GridDataPoint {
    [key: string]: any;
}

interface GridConfig {
    xAxisName: string;
    yAxisName: string;
    xAxisBins: number; // Step size for x-axis bins (e.g., 2 for 2-degree intervals)
    yAxisBins: number; // Step size for y-axis bins (e.g., 2 for 2-knot intervals)
    cellContentType: string;
    zAxisChannel?: string; // Z-axis channel for average calculation
}

interface GridCell {
    xIndex: number;
    yIndex: number;
    count: number;
    xValue: number;
    yValue: number;
    averageValue?: number; // Average value for the cell
    probability?: number; // Probability percentage for the cell
    minValue?: number; // Minimum value for the cell
    maxValue?: number; // Maximum value for the cell
    stdValue?: number; // Standard deviation for the cell
    sailConfig?: string; // Best configuration (highest Vmg_perc)
}

interface ProcessedGridData {
    gridData: GridCell[];
    xAxisRange: { min: number; max: number };
    yAxisRange: { min: number; max: number };
    xAxisStep: number;
    yAxisStep: number;
}

const MAX_BINS = 10;
const NICE_STEPS = [1, 2, 4, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120, 180];

/** Choose an interval that keeps bin count <= MAX_BINS. Uses nice steps (2, 4, 5, 10, ...). */
function getNiceIntervalForMaxBins(rangeMin: number, rangeMax: number, baseInterval: number): number {
    const span = rangeMax - rangeMin;
    if (span <= 0) return baseInterval;
    const minStep = span / MAX_BINS;
    const candidate = NICE_STEPS.find(s => s >= minStep);
    return candidate ?? Math.ceil(minStep);
}

// Calculate bin index for a value
const getBinIndex = (value: number, min: number, max: number, bins: number): number => {
    if (value < min) return 0;
    if (value >= max) return bins - 1;
    return Math.floor(((value - min) / (max - min)) * bins);
};

// Process grid data with progress updates
const processGridData = async (data: GridDataPoint[], config: GridConfig): Promise<ProcessedGridData> => {
    const { xAxisName, yAxisName, xAxisBins: xAxisStep, yAxisBins: yAxisStep, cellContentType, zAxisChannel } = config;
    
    // Send initial progress update
    self.postMessage({
        type: 'GRID_PROGRESS_UPDATE',
        progress: 10,
        status: 'Filtering data points...'
    });
    
    // Filter out invalid data points
    const validData = data.filter(item => 
        item[xAxisName] !== undefined && 
        item[xAxisName] !== null && 
        !Number.isNaN(item[xAxisName]) &&
        item[yAxisName] !== undefined && 
        item[yAxisName] !== null && 
        !Number.isNaN(item[yAxisName])
    );
    
    // Send progress update
    self.postMessage({
        type: 'GRID_PROGRESS_UPDATE',
        progress: 20,
        status: 'Calculating data ranges...'
    });
    
    if (validData.length === 0) {
        return {
            gridData: [],
            xAxisRange: { min: 0, max: 100 },
            yAxisRange: { min: 0, max: 100 }
        };
    }
    
    // Calculate ranges
    const xValues = validData.map(item => item[xAxisName]);
    const yValues = validData.map(item => item[yAxisName]);
    
    const xMin = Math.min(...xValues);
    const xMax = Math.max(...xValues);
    const yMin = Math.min(...yValues);
    const yMax = Math.max(...yValues);
    
    // Optimize step so we get at most MAX_BINS (10) rows/columns when zoomed or wide range
    const effectiveXStep = getNiceIntervalForMaxBins(xMin, xMax, xAxisStep);
    const effectiveYStep = getNiceIntervalForMaxBins(yMin, yMax, yAxisStep);
    
    // Send progress update
    self.postMessage({
        type: 'GRID_PROGRESS_UPDATE',
        progress: 40,
        status: 'Creating grid bins...'
    });
    
    // Round ranges to step boundaries with minimal padding
    const xAxisRange = {
        min: Math.floor(xMin / effectiveXStep) * effectiveXStep,
        max: Math.ceil(xMax / effectiveXStep) * effectiveXStep
    };
    const yAxisRange = {
        min: Math.floor(yMin / effectiveYStep) * effectiveYStep,
        max: Math.ceil(yMax / effectiveYStep) * effectiveYStep
    };
    
    // Add minimal padding only if the range is too tight
    const xPadding = Math.max(effectiveXStep * 0.1, (xMax - xMin) * 0.05);
    const yPadding = Math.max(effectiveYStep * 0.1, (yMax - yMin) * 0.05);
    
    xAxisRange.max += xPadding;
    yAxisRange.max += yPadding;
    
    // Number of bins from effective step (capped at MAX_BINS)
    const xAxisBins = Math.round((xAxisRange.max - xAxisRange.min) / effectiveXStep);
    const yAxisBins = Math.round((yAxisRange.max - yAxisRange.min) / effectiveYStep);
    
    // Initialize grid cells
    const gridCells: { [key: string]: GridCell } = {};
    
    // Send progress update
    self.postMessage({
        type: 'GRID_PROGRESS_UPDATE',
        progress: 60,
        status: 'Processing data points...'
    });
    
    // First pass: collect all values for each cell
    const cellValues: { [key: string]: number[] } = {};
    const cellConfigs: { [key: string]: Array<{vmg_perc: number, config: string}> } = {};
    const cellCounts: { [key: string]: number } = {}; // For counting data points per cell
    
    validData.forEach(item => {
        const xValue = item[xAxisName];
        const yValue = item[yAxisName];
        
        const xIndex = getBinIndex(xValue, xAxisRange.min, xAxisRange.max, xAxisBins);
        const yIndex = getBinIndex(yValue, yAxisRange.min, yAxisRange.max, yAxisBins);
        
        const cellKey = `${xIndex}-${yIndex}`;
        
        // Always count data points for each cell
        cellCounts[cellKey] = (cellCounts[cellKey] || 0) + 1;
        
        if (!cellValues[cellKey]) {
            cellValues[cellKey] = [];
        }
        
        if (!cellConfigs[cellKey]) {
            cellConfigs[cellKey] = [];
        }
        
        // Collect values based on cell content type
        if (cellContentType === 'probability' || cellContentType === 'count') {
            // For probability and count, we just count data points (already done above)
        } else if (zAxisChannel && item[zAxisChannel] !== undefined && item[zAxisChannel] !== null) {
            // For statistical types, collect Z-axis values
            cellValues[cellKey].push(item[zAxisChannel]);
        }
        
        // Collect configuration data
        if (cellContentType === 'config' && 
            item.Vmg_perc !== undefined && item.Vmg_perc !== null && 
            item.Config !== undefined && item.Config !== null) {
            cellConfigs[cellKey].push({
                vmg_perc: item.Vmg_perc,
                config: item.Config
            });
        }
    });
    
    // Send progress update
    self.postMessage({
        type: 'GRID_PROGRESS_UPDATE',
        progress: 80,
        status: 'Calculating cell statistics...'
    });
    
    // Second pass: calculate statistics for each cell
    const allCellKeys = new Set([...Object.keys(cellValues), ...Object.keys(cellCounts)]);
    
    allCellKeys.forEach(cellKey => {
        const [xIndex, yIndex] = cellKey.split('-').map(Number);
        const values = cellValues[cellKey] || [];
        const configs = cellConfigs[cellKey] || [];
        const count = cellCounts[cellKey] || 0;
        
        if (count > 0) {
            // Calculate statistics based on cell content type
            let average = 0, min = 0, max = 0, stdDev = 0;
            
            if (values.length > 0) {
                // We have Z-axis values for statistical calculations
                const sum = values.reduce((acc, val) => acc + val, 0);
                average = sum / count;
                min = Math.min(...values);
                max = Math.max(...values);
                
                // Calculate standard deviation
                const variance = values.reduce((acc, val) => acc + Math.pow(val - average, 2), 0) / count;
                stdDev = Math.sqrt(variance);
            }
            
            // Find best configuration (highest Vmg_perc)
            let bestConfig = '';
            if (configs.length > 0) {
                const sortedConfigs = configs.sort((a, b) => b.vmg_perc - a.vmg_perc);
                const best = sortedConfigs[0];
                bestConfig = best.config;
            }
            
            gridCells[cellKey] = {
                xIndex,
                yIndex,
                count,
                xValue: xAxisRange.min + (xIndex + 0.5) * effectiveXStep,
                yValue: yAxisRange.min + (yIndex + 0.5) * effectiveYStep,
                averageValue: average,
                minValue: min,
                maxValue: max,
                stdValue: stdDev,
                sailConfig: bestConfig
            };
            
        }
    });
    
    // Send progress update
    self.postMessage({
        type: 'GRID_PROGRESS_UPDATE',
        progress: 90,
        status: 'Finalizing grid data...'
    });
    
    // Convert to array
    const gridData = Object.values(gridCells);
    
    // Calculate probabilities if cellContentType is "probability"
    if (cellContentType === "probability") {
        const totalCount = gridData.reduce((sum, cell) => sum + cell.count, 0);
        gridData.forEach(cell => {
            cell.probability = totalCount > 0 ? (cell.count / totalCount) * 100 : 0;
        });
    }
    
    // Send final progress update
    self.postMessage({
        type: 'GRID_PROGRESS_UPDATE',
        progress: 100,
        status: 'Complete!'
    });
    
    return {
        gridData,
        xAxisRange,
        yAxisRange,
        xAxisStep: effectiveXStep,
        yAxisStep: effectiveYStep
    };
};

// Handle messages from main thread
self.onmessage = async (event) => {
    const { type, data, config } = event.data;
    
    if (type === 'PROCESS_GRID_DATA') {
        try {
            const result = await processGridData(data, config);
            self.postMessage({
                type: 'GRID_DATA_PROCESSED',
                result
            });
        } catch (error) {
            self.postMessage({
                type: 'ERROR',
                error: error.message
            });
        }
    }
};
