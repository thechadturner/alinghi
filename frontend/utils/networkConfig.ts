/**
 * Network Configuration Utility
 * 
 * This utility provides bulletproof network configuration that adapts to different
 * environments, computers, and networks automatically.
 */

import { config } from '../config/env.js';
import { warn } from '../utils/console';

/**
 * Network configuration modes
 */
export const NETWORK_MODES = {
  AUTO: 'auto',           // Automatically detect the best configuration
  LOCALHOST: 'localhost', // Force localhost (development)
  NETWORK: 'network',     // Force network IP
  CUSTOM: 'custom'        // Use custom host from env
} as const;

export type NetworkMode = typeof NETWORK_MODES[keyof typeof NETWORK_MODES];

/**
 * Network configuration interface
 */
export interface NetworkConfig {
  apiHost: string;
  mediaHost: string;
  fileHost: string;
  adminHost: string;
  pythonHost: string;
  mode: NetworkMode;
  isLocal: boolean;
}

/**
 * Media server connectivity test result
 */
export interface ConnectivityResult {
  success: boolean;
  host: string;
  error?: string;
  data?: any;
}

/**
 * Get the current network configuration
 */
export function getNetworkConfig(): NetworkConfig {
  const mode = (import.meta.env.VITE_NETWORK_MODE as NetworkMode) || NETWORK_MODES.AUTO;
  const customHost = import.meta.env.VITE_CUSTOM_HOST as string;
  
  // Debug logging removed for production
  
  switch (mode) {
    case NETWORK_MODES.LOCALHOST:
      return getLocalhostConfig();
    
    case NETWORK_MODES.NETWORK:
      return getNetworkModeConfig();
    
    case NETWORK_MODES.CUSTOM:
      return getCustomConfig(customHost);
    
    case NETWORK_MODES.AUTO:
    default:
      return getAutoConfig();
  }
}

/**
 * Get localhost configuration (development mode)
 */
function getLocalhostConfig(): NetworkConfig {
  return {
    apiHost: 'localhost',
    mediaHost: 'localhost',
    fileHost: 'localhost',
    adminHost: 'localhost',
    pythonHost: 'localhost',
    mode: NETWORK_MODES.LOCALHOST,
    isLocal: true
  };
}

/**
 * Get network configuration (production/network mode)
 */
function getNetworkModeConfig(): NetworkConfig {
  const currentHost = window.location.hostname;
  return {
    apiHost: currentHost,
    mediaHost: currentHost,
    fileHost: currentHost,
    adminHost: currentHost,
    pythonHost: currentHost,
    mode: NETWORK_MODES.NETWORK,
    isLocal: false
  };
}

/**
 * Get custom configuration from environment
 */
function getCustomConfig(customHost: string): NetworkConfig {
  if (!customHost) {
    warn('🌐 NetworkConfig: Custom host not specified, falling back to auto');
    return getAutoConfig();
  }
  
  return {
    apiHost: customHost,
    mediaHost: customHost,
    fileHost: customHost,
    adminHost: customHost,
    pythonHost: customHost,
    mode: NETWORK_MODES.CUSTOM,
    isLocal: customHost === 'localhost' || customHost === '127.0.0.1'
  };
}

/**
 * Auto-detect the best configuration
 */
function getAutoConfig(): NetworkConfig {
  const currentHost = window.location.hostname;
  const isLocal = currentHost === 'localhost' || currentHost === '127.0.0.1';
  
  // Debug logging removed for production
  
  // If we're on localhost, use localhost for all services
  if (isLocal) {
    return getLocalhostConfig();
  }
  
  // If we're on a network IP, use the current host
  return getNetworkModeConfig();
}

/**
 * Get the media server URL with proper host configuration
 */
export function getMediaUrl(fileName: string, quality: string = 'high_res'): string | null {
  if (!fileName) {
    // Debug logging removed for production
    return null;
  }
  
  let url = fileName;
  
  // If {res} placeholder exists, replace it with the specified quality
  if (url.includes('{res}')) {
    url = url.replace('{res}', quality);
  } else {
    // If {res} placeholder is missing (old database records), replace existing quality folders
    // This handles cases where database has low_res/med_res/high_res hardcoded
    url = url.replace(/[\/\\](low_res|med_res|high_res)[\/\\]/g, `/${quality}/`);
  }
  
  // Always use relative URL - nginx handles routing
  const mediaUrl = `/api/media/video?path=${encodeURIComponent(url)}`;
  return mediaUrl;
}

/**
 * Get alternative media URLs for fallback
 */
export function getAlternativeMediaUrls(fileName: string, quality: string = 'high_res'): string[] {
  if (!fileName) return [];
  
  let url = fileName;
  
  // If {res} placeholder exists, replace it with the specified quality
  if (url.includes('{res}')) {
    url = url.replace('{res}', quality);
  } else {
    // If {res} placeholder is missing (old database records), replace existing quality folders
    // This handles cases where database has low_res/med_res/high_res hardcoded
    url = url.replace(/[\/\\](low_res|med_res|high_res)[\/\\]/g, `/${quality}/`);
  }
  
  // Always use relative URLs - nginx handles routing
  return [`/api/media/video?path=${encodeURIComponent(url)}`];
}

/**
 * Test media server connectivity
 */
export async function testMediaServerConnectivity(): Promise<ConnectivityResult> {
  const networkConfig = getNetworkConfig();
  
  // Always use relative URL - nginx handles routing
  const healthUrl = '/api/media/health';
  
  try {
    // Debug logging removed for production
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
    
    const response = await fetch(healthUrl, {
      method: 'GET',
      credentials: 'include',
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const data = await response.json();
      // Debug logging removed for production
      return { success: true, host: networkConfig.mediaHost, data };
    } else {
      warn('🌐 NetworkConfig: Media server health check failed', { 
        status: response.status, 
        host: networkConfig.mediaHost 
      });
      return { success: false, host: networkConfig.mediaHost, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    error('🌐 NetworkConfig: Media server connectivity test failed', { 
      error: errorMessage, 
      host: networkConfig.mediaHost 
    });
    return { success: false, host: networkConfig.mediaHost, error: errorMessage };
  }
}

/**
 * Get the current network configuration as a string for debugging
 */
export function getNetworkConfigString(): string {
  const networkConfig = getNetworkConfig();
  return `Mode: ${networkConfig.mode}, Host: ${networkConfig.mediaHost}, Local: ${networkConfig.isLocal}`;
}

export default {
  getNetworkConfig,
  getMediaUrl,
  getAlternativeMediaUrls,
  testMediaServerConnectivity,
  getNetworkConfigString,
  NETWORK_MODES
};
