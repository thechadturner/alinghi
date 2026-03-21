/**
 * Chart Layout Utility
 * 
 * Provides consistent chart layout configuration based on chart count.
 * Handles centering, multi-row layouts, and proper grid arrangements.
 */

export type LayoutMode = 'default' | 'quarters';

export interface ChartLayoutConfig {
  className: string;
  columns: number;
  rows: number;
  shouldCenter: boolean;
  lastRowItemCount?: number; // Number of items in the last row (for centering purposes)
}

/**
 * Calculates the appropriate chart layout configuration based on chart count.
 * 
 * @param chartCount - The number of charts to display
 * @param layoutMode - Optional layout mode preference (e.g. 'quarters' for 2x2 grid)
 * @param explicitColumns - Optional explicit number of columns (overrides auto-calculation)
 * @returns ChartLayoutConfig object with layout details
 */
export function getChartLayoutConfig(chartCount: number, layoutMode: LayoutMode = 'default', explicitColumns?: number): ChartLayoutConfig {
  if (explicitColumns && explicitColumns > 0) {
    const columns = explicitColumns;
    const rows = Math.ceil(chartCount / columns);
    const lastRowItemCount = chartCount % columns || columns;
    const shouldCenter = lastRowItemCount < columns && lastRowItemCount > 0;
    
    let className = `col${columns}`;
    if (columns === 2 && chartCount > 2) className = 'col2x2';
    if (columns === 3 && chartCount > 3) className = 'col3x';
    
    return {
      className,
      columns,
      rows,
      shouldCenter,
      lastRowItemCount
    };
  }

  if (chartCount <= 0) {
    return {
      className: 'col1',
      columns: 1,
      rows: 1,
      shouldCenter: true
    };
  }

  if (chartCount === 1) {
    return {
      className: 'col1',
      columns: 1,
      rows: 1,
      shouldCenter: true
    };
  }

  if (chartCount === 2) {
    return {
      className: 'col2',
      columns: 2,
      rows: 1,
      shouldCenter: true
    };
  }

  if (chartCount === 3) {
    return {
      className: 'col3',
      columns: 3,
      rows: 1,
      shouldCenter: false
    };
  }

  // Special case for 4 charts: use 2x2 layout by default
  if (chartCount === 4) {
    return {
      className: 'col2x2',
      columns: 2,
      rows: 2,
      shouldCenter: false
    };
  }

  // For 4+ charts, use 3-column layout
  // Calculate rows and check if last row needs centering
  const columns = 3;
  const rows = Math.ceil(chartCount / columns);
  const lastRowItemCount = chartCount % columns || columns; // If divisible, last row is full
  const shouldCenter = lastRowItemCount < columns && lastRowItemCount > 0;

  return {
    className: 'col3x',
    columns,
    rows,
    shouldCenter,
    lastRowItemCount
  };
}

/**
 * Gets the CSS class name for chart layout based on chart count.
 * This is a convenience function that returns just the className.
 * 
 * @param chartCount - The number of charts to display
 * @param layoutMode - Optional layout mode preference
 * @param explicitColumns - Optional explicit number of columns
 * @returns CSS class name string
 */
export function getChartLayoutClass(chartCount: number, layoutMode: LayoutMode = 'default', explicitColumns?: number): string {
  return getChartLayoutConfig(chartCount, layoutMode, explicitColumns).className;
}

