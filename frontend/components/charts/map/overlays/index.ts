/**
 * Overlay System Entry Point
 * 
 * Exports overlay registry and initialization function.
 */

import { overlayRegistry } from "./registry";
import type { OverlayMetadata } from "./types";
import { debug } from "../../../../utils/console";

export function initializeOverlays() {
  // Register BadAirOverlay with lazy loading
  overlayRegistry.register({
    key: "bad-air",
    label: "Bad Air",
    loader: () => import("./BadAirOverlay"),
    defaultEnabled: false
  });

  overlayRegistry.register({
    key: "mark-wind",
    label: "Mark Wind",
    loader: () => import("./MarkWindOverlay"),
    defaultEnabled: false
  });

  debug("initializeOverlays: Registered overlays", overlayRegistry.getAll().map(o => o.key));
}

/**
 * Get overlay registry for external use
 */
export { overlayRegistry };

/**
 * Export types
 */
export type { OverlayMetadata, BaseOverlayProps } from "./types";

