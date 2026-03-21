/**
 * Overlay Registry
 * 
 * Central registry for managing map overlays with lazy loading support.
 */

import { OverlayMetadata, OverlayRegistryEntry, OverlayComponent } from "./types";

class OverlayRegistry {
  private overlays: Map<string, OverlayRegistryEntry> = new Map();

  /**
   * Register an overlay
   */
  register(metadata: OverlayMetadata): void {
    this.overlays.set(metadata.key, {
      ...metadata,
      component: null,
      loaded: false,
      enabled: metadata.defaultEnabled ?? false
    });
  }

  /**
   * Get all registered overlays
   */
  getAll(): OverlayRegistryEntry[] {
    return Array.from(this.overlays.values());
  }

  /**
   * Get overlay metadata by key
   */
  get(key: string): OverlayRegistryEntry | undefined {
    return this.overlays.get(key);
  }

  /**
   * Check if overlay is registered
   */
  has(key: string): boolean {
    return this.overlays.has(key);
  }

  /**
   * Load an overlay component (lazy load)
   */
  async load(key: string): Promise<OverlayComponent | null> {
    const overlay = this.overlays.get(key);
    if (!overlay) {
      // Overlay not found - return null silently
      return null;
    }

    if (overlay.loaded && overlay.component) {
      return overlay.component;
    }

    try {
      const module = await overlay.loader();
      overlay.component = module.default;
      overlay.loaded = true;
      return overlay.component;
    } catch (error) {
      // Error loading overlay - handled by caller
      return null;
    }
  }

  /**
   * Set enabled state for an overlay
   */
  setEnabled(key: string, enabled: boolean): void {
    const overlay = this.overlays.get(key);
    if (overlay) {
      overlay.enabled = enabled;
    }
  }

  /**
   * Get enabled state for an overlay
   */
  isEnabled(key: string): boolean {
    const overlay = this.overlays.get(key);
    return overlay?.enabled ?? false;
  }

  /**
   * Check if overlay is loaded
   */
  isLoaded(key: string): boolean {
    const overlay = this.overlays.get(key);
    return overlay?.loaded ?? false;
  }
}

// Singleton instance
export const overlayRegistry = new OverlayRegistry();

