/**
 * Overlay System Types
 * 
 * Defines the interface for map overlay components that can be dynamically loaded and toggled.
 */

import { Accessor } from "solid-js";
import * as d3 from "d3";

export interface TrackPoint {
  Datetime: string;
  Lng: number;
  Lat: number;
  TWD?: number;
  TWS?: number;
  HDG?: number;
  BS?: number;
  [key: string]: any; // Allow additional properties
}

/**
 * Props that all overlay components receive
 */
export interface BaseOverlayProps {
  /** Mapbox map instance */
  map: any;
  /** Map container DOM element */
  mapContainer: HTMLElement | null;
  /** SVG overlay element (created and managed by overlay system) */
  svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, any> | null;
  /** Track data points */
  data: TrackPoint[];
  /** Whether the overlay is enabled/visible */
  enabled: boolean;
  /** Whether we're in live mode (affects time-based calculations) */
  liveMode?: boolean;
  /** Container dimensions */
  width: number;
  height: number;
  /** When provided (time-window playback), use this instead of selectedTime so overlays end at boat position */
  effectivePlaybackTime?: Date | null;
  /** Samples per second (e.g. 1 = 1Hz). Used e.g. for bad air "one step back" offset. */
  samplingFrequency?: number;
}

/**
 * Overlay component type
 * Can be a SolidJS component or a function that sets up effects
 */
export type OverlayComponent = (props: BaseOverlayProps) => JSX.Element | void;

/**
 * Overlay metadata for registration
 */
export interface OverlayMetadata {
  /** Unique key for the overlay */
  key: string;
  /** Display name */
  label: string;
  /** Component loader (for lazy loading) */
  loader: () => Promise<{ default: OverlayComponent }>;
  /** Default enabled state */
  defaultEnabled?: boolean;
}

/**
 * Overlay registry entry
 */
export interface OverlayRegistryEntry extends OverlayMetadata {
  /** Loaded component */
  component: OverlayComponent | null;
  /** Whether component is loaded */
  loaded: boolean;
  /** Whether overlay is currently enabled */
  enabled: boolean;
}

