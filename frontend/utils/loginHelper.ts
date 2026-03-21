/**
 * Login Helper Function
 * Shared logic for logging in users after authentication
 * Used by both Login and ResetPassword pages
 */

import { setIsLoggedIn, setUser, setSubscription } from "../store/userStore";
import { persistantStore } from "../store/persistantStore";
import { getData } from "./global";
import { log, error as logError } from "./console";
import { authManager } from "./authManager";

export interface LoginUserData {
  user_id: number;
  user_name: string;
  first_name?: string;
  last_name?: string;
  email: string;
  is_verified?: boolean;
  is_super_user?: boolean;
  [key: string]: any;
}

export interface LoginTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
}

/**
 * Handles the login flow after successful authentication
 * @param userData - User data from the authentication response
 * @param source - Source of the login (e.g., 'Login', 'ResetPassword', 'Verify')
 * @param tokens - Optional tokens to store (for password reset where backend sets cookie)
 * @returns Promise that resolves when login is complete
 */
export async function handleLogin(userData: LoginUserData, source: string = 'Login', tokens?: LoginTokens): Promise<void> {
  try {
    log(`[${source}] Starting login process for user: ${userData.user_id}`);
    
    // Clear any existing user state before setting new user
    log(`[${source}] Clearing existing session before logging in`);
    setIsLoggedIn(false);
    setUser(null);
    setSubscription(null);
    
    // Clear persistent store localStorage to prevent stale data from previous user
    // The store will reload from API after user is set, which will restore all values
    try {
      const keysToClear = [
        'selectedDatasetId', 'selectedProjectId', 'selectedClassName',
        'selectedSourceId', 'selectedSourceName', 'selectedDate',
        'selectedYear', 'selectedEvent', 'selectedMenu', 'selectedPage'
      ];
      keysToClear.forEach(key => localStorage.removeItem(key));
      log(`[${source}] Cleared persistent store localStorage`);
    } catch (err) {
      logError(`[${source}] Error clearing localStorage:`, err);
    }
    
    // Clear cache initialization flag to ensure fresh initialization on dashboard
    try {
      persistantStore.setIsCacheInitialized(false);
      log(`[${source}] Cleared cache initialization flag`);
    } catch (err) {
      logError(`[${source}] Error clearing cache initialization flag:`, err);
    }
    
    // Store tokens in localStorage if provided (e.g., from password reset)
    // This ensures authManager can read them for authenticated requests
    if (tokens && tokens.accessToken && tokens.refreshToken) {
      log(`[${source}] Storing tokens in localStorage`);
      authManager.storeTokens(
        tokens.accessToken,
        tokens.refreshToken,
        tokens.expiresIn || 86400 // Default to 24 hours if not provided
      );
    }
    
    // Set user state immediately - don't block on subscription
    setIsLoggedIn(true);
    setUser(userData);
    
    // Flush pending logs to server now that user is authenticated
    try {
      log(`[${source}] Flushing pending logs to server`);
      const { flushPendingLogs } = await import('./logging');
      flushPendingLogs().catch((err) => {
        logError(`[${source}] Error flushing pending logs:`, err);
      });
    } catch (err) {
      logError(`[${source}] Error importing logging module:`, err);
    }
    
    // Fetch subscription in background (non-blocking)
    if (userData.user_id) {
      getData(`/api/users/subscription?id=${encodeURIComponent(userData.user_id)}`)
        .then((result) => {
          setSubscription(result.data);
        })
        .catch((err) => {
          // Subscription fetch failed, but login still succeeds
          logError(`[${source}] Could not fetch subscription data:`, err);
        });
    }
    
    // Load persistent settings before navigating to ensure proper initialization
    // This matches the flow when app initializes with existing tokens
    // The Sidebar will also load settings, but loading here ensures they're ready
    // If no projectId is in settings, the first project will be selected automatically
    try {
      log(`[${source}] Loading persistent settings before navigation`);
      await persistantStore.loadPersistentSettings();
      log(`[${source}] Persistent settings loaded`);
    } catch (err) {
      logError(`[${source}] Error loading persistent settings:`, err);
    }
    
    log(`[${source}] Login process completed successfully`);
  } catch (err) {
    logError(`[${source}] Error during login process:`, err);
    throw err;
  }
}
