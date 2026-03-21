/**
 * Channel Discovery Worker
 * 
 * Handles channel discovery API calls in the background to avoid blocking the UI.
 * The worker makes the API call and returns the channels, while caching is handled
 * in the main thread.
 */

import type { WorkerMessage, WorkerResponse } from './types';
import { debug, error as logError } from '../utils/console';

interface ChannelDiscoveryConfig {
  url: string;
  className?: string;
  projectId?: string;
  date: string;
  sourceName: string;
  dataSource: 'FILE' | 'INFLUX';
  authToken?: string;
}

interface ChannelDiscoveryResult {
  channels: string[];
}

// Worker message handler
self.onmessage = async function(e: MessageEvent<WorkerMessage<ChannelDiscoveryConfig, never>>) {
  const { id, type, data } = e.data;
  const startTime = Date.now();
  
  try {
    if (type !== 'discover-channels') {
      throw new Error(`Unknown task type: ${type}`);
    }

    const { url, authToken } = data;
    
    // Build headers with authentication
    const headers: HeadersInit = {
      'Content-Type': 'application/json'
    };
    
    // Include auth token in Authorization header if provided
    // This is more reliable than cookies in worker context
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    // Make the API call in the worker (non-blocking for UI)
    // Include credentials to send cookies as fallback, but prefer Authorization header
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers
    });
    
    if (!response.ok) {
      // Handle 404 gracefully - "Source not found" means no channels available, not an error
      if (response.status === 404) {
        try {
          const errorResult = await response.json();
          // If it's a "Source not found" or "Date not found" message, return empty array
          if (errorResult.message && (
            errorResult.message.includes('Source not found') ||
            errorResult.message.includes('Date not found') ||
            errorResult.message.includes('No files found')
          )) {
            // Source/date doesn't exist - return empty channels array (not an error)
            const workerResponse: WorkerResponse<ChannelDiscoveryResult> = {
              id,
              type: 'success',
              result: { channels: [] },
              duration: Date.now() - startTime
            };
            self.postMessage(workerResponse);
            return;
          }
        } catch (e) {
          // If we can't parse the response, still treat 404 as "no channels"
          const workerResponse: WorkerResponse<ChannelDiscoveryResult> = {
            id,
            type: 'success',
            result: { channels: [] },
            duration: Date.now() - startTime
          };
          self.postMessage(workerResponse);
          return;
        }
      }
      
      // For other errors, throw as before
      // Try to extract error message from response body
      let errorMessage = `HTTP error! status: ${response.status}`;
      try {
        const errorResult = await response.json();
        if (errorResult.message) {
          errorMessage = `${errorMessage}: ${errorResult.message}`;
        } else if (errorResult.error) {
          errorMessage = `${errorMessage}: ${errorResult.error}`;
        }
      } catch (e) {
        // If response is not JSON, try to get text
        try {
          const errorText = await response.text();
          if (errorText) {
            errorMessage = `${errorMessage}: ${errorText.substring(0, 200)}`;
          }
        } catch (textError) {
          // Ignore if we can't read the response
        }
      }
      throw new Error(errorMessage);
    }
    
    const result = await response.json();
    
    // Debug: Log the response to see what we're getting
    debug('[ChannelDiscovery Worker] API response:', {
      success: result.success,
      hasData: !!result.data,
      dataType: Array.isArray(result.data) ? 'array' : typeof result.data,
      dataLength: Array.isArray(result.data) ? result.data.length : 'N/A',
      message: result.message,
      sampleData: Array.isArray(result.data) ? result.data.slice(0, 5) : result.data
    });
    
    let channels: string[] = [];
    if (result.success && Array.isArray(result.data)) {
      channels = result.data;
      debug('[ChannelDiscovery Worker] Extracted ' + channels.length + ' channels from API response');
    } else {
      logError('[ChannelDiscovery Worker] Invalid response format:', {
        success: result.success,
        dataType: typeof result.data,
        isArray: Array.isArray(result.data),
        result: result
      });
      throw new Error('Invalid response format from channels API');
    }
    
    // Send result back to main thread
    const workerResponse: WorkerResponse<ChannelDiscoveryResult> = {
      id,
      type: 'success',
      result: { channels },
      duration: Date.now() - startTime
    };
    
    self.postMessage(workerResponse);
    
  } catch (error) {
    // Send error back to main thread with more details
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    const workerResponse: WorkerResponse = {
      id,
      type: 'error',
      error: `${errorName}: ${errorMessage}`,
      duration: Date.now() - startTime
    };
    
    // Include additional error context if available
    if (errorStack) {
      (workerResponse as any).errorStack = errorStack;
    }
    if (data?.dataSource) {
      (workerResponse as any).dataSource = data.dataSource;
    }
    if (data?.url) {
      (workerResponse as any).url = data.url;
    }
    
    self.postMessage(workerResponse);
  }
};
