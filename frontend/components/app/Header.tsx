import { Show, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { postData, getData } from "../../utils/global";
import { user, setUser, isLoggedIn, setIsLoggedIn } from "../../store/userStore"; 
import { persistantStore } from "../../store/persistantStore";
const { selectedClassName, selectedSourceName, selectedDatasetId, selectedProjectId, selectedDate, projectHeader } = persistantStore;
import { sidebarState } from "../../store/globalStore";
import { streamingStore } from "../../store/streamingStore";

import { apiEndpoints } from "@config/env";
import { error as logError, log } from "../../utils/console";
import { authManager } from "../../utils/authManager";
// OLD INDEXEDDB - REPLACED WITH HUNIDB
import { huniDBStore } from "../../store/huniDBStore";

const handleLogout = async () => {
  try {
    // Always clear local state first, regardless of backend response
    // This ensures the user is logged out on the frontend even if the backend call fails
    log('Logging out user - clearing local state');
    
    // Clear HuniDB data (replaced old IndexedDB)
    try {
      await huniDBStore.clearAllData();
      log('HuniDB cleared successfully');
    } catch (huniDBError: any) {
      logError('Error clearing HuniDB during logout:', huniDBError);
      // Continue with logout even if HuniDB clearing fails
    }
    
    // Clear auth tokens from localStorage
    authManager.clearTokens();
    
    // Clear user state
    setIsLoggedIn(false);
    setUser(null);
    
    // Try to notify the backend, but don't fail if it doesn't work
    try {
      const controller = new AbortController();
      await postData(`${apiEndpoints.auth.logout}`, {}, controller.signal);
      log('Backend logout successful');
    } catch (backendError: any) {
      // Backend logout failed, but we already cleared local state, so it's okay
      if (backendError.name !== 'AbortError') {
        logError('Backend logout failed (local logout already completed):', backendError);
      }
    }
    
    // Redirect to index page after logout
    window.location.href = '/';
  } catch (error: any) {
    // Even if something goes wrong, make sure we clear the state
    try {
      await huniDBStore.clearAllData();
    } catch (huniDBError) {
      // Ignore HuniDB errors in error handler
    }
    authManager.clearTokens();
    setIsLoggedIn(false);
    setUser(null);
    logError('Error during logout:', error);
    
    // Redirect to index page even if there was an error
    window.location.href = '/';
  }
};

export default function Header() {
  const location = useLocation();
  const navigate = useNavigate();
  const [showMobileUserMenu, setShowMobileUserMenu] = createSignal(false);
  const [isMobile, setIsMobile] = createSignal(false);
  const [datasetDate, setDatasetDate] = createSignal("");
  const [screenWidth, setScreenWidth] = createSignal(window.innerWidth);
  
  // Check if cookies are accepted
  const areCookiesAccepted = () => {
    const cookiesAccepted = localStorage.getItem("cookiesAccepted");
    return cookiesAccepted === "true";
  };
  
  // Handle navigation to login/register with cookie check
  const handleAuthNavigation = (path: string, e: MouseEvent) => {
    e.preventDefault();
    if (areCookiesAccepted()) {
      navigate(path);
    } else {
      navigate(`/cookie-policy?redirect=${path}`);
    }
  };
  
  // Check if we're on the index page - using router location
  const isIndexPage = () => location.pathname === "/";
  
  // Check if we're on the dashboard page - using router location
  const isDashboardPage = () => location.pathname === "/dashboard";
  
  // Function to check if we're on authentication pages - using router location
  const isAuthPage = () => {
    const path = location.pathname;
    return path === '/login' || path === '/register' || path === '/resetpassword' || path.startsWith('/resetpassword/') || path === '/cookie-policy';
  };

  // Fetch dataset date when selectedDatasetId, className, or projectId changes
  createEffect(async () => {
    const datasetId = selectedDatasetId();
    const className = selectedClassName();
    const projectId = selectedProjectId();
    
    // Only fetch if we have all required values
    if (datasetId > 0 && className && projectId > 0) {
      try {
        const controller = new AbortController();
        const response = await getData(
          `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_id=${encodeURIComponent(datasetId)}`,
          controller.signal
        );
        
        if (response.success && response.data && response.data.date) {
          setDatasetDate(response.data.date);
        } else {
          setDatasetDate("");
        }
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          logError('Error fetching dataset date:', error);
        }
        setDatasetDate("");
      }
    } else {
      setDatasetDate("");
    }
  });

  const toggleMobileUserMenu = () => {
    setShowMobileUserMenu(!showMobileUserMenu());
  };

  const closeMobileUserMenu = () => {
    setShowMobileUserMenu(false);
  };

  // Handle responsive behavior
  const checkScreenSize = () => {
    setIsMobile(window.innerWidth <= 1000);
    setScreenWidth(window.innerWidth);
  };

  onMount(() => {
    checkScreenSize();
    window.addEventListener('resize', checkScreenSize);
  });

  onCleanup(() => {
    window.removeEventListener('resize', checkScreenSize);
  });

  return (
    <Show when={!isIndexPage() || isLoggedIn()}>
      <header class="header" onContextMenu={(e: MouseEvent) => e.preventDefault()}>
      <div class="logo">
        {/* Project name header - hidden on mobile (width < 1000px) */}
        <Show when={!isMobile()}>
          <a href="/">{projectHeader()}</a>
        </Show>
        {/* Class name, source, date header - shown on mobile (width < 1000px) when data is available, or on desktop when conditions are met */}
        <Show when={isLoggedIn() && isDashboardPage() && selectedClassName() && (selectedSourceName() || sidebarState() === 'live' || streamingStore.isInitialized)}>
          <span class="logo-subtitle">
            {selectedClassName().toUpperCase()}
            <Show when={sidebarState() !== 'live' && !streamingStore.isInitialized && selectedSourceName()}>
              <span> - {selectedSourceName()}</span>
            </Show>
            <Show when={sidebarState() === 'live' || streamingStore.isInitialized}>
              <span> - LIVE</span>
            </Show>
            <Show when={datasetDate() || selectedDate()}>
              <span class="logo-date"> - {datasetDate() || selectedDate()}</span>
            </Show>
          </span>
        </Show>
      </div>
      {/* Desktop auth links - hidden on mobile and auth pages */}
      <Show when={!isMobile() && !isAuthPage() && isLoggedIn() && user()}>
        <div class="auth-links">
          <a id="user_name" href="/profile">{user().user_name}</a>
          <a id="user-icon" href="/profile" aria-label="User Profile">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" class="w-6 h-6">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 14c4.418 0 8 3.582 8 8H4c0-4.418 3.582-8 8-8zm0-4c1.5 0 2.5-1.5 2.5-3s-1-3-2.5-3-2.5 1.5-2.5 3 1 3 2.5 3z"/>
            </svg>
          </a>
          <a id="logout" href="/" onClick={(e: MouseEvent) => { e.preventDefault(); handleLogout(); }}>Logout</a>
        </div>
      </Show>
      
      {/* Mobile auth links - hidden on desktop and auth pages */}
      <Show when={isMobile() && !isAuthPage() && isLoggedIn() && user()}>
        <div class="mobile-auth-links">
          <div class="mobile-user-menu">
            <button 
              id="mobile-user-icon" 
              onClick={toggleMobileUserMenu}
              aria-label="User Menu"
              style="background: none; border: none; color: white; cursor: pointer; padding: 4px;"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" class="w-6 h-6">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 14c4.418 0 8 3.582 8 8H4c0-4.418 3.582-8 8-8zm0-4c1.5 0 2.5-1.5 2.5-3s-1-3-2.5-3-2.5 1.5-2.5 3 1 3 2.5 3z"/>
              </svg>
            </button>
            <Show when={showMobileUserMenu()}>
              <div class="mobile-user-dropdown">
                <a href="/profile" onClick={closeMobileUserMenu}>Edit User Profile</a>
                <a href="/" onClick={() => { closeMobileUserMenu(); handleLogout(); }}>Logout</a>
              </div>
            </Show>
          </div>
        </div>
      </Show>
      </header>
    </Show>
  );
}
