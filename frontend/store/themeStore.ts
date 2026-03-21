import { createSignal, Accessor, Setter } from "solid-js";
import { debug } from "../utils/console";
import { persistentSettingsService } from "../services/persistentSettingsService";
import { user } from "./userStore";
import { persistantStore } from "./persistantStore";

// Theme types
export type Theme = 'light' | 'medium' | 'dark';

// Theme store interface
export interface ThemeStore {
  theme: Accessor<Theme>;
  setTheme: (value: Theme | ((prev: Theme) => Theme)) => void;
  toggleTheme: () => void;
  isDark: Accessor<boolean>;
  isLight: Accessor<boolean>;
  isMedium: Accessor<boolean>;
}

// Create theme signal with localStorage persistence
const getInitialTheme = (): Theme => {
  if (typeof window === 'undefined') return 'medium';
  
  try {
    const saved = localStorage.getItem('teamshare-theme');
    // Handle migration from old theme names (only migrate once)
    if (saved === 'dark-grey') {
      // Old dark-grey becomes new dark
      localStorage.setItem('teamshare-theme', 'dark');
      return 'dark';
    } else if (saved === 'medium' || saved === 'light' || saved === 'dark') {
      // Valid current theme values - return as-is
      return saved as Theme;
    }
    
    // Check system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'medium';
    }
  } catch (error) {
    debug('Error reading theme from localStorage:', error);
  }
  
  return 'medium';
};

const [theme, setThemeSignal] = createSignal<Theme>(getInitialTheme());

// Enhanced setter with localStorage persistence and API sync
const setTheme = (value: Theme | ((prev: Theme) => Theme)) => {
  const oldTheme = theme();
  const newTheme = typeof value === 'function' ? value(theme()) : value;
  
  debug(`[ThemeStore] setTheme called: ${oldTheme} -> ${newTheme}`);
  
  try {
    localStorage.setItem('teamshare-theme', newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
    if (newTheme === 'medium' || newTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    debug(`[ThemeStore] Theme changed to: ${newTheme}`);
    
    // Save to API with debouncing
    try {
      const currentUser = user();
      let className: string | undefined;
      let projectId: number | undefined;
      
      try {
        if (persistantStore && typeof persistantStore.selectedClassName === 'function') {
          className = persistantStore.selectedClassName();
        }
        if (persistantStore && typeof persistantStore.selectedProjectId === 'function') {
          projectId = persistantStore.selectedProjectId();
        }
      } catch (storeError) {
        debug('[ThemeStore] Error accessing persistentStore:', storeError);
        // Continue without saving to API if store is not available
      }
      
      if (currentUser?.user_id && className && projectId && projectId > 0) {
        debug(`[ThemeStore] Saving theme to API: ${newTheme}`);
        persistentSettingsService.saveSettings(
          currentUser.user_id,
          className,
          projectId,
          { 'teamshare-theme': newTheme }
        );
      } else {
        debug(`[ThemeStore] Cannot save theme to API - missing user/className/projectId`, {
          hasUser: !!currentUser?.user_id,
          className,
          projectId
        });
      }
    } catch (apiError) {
      debug('[ThemeStore] Error saving theme to API:', apiError);
      // Don't throw - theme change should still succeed even if API save fails
    }
  } catch (error) {
    debug('[ThemeStore] Error saving theme to localStorage:', error);
  }
  
  setThemeSignal(newTheme);
};

// Toggle function - cycles through: light -> medium -> dark -> light
const toggleTheme = () => {
  const current = theme();
  if (current === 'light') {
    setTheme('medium');
  } else if (current === 'medium') {
    setTheme('dark');
  } else {
    setTheme('light');
  }
};

// Computed signals
const isDark = () => theme() === 'medium' || theme() === 'dark';
const isLight = () => theme() === 'light';
const isMedium = () => theme() === 'medium';

// Initialize theme on load
if (typeof window !== 'undefined') {
  const current = theme();
  debug(`[ThemeStore] Initializing theme on load: ${current}`);
  document.documentElement.setAttribute('data-theme', current);
  if (current === 'medium' || current === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  debug(`[ThemeStore] Theme initialization complete: ${current}`);
}

// Export theme store
export const themeStore: ThemeStore = {
  theme,
  setTheme,
  toggleTheme,
  isDark,
  isLight,
  isMedium
};

// Get stroke color based on current theme
export const getStrokeColor = (): string => {
  const currentTheme = theme();
  return (currentTheme === 'medium' || currentTheme === 'dark') ? "white" : "black";
};

// Export individual signals for convenience
export { theme, setTheme, toggleTheme, isDark, isLight, isMedium };
