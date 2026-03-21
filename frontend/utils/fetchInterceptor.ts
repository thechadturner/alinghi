/**
 * Global Fetch Interceptor
 * Automatically includes CSRF tokens in all fetch requests
 */

import { getCookie } from './global';

// Store the original fetch function
const originalFetch = window.fetch;

// Override the global fetch function
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  // Parse the input to get the URL
  let url: string;
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else if (input instanceof Request) {
    url = input.url;
  } else {
    url = input.toString();
  }

  // Do not modify requests for WASM or SQLite assets - they must use default fetch behavior
  // or the SQLite WASM loader can fail with "Failed to fetch" (e.g. credentials or URL handling)
  const isWasmOrSqliteAsset =
    url.endsWith('.wasm') ||
    (url.includes('sqlite') && (url.includes('wasm') || url.includes('opfs') || url.includes('cgi')));

  // Check if this is a request to our API (not external)
  const isApiRequest =
    !isWasmOrSqliteAsset &&
    (url.startsWith('/api/') ||
      url.includes(window.location.origin) ||
      url.startsWith('http://localhost:') ||
      url.startsWith('https://localhost:'));

  if (isApiRequest) {
    // Get the method (default to GET)
    const method = (init?.method || 'GET').toUpperCase();
    
    // Only add CSRF token for unsafe methods
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrfToken = getCookie('csrf_token');
      
      if (csrfToken) {
        // Ensure headers object exists
        const headers = new Headers(init?.headers);
        headers.set('X-CSRF-Token', csrfToken);
        
        // Update the init object
        init = {
          ...init,
          headers,
          credentials: 'include' // Ensure cookies are sent
        };
      } else {
        // If no CSRF token, still ensure credentials are included
        init = {
          ...init,
          credentials: 'include'
        };
      }
    } else {
      // For safe methods, just ensure credentials are included
      init = {
        ...init,
        credentials: 'include'
      };
    }
  }

  // Call the original fetch with the modified init
  return originalFetch(input, init);
};

// Export the original fetch for cases where we need it
export { originalFetch as originalFetch };
