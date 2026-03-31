/**
 * JWT Authentication Manager
 * Handles JWT token management, refresh, and authenticated requests
 */

import { getCookie } from './global';
import { apiEndpoints } from '@config/env';
import { error as logError } from './console';
import { config } from '@config/env';

interface LoginResponse {
  success: boolean;
  data?: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: any;
  };
  message?: string;
}

interface RegisterResponse {
  success: boolean;
  message?: string;
}

interface UserResponse {
  success: boolean;
  data?: any;
  message?: string;
}

interface RefreshResponse {
  success: boolean;
  data?: {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  };
  message?: string;
}

interface UserData {
  email: string;
  password: string;
  [key: string]: any;
}

class AuthManager {
  private accessTokenKey: string;
  private refreshTokenKey: string;
  private tokenExpiresKey: string;
  private isRefreshing: boolean;
  private refreshPromise: Promise<boolean> | null;
  private refreshTimerId: number | null;
  private activityCheckIntervalId: number | null;
  private lastActivityTime: number;
  private isPageVisible: boolean;
  private activityListenersAttached: boolean;

  constructor() {
    this.accessTokenKey = 'access_token';
    this.refreshTokenKey = 'refresh_token';
    this.tokenExpiresKey = 'token_expires';
    this.isRefreshing = false;
    this.refreshPromise = null;
    this.refreshTimerId = null;
    this.activityCheckIntervalId = null;
    this.lastActivityTime = Date.now();
    // In non-browser environments (e.g. Web Workers, SSR), document is not available
    this.isPageVisible = typeof document !== 'undefined' ? !document.hidden : true;
    this.activityListenersAttached = false;
    
    // Initialize activity detection only when running in a browser environment
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
      this.initializeActivityDetection();
    }
  }

  /**
   * Get stored access token
   */
  getAccessToken(): string | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return localStorage.getItem(this.accessTokenKey);
  }

  /**
   * Get stored refresh token
   */
  getRefreshToken(): string | null {
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return localStorage.getItem(this.refreshTokenKey);
  }

  /**
   * Check if access token is expired
   */
  isTokenExpired(): boolean {
    if (typeof localStorage === 'undefined') {
      return true;
    }
    const expires = localStorage.getItem(this.tokenExpiresKey);
    if (!expires) return true;
    // Add small clock skew tolerance (60s)
    const skewMs = 60 * 1000;
    return Date.now() + skewMs > parseInt(expires);
  }

  /**
   * Determine if token is nearing expiry and should be proactively refreshed
   */
  private isTokenNearExpiry(): boolean {
    if (typeof localStorage === 'undefined') {
      return true;
    }
    const expires = localStorage.getItem(this.tokenExpiresKey);
    if (!expires) return true;
    // Refresh when less than 5 minutes remain
    const leewayMs = 5 * 60 * 1000;
    return Date.now() + leewayMs > parseInt(expires);
  }

  /**
   * Store JWT tokens
   */
  storeTokens(accessToken: string, refreshToken: string, expiresIn: number): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.setItem(this.accessTokenKey, accessToken);
    localStorage.setItem(this.refreshTokenKey, refreshToken);
    localStorage.setItem(this.tokenExpiresKey, (Date.now() + (expiresIn * 1000)).toString());
    // Schedule proactive refresh shortly before expiry
    this.scheduleRefresh(expiresIn);
  }

  /**
   * Clear all stored tokens
   */
  clearTokens(): void {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.removeItem(this.accessTokenKey);
    localStorage.removeItem(this.refreshTokenKey);
    localStorage.removeItem(this.tokenExpiresKey);
    if (this.refreshTimerId) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = null;
    }
    this.stopActivityCheck();
  }

  /**
   * Schedule a proactive token refresh before expiry
   */
  private scheduleRefresh(expiresInSeconds: number): void {
    try {
      if (this.refreshTimerId) {
        clearTimeout(this.refreshTimerId);
      }
      // Refresh 5 minutes before expiry, but not earlier than 30 seconds from now
      const refreshDelayMs = Math.max((expiresInSeconds * 1000) - (5 * 60 * 1000), 30 * 1000);
      this.refreshTimerId = window.setTimeout(async () => {
        try {
          await this.refreshToken();
        } catch (_) {
          // If refresh fails, keep existing token; next request will handle re-auth
        }
      }, refreshDelayMs);
    } catch (_) {
      // Ignore scheduling errors (non-browser env)
    }
  }

  /**
   * Initialize activity detection for automatic token renewal
   */
  private initializeActivityDetection(): void {
    // Only attach DOM event listeners in browser environments
    if (typeof document === 'undefined' || typeof window === 'undefined') {
      return;
    }

    if (this.activityListenersAttached) return;
    
    // Track page visibility
    const handleVisibilityChange = () => {
      this.isPageVisible = !document.hidden;
      if (this.isPageVisible && this.getRefreshToken()) {
        // Page became visible - start activity check if user is logged in
        this.startActivityCheck();
        // Check immediately if token needs refresh
        this.checkAndRefreshTokenIfNeeded();
      } else if (!this.isPageVisible) {
        // Page hidden - stop activity check to save resources
        this.stopActivityCheck();
      }
    };

    // Track user activity (mouse, keyboard, touch, scroll)
    const handleActivity = () => {
      this.lastActivityTime = Date.now();
      // If we're not checking yet and user is active, start checking
      if (this.isPageVisible && !this.activityCheckIntervalId && this.getRefreshToken()) {
        this.startActivityCheck();
      }
    };

    // Attach event listeners
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('mousemove', handleActivity, { passive: true });
    document.addEventListener('keydown', handleActivity, { passive: true });
    document.addEventListener('touchstart', handleActivity, { passive: true });
    document.addEventListener('click', handleActivity, { passive: true });
    document.addEventListener('scroll', handleActivity, { passive: true });
    
    // Also check on window focus
    window.addEventListener('focus', () => {
      this.isPageVisible = true;
      if (this.getRefreshToken()) {
        this.startActivityCheck();
        this.checkAndRefreshTokenIfNeeded();
      }
    });

    this.activityListenersAttached = true;
    
    // Start activity check if page is visible and user has tokens
    if (this.isPageVisible && this.getRefreshToken()) {
      this.startActivityCheck();
    }
  }

  /**
   * Start periodic activity check for token renewal
   */
  private startActivityCheck(): void {
    // Don't start if already running or no refresh token
    if (this.activityCheckIntervalId || !this.getRefreshToken()) {
      return;
    }

    // Check every 2 minutes if token needs refresh
    // This ensures we catch tokens that need renewal while user is active
    this.activityCheckIntervalId = window.setInterval(() => {
      // Only check if page is visible and user has been active recently (within last 5 minutes)
      const timeSinceActivity = Date.now() - this.lastActivityTime;
      const isUserActive = timeSinceActivity < 5 * 60 * 1000; // 5 minutes
      
      if (this.isPageVisible && isUserActive && this.getRefreshToken()) {
        this.checkAndRefreshTokenIfNeeded();
      } else if (!isUserActive) {
        // User inactive - stop checking to save resources
        this.stopActivityCheck();
      }
    }, 2 * 60 * 1000); // Check every 2 minutes
  }

  /**
   * Stop periodic activity check
   */
  private stopActivityCheck(): void {
    if (this.activityCheckIntervalId) {
      clearInterval(this.activityCheckIntervalId);
      this.activityCheckIntervalId = null;
    }
  }

  /**
   * Check if token needs refresh and refresh it if user is active
   */
  private async checkAndRefreshTokenIfNeeded(): Promise<void> {
    // Don't check if already refreshing
    if (this.isRefreshing) {
      return;
    }

    // Only refresh if token is near expiry (within 10 minutes)
    // This is more aggressive than the scheduled refresh to ensure seamless experience
    const expires = localStorage.getItem(this.tokenExpiresKey);
    if (!expires) return;
    
    const timeUntilExpiry = parseInt(expires) - Date.now();
    const refreshThreshold = 10 * 60 * 1000; // 10 minutes
    
    // If token expires within 10 minutes and user is active, refresh it
    if (timeUntilExpiry < refreshThreshold && timeUntilExpiry > 0) {
      try {
        await this.refreshToken();
      } catch (error) {
        // Silently fail - token will be refreshed on next API call
        // Don't log errors here to avoid spam
      }
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(): Promise<boolean> {
    // Prevent multiple simultaneous refresh attempts
    if (this.isRefreshing) {
      return this.refreshPromise!;
    }

    this.isRefreshing = true;
    this.refreshPromise = this._performRefresh();

    try {
      const result = await this.refreshPromise;
      return result;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  /**
   * Perform the actual token refresh
   */
  private async _performRefresh(): Promise<boolean> {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) {
      // Don't log this as a warning - it's expected when user is not logged in
      throw new Error('No refresh token available');
    }

    try {
      // Ensure CSRF cookie exists by performing a safe GET to the same server
      try {
        const refreshUrl = new URL(apiEndpoints.auth.refresh, window.location.origin);
        const healthUrl = refreshUrl.origin + '/api/health';
        await fetch(healthUrl, { method: 'GET', credentials: 'include' });
      } catch (_) { /* ignore */ }

      const csrfToken = getCookie('csrf_token');
      const response = await fetch(apiEndpoints.auth.refresh, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ refreshToken })
      });

      // Read response body once (can only be read once)
      let responseText = '';
      try {
        responseText = await response.text();
      } catch (e) {
        throw new Error(`Failed to read response: ${(e as Error).message}`);
      }

      // Check if response is ok
      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ''}`);
      }

      // Check if response has content
      if (!responseText || !responseText.trim()) {
        throw new Error('Empty response from server');
      }

      // Check content type
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error(`Invalid response format: ${responseText}`);
      }

      // Parse JSON response
      let data: RefreshResponse;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        throw new Error(`Failed to parse JSON response: ${(e as Error).message}. Response: ${responseText.substring(0, 100)}`);
      }

      if (data.success && data.data) {
        // Store new tokens; preserve existing refresh token if server omits it
        this.storeTokens(
          data.data.accessToken,
          data.data.refreshToken ?? this.getRefreshToken() ?? '',
          data.data.expiresIn
        );
        // Reschedule proactive refresh with new expiry
        this.scheduleRefresh(data.data.expiresIn);
        // Ensure activity check is running if page is visible
        if (this.isPageVisible) {
          this.startActivityCheck();
        }
        return true;
      } else {
        // Refresh failed, clear tokens
        this.clearTokens();
        throw new Error(data.message || 'Token refresh failed');
      }
    } catch (error) {
      this.clearTokens();
      throw error;
    }
  }

  /**
   * Get valid access token (refresh if needed)
   */
  async getValidToken(): Promise<string | null> {
    if (this.isTokenExpired() || this.isTokenNearExpiry()) {
      const hasRefresh = !!this.getRefreshToken();
      if (!hasRefresh) return null;
      try {
        await this.refreshToken();
      } catch (_) {
        return null;
      }
    }
    return this.getAccessToken();
  }

  /**
   * Make authenticated request with automatic token refresh
   */
  async makeAuthenticatedRequest(url: string, options: RequestInit = {}): Promise<Response> {
    // Import console utilities for logging
    const { log, error: logError } = await import('./console');
    
    // Construct full URL if relative
    let fullUrl = url;
    if (!url.startsWith('http')) {
      // Relative URL - use current origin
      fullUrl = window.location.origin + (url.startsWith('/') ? url : '/' + url);
    }
    
    log(`[authManager] makeAuthenticatedRequest: ${options.method || 'GET'} ${fullUrl}`);
    
    const token = await this.getValidToken();
    if (!token) {
      // Check if user is not authenticated - suppress console errors but still log to server
      const { isLoggedIn } = await import('../store/userStore');
      const { debug: logDebug } = await import('./console');
      const userIsNotAuthenticated = !isLoggedIn();
      
      if (userIsNotAuthenticated) {
        // User is not authenticated - log to server (database) but don't show in console
        logDebug(`[authManager] No valid token available for ${fullUrl} (user not authenticated)`);
      } else {
        // User is authenticated but token is missing - this is an error
        logError(`[authManager] No valid token available for ${fullUrl}`);
      }
      
      // Return a 401 response instead of throwing - this allows graceful handling
      return new Response(JSON.stringify({ success: false, message: 'No valid token available' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const authOptions: RequestInit = {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${token}`
      }
    };

    // Attach CSRF token for unsafe methods using double-submit cookie pattern
    const method = (authOptions.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const csrfToken = getCookie('csrf_token');
      if (csrfToken) {
        (authOptions.headers as Record<string, string>)['X-CSRF-Token'] = csrfToken;
      }
      // Ensure credentials sent so cookie is included across subdomains/origins when allowed by CORS
      authOptions.credentials = 'include';
    }

    // Retry configuration for network errors
    const MAX_RETRIES = 2; // Retry up to 2 times (3 total attempts)
    const INITIAL_RETRY_DELAY = 500; // Start with 500ms delay
    const MAX_RETRY_DELAY = 2000; // Max 2 seconds between retries
    
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Check URL length - warn if potentially too long (browsers/servers typically limit to 2048 chars)
        const urlLength = fullUrl.length;
        if (urlLength > 2000 && attempt === 0) {
          logError(`[authManager] Warning: URL length is ${urlLength} characters (may exceed browser/server limits): ${fullUrl.substring(0, 200)}...`);
        }
        
        if (attempt > 0) {
          log(`[authManager] Retry attempt ${attempt}/${MAX_RETRIES} for ${fullUrl}`);
        } else {
          log(`[authManager] Calling fetch for ${fullUrl} with method ${method}`);
        }
        
        const response = await fetch(fullUrl, authOptions);
        log(`[authManager] Fetch response: ${response.status} ${response.statusText} for ${fullUrl}`);
        
        // If 401, try to refresh token once
        if (response.status === 401) {
          log(`[authManager] Got 401, attempting token refresh for ${fullUrl}`);
          try {
            await this.refreshToken();
            const newToken = this.getAccessToken();
            if (newToken) {
              (authOptions.headers as Record<string, string>)['Authorization'] = `Bearer ${newToken}`;
              log(`[authManager] Token refreshed, retrying ${fullUrl}`);
              const retryResponse = await fetch(fullUrl, authOptions);
              log(`[authManager] Retry response: ${retryResponse.status} ${retryResponse.statusText} for ${fullUrl}`);
              return retryResponse;
            }
          } catch (error) {
            // Token refresh failed - return the original 401 response
            // This allows the calling code to handle it gracefully
            logError(`[authManager] Token refresh failed for ${fullUrl}:`, error);
          }
        }
        
        return response;
      } catch (fetchError) {
        lastError = fetchError as Error;
        
        // Don't retry AbortErrors - they're expected when requests are cancelled
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          log(`[authManager] Request aborted for ${fullUrl}`);
          throw fetchError;
        }
        
        // For streaming endpoints, "Failed to fetch" errors are expected when Redis has no data
        // Suppress these errors - the streamingDataService will handle them gracefully
        const isStreamingEndpoint = fullUrl.includes('/api/stream/');
        const errorMessage = (fetchError as Error).message || String(fetchError);
        const isFailedToFetch = errorMessage.includes('Failed to fetch');
        
        if (isStreamingEndpoint && isFailedToFetch) {
          // Suppress "Failed to fetch" errors for streaming endpoints - they're expected
          // The streamingDataService will log a warning if needed
          // No logging here to reduce console noise
          throw fetchError;
        }
        
        // Check if we should retry (only for network errors on non-streaming endpoints)
        const isNetworkError = isFailedToFetch || 
          errorMessage.includes('NetworkError') || 
          errorMessage.includes('network') ||
          errorMessage.includes('timeout');
        
        if (isNetworkError && attempt < MAX_RETRIES) {
          // Calculate exponential backoff delay
          const delay = Math.min(INITIAL_RETRY_DELAY * Math.pow(2, attempt), MAX_RETRY_DELAY);
          log(`[authManager] Network error on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${delay}ms: ${errorMessage}`);
          
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, delay));
          continue; // Retry the request
        }
        
        // All retries exhausted or non-retryable error - log with enhanced context
        const errorContext: Record<string, any> = {
          url: fullUrl,
          urlLength: fullUrl.length,
          method: method,
          errorName: (fetchError as Error).name,
          errorMessage: errorMessage,
          online: typeof navigator !== 'undefined' ? navigator.onLine : 'unknown',
          timestamp: new Date().toISOString(),
          attempts: attempt + 1
        };
        
        // Check if URL might be too long
        if (fullUrl.length > 2000) {
          errorContext.urlLengthWarning = `URL length (${fullUrl.length}) may exceed browser/server limits (typically 2048 chars)`;
        }
        
        // Check if we're offline
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          errorContext.networkStatus = 'Browser reports offline';
        }
        
        // Log with enhanced context
        logError(`[authManager] Fetch error for ${fullUrl} (after ${attempt + 1} attempt(s)):`, { 
          error: fetchError, 
          context: errorContext 
        });
        
        throw fetchError;
      }
    }
    
    // This should never be reached, but TypeScript needs it
    throw lastError || new Error('Unknown error in makeAuthenticatedRequest');
  }

  /**
   * Login with email and password
   */
  async login(email: string, password: string, rememberMe: boolean = false): Promise<LoginResponse> {
    try {
      // Ensure CSRF cookie exists by performing a safe GET to the same server
      try {
        const loginUrl = new URL(apiEndpoints.auth.login, window.location.origin);
        const healthUrl = loginUrl.origin + '/api/health';
        await fetch(healthUrl, { method: 'GET', credentials: 'include' });
      } catch (_) { /* ignore */ }

      const csrfToken = getCookie('csrf_token');
      const response = await fetch(apiEndpoints.auth.login, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify({ email, password, rememberMe })
      });

      // Read response body once (can only be read once)
      let responseText = '';
      try {
        responseText = await response.text();
      } catch (e) {
        return {
          success: false,
          message: `Failed to read response: ${(e as Error).message}`
        };
      }

      // Check if response is ok – use friendly messages for auth failure and rate limit
      if (!response.ok) {
        let message: string;
        if (response.status === 401) {
          message = 'Invalid email or password';
        } else if (response.status === 429) {
          message = 'Too many attempts. Please try again later.';
        } else if (response.status === 503) {
          message =
            'Server cannot reach the database. Check DB_HOST, that Postgres allows connections from Docker, and DB_PASSWORD in .env.production.local.';
        } else {
          message = `Login failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ''}`;
        }
        return { success: false, message };
      }

      // Check if response has content
      if (!responseText || !responseText.trim()) {
        return {
          success: false,
          message: 'Empty response from server'
        };
      }

      // Check content type
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        return {
          success: false,
          message: `Invalid response format: ${responseText}`
        };
      }

      // Parse JSON response
      let data: LoginResponse;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        return {
          success: false,
          message: `Failed to parse JSON response: ${(e as Error).message}. Response: ${responseText.substring(0, 100)}`
        };
      }

      if (data.success && data.data) {
        // Store JWT tokens
        this.storeTokens(
          data.data.accessToken,
          data.data.refreshToken,
          data.data.expiresIn
        );

        // Warm-up CSRF cookies for all backends we call from the client
        try {
          const healthCalls = [
            `${config.API_BASE_URL}/health`,
            `${config.ADMIN_BASE_URL}/health`,
            `${config.FILE_BASE_URL}/health`,
            `${config.MEDIA_BASE_URL}/health`,
          ]; // All use /api/health now
          await Promise.all(healthCalls.map(u => fetch(u, { method: 'GET', credentials: 'include' })));
        } catch (_) { /* ignore */ }

        // Start activity check for automatic token renewal
        if (this.isPageVisible) {
          this.startActivityCheck();
        }

        return {
          success: true,
          data: data.data
        };
      } else {
        return {
          success: false,
          message: data.message || 'Login failed'
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Network error: ${(error as Error).message}`
      };
    }
  }

  /**
   * Register new user
   */
  async register(userData: UserData): Promise<RegisterResponse> {
    try {
      // Ensure CSRF cookie exists
      try {
        const regUrl = new URL(apiEndpoints.auth.register, window.location.origin);
        const healthUrl = regUrl.origin + '/api/health';
        await fetch(healthUrl, { method: 'GET', credentials: 'include' });
      } catch (_) { /* ignore */ }

      const csrfToken = getCookie('csrf_token');
      const response = await fetch(apiEndpoints.auth.register, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        },
        credentials: 'include',
        body: JSON.stringify(userData)
      });

      // Read response body once (can only be read once)
      let responseText = '';
      try {
        responseText = await response.text();
      } catch (e) {
        return {
          success: false,
          message: `Failed to read response: ${(e as Error).message}`
        };
      }

      // Check if response is ok
      if (!response.ok) {
        return {
          success: false,
          message: `Registration failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ''}`
        };
      }

      // Check if response has content
      if (!responseText || !responseText.trim()) {
        return {
          success: false,
          message: 'Empty response from server'
        };
      }

      // Check content type
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        return {
          success: false,
          message: `Invalid response format: ${responseText}`
        };
      }

      // Parse JSON response
      let data: RegisterResponse;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        return {
          success: false,
          message: `Failed to parse JSON response: ${(e as Error).message}. Response: ${responseText.substring(0, 100)}`
        };
      }
      return data;
    } catch (error) {
      return {
        success: false,
        message: `Network error: ${(error as Error).message}`
      };
    }
  }

  /**
   * Logout and clear tokens
   */
  async logout(): Promise<void> {
    const refreshToken = this.getRefreshToken();
    
    if (refreshToken) {
      try {
        const csrfToken = getCookie('csrf_token');
        await fetch(apiEndpoints.auth.logout, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          },
          credentials: 'include',
          body: JSON.stringify({ refreshToken })
        });
      } catch (error) {
        logError('Logout request failed:', error);
      }
    }

    this.clearTokens();
  }

  /**
   * Get current user info
   */
  async getCurrentUser(): Promise<UserResponse> {
    try {
      const response = await this.makeAuthenticatedRequest(apiEndpoints.auth.me);
      
      // Check if the response is successful
      if (response.ok) {
        const data: UserResponse = await response.json();
        return data;
      } else {
        // Handle non-200 responses gracefully
        return {
          success: false,
          message: `Authentication failed: ${response.status} ${response.statusText}`
        };
      }
    } catch (error) {
      return {
        success: false,
        message: `Failed to get user info: ${(error as Error).message}`
      };
    }
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    const accessToken = this.getAccessToken();
    const refreshToken = this.getRefreshToken();
    return !!(accessToken && refreshToken && !this.isTokenExpired());
  }
}

// Export singleton instance
export const authManager = new AuthManager();
export default authManager;
