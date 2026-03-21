// D3 Cleanup Utility for SolidJS Components
import { onCleanup } from 'solid-js';
import * as d3 from 'd3';
import { warn } from './console';

// Type definitions
type D3Selection = d3.Selection<any, any, any, any>;
type D3Behavior = d3.ZoomBehavior<any, any> | d3.BrushBehavior<any> | d3.DragBehavior<any, any, any>;
type EventHandler = (event: any, ...args: any[]) => void;
type ResizeCallback = (entries: ResizeObserverEntry[]) => void;

interface EventListener {
  element: D3Selection;
  event: string;
  handler: EventHandler;
}

interface D3BehaviorOptions {
  scaleExtent?: [number, number];
  extent?: [[number, number], [number, number]];
  onZoom?: EventHandler;
  onBrush?: EventHandler;
  onStart?: EventHandler;
  onDrag?: EventHandler;
  onEnd?: EventHandler;
}

type TimerHandle = ReturnType<typeof setInterval>;

interface D3CleanupHook {
  addSelection: (selection: D3Selection) => void;
  addEventListener: (element: D3Selection, event: string, handler: EventHandler) => void;
  addTimer: (timer: TimerHandle) => void;
  addObserver: (observer: ResizeObserver) => void;
  cleanup: () => void;
}

interface ChartCleanupHook extends D3CleanupHook {
  addZoomBehavior: (element: D3Selection, zoomBehavior: d3.ZoomBehavior<any, any>) => void;
  addBrushBehavior: (element: D3Selection, brushBehavior: d3.BrushBehavior<any>) => void;
  addTooltip: (tooltipElement: D3Selection) => void;
  addContinuousUpdate: (updateFunction: () => void, interval: number) => TimerHandle;
  addResizeObserver: (element: Element, callback: ResizeCallback) => ResizeObserver | undefined;
}

/**
 * Hook for managing D3 cleanup in SolidJS components
 * Automatically cleans up D3 selections, event listeners, and timers on component unmount
 */
export function useD3Cleanup(): D3CleanupHook {
  const d3Selections: D3Selection[] = [];
  const eventListeners: EventListener[] = [];
  const timers: TimerHandle[] = [];
  const observers: ResizeObserver[] = [];

  const addSelection = (selection: D3Selection): void => {
    if (selection) {
      d3Selections.push(selection);
    }
  };

  const addEventListener = (element: D3Selection, event: string, handler: EventHandler): void => {
    if (element && element.on) {
      eventListeners.push({ element, event, handler });
    }
  };

  const addTimer = (timer: TimerHandle): void => {
    if (timer) {
      timers.push(timer);
    }
  };

  const addObserver = (observer: ResizeObserver): void => {
    if (observer) {
      observers.push(observer);
    }
  };

  const cleanup = (): void => {
    // Clean up D3 selections
    d3Selections.forEach(selection => {
      try {
        if (selection && typeof selection.remove === 'function') {
          selection.remove();
        } else if (selection && selection.node && selection.node()) {
          // For D3 selections that might not have remove method
          d3.select(selection.node()).selectAll('*').remove();
        }
      } catch (error) {
        warn('Error cleaning up D3 selection:', error);
      }
    });
    d3Selections.length = 0;

    // Remove event listeners
    eventListeners.forEach(({ element, event, handler }) => {
      try {
        if (element && element.on) {
          element.on(event, null);
        }
      } catch (error) {
        warn('Error removing event listener:', error);
      }
    });
    eventListeners.length = 0;

    // Clear timers
    timers.forEach(timer => {
      try {
        if (timer) {
          clearInterval(timer);
        }
      } catch (error) {
        warn('Error clearing timer:', error);
      }
    });
    timers.length = 0;

    // Disconnect observers
    observers.forEach(observer => {
      try {
        if (observer && observer.disconnect) {
          observer.disconnect();
        }
      } catch (error) {
        warn('Error disconnecting observer:', error);
      }
    });
    observers.length = 0;
  };

  // Automatically cleanup on component unmount
  onCleanup(cleanup);

  return { 
    addSelection, 
    addEventListener, 
    addTimer, 
    addObserver, 
    cleanup 
  };
}

/**
 * Enhanced D3 cleanup for chart components with specific patterns
 */
export function useChartCleanup(): ChartCleanupHook {
  const { addSelection, addEventListener, addTimer, addObserver, cleanup } = useD3Cleanup();

  const addZoomBehavior = (element: D3Selection, zoomBehavior: d3.ZoomBehavior<any, any>): void => {
    if (element && zoomBehavior) {
      addEventListener(element, 'zoom', zoomBehavior);
    }
  };

  const addBrushBehavior = (element: D3Selection, brushBehavior: d3.BrushBehavior<any>): void => {
    if (element && brushBehavior) {
      addEventListener(element, 'brush', brushBehavior);
    }
  };

  const addTooltip = (tooltipElement: D3Selection): void => {
    if (tooltipElement) {
      addSelection(tooltipElement);
    }
  };

  const addContinuousUpdate = (updateFunction: () => void, interval: number): TimerHandle => {
    const timer = setInterval(updateFunction, interval);
    addTimer(timer);
    return timer;
  };

  const addResizeObserver = (element: Element, callback: ResizeCallback): ResizeObserver | undefined => {
    if (element && window.ResizeObserver) {
      const observer = new ResizeObserver(callback);
      observer.observe(element);
      addObserver(observer);
      return observer;
    }
    return undefined;
  };

  return {
    addSelection,
    addEventListener,
    addTimer,
    addObserver,
    addZoomBehavior,
    addBrushBehavior,
    addTooltip,
    addContinuousUpdate,
    addResizeObserver,
    cleanup
  };
}

/**
 * Utility to safely create D3 selections with automatic cleanup
 */
export function createD3Selection(container: Element | d3.Selection<any, any, any, any>, selector?: string | null): D3Selection {
  const selection = selector ? d3.select(container as Element).select(selector) : d3.select(container as Element);
  return selection;
}

/**
 * Utility to safely add event listeners with cleanup
 */
export function addD3EventListener(selection: D3Selection, event: string, handler: EventHandler): () => void {
  if (selection && selection.on) {
    selection.on(event, handler);
    return () => selection.on(event, null);
  }
  return () => {};
}

/**
 * Utility to create and manage D3 behaviors with cleanup
 */
export function createD3Behavior(type: 'zoom' | 'brush' | 'drag', options: D3BehaviorOptions = {}): D3Behavior {
  let behavior: D3Behavior;
  
  switch (type) {
    case 'zoom':
      behavior = d3.zoom()
        .scaleExtent(options.scaleExtent || [0.5, 4])
        .on('zoom', options.onZoom || (() => {})) as d3.ZoomBehavior<any, any>;
      break;
    case 'brush':
      behavior = d3.brush()
        .extent(options.extent || [[0, 0], [800, 600]])
        .on('brush', options.onBrush || (() => {})) as d3.BrushBehavior<any>;
      break;
    case 'drag':
      behavior = d3.drag()
        .on('start', options.onStart || (() => {}))
        .on('drag', options.onDrag || (() => {}))
        .on('end', options.onEnd || (() => {})) as d3.DragBehavior<any, any, any>;
      break;
    default:
      throw new Error(`Unknown D3 behavior type: ${type}`);
  }
  
  return behavior;
}
