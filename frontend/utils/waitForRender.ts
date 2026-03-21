/**
 * Utility functions to wait for browser rendering to complete
 * 
 * These functions help detect when the browser has finished painting
 * content to the screen, not just when DOM elements are created.
 */

import { warn } from './console';

/**
 * Wait for the browser to complete rendering using requestAnimationFrame
 * Multiple RAF calls ensure the browser has had time to paint
 * 
 * @param frames - Number of animation frames to wait (default: 2)
 * @returns Promise that resolves when rendering is complete
 */
export function waitForPaint(frames: number = 2): Promise<void> {
  return new Promise((resolve) => {
    let frameCount = 0;
    
    const raf = () => {
      frameCount++;
      if (frameCount >= frames) {
        resolve();
      } else {
        requestAnimationFrame(raf);
      }
    };
    
    requestAnimationFrame(raf);
  });
}

/**
 * Wait for an element to have dimensions (indicating it's rendered)
 * 
 * @param element - Element to check
 * @param timeout - Maximum time to wait in ms (default: 5000)
 * @returns Promise that resolves when element has dimensions
 */
export function waitForElementDimensions(
  element: HTMLElement | null,
  timeout: number = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!element) {
      reject(new Error('Element is null'));
      return;
    }

    // Check if already has dimensions
    if (element.offsetWidth > 0 && element.offsetHeight > 0) {
      resolve();
      return;
    }

    const startTime = Date.now();
    const checkInterval = setInterval(() => {
      if (!element) {
        clearInterval(checkInterval);
        reject(new Error('Element became null'));
        return;
      }

      const hasDimensions = element.offsetWidth > 0 && element.offsetHeight > 0;
      const elapsed = Date.now() - startTime;

      if (hasDimensions) {
        clearInterval(checkInterval);
        resolve();
      } else if (elapsed >= timeout) {
        clearInterval(checkInterval);
        reject(new Error(`Timeout waiting for element dimensions after ${timeout}ms`));
      }
    }, 100); // Check every 100ms (reduced from 50ms to lower CPU usage)
  });
}

/**
 * Wait for Mapbox map to be fully loaded and rendered
 * 
 * @param map - Mapbox map instance
 * @param timeout - Maximum time to wait in ms (default: 10000)
 * @returns Promise that resolves when map is fully rendered
 */
export function waitForMapboxRender(
  map: any,
  timeout: number = 10000
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!map) {
      reject(new Error('Map is null'));
      return;
    }

    // Check if already loaded
    if (map.loaded() && map.isStyleLoaded()) {
      // Wait for paint to ensure rendering is complete
      waitForPaint(2).then(resolve);
      return;
    }

    const startTime = Date.now();
    
    const checkLoaded = () => {
      if (!map) {
        reject(new Error('Map became null'));
        return;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= timeout) {
        reject(new Error(`Timeout waiting for map to load after ${timeout}ms`));
        return;
      }

      if (map.loaded() && map.isStyleLoaded()) {
        // Wait for paint to ensure rendering is complete
        waitForPaint(2).then(resolve);
      } else {
        // Check again after a delay (100ms) instead of every frame to reduce CPU usage
        setTimeout(checkLoaded, 100);
      }
    };

    setTimeout(checkLoaded, 100);
  });
}

/**
 * Wait for timeline chart to be drawn (checks for SVG with x-axis)
 * 
 * @param containerSelector - Selector for the chart container (default: '.map-container .chart-container')
 * @param timeout - Maximum time to wait in ms (default: 5000)
 * @returns Promise that resolves when timeline is drawn
 */
export function waitForTimelineDraw(
  containerSelector: string = '.map-container .chart-container',
  timeout: number = 5000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const checkTimeline = () => {
      try {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeout) {
          reject(new Error(`Timeout waiting for timeline after ${timeout}ms`));
          return;
        }

        const chartContainer = document.querySelector(containerSelector);
        if (!chartContainer) {
          // Check again after a delay instead of every frame
          setTimeout(checkTimeline, 100);
          return;
        }

        // Check for SVG with x-axis (using DOM directly, not D3, to avoid import)
        const svg = chartContainer.querySelector('svg');
        if (!svg) {
          setTimeout(checkTimeline, 100);
          return;
        }

        const xAxisGroup = svg.querySelector('.x-axis');
        if (!xAxisGroup) {
          setTimeout(checkTimeline, 100);
          return;
        }

        // Check if axis has ticks (indicating it's fully drawn)
        const ticks = xAxisGroup.querySelectorAll('.tick');
        if (ticks.length === 0) {
          setTimeout(checkTimeline, 100);
          return;
        }

        // Timeline is drawn, wait for paint to ensure it's visible
        waitForPaint(2).then(resolve);
      } catch (error) {
        reject(error);
      }
    };

    // Start checking after initial delay
    setTimeout(checkTimeline, 100);
  });
}

/**
 * Comprehensive wait for map rendering to complete
 * Waits for:
 * 1. Mapbox map to be loaded and styled
 * 2. Map container to have dimensions
 * 3. Timeline to be drawn (if checkTimeline is true)
 * 4. Browser to paint the content
 * 
 * @param map - Mapbox map instance
 * @param mapContainer - Map container element
 * @param options - Options for what to wait for
 * @returns Promise that resolves when all rendering is complete
 */
export async function waitForMapRenderComplete(
  map: any,
  mapContainer: HTMLElement | null,
  options: {
    checkTimeline?: boolean;
    timelineSelector?: string;
    timeout?: number;
  } = {}
): Promise<void> {
  const {
    checkTimeline = true,
    timelineSelector = '.map-container .chart-container',
    timeout = 10000
  } = options;

  try {
    // Wait for Mapbox to be loaded and styled
    await waitForMapboxRender(map, timeout);
    
    // Wait for map container to have dimensions
    if (mapContainer) {
      await waitForElementDimensions(mapContainer, timeout);
    }
    
    // Wait for timeline to be drawn (if requested)
    if (checkTimeline) {
      try {
        await waitForTimelineDraw(timelineSelector, timeout);
      } catch (error) {
        // Timeline might not be present in all map views, so we don't fail completely
        warn('Timeline check failed (may not be present):', error);
      }
    }
    
    // Final wait for paint to ensure everything is visible
    await waitForPaint(2);
  } catch (error) {
    warn('Error waiting for map render complete:', error);
    // Don't throw - we still want to hide loading even if checks fail
  }
}
