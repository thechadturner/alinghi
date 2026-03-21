/**
 * Overlay Manager Component
 * 
 * Manages rendering of all registered overlays with lazy loading support.
 */

import { createEffect, onMount, onCleanup, Show, createSignal, createMemo } from "solid-js";
import * as d3 from "d3";
import { overlayRegistry } from "./registry";
import { BaseOverlayProps } from "./types";
import { debug, warn as logWarn, error as logError } from "../../../../utils/console";

export interface OverlayManagerProps {
  map: any;
  mapContainer: HTMLElement | null;
  data: BaseOverlayProps['data'];
  liveMode?: boolean;
  width: number;
  height: number;
  /** Optional external enabled state getters/setters - keyed by overlay key */
  enabledStates?: Record<string, { get: () => boolean; set: (v: boolean) => void }>;
  /** When provided (time-window playback), use for overlays so they end at boat position */
  effectivePlaybackTime?: Date | null;
  /** Samples per second for playback step (e.g. 1 = 1Hz). Used for bad air offset. */
  samplingFrequency?: number;
}

export default function OverlayManager(props: OverlayManagerProps) {
  let svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, any> | null = null;
  let overlayGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any> | null = null;
  const loadedComponents = new Map<string, any>();

  /**
   * Initialize SVG overlay layer
   */
  const initSVG = () => {
    if (!props.mapContainer || svg) {
      return;
    }

    // Try to find canvas container first
    let container = props.mapContainer.querySelector(".mapboxgl-canvas-container") as HTMLElement;
    
    // Fallback to .map container if canvas container not found
    if (!container) {
      container = props.mapContainer.querySelector(".map") as HTMLElement || props.mapContainer;
    }

    if (!container) {
      return;
    }

    // Check if overlay SVG already exists
    const existingSvg = d3.select(container).select<SVGSVGElement>("svg.map-overlays");
    
    if (!existingSvg.empty()) {
      svg = existingSvg;
      overlayGroup = svg.select<SVGGElement>("g.overlays");
      if (!overlayGroup || overlayGroup.empty()) {
        overlayGroup = svg.append<SVGGElement>("g").attr("class", "overlays");
      }
      return;
    }

    // Create new SVG overlay
    const mapRect = container.getBoundingClientRect();
    const width = mapRect.width || props.width;
    const height = mapRect.height || props.height;

    svg = d3
      .select(container)
      .append<SVGSVGElement>("svg")
      .attr("class", "map-overlays")
      .attr("width", width)
      .attr("height", height)
      .style("position", "absolute")
      .style("top", "0")
      .style("left", "0")
      .style("width", "100%")
      .style("height", "100%")
      .style("z-index", "40") // Below race course (marks & boundaries, z-index 50) so they stay on top
      .style("pointer-events", "none");

    overlayGroup = svg.append<SVGGElement>("g").attr("class", "overlays");

    debug("OverlayManager: SVG initialized", { width, height });
  };

  /**
   * Update SVG dimensions
   */
  const updateDimensions = () => {
    if (!svg || !props.mapContainer) return;

    const container = props.mapContainer.querySelector(".mapboxgl-canvas-container");
    if (!container) return;

    const width = (container as HTMLElement).offsetWidth || props.width;
    const height = (container as HTMLElement).offsetHeight || props.height;

    svg
      .attr("width", width)
      .attr("height", height);
  };

  /**
   * Load and render an overlay
   */
  const renderOverlay = async (key: string, enabled: boolean) => {
    const overlay = overlayRegistry.get(key);
    if (!overlay) {
      return;
    }

    // Remove overlay if disabled
    if (!enabled) {
      if (overlayGroup) {
        overlayGroup.select(`.overlay-${key}`).remove();
      }
      return;
    }

    // Load component if not already loaded
    if (!overlay.loaded) {
      debug(`OverlayManager: Loading overlay: ${key}`);
      const component = await overlayRegistry.load(key);
      if (!component) {
        logError(`OverlayManager: Failed to load overlay: ${key}`);
        return;
      }
    }

    // Get the component
    const component = overlay.component;
    if (!component) {
      return;
    }

    // Ensure overlayGroup is initialized before proceeding
    // If not ready, queue the render for when SVG is initialized
    if (!overlayGroup) {
      debug(`OverlayManager: overlayGroup not initialized, queuing overlay: ${key}`);
      // Queue the render - it will be picked up when SVG is ready
      // The effect at line 260 will trigger renderAllOverlays when SVG becomes available
      return;
    }

    // Create overlay props
    // Pass the SVG element (not the group) so overlays can append their own groups
    // Only pass SVG if it's actually initialized and in the DOM
    const overlayProps: BaseOverlayProps = {
      map: props.map,
      mapContainer: props.mapContainer,
      svg: svg && svg.node() && svg.node()?.parentNode ? svg : null, // Only pass if SVG is ready
      data: props.data,
      liveMode: props.liveMode || false,
      enabled: enabled,
      width: props.width,
      height: props.height,
      effectivePlaybackTime: props.effectivePlaybackTime ?? undefined,
      samplingFrequency: props.samplingFrequency ?? undefined
    };

    // Create a group for this overlay
    let overlayElementGroup = overlayGroup.select(`.overlay-${key}`);
    if (!overlayElementGroup || overlayElementGroup.empty()) {
      overlayElementGroup = overlayGroup
        .append<SVGGElement>("g")
        .attr("class", `overlay overlay-${key}`);
    }

    // Render overlay
    // Note: SolidJS components must be rendered in JSX, not called directly
    // Store props for JSX rendering
    loadedComponents.set(key, { component, props: overlayProps });
  };

  /**
   * Render all enabled overlays
   */
  const renderAllOverlays = async () => {
    if (!overlayGroup || !props.map) {
      return;
    }

    const overlays = overlayRegistry.getAll();
    
    for (const overlay of overlays) {
      // Check if external enabled state is provided, otherwise use registry
      let enabled = overlay.enabled;
      if (props.enabledStates && props.enabledStates[overlay.key]) {
        enabled = props.enabledStates[overlay.key].get();
        // Sync with registry
        overlayRegistry.setEnabled(overlay.key, enabled);
      }
      
      await renderOverlay(overlay.key, enabled);
    }
  };

  // Sync external enabled states with registry and update local state
  createEffect(() => {
    if (props.enabledStates) {
      const newStates: Record<string, boolean> = {};
      Object.keys(props.enabledStates).forEach(key => {
        const state = props.enabledStates![key];
        if (overlayRegistry.has(key)) {
          const enabled = state.get();
          overlayRegistry.setEnabled(key, enabled);
          newStates[key] = enabled;
          
          // If enabling an overlay for the first time, ensure it gets loaded and rendered
          if (enabled && !loadedComponents.has(key)) {
            // Component needs to be loaded
            renderOverlay(key, enabled);
          }
        }
      });
      // Update all registered overlays
      overlayRegistry.getAll().forEach(overlay => {
        if (!(overlay.key in newStates)) {
          newStates[overlay.key] = overlay.enabled;
        }
      });
      setOverlayStates(newStates);
      // Trigger overlay rendering when states change
      // Only render if SVG is ready
      if (svg && svg.node() && overlayGroup) {
        renderAllOverlays();
      }
    } else {
      // Fallback to registry states
      const states: Record<string, boolean> = {};
      overlayRegistry.getAll().forEach(overlay => {
        states[overlay.key] = overlay.enabled;
      });
      setOverlayStates(states);
    }
  });

  // Initialize SVG on mount
  onMount(() => {
    // Wait a bit for map to be fully initialized
    setTimeout(() => {
      initSVG();
      updateDimensions();
      // After SVG is initialized, render all overlays
      // This ensures overlays that were enabled from localStorage get rendered
      // Add a small delay to ensure overlayGroup is ready
      setTimeout(() => {
        if (overlayGroup) {
          renderAllOverlays();
        }
      }, 100);
    }, 500);

    // Handle map resize
    if (props.map) {
      props.map.on("resize", updateDimensions);
      props.map.on("moveend", () => {
        // Small delay to ensure dimensions are updated
        setTimeout(updateDimensions, 100);
      });
    }
  });

  // Watch for SVG initialization and trigger overlay rendering
  // Also update loadedComponents props when SVG becomes available
  createEffect(() => {
    // When SVG becomes available and we have enabled overlays, update props and render
    if (svg && svg.node() && svg.node()?.parentNode && overlayGroup && props.enabledStates) {
      // Update props in loadedComponents to include the now-available SVG
      loadedComponents.forEach((entry, key) => {
        const state = props.enabledStates![key];
        const isEnabled = state && state.get && state.get();
        if (isEnabled) {
          // Update props with current SVG
          entry.props.svg = svg;
          entry.props.map = props.map;
          entry.props.mapContainer = props.mapContainer;
          entry.props.data = props.data;
          entry.props.liveMode = props.liveMode || false;
          entry.props.enabled = isEnabled;
          entry.props.width = props.width;
          entry.props.height = props.height;
        }
      });
      
      // Check if any overlay is enabled
      const hasEnabledOverlay = Object.keys(props.enabledStates).some(key => {
        const state = props.enabledStates![key];
        return state && state.get && state.get();
      });
      
      if (hasEnabledOverlay) {
        // Trigger re-render by updating overlayStates
        const states = overlayStates();
        setOverlayStates({ ...states });
      }
    }
  });

  // Update overlays when data changes
  createEffect(() => {
    if (props.data.length > 0 && overlayGroup && props.map) {
      renderAllOverlays();
    }
  });

  // Track overlay enabled states to trigger re-renders
  const [overlayStates, setOverlayStates] = createSignal<Record<string, boolean>>({});
  
  // Track which overlays should be rendered as JSX (reactive)
  // This memo reactively updates when SVG, data, or enabled states change
  const activeOverlays = createMemo(() => {
    const overlays: Array<{ key: string; component: any; props: BaseOverlayProps }> = [];
    const states = overlayStates();
    
    // Access svg and overlayGroup to make this reactive to their changes
    const currentSvg = svg;
    const currentOverlayGroup = overlayGroup;
    
    // Explicitly access props so overlays react to data, effectivePlaybackTime (animation), etc.
    const dataLength = (props.data || []).length;
    const effectiveTime = props.effectivePlaybackTime;
    const samplingFreq = props.samplingFrequency;
    void dataLength;
    void effectiveTime;
    void samplingFreq;

    loadedComponents.forEach((entry, key) => {
      const overlay = overlayRegistry.get(key);
      const isEnabled = states[key] ?? overlay?.enabled ?? false;
      if (isEnabled && entry.component) {
        const currentProps: BaseOverlayProps = {
          ...entry.props,
          map: props.map,
          mapContainer: props.mapContainer,
          svg: currentSvg && currentSvg.node() && currentSvg.node()?.parentNode ? currentSvg : null,
          data: props.data,
          liveMode: props.liveMode || false,
          enabled: isEnabled,
          width: props.width,
          height: props.height,
          effectivePlaybackTime: props.effectivePlaybackTime ?? undefined,
          samplingFrequency: props.samplingFrequency ?? undefined
        };
        overlays.push({ key, component: entry.component, props: currentProps });
      }
    });
    return overlays;
  });

  // Update SVG dimensions when props change
  createEffect(() => {
    updateDimensions();
  });

  // Cleanup
  onCleanup(() => {
    if (props.map) {
      props.map.off("resize", updateDimensions);
      props.map.off("moveend", updateDimensions);
    }
    
    if (svg) {
      svg.remove();
      svg = null;
    }
    
    loadedComponents.clear();
  });

  // Render active overlays as JSX components
  // We need to render them in JSX so SolidJS effects work properly
  return (
    <>
      {activeOverlays().map(({ key, component: Component, props }) => (
        <Component key={key} {...props} />
      ))}
    </>
  );
}

