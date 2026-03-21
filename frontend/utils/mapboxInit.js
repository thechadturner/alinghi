/**
 * Mapbox GL JS initialization
 * 
 * This module ensures the Mapbox access token is set as early as possible,
 * before any mapbox-gl imports happen. This prevents issues with frozen objects.
 */

import { config } from '@config/env';

// Set token immediately when this module loads
// This will run before any dynamic imports of mapbox-gl
if (typeof window !== 'undefined' && config.MAPBOX_TOKEN) {
  // Try to set token on window.mapboxgl if it exists (from static imports)
  if (window.mapboxgl) {
    try {
      window.mapboxgl.accessToken = config.MAPBOX_TOKEN;
    } catch (e) {
      // Ignore if frozen
    }
  }
  
  // Also try to pre-import and set token
  // This ensures the token is set before the module is frozen
  import('mapbox-gl').then((mapboxModule) => {
    const mapboxgl = mapboxModule.default || mapboxModule;
    if (mapboxgl && !mapboxgl.accessToken && config.MAPBOX_TOKEN) {
      try {
        mapboxgl.accessToken = config.MAPBOX_TOKEN;
      } catch (e) {
        // Object might be frozen, but we tried
      }
    }
  }).catch(() => {
    // Ignore import errors - module will be imported later
  });
}

export default {};

