import { createMemo, createSignal } from "solid-js";
import { log, error as logError } from "../../utils/console";

interface FitValue {
  x: number;
  y: number;
}

interface FitGroup {
  group: string;
  color: string;
  fitValues: FitValue[];
  rawPoints?: FitValue[];
  pointCount?: number;
}

interface FitTableProps {
  xaxis?: string;
  version?: number;
  fitData?: FitGroup[];
  /** Current loess bandwidth (e.g. 0.5); when set, +/- buttons are shown */
  loessFactor?: number;
  /** Called with +0.1 or -0.1 to adjust loess and regenerate fits */
  onLoessFactorChange?: (delta: number) => void;
}

export default function FitTable(props: FitTableProps) {
  const { xaxis, version } = props;
  
  // Track hover state for showing copy button
  const [isHovered, setIsHovered] = createSignal(false);
  
  // Get the fit data as a function to ensure reactivity
  const fitData = () => props.fitData || [];

  // Nice steps for row increment so we cap at MAX_FIT_TABLE_ROWS (used when zoomed in FleetPerformance etc.)
  const MAX_FIT_TABLE_ROWS = 10;
  const NICE_FIT_STEPS = [1, 2, 4, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120, 180];

  function getNiceIncrementForMaxRows(rangeMin: number, rangeMax: number): number {
    const span = rangeMax - rangeMin;
    if (span <= 0) return 1;
    const minStep = span / MAX_FIT_TABLE_ROWS;
    const candidate = NICE_FIT_STEPS.find((s) => s >= minStep);
    return candidate ?? Math.ceil(minStep);
  }

  // Dynamic x values based on data range; cap at 10 rows with nice increments when zoomed
  const xValues = createMemo(() => {
    // If no fit data, use default range
    if (!fitData().length) return [10, 12, 14, 16, 18, 20, 22, 24];
    
    // Collect all x values from all groups
    const allXValues = fitData().flatMap(group =>
      group.fitValues.map(point => point.x)
    );
    
    // Data range: allow full zoom range (e.g. TWA 35–90), cap at 180 for angles
    const minX = Math.max(5, Math.floor(Math.min(...allXValues)));
    const maxX = Math.min(180, Math.ceil(Math.max(...allXValues)));
    const range = maxX - minX;
    const increment = getNiceIncrementForMaxRows(minX, maxX);
    
    const values: number[] = [];
    const start = increment >= 1 ? Math.round(minX / increment) * increment : Math.round(minX * 2) / 2;
    for (let x = start; x <= maxX; x += increment) {
      values.push(x);
    }
    
    if (values.length === 0) return [minX, maxX];
    if (values.length === 1) return [minX, ...values, maxX].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
    return values;
  });

  // Track copy state for feedback
  const [copySuccess, setCopySuccess] = createSignal(false);

  // Copy table data to clipboard
  const copyTableToClipboard = async () => {
    try {
      // Build CSV-like format with tab separators for Excel compatibility
      let clipboardText = '';
      
      // Header row
      clipboardText += `${xaxis ? xaxis.toUpperCase() : 'X'}\t`;
      fitData().forEach(group => {
        clipboardText += `${group.group}\t`;
      });
      if (fitData().length === 2) {
        clipboardText += 'DELTA\t';
      }
      clipboardText += '\n';
      
      // Data rows
      xValues().forEach(x => {
        const values = fitData().map(group => 
          getInterpolatedValue(group.fitValues, group.rawPoints, x)
        );
        
        clipboardText += `${x}\t`;
        values.forEach(value => {
          clipboardText += `${value}\t`;
        });
        
        if (fitData().length === 2 && values[0] !== "-" && values[1] !== "-") {
          const delta = (parseFloat(values[0]) - parseFloat(values[1])).toFixed(2);
          clipboardText += `${delta}\t`;
        }
        
        clipboardText += '\n';
      });
      
      log('📋 FitTable: Attempting to copy table data to clipboard', { textLength: clipboardText.length });
      log('📋 FitTable: Clipboard text preview:', clipboardText.substring(0, 200));
      
      // Copy to clipboard using modern API
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(clipboardText);
        log('📋 FitTable: Table data copied to clipboard successfully');
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      } else {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = clipboardText;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        log('📋 FitTable: Table data copied to clipboard (fallback method)');
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      }
    } catch (error: any) {
      logError('Error copying table data:', error);
      log(`📋 FitTable: Error copying table data: ${error.message}`, error);
    }
  };

  // Helper function to get linearly interpolated y value at specific x
  // with improved limits on extrapolation and fallback to average when fit can't interpolate
  function getInterpolatedValue(fitValues: FitValue[], rawPoints: FitValue[] | undefined, targetX: number): string {
    if (!fitValues || fitValues.length === 0) {
      // If no fit values, try to use raw points average
      if (rawPoints && rawPoints.length > 0) {
        return getAverageFromRawPoints(rawPoints, targetX);
      }
      return "-";
    }
    
    // Find the x bounds of our data
    const xMin = Math.min(...fitValues.map(p => p.x));
    const xMax = Math.max(...fitValues.map(p => p.x));
    
    // Only show values within a reasonable extrapolation range
    // Allow extrapolation of about 10% beyond data range
    const extrapolationLimit = (xMax - xMin) * 0.1;
    if (targetX < xMin - extrapolationLimit || targetX > xMax + extrapolationLimit) {
      // Out of range, try raw points average
      return getAverageFromRawPoints(rawPoints, targetX);
    }
    
    // Find points on either side of targetX
    let lowerPoint = null;
    let upperPoint = null;
    
    for (const point of fitValues) {
      if (point.x <= targetX && (!lowerPoint || point.x > lowerPoint.x)) {
        lowerPoint = point;
      }
      if (point.x >= targetX && (!upperPoint || point.x < upperPoint.x)) {
        upperPoint = point;
      }
    }
    
    // If we found exact match
    if (lowerPoint && lowerPoint.x === targetX) return lowerPoint.y.toFixed(2);
    if (upperPoint && upperPoint.x === targetX) return upperPoint.y.toFixed(2);
    
    // If we can interpolate
    if (lowerPoint && upperPoint) {
      // Only interpolate if points aren't too far apart (max 30% of total range)
      const maxGap = (xMax - xMin) * 0.3;
      if (upperPoint.x - lowerPoint.x > maxGap) {
        // Gap too large, try raw points average
        return getAverageFromRawPoints(rawPoints, targetX);
      }
      
      const ratio = (targetX - lowerPoint.x) / (upperPoint.x - lowerPoint.x);
      const interpolatedY = lowerPoint.y + ratio * (upperPoint.y - lowerPoint.y);
      return interpolatedY.toFixed(2);
    }
    
    // Handle extrapolation cases with care
    if (lowerPoint && targetX > lowerPoint.x) {
      // Extrapolating above highest point
      if (targetX - lowerPoint.x > extrapolationLimit) {
        // Too far, try raw points average
        return getAverageFromRawPoints(rawPoints, targetX);
      }
      return lowerPoint.y.toFixed(2);
    }
    
    if (upperPoint && targetX < upperPoint.x) {
      // Extrapolating below lowest point
      if (upperPoint.x - targetX > extrapolationLimit) {
        // Too far, try raw points average
        return getAverageFromRawPoints(rawPoints, targetX);
      }
      return upperPoint.y.toFixed(2);
    }
    
    // No fit available, try raw points average
    return getAverageFromRawPoints(rawPoints, targetX);
  }

  // Helper function to calculate average from raw data points near targetX
  function getAverageFromRawPoints(rawPoints: FitValue[] | undefined, targetX: number): string {
    if (!rawPoints || rawPoints.length === 0) {
      return "-";
    }
    
    // Define a bucket range (e.g., ±0.5 around targetX)
    const bucketRange = 0.5;
    const minX = targetX - bucketRange;
    const maxX = targetX + bucketRange;
    
    // Find all points within the bucket range
    const pointsInBucket = rawPoints.filter(p => p.x >= minX && p.x <= maxX);
    
    if (pointsInBucket.length === 0) {
      return "-";
    }
    
    // Calculate average y value
    const sumY = pointsInBucket.reduce((sum, p) => sum + p.y, 0);
    const avgY = sumY / pointsInBucket.length;
    
    return avgY.toFixed(2);
  }

  return (
    <div 
      class="modern-table-container"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <table class="modern-table">
        <thead>
          <tr>
            <th style={{ "text-align": "center" }}>{xaxis ? xaxis.toUpperCase() : 'X'}</th>
            {fitData().map(group => (
              <th style={{ "text-align": "center" }}>
                <span class="inline-block w-3 h-3 rounded-full mr-2" style={{"background-color": group.color}}></span>
                {group.group} ({group.pointCount || '?'})
              </th>
            ))}
            {fitData().length === 2 ? <th style={{ "text-align": "center" }}>DELTA</th> : null}
          </tr>
        </thead>
        <tbody>
          {xValues().map(x => {
            // Get interpolated values for each group
            const values = fitData().map(group => 
              getInterpolatedValue(group.fitValues, group.rawPoints, x)
            );
            
            // Calculate delta if we have exactly two groups with valid values
            let delta = "-";
            if (fitData().length === 2 && values[0] !== "-" && values[1] !== "-") {
              delta = (parseFloat(values[0]) - parseFloat(values[1])).toFixed(2);
            }
            
            return (
              <tr>
                <td><strong>{x}</strong></td>
                {values.map((value) => (
                  <td>{value}</td>
                ))}
                {fitData().length === 2 ? <td>{delta}</td> : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {isHovered() && (
        <div style={{ "margin-top": "10px", "text-align": "center", display: "flex", "align-items": "center", "justify-content": "center", "gap": "8px", "flex-wrap": "wrap" }}>
          <button
            onClick={copyTableToClipboard}
            style={{
              "background-color": copySuccess() ? "#45a049" : "#4CAF50",
              color: "white",
              border: "none",
              padding: "8px 16px",
              "font-size": "14px",
              "border-radius": "4px",
              cursor: "pointer",
              transition: "background-color 0.2s"
            }}
            onMouseOver={(e: MouseEvent) => !copySuccess() && ((e.target as HTMLElement).style.backgroundColor = "#45a049")}
            onMouseOut={(e: MouseEvent) => !copySuccess() && ((e.target as HTMLElement).style.backgroundColor = "#4CAF50")}
          >
            {copySuccess() ? "✓ Copied!" : "Copy Table Data"}
          </button>
          {props.onLoessFactorChange != null && props.loessFactor != null && (
            <>
              <button
                type="button"
                aria-label="Decrease loess factor"
                onClick={() => props.onLoessFactorChange!(-0.1)}
                style={{
                  width: "28px",
                  height: "28px",
                  padding: "0",
                  "font-size": "18px",
                  "line-height": "1",
                  color: "black",
                  "border-radius": "4px",
                  border: "1px solid #ccc",
                  background: "#f5f5f5",
                  cursor: "pointer",
                  display: "inline-flex",
                  "align-items": "center",
                  "justify-content": "center"
                }}
              >
                −
              </button>
              <span style={{ "font-size": "12px", color: "white", "min-width": "48px" }}>
                Smoothness {Math.round(props.loessFactor * 10)}
              </span>
              <button
                type="button"
                aria-label="Increase loess factor"
                onClick={() => props.onLoessFactorChange!(0.1)}
                style={{
                  width: "28px",
                  height: "28px",
                  padding: "0",
                  "font-size": "18px",
                  "line-height": "1",
                  color: "black",
                  "border-radius": "4px",
                  border: "1px solid #ccc",
                  background: "#f5f5f5",
                  cursor: "pointer",
                  display: "inline-flex",
                  "align-items": "center",
                  "justify-content": "center"
                }}
              >
                +
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
