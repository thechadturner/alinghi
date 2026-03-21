import { createSignal, onMount, createEffect, Show, onCleanup, createMemo } from "solid-js";
import { FiCodepen, FiSettings, FiFolder, FiChevronDown, FiFile, FiMap, FiActivity, FiTrendingUp, FiCornerUpRight, FiPlus, FiVideo, FiList, FiGrid, FiTrendingDown, FiTarget, FiRss, FiPlusCircle, FiMenu, FiWatch, FiX } from "solid-icons/fi";
import { useNavigate, useLocation } from "@solidjs/router";

import Pages from "./Pages";
import SidebarSettings from "../menus/SidebarSettings"; 

import { getData, getTimezoneForDate } from "../../utils/global";
import { user, isLoggedIn } from "../../store/userStore"; 

import { persistantStore } from "../../store/persistantStore";
import { unifiedDataStore } from "../../store/unifiedDataStore";
import { sourcesStore } from "../../store/sourcesStore";
import { streamingStore } from "../../store/streamingStore";
import { selection, hasSelection, isCut, selectedEvents, selectedRange, selectedRanges, selectedGroupKeys, cutEvents, setSelectedEvents, setSelectedRanges, setSelectedRange, setHasSelection, setCutEvents, setIsCut } from "../../store/selectionStore";
import { phase, setPhase, color, setColor, eventType, setEventType, tws, grade, grouped, setGrouped, groupDisplayMode, setGroupDisplayMode } from "../../store/globalStore";
import { setSelectedTime, liveMode, isPlaying, setIsPlaying, selectedTime, timeWindow } from "../../store/playbackStore";
import { selectedStatesTimeseries, selectedRacesTimeseries, selectedLegsTimeseries, selectedGradesTimeseries, raceOptions, legOptions, gradeOptions, selectedHeadsailCodes, selectedMainsailCodes, clearTimeseriesFilters } from "../../store/filterStore";
import { hasVideoMenu, setHasVideoMenu, sidebarState, setSidebarState, sidebarMenuRefreshTrigger, setSidebarMenuRefreshTrigger } from "../../store/globalStore";
import { streamingStatusStore } from "../../store/streamingStatusStore";

import { apiEndpoints } from "@config/env";
import { error as logError, log, debug, warn } from "../../utils/console";
import { persistentSettingsService } from "../../services/persistentSettingsService";
import { isMacOS } from "../../utils/deviceDetection";
const { projects, selectedProjectId, setSelectedProjectId, selectedClassName, setSelectedClassName, selectedClassIcon, setSelectedClassIcon, selectedClassSizeM, setSelectedClassSizeM, selectedClassObject, setSelectedClassObject, selectedDatasetId, setSelectedDatasetId, selectedDate, setSelectedDate, selectedSourceId, setSelectedSourceId, selectedSourceName, setSelectedSourceName, selectedMenu, setSelectedMenu, selectedPage, setSelectedPage, restoreLastMenuForMode } = persistantStore;

const [DatasetsComponent, setDatasetsComponent] = createSignal<any>(null);

// Pre-load all report components using Vite's glob import
// This allows Vite to discover all files at build time and create proper chunks
// The glob pattern matches all .tsx files in the reports directory
// This must be at module level (not inside a function) for Vite to process it correctly
const reportModules = import.meta.glob('../../reports/**/*.tsx', { eager: false });

/** After receiving play from a child, ignore BroadcastChannel "false" for this long so play does not immediately pause. */
const PLAY_HOLD_MS = 250;

const ensureInteger = (value: any): number | null => {
  const intValue = parseInt(value);
  return isNaN(intValue) ? null : intValue;
};

const FiScatter = () => (
  <svg class="svg" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <line x1="3" y1="24" x2="24" y2="24" />
    <line x1="3" y1="24" x2="3" y2="3" />
    <circle cx="8" cy="16" r="1.5" /> 
    <circle cx="12" cy="10" r="1.5" /> 
    <circle cx="9" cy="7" r="1.5" /> 
    <circle cx="20" cy="13" r="1.5" />
    <circle cx="17" cy="5" r="1.5" /> 
  </svg>
);

const FiProbability = () => (
  <svg class="svg" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <line x1="3" y1="24" x2="24" y2="24" />
    <line x1="3" y1="24" x2="3" y2="3" />
    <path d="M3,24 C8,3 16,3 21,24" />
  </svg>
);

const FiParallel = () => (
  <svg class="svg" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    <line x1="3" y1="24" x2="24" y2="24" />
    <line x1="3" y1="24" x2="3" y2="3" />
    <polyline points="3,13 6,8 10,18 14,7 18,19 24,13" />
  </svg>
);

const FiPolarRose = () => (
  <svg class="svg" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor">
    {/* Four symmetric wedges radiating from center at 45°, 135°, 225°, 315° */}
    {/* 45° wedge (NE) */}
    <polygon points="12,12 17,17 19.5,14.5" fill="currentColor" opacity="0.2" />
    <line x1="12" y1="12" x2="17" y2="17" />
    <line x1="12" y1="12" x2="19.5" y2="14.5" />
    {/* 135° wedge (NW) */}
    <polygon points="12,12 7,17 4.5,14.5" fill="currentColor" opacity="0.2" />
    <line x1="12" y1="12" x2="7" y2="17" />
    <line x1="12" y1="12" x2="4.5" y2="14.5" />
    {/* 225° wedge (SW) */}
    <polygon points="12,12 7,7 4.5,9.5" fill="currentColor" opacity="0.2" />
    <line x1="12" y1="12" x2="7" y2="7" />
    <line x1="12" y1="12" x2="4.5" y2="9.5" />
    {/* 315° wedge (SE) */}
    <polygon points="12,12 17,7 19.5,9.5" fill="currentColor" opacity="0.2" />
    <line x1="12" y1="12" x2="17" y2="7" />
    <line x1="12" y1="12" x2="19.5" y2="9.5" />
  </svg>
);

// Mapping of icon names to icon components
const iconMapping: Record<string, any> = {
  FiFile: FiFile,
  FiMap: FiMap,
  FiActivity: FiActivity,
  FiTrendingUp: FiTrendingUp,
  FiSettings: FiSettings,
  FiPlus: FiPlus,
  FiChevronDown: FiChevronDown,
  FiFolder: FiFolder,
  FiCornerUpRight: FiCornerUpRight,
  FiVideo: FiVideo,
  FiScatter: FiScatter,
  FiProbability: FiProbability,
  FiParallel: FiParallel,
  FiPolarRose: FiPolarRose,
  FiGrid: FiGrid,
  FiList: FiList,
  FiTrendingDown: FiTrendingDown,
  FiTarget: FiTarget,
  FiRss: FiRss,
  FiCodepen: FiCodepen,
  FiWatch: FiWatch

};

interface SidebarProps {
  setSidebarInitialized: (value: boolean) => void;
  setComponent: (component: any) => void;
  fetchMenuTrigger: () => number;
  setFetchMenuTrigger: (value: number) => void;
  hasExistingDataset: () => boolean;
  openInSplitView?: (component: any, title: string, menuName?: string | null, leftComponent?: any) => void;
  isSplitView: () => boolean;
  updateLeftComponent?: (component: any) => void;
  rightPanelMenu?: () => string;
  closeSplitView?: () => void;
}

const Sidebar = (props: SidebarProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  
  const [showProjects, setShowProjects] = createSignal(false);
  const [dynamicMenuItems1, setDynamicMenuItems1] = createSignal<any[]>([]);
  const [dynamicMenuItems2, setDynamicMenuItems2] = createSignal<any[]>([]);
  // Tools menus (project-related tools)
  const [dynamicMenuItemsTools, setDynamicMenuItemsTools] = createSignal<any[]>([]);
  const [dividerLabelTools, setDividerLabelTools] = createSignal("");
  const [dividerLabel1, setDividerLabel1] = createSignal("");
  const [dividerLabel2, setDividerLabel2] = createSignal("");
  const [menuFound, setMenuFound] = createSignal(false);
  const [showModal, setShowModal] = createSignal(false);
  const [updateMenus, setUpdateMenus] = createSignal(false);
  const [isProjectMenuActive, setIsProjectMenuActive] = createSignal(false);
  const [childWindows, setChildWindows] = createSignal<Map<string, Window>>(new Map());
  /** When set, parent re-applies play if a stale BroadcastChannel "false" flips isPlaying within PLAY_HOLD_MS. */
  let lastPlayFromChildAt = 0;
  
  // New state for user pages with dropdowns
  const [userPageMenus, setUserPageMenus] = createSignal<any[]>([]);
  const [expandedMenus, setExpandedMenus] = createSignal<Set<string>>(new Set());
  const [userPageObjects, setUserPageObjects] = createSignal<Map<string, any>>(new Map());
  
  // State for maneuver menus
  const [maneuverMenus, setManeuverMenus] = createSignal<any[]>([]);

  // Responsive sidebar state
  const [isCollapsed, setIsCollapsed] = createSignal(false);
  const [isMobile, setIsMobile] = createSignal(false);
  const [showMobileMenu, setShowMobileMenu] = createSignal(false);
  const [isInitialized, setIsInitialized] = createSignal(false);
  const [hasSources, setHasSources] = createSignal(true);
  const [settingsMenuItems, setSettingsMenuItems] = createSignal<any[]>([]);
  const [datasetCount, setDatasetCount] = createSignal(0);
  // VIDEO page lives under page_type dataset/explore; when in add-dataset state we fetch this to know if "+ add video" should show
  const [projectHasVideoPage, setProjectHasVideoPage] = createSignal(false);

  // Fetch dataset count for the current project
  const fetchDatasetCount = async () => {
    if (!selectedClassName() || !selectedProjectId() || selectedProjectId() === 0) {
      setDatasetCount(0);
      return;
    }

    try {
      const controller = new AbortController();
      const response = await getData(
        `${apiEndpoints.app.datasets}/count?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}`,
        controller.signal
      );

      if (response.success && response.data !== undefined) {
        setDatasetCount(response.data);
        debug('[Sidebar] Dataset count fetched:', response.data);
      } else {
        setDatasetCount(0);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        warn('[Sidebar] Error fetching dataset count:', error);
      }
      setDatasetCount(0);
    }
  };

  // Watch for project changes and fetch dataset count
  createEffect(() => {
    const projectId = selectedProjectId();
    const className = selectedClassName();
    
    if (projectId && projectId > 0 && className) {
      fetchDatasetCount();
    } else {
      setDatasetCount(0);
    }
  });

  // When in add-dataset state (no dataset, no date), fetch dataset/explore to see if project has VIDEO page (VIDEO uses page_type dataset/explore)
  createEffect(() => {
    const projectId = selectedProjectId();
    const className = selectedClassName();
    const datasetId = selectedDatasetId();
    const date = selectedDate();
    if (!projectId || projectId <= 0 || !className || datasetId !== 0 || isValidDate(date)) {
      setProjectHasVideoPage(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        const response = await getData(
          `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&page_type=${encodeURIComponent('dataset/explore')}`,
          controller.signal
        );
        if (cancelled) return;
        const hasVideo = !!(response?.success && response?.data && Array.isArray(response.data) &&
          response.data.some((item: any) => (String(item?.page_name || '').replace(/\s+/g, '').toUpperCase() === 'VIDEO')));
        setProjectHasVideoPage(hasVideo);
      } catch (e: any) {
        if (!cancelled && e?.name !== 'AbortError') {
          warn('[Sidebar] Error fetching dataset/explore for VIDEO page check:', e);
        }
        if (!cancelled) setProjectHasVideoPage(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  });

  // Memoized value to check if datasets are available
  const hasDatasets = createMemo(() => {
    const count = datasetCount();
    const projectId = selectedProjectId();
    const className = selectedClassName();
    // Only show if we have a valid project, class, and count > 0
    const result = !!(projectId && projectId > 0 && className && count && count > 0);
    debug('[Sidebar] hasDatasets computed:', { count, projectId, className, result });
    return result;
  });

  // Helper function to check if selectedDate is valid
  const isValidDate = (date: string | null | undefined) => {
    return date && date !== "" && date !== "0" && date !== null;
  };

  /** Normalize date to YYYYMMDD for date/races API. */
  const dateNormForRaces = (date: string | null | undefined): string => {
    if (!date || typeof date !== "string") return "";
    return String(date).replace(/[-/]/g, "").trim();
  };

  /** Page names that require races to be available (Race Summary, Start Summary, Prestart). Hide from sidebar when no races. */
  const RACE_DEPENDENT_REPORT_NAMES = ["RACESUMMARY", "STARTSUMMARY", "PRESTART"];

  /** Report names that require both marks for the day and races in hunidb/events. Only show when both exist. */
  const RACE_AND_MARKS_REPORT_NAMES = ["RACESUMMARY", "STARTSUMMARY"];

  const isRaceDependentReport = (pageName: string | null | undefined): boolean => {
    if (pageName == null || typeof pageName !== "string") return false;
    const normalized = String(pageName).replace(/\s+/g, "").toUpperCase();
    return RACE_DEPENDENT_REPORT_NAMES.includes(normalized);
  };

  const isRaceAndMarksReport = (pageName: string | null | undefined): boolean => {
    if (pageName == null || typeof pageName !== "string") return false;
    const normalized = String(pageName).replace(/\s+/g, "").toUpperCase();
    return RACE_AND_MARKS_REPORT_NAMES.includes(normalized);
  };

  /** Fetch races for the given class, project, and date. Returns empty array on failure or no races. */
  const fetchRacesForDate = async (
    className: string,
    projectId: string | number,
    dateNorm: string
  ): Promise<string[]> => {
    if (!className || !projectId || dateNorm.length !== 8) return [];
    try {
      const timezone = await getTimezoneForDate(className, Number(projectId), dateNorm);
      let url = `${apiEndpoints.app.datasets}/date/races?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(String(projectId))}&date=${encodeURIComponent(dateNorm)}`;
      if (timezone) url += `&timezone=${encodeURIComponent(timezone)}`;
      const result = await getData(url);
      if (!result?.success || !Array.isArray(result.data)) return [];
      const raceKeys = (result.data as { Race_number?: number }[])
        .map((r) => (r?.Race_number != null ? String(r.Race_number) : null))
        .filter((k): k is string => k != null && k !== "" && k !== "-1");
      return raceKeys;
    } catch (err) {
      debug("Sidebar: fetch races for date failed", err);
      return [];
    }
  };

  /** Check if marks exist for the given class, project, and date. Tries markwind first, then marks. */
  const fetchMarksExistForDate = async (
    className: string,
    projectId: string | number,
    dateStr: string
  ): Promise<boolean> => {
    if (!className || !projectId || !dateStr) return false;
    const parseMarksData = (raw: any): unknown[] => {
      const v = (raw as any)?.value ?? raw;
      if (Array.isArray(v)) return v;
      if (typeof v === "string") try { return JSON.parse(v); } catch { return []; }
      return v && typeof v === "object" ? [v] : [];
    };
    const hasMarksInArray = (arr: unknown[]): boolean => {
      if (arr.length === 0) return false;
      for (const item of arr) {
        const marks = (item as any)?.MARKS;
        if (Array.isArray(marks) && marks.length > 0) return true;
      }
      return false;
    };
    try {
      const markwindUrl = `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(String(projectId))}&date=${encodeURIComponent(dateStr)}&object_name=markwind`;
      let result = await getData(markwindUrl);
      if (result?.success && result?.data && hasMarksInArray(parseMarksData(result.data))) return true;
      const marksUrl = `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(String(projectId))}&date=${encodeURIComponent(dateStr)}&object_name=marks`;
      result = await getData(marksUrl);
      if (result?.success && result?.data && hasMarksInArray(parseMarksData(result.data))) return true;
      return false;
    } catch (err) {
      debug("Sidebar: fetch marks for date failed", err);
      return false;
    }
  };

  // Helper to check if user is administrator or publisher
  const isAdminOrPublisher = () => {
    const currentUser = user();
    if (!currentUser) return false;
    
    if (currentUser.is_super_user === true) return true;
    
    // Handle permissions as string, array, or object
    const userPermissions = currentUser.permissions;
    if (typeof userPermissions === 'string') {
      return userPermissions === 'administrator' || userPermissions === 'publisher';
    } else if (Array.isArray(userPermissions)) {
      return userPermissions.includes('administrator') || userPermissions.includes('publisher');
    } else if (typeof userPermissions === 'object' && userPermissions !== null) {
      const permissionValues = Object.values(userPermissions);
      return permissionValues.includes('administrator') || permissionValues.includes('publisher');
    }
    
    return false;
  };

  // Report menu items for display (readers can see POLAR REVIEW; edit is restricted on the page)
  const reportMenuItemsDisplay = createMemo(() => dynamicMenuItems2() || []);

  // Memoized value to check if Options section should be shown
  // Hide when a dataset is selected (selectedDatasetId > 0)
  // Options (upload video, dataset, race course) only when project selected and datasets form visible (no day/dataset selected)
  const shouldShowOptions = createMemo(() => {
    const datasetId = selectedDatasetId();
    // Always hide when a dataset is selected
    if (datasetId > 0) {
      return false;
    }
    const atProjectDatasetsLevel = datasetId === 0 && !isValidDate(selectedDate());
    // Video upload option - only when at project/datasets level (not when in a day viewing data)
    const videoOption = selectedMenu() == 'VIDEO' && atProjectDatasetsLevel && user() && (Array.isArray(user()?.permissions) ? user()?.permissions?.[0] : user()?.permissions) !== 'reader';
    // Dataset and Race Course options (not on targets or polars pages)
    const datasetOption = isAdminOrPublisher() && sidebarState() !== 'live' && atProjectDatasetsLevel && (selectedMenu() || '').replace(/\s+/g, '').toUpperCase() !== 'TARGETREVIEW' && selectedMenu() !== 'POLAR REVIEW';
    // Targets page option
    const targetsOption = datasetId == 0 && (selectedMenu() || '').replace(/\s+/g, '').toUpperCase() === 'TARGETREVIEW';
    // Polars page option
    const polarsOption = datasetId == 0 && selectedMenu() == 'POLAR REVIEW';
    // Live mode race course option
    const liveOption = isAdminOrPublisher() && sidebarState() === 'live';
    
    const shouldShow = videoOption || datasetOption || targetsOption || polarsOption || liveOption;
    
    debug('[Sidebar] Options section visibility:', {
      datasetId,
      videoOption,
      datasetOption,
      targetsOption,
      polarsOption,
      liveOption,
      shouldShow
    });
    
    return shouldShow;
  });
  
  // Debounce timer for component loading - declared at component level for cleanup
  let loadComponentTimeout: number | null = null;
  let currentLoadingPath: string | null = null;
  let currentComponent: any = null;
  
  // Flags to prevent duplicate API calls during initialization
  let isFetchingMenus = false;
  let isLoadingManeuverMenus = false;
  let fetchMenusTimeout: number | null = null;

  const { setSidebarInitialized, setComponent, fetchMenuTrigger, setFetchMenuTrigger, hasExistingDataset, openInSplitView, isSplitView, updateLeftComponent, rightPanelMenu, closeSplitView } = props;

  // Helper function to check if a menu item should be highlighted
  const isMenuActive = (menuName: string): boolean => {
    // Highlight based only on the left panel selection to avoid sticky highlights from split view
    // Handle MANEUVERS submenu format: "MANEUVERS_viewname"
    if (menuName.startsWith('MANEUVERS_')) {
      const viewName = menuName.replace('MANEUVERS_', '');
      return selectedMenu() === 'MANEUVERS' && selectedPage() === viewName;
    }
    // Parent explore menu (TIME SERIES / TIMESERIES) is active when a sub-item is selected (FLEET_TIMESERIES)
    const sel = selectedMenu() || '';
    const norm = (s: string) => (s || '').replace(/\s+/g, '').toUpperCase();
    if (norm(sel) === 'FLEET_TIMESERIES' && (norm(menuName) === 'TIMESERIES' || menuName === 'TIME SERIES')) return true;
    if (norm(sel) === 'FLEET_SCATTER' && norm(menuName) === 'SCATTER') return true;
    if (norm(sel) === 'FLEET_PROBABILITY' && norm(menuName) === 'PROBABILITY') return true;
    // Compare using canonical names so Map and Overlay are treated as the same
    return canonicalExploreMenuName(sel) === canonicalExploreMenuName(menuName);
  };

  // Function to detect screen size and set responsive state
  const checkScreenSize = (): void => {
    const width = window.innerWidth;
    const mobile = width <= 1000;
    setIsMobile(mobile);
    
    // Auto-collapse on mobile, restore desktop state on larger screens
    if (mobile) {
      setIsCollapsed(true);
      setShowMobileMenu(false);
    } else {
      // Restore collapsed state from localStorage for desktop
      const savedCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
      setIsCollapsed(savedCollapsed);
    }
  };

  // Function to toggle sidebar collapse
  const toggleSidebar = (): void => {
    if (isMobile()) {
      setShowMobileMenu(!showMobileMenu());
    } else {
      const newCollapsed = !isCollapsed();
      setIsCollapsed(newCollapsed);
      localStorage.setItem('sidebarCollapsed', newCollapsed.toString());
    }
  };

  // Function to handle double-click on sidebar
  const handleSidebarDoubleClick = (): void => {
    // Only handle double-click on desktop (not mobile)
    if (!isMobile()) {
      const newCollapsed = !isCollapsed();
      setIsCollapsed(newCollapsed);
      localStorage.setItem('sidebarCollapsed', newCollapsed.toString());
    }
  };

  // Function to build settings menu items based on current state
  const buildSettingsMenuItems = (): any[] => {
    debug('🔄 Sidebar: buildSettingsMenuItems called', {
      sidebarState: sidebarState(),
      datasetCount: datasetCount(),
      selectedMenu: selectedMenu()
    });
    const menuItems: any[] = [];

    const currentSidebarState = sidebarState();
    const currentPath = location.pathname;
    // Check if we're in project mode - either by sidebarState or by being on datasets/upload pages
    const isInProjectsArea = currentSidebarState === 'project' || 
                             currentPath.includes('/upload-datasets') || 
                             (currentPath.includes('/dashboard') && selectedMenu() === 'Datasets');
    const hasNoDatasets = datasetCount() === 0;
    const isInLiveMode = currentSidebarState === 'live';
    const normalizedSelectedMenu = (selectedMenu() || '').replace(/\s+/g, '').toUpperCase();

    // Check for Target Review tool - this should work regardless of sidebar state
    const hasTarget = normalizedSelectedMenu.includes('TARGET');
    const hasReview = normalizedSelectedMenu.includes('REVIEW');
    const hasTool = normalizedSelectedMenu.includes('TOOL');
    const isTargetsMenu = normalizedSelectedMenu === 'TARGETS';
    const menusWithPageSettings = new Set(['TIMESERIES', 'PARALLEL', 'SCATTER', 'PROBABILITY', 'MAP', 'VIDEO', 'PERFORMANCE', 'TARGETS', 'POLARROSE', 'GRID', 'TABLE']);
    
    // Check if this is the target review tool (not the regular TARGETS explore page)
    // Tools typically don't have a selectedPage, so if it's TARGETS without selectedPage, it's likely the tool
    const isTargetReviewTool = hasTarget && (hasReview || hasTool || (isTargetsMenu && !selectedPage()));
    
    // Helper to get user permissions as string
    const getUserPermission = () => {
      const currentUser = user();
      if (!currentUser) return null;
      
      // Handle permissions as string, array, or object
      if (typeof currentUser.permissions === 'string') {
        return currentUser.permissions;
      } else if (Array.isArray(currentUser.permissions)) {
        // Check if array contains administrator or publisher
        if (currentUser.permissions.includes("administrator")) return "administrator";
        if (currentUser.permissions.includes("publisher")) return "publisher";
        if (currentUser.permissions.includes("superuser")) return "superuser";
        // Return first permission if no admin/publisher found
        return currentUser.permissions[0] || null;
      } else if (typeof currentUser.permissions === 'object' && currentUser.permissions !== null) {
        // Handle permissions as object - check values
        const permissionValues = Object.values(currentUser.permissions);
        if (permissionValues.includes("administrator")) return "administrator";
        if (permissionValues.includes("publisher")) return "publisher";
        if (permissionValues.includes("superuser")) return "superuser";
        return permissionValues[0] || null;
      }
      
      return null;
    };

    // Helper to check if user is administrator or superuser
    const isAdminOrSuperUser = () => {
      const currentUser = user();
      if (!currentUser) return false;
      
      if (currentUser.is_super_user === true) return true;
      
      // Handle permissions as string, array, or object
      if (typeof currentUser.permissions === 'string') {
        return currentUser.permissions === "administrator" || currentUser.permissions === "superuser";
      } else if (Array.isArray(currentUser.permissions)) {
        return currentUser.permissions.includes("administrator") || currentUser.permissions.includes("superuser");
      } else if (typeof currentUser.permissions === 'object' && currentUser.permissions !== null) {
        const permissionValues = Object.values(currentUser.permissions);
        return permissionValues.includes("administrator") || permissionValues.includes("superuser");
      }
      
      return false;
    };
    
    debug('🔄 Sidebar: Checking for TARGET REVIEW menu', {
      selectedMenu: selectedMenu(),
      normalizedSelectedMenu: normalizedSelectedMenu,
      hasTarget: hasTarget,
      hasReview: hasReview,
      hasTool: hasTool,
      isTargetsMenu: isTargetsMenu,
      selectedPage: selectedPage(),
      isTargetReviewTool: isTargetReviewTool,
      sidebarState: currentSidebarState
    });

    if (isInProjectsArea) {
      // Add Target Review Page Settings even in project mode (show first)
      if (isTargetReviewTool && !(isTargetsMenu && selectedPage() && menusWithPageSettings.has(normalizedSelectedMenu))) {
        debug('🔄 Sidebar: Adding Page Settings for TARGET REVIEW tool (project mode)');
        menuItems.push({
          label: 'Page Settings',
          route: '/targets-builder'
        });
      }

      // Project Info - show for administrators, publishers, or superusers
      // Always show when in project mode, especially when there are no datasets
      // so users can update project info and add sources
      const projectId = selectedProjectId();
      const currentUser = user();
      const isAdmin = isAdminOrSuperUser();
      const isPublisher = isAdminOrPublisher();
      const userPerm = getUserPermission();
      
      // Show Project Info for admins, publishers, or superusers
      const shouldShowProjectInfo = projectId > 0 && (isAdmin || isPublisher);
      // Administrator Settings - only for administrators (not publishers)
      const shouldShowAdminSettings = userPerm === "administrator" || (currentUser?.is_super_user === true);
      
      // Detailed debug logging to understand permission structure
      debug('🔄 Sidebar: Project mode settings check - FULL USER OBJECT', {
        projectId: projectId,
        userExists: !!currentUser,
        userObject: currentUser ? {
          id: currentUser.id,
          username: currentUser.username,
          email: currentUser.email,
          is_super_user: currentUser.is_super_user,
          is_super_user_type: typeof currentUser.is_super_user,
          permissions: currentUser.permissions,
          permissions_type: typeof currentUser.permissions,
          permissions_isArray: Array.isArray(currentUser.permissions),
          allKeys: Object.keys(currentUser)
        } : null,
        permissionChecks: {
          getUserPermission_result: userPerm,
          isAdminOrSuperUser_result: isAdmin,
          isAdminOrPublisher_result: isPublisher,
          is_super_user_check: currentUser?.is_super_user === true,
          is_super_user_value: currentUser?.is_super_user,
          permissions_includes_admin: Array.isArray(currentUser?.permissions) ? currentUser.permissions.includes("administrator") : false,
          permissions_includes_publisher: Array.isArray(currentUser?.permissions) ? currentUser.permissions.includes("publisher") : false
        },
        shouldShow: {
          shouldShowProjectInfo: shouldShowProjectInfo,
          shouldShowAdminSettings: shouldShowAdminSettings
        },
        hasNoDatasets: hasNoDatasets
      });
      
      if (shouldShowProjectInfo) {
        menuItems.push({
          label: 'Project Info',
          route: '/project-info'
        });
      }

      // Administrator Settings - show for administrators and superusers
      // Always show when in project mode, especially when there are no datasets
      // so users can add sources through the admin panel
      if (shouldShowAdminSettings) {
        menuItems.push({
          label: 'Administrator Settings',
          route: '/admin'
        });
      }
    } else if (isInLiveMode) {
      // Live mode settings menu items
      // Similar to dataset mode but for live streaming
      
      // Add Target Review Page Settings even in live mode
      if (isTargetReviewTool && !(isTargetsMenu && selectedPage() && menusWithPageSettings.has(normalizedSelectedMenu))) {
        debug('🔄 Sidebar: Adding Page Settings for TARGET REVIEW tool (live mode)');
        menuItems.push({
          label: 'Page Settings',
          route: '/targets-builder'
        });
      }

      if (getUserPermission() === "administrator") {
        menuItems.push({
          label: 'Administrator Settings',
          route: '/admin'
        });
      }
    } else {
      // Show Page Settings for Timeseries and Map menus even without selectedPage
      const showPageSettingsForTimeseriesOrMap = (normalizedSelectedMenu === 'TIMESERIES' || normalizedSelectedMenu === 'MAP');
      
      if (menusWithPageSettings.has(normalizedSelectedMenu) && (selectedPage() || showPageSettingsForTimeseriesOrMap)) {
        menuItems.push({
          label: 'Page Settings',
          route: () => handlePageSettings(selectedMenu())
        });
      }

      // Target Review Page Settings
      if (isTargetReviewTool && !(isTargetsMenu && selectedPage() && menusWithPageSettings.has(normalizedSelectedMenu))) {
        debug('🔄 Sidebar: Adding Page Settings for TARGET REVIEW tool');
        menuItems.push({
          label: 'Page Settings',
          route: '/targets-builder'
        });
      }

      // Notes Page Settings
      if (normalizedSelectedMenu === 'NOTES') {
        menuItems.push({
          label: 'Page Settings',
          route: '/dataset-info'
        });
      }

      // Dataset Info Settings - hide when in dataset mode or when selectedDate is valid
      if (getUserPermission() === "administrator" && currentSidebarState !== 'dataset' && !isValidDate(selectedDate())) {
        menuItems.push({
          label: 'Edit Dataset Info',
          route: '/dataset-info'
        });
      }

      // Admin Settings - always show for enterprise users
      if (getUserPermission() === "administrator") {
        menuItems.push({
          label: 'Administrator Settings',
          route: '/admin'
        });
      }
    }

    setSettingsMenuItems(menuItems);
    
    // Debug: Log the final menu items to help troubleshoot
    debug('🔄 Sidebar: buildSettingsMenuItems completed', {
      menuItemsCount: menuItems.length,
      menuItems: menuItems.map(item => item.label),
      sidebarState: currentSidebarState,
      isInProjectsArea,
      hasNoDatasets,
      selectedProjectId: selectedProjectId(),
      isAdmin: isAdminOrSuperUser(),
      userPermission: getUserPermission()
    });
    
    return menuItems;
  };

  // Function to toggle dropdown for user page menus (accordion: only one submenu open at a time)
  const toggleUserMenuDropdown = (parentName: string) => {
    setExpandedMenus(prev => {
      if (prev.has(parentName)) {
        // Closing this submenu
        const newSet = new Set(prev);
        newSet.delete(parentName);
        return newSet;
      }
      // Opening this submenu: close any other open submenus
      return new Set([parentName]);
    });
  };

  // Function to restore state from persistent store
  const restoreStateFromStore = async () => {
    // Don't restore state if we're on a route that doesn't use the sidebar component system
    const currentPath = location.pathname;
    const routesWithoutSidebar = ['/events', '/admin', '/profile', '/project', '/project-info', '/dataset-info', '/day-info', 
      '/targets-builder', '/performance-builder', '/scatter-builder', '/timeseries-builder', '/probability-builder',
      '/overlay-builder', '/parallel-builder', '/polar-rose-builder', '/grid-builder', '/table-builder', 
      '/video-builder', '/video-sync', '/upload-datasets', '/upload-targets', '/upload-race-course', 
      '/upload-video', '/upload-images', '/window'];
    
    if (routesWithoutSidebar.some(route => currentPath.startsWith(route))) {
      debug('🔄 Sidebar: Skipping state restoration - on route that does not use sidebar component system', {
        currentPath
      });
      return;
    }
    
    const currentMenu = selectedMenu();
    const currentPage = selectedPage();
    
    const hasDataset = selectedDatasetId() > 0;
    const hasDate = selectedDate() && selectedDate() !== '';
    
    debug('🔄 Sidebar: restoreStateFromStore called', {
      currentMenu,
      currentPage,
      selectedDatasetId: selectedDatasetId(),
      selectedDate: selectedDate(),
      hasDataset,
      hasDate,
      currentPath
    });
    
    // Don't restore if currentMenu is 'EVENTS' - Events page should not trigger other component loading
    if (currentMenu && (currentMenu.toUpperCase() === 'EVENTS' || currentMenu.toUpperCase() === 'EVENT')) {
      debug('🔄 Sidebar: Skipping state restoration - Events page is active', {
        currentMenu
      });
      return;
    }
    
    
    // On reload: restore to the user's selected explore menu (Map, Scatter, Probability, etc.) when we have
    // dataset or date context. Allow restoration even when selectedPage is empty (e.g. Map has no sub-pages).
    // Fresh browser (no persisted menu) continues to use "first report" logic elsewhere.
    // Note: PERFORMANCE is NOT a user page type - it's a regular dataset report
    const userPageTypes = ['TIME SERIES', 'SCATTER', 'PROBABILITY', 'POLAR ROSE', 'TABLE', 'GRID', 'PARALLEL', 'VIDEO', 'BOAT', 'MAP', 'TARGETS'];
    if (userPageTypes.includes(currentMenu) && (hasDataset || hasDate)) {
      debug('🔄 Sidebar: Found user/explore page type, attempting restoration', {
        currentMenu,
        currentPage,
        isUserPageType: true
      });
      // Convert menu name to lowercase and handle spaces for loadExploreComponent
      const builderType = currentMenu.toLowerCase().replace(/\s+/g, '');
      debug('🔄 Sidebar: Loading explore component', {
        builderType,
        currentPage: currentPage || '(empty)',
        originalMenu: currentMenu,
        mode: hasDataset ? 'dataset' : 'day'
      });
      await loadExploreComponent(builderType, currentPage || '');
      return;
    }
    if (userPageTypes.includes(currentMenu) && !hasDataset && !hasDate) {
      debug('🔄 Sidebar: No valid dataset or date for explore menu, clearing stale state');
      setSelectedMenu('Datasets');
      setSelectedPage('');
      setComponent(() => DatasetsComponent());
      return;
    }
    
    // Check if Dashboard Studio was the last viewed page
    if (currentMenu === 'DASHBOARD STUDIO') {
      await loadExploreComponent('dashboard', ''); // Pass empty string explicitly
      return;
    }
    
    // Check if this is a MANEUVERS menu with a view (submenu)
    if (currentMenu === 'MANEUVERS' && currentPage && currentPage !== '') {
      debug('🔄 Sidebar: Found MANEUVERS with view, attempting restoration', {
        currentMenu,
        currentPage,
        selectedDatasetId: selectedDatasetId(),
        selectedSourceId: selectedSourceId()
      });
      
      // Restore maneuver state - works in dataset mode, project mode, or historical mode
      // ManeuverWindow can handle all contexts (dataset, fleet, historical)
      await loadManeuverWindow(currentPage);
      return;
    }
    
    // For regular menu items, find the menu item and load its component
    if (currentMenu && currentMenu !== '' && currentMenu !== 'Datasets') {
      const menuItem = findMenuItemByPageName(currentMenu);
      if (menuItem) {
        // Check if page name contains 'Live' - require live mode to be enabled
        if (menuItem.page_name && menuItem.page_name.toLowerCase().includes('live')) {
          if (!liveMode()) {
            logError(`Cannot load "${menuItem.page_name}" - Live mode must be enabled first`);
            return;
          }
          debug('Sidebar: Loading Live component, live mode is enabled');
        }
        await loadComponent(menuItem.file_path);
        return;
      }
    }
    
  };

  // Map fleet parent names (API keys) to menu page names for component lookup
  const parentNameToMenuPageName = (parentName: string): string => {
    const key = (parentName || '').toString().toLowerCase().replace(/\s+/g, '');
    if (key === 'fleet_timeseries') return 'TIME SERIES';
    if (key === 'fleet_scatter') return 'SCATTER';
    if (key === 'fleet_probability') return 'PROBABILITY';
    return parentName;
  };

  // Canonical name for explore menus: use "MAP" for map/overlay (Overlay is internal), "TIME SERIES" for timeseries; used for display, selectedMenu, and split view.
  const canonicalExploreMenuName = (pageName: string): string => {
    if (!pageName) return pageName;
    const key = (pageName || '').toString().toLowerCase().replace(/\s+/g, '');
    if (key === 'map' || key === 'overlay') return 'MAP';
    if (key === 'timeseries' || key === 'fleet_timeseries') return 'TIME SERIES';
    if (key === 'fleet_scatter') return 'SCATTER';
    if (key === 'fleet_probability') return 'PROBABILITY';
    return pageName;
  };

  // Canonical display name for explore menus (API may return 'TIMESERIES' or 'Overlay'; we show 'TIME SERIES' and 'MAP')
  const getExploreMenuDisplayName = (pageName: string): string => canonicalExploreMenuName(pageName);

  // URL slug for builder routes (must match handlePageSettings and router paths)
  const getBuilderSlug = (normalizedPageName: string, pageName: string): string => {
    if (normalizedPageName === 'TIMESERIES') return 'timeseries';
    if (normalizedPageName === 'POLARROSE') return 'polar-rose';
    if (normalizedPageName === 'MAP') return 'overlay';
    return (pageName || normalizedPageName).toLowerCase().replace(/\s+/g, '-');
  };

  // Helper function to find menu item by page name (normalize: lowercase, remove spaces).
  // Map and Overlay are the same page; API may return either, so try both for reliable split view when Map is selected.
  const findMenuItemByPageName = (pageName: string) => {
    const normalize = (s: string) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
    const menuPageName = parentNameToMenuPageName(pageName);
    const key = normalize(menuPageName);
    const find = (items: any[], k: string) => items.find(item => normalize(item.page_name) === k);
    const d1 = dynamicMenuItems1() || [];
    const d2 = dynamicMenuItems2() || [];
    // Look in dynamicMenuItems1 first
    let menuItem = find(d1, key) || find(d2, key);
    if (menuItem) return menuItem;
    // Map/Overlay alias: when resolving Map, also try Overlay (and vice versa) so split view works when Map is selected
    if (key === 'map' || key === 'overlay') {
      const alt = key === 'map' ? 'overlay' : 'map';
      menuItem = find(d1, alt) || find(d2, alt);
      if (menuItem) return menuItem;
    }
    return null;
  };

  // Day/explore components use Fleet* names (FleetMap, FleetVideo, FleetTimeSeries) but API may return path_name Map, Overlay, Video, TimeSeries
  const DAY_EXPLORE_FLEET_ALIAS: Record<string, string> = {
    'map': 'FleetMap',
    'overlay': 'FleetMap', // MAP page in day/explore often uses path_name Overlay (same as builder slug)
    'video': 'FleetVideo',
    'timeseries': 'FleetTimeSeries',
  };

  /** When in day mode, use this path for split view so we load FleetMap/FleetVideo/FleetTimeSeries instead of dataset explore components. Map is always "MAP" in UI. */
  const getDayExploreFilePath = (pageName: string): string | null => {
    // Normalize: lowercase, no spaces, no underscores (so TIME_SERIES / Time Series -> timeseries)
    let key = (pageName || '').toString().toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
    // Normalize "fleet video" / "fleetvideo" -> "video", "fleet timeseries" -> "timeseries", etc.
    if (key.startsWith('fleet')) key = key.replace(/^fleet_?/, '') || key;
    const fleetName = DAY_EXPLORE_FLEET_ALIAS[key];
    return fleetName ? `gp50/day/explore/${fleetName}` : null;
  };

  /** Day report page_name -> file path (no extension). Used when day_pages returns dataset paths; load Fleet* day components instead. */
  const DAY_REPORT_PATH: Record<string, string> = {
    'performance': 'gp50/day/reports/FleetPerformance',
    'maneuvers': 'gp50/day/reports/FleetManeuvers',
    'racesummary': 'gp50/day/reports/RaceSummary',
    'trainingsummary': 'gp50/day/reports/TrainingSummary',
    'prestart': 'gp50/day/reports/Prestart',
  };
  const getDayReportFilePath = (pageName: string): string | null => {
    if (!pageName || typeof pageName !== 'string') return null;
    const key = (pageName || '').toString().toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
    return DAY_REPORT_PATH[key] ?? null;
  };

  // Helper function to load component from file path
  const loadComponentFromPath = async (filePath: string) => {
    debug('[Sidebar] loadComponentFromPath ENTRY', { filePath });
    
    try {
      // Remove any file extension to let Vite resolve the correct compiled file
      const basePath = filePath.replace(/\.(jsx|tsx|js|ts)$/, '');
      debug('[Sidebar] basePath after extension removal', { basePath });
      
      // Convert file path to the glob key format (relative to reports directory)
      // e.g., "gp50/dataset/explore/Map" -> "../../reports/gp50/dataset/explore/Map.tsx"
      let globKey = `../../reports/${basePath}.tsx`;
      debug('[Sidebar] Initial glob key', { globKey });
      
      // Get the loader function from the glob map (try exact match first)
      let loader = reportModules[globKey];
      debug('[Sidebar] Exact match loader', { found: !!loader });
      
      // If not found and path is day/explore with Map/Video/TimeSeries, try Fleet* component (splitscreen fix for FleetMap, FleetVideo, FleetTimeSeries)
      if (!loader && basePath.includes('day/explore')) {
        const segments = basePath.split('/');
        const lastSegmentRaw = segments[segments.length - 1] || '';
        let lastSegment = lastSegmentRaw.toLowerCase().replace(/_/g, '');
        if (lastSegment.startsWith('fleet')) lastSegment = lastSegment.replace(/^fleet_?/, '') || lastSegment;
        const fleetName = DAY_EXPLORE_FLEET_ALIAS[lastSegment];
        if (fleetName) {
          const prefix = segments.slice(0, -1).join('/');
          const fleetPath = prefix ? `${prefix}/${fleetName}` : fleetName;
          const fleetGlobKey = `../../reports/${fleetPath}.tsx`;
          loader = reportModules[fleetGlobKey];
          if (loader) {
            debug(`[Sidebar] Resolved day/explore component: ${basePath} -> ${fleetPath}`);
          }
        }
      }
      // If still not found and path is dataset/explore with Map/Video/TimeSeries, try day/explore Fleet* (e.g. when API returns dataset path in day context)
      if (!loader && basePath.includes('dataset/explore')) {
        const segments = basePath.split('/');
        const lastSegmentRaw = segments[segments.length - 1] || '';
        let lastSegment = lastSegmentRaw.toLowerCase().replace(/_/g, '');
        if (lastSegment.startsWith('fleet')) lastSegment = lastSegment.replace(/^fleet_?/, '') || lastSegment;
        const fleetName = DAY_EXPLORE_FLEET_ALIAS[lastSegment];
        if (fleetName) {
          const fleetPath = `gp50/day/explore/${fleetName}`;
          const fleetGlobKey = `../../reports/${fleetPath}.tsx`;
          loader = reportModules[fleetGlobKey];
          if (loader) {
            debug(`[Sidebar] Resolved dataset/explore to day/explore Fleet: ${basePath} -> ${fleetPath}`);
          }
        }
      }
      
      // If not found, try case-insensitive matching
      if (!loader) {
        const lowerBasePath = basePath.toLowerCase();
        const matchingKey = Object.keys(reportModules).find(key => 
          key.toLowerCase() === globKey.toLowerCase()
        );
        
        if (matchingKey) {
          loader = reportModules[matchingKey];
          debug(`[Sidebar] Found component with case-insensitive match: ${matchingKey} (requested: ${globKey})`);
        }
      }
      
      if (!loader) {
        // List available keys for debugging (show first 10)
        const availableKeys = Object.keys(reportModules).slice(0, 10);
        throw new Error(`Component not found in glob map: ${basePath}. Available keys: ${availableKeys.join(', ')}...`);
      }
      
      // Load the module using the glob loader
      const module = await loader();
      
      if (!module || !module.default) {
        throw new Error(`Module loaded but has no default export: ${basePath}`);
      }
      
      return module.default;
    } catch (error: any) {
      logError(`Error loading component from path ${filePath}:`, error);
      throw error;
    }
  };

  // Function to load explore component with user object
  /**
   * Ensure sources are initialized before loading components
   * This ensures correct source information is available for drawing
   */
  const ensureSourcesReady = async (): Promise<void> => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    
    if (!className || !projectId) {
      debug('[Sidebar] No className or projectId, skipping source initialization');
      return;
    }
    
    // Check if sources are already ready
    if (sourcesStore.isReady()) {
      debug('[Sidebar] Sources already ready');
      return;
    }
    
    debug('[Sidebar] Waiting for sources to initialize...');
    // Wait for sources to be ready (with shorter timeout for faster initial load)
    let attempts = 0;
    const maxAttempts = 10; // 1 second max wait (reduced from 5 seconds)
    while (!sourcesStore.isReady() && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }
    
    if (sourcesStore.isReady()) {
      debug('[Sidebar] Sources initialized successfully', {
        sourceCount: sourcesStore.sources().length
      });
    } else {
      warn('[Sidebar] Sources not ready after waiting, proceeding anyway');
    }
  };

  const loadExploreComponent = async (builderType: string, objectName: string) => {
    try {
      // Ensure sources are ready before loading component
      await ensureSourcesReady();
      
      // Normalize objectName to prevent undefined from causing reactive loops
      const normalizedObjectName = objectName || '';
      
      // Map fleet parent names (fleet_timeseries, etc.) to menu page name for component lookup
      const menuPageName = parentNameToMenuPageName(builderType);
      const menuItem = findMenuItemByPageName(menuPageName);
      
      if (!menuItem) {
        logError(`Menu item not found for builder type: ${builderType}`);
        return;
      }

      // Check if page name contains 'Live' - require live mode to be enabled
      if (menuItem.page_name && menuItem.page_name.toLowerCase().includes('live')) {
        if (!liveMode()) {
          logError(`Cannot load "${menuItem.page_name}" - Live mode must be enabled first`);
          setComponent(null);
          return;
        }
        debug('Sidebar: Loading Live component, live mode is enabled');
      }

      // In day mode use day/explore Fleet path (FleetMap, FleetVideo, FleetTimeSeries) so Map loads correctly and split view works
      const isDayModeExplore = isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0);
      const componentPath = isDayModeExplore ? (getDayExploreFilePath(menuItem.page_name) || menuItem.file_path) : menuItem.file_path;

      // Load the component
      const Component = await loadComponentFromPath(componentPath);
      
      // Create a wrapper component that passes the object_name as a prop
      const WrappedExplore = (props: any) => {
        return <Component {...props} objectName={normalizedObjectName} />;
      };
      
      setComponent(() => WrappedExplore);
      setSelectedPage(normalizedObjectName);
    } catch (error: any) {
      logError(`Error loading explore component ${builderType}:`, error);
      setComponent(null);
    }
  };

  // Function to load explore component for split view
  const loadExploreComponentForSplitView = async (builderType: string, objectName: string, title: string, menuName: string | null = null) => {
    try {
      // Ensure sources are ready before loading component
      await ensureSourcesReady();
      
      const menuPageName = parentNameToMenuPageName(builderType);
      const menuItem = findMenuItemByPageName(menuPageName);
      
      if (!menuItem) {
        logError(`Menu item not found for builder type: ${builderType}`);
        return;
      }

      // Check if page name contains 'Live' - require live mode to be enabled
      if (menuItem.page_name && menuItem.page_name.toLowerCase().includes('live')) {
        if (!liveMode()) {
          logError(`Cannot load "${menuItem.page_name}" - Live mode must be enabled first`);
          return;
        }
        debug('Sidebar: Loading Live component, live mode is enabled');
      }

      // In day mode use day/explore Fleet path so we load FleetMap/FleetVideo/FleetTimeSeries (same as loadExploreComponentForLeftPanel)
      const isDayModeExplore = isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0);
      const componentPath = isDayModeExplore ? (getDayExploreFilePath(menuItem.page_name) || menuItem.file_path) : menuItem.file_path;

      // Load the component
      const Component = await loadComponentFromPath(componentPath);
      
      // Create a wrapper component that passes the object_name as a prop
      const WrappedExplore = (props: any) => {
        return <Component {...props} objectName={objectName} />;
      };
      
      if (openInSplitView) {
        // Defer so state update runs in next macrotask and Solid creates computations inside createRoot (fixes splitscreen warning)
        setTimeout(() => {
          openInSplitView(() => WrappedExplore, title);
        }, 0);
      }
    } catch (error: any) {
      logError(`Error loading explore component for split view ${builderType}:`, error);
    }
  };

  // Function to load ManeuverWindow component with view prop
  const loadManeuverWindow = async (viewName: string) => {
    try {
      // Ensure sources are ready before loading component
      await ensureSourcesReady();
      
      // Use @pages alias so Vite resolves the chunk path correctly (avoids "Failed to fetch dynamically imported module")
      const module = await import('@pages/ManeuverWindow');
      const Component = module.default;
      
      // Create a wrapper component that passes the view prop
      const WrappedManeuverWindow = (props: any) => {
        return <Component {...props} view={viewName} />;
      };
      
      setComponent(() => WrappedManeuverWindow);
      setSelectedMenu('MANEUVERS');
      setSelectedPage(viewName);
    } catch (error: any) {
      logError(`Error loading ManeuverWindow with view ${viewName}:`, error);
      setComponent(null);
    }
  };

  // Function to handle maneuver menu click
  const handleManeuverMenuClick = (viewName: string, event: MouseEvent | null = null) => {
    const isCtrlPressed = event?.ctrlKey || (event as any)?.metaKey;
    const isShiftPressed = event?.shiftKey;
    
    // Guard: prevent opening the same maneuver window in split view if it's already on the left
    const isSameManeuverAsLeft = () => {
      if ((selectedMenu() || '').toString().toUpperCase() !== 'MANEUVERS') return false;
      return (selectedPage() || '') === viewName;
    };
    
    // Guard: check if ANY ManeuverWindow is already in split view's right panel
    const isAnyManeuverInSplitView = () => {
      if (!isSplitView()) return false;
      const rightMenu = rightPanelMenu?.();
      if (!rightMenu) return false;
      // Check if right panel has ANY maneuver view (format: MANEUVERS_viewName)
      return rightMenu.toString().startsWith('MANEUVERS_');
    };
    
    // Special case: prevent split view when MANEUVERS is the selected menu
    const isManeuversSelected = () => {
      return (selectedMenu() || '').toString().toUpperCase() === 'MANEUVERS';
    };
    
    if (isCtrlPressed && isShiftPressed) {
      // Ctrl+Shift+click - open in new window
      const maneuversMenuItem = findMenuItemByPageName('MANEUVERS');
      if (maneuversMenuItem) {
        openComponentInNewWindow('MANEUVERS', viewName);
      }
    } else if (isCtrlPressed) {
      // Ctrl+click - open in split view WITHOUT updating selectedMenu
      // Special case: prevent split view when MANEUVERS is already selected
      if (isManeuversSelected()) {
        log('Split view prevented: MANEUVERS is selected menu, split view disabled for maneuver dropdowns');
        return;
      }
      if (isSameManeuverAsLeft()) {
        log('Split view prevented: same maneuver view already open on left');
        return;
      }
      loadManeuverWindowForSplitView(viewName);
    } else {
      // Normal click - prevent if ANY ManeuverWindow is already in split view
      if (isAnyManeuverInSplitView()) {
        log('Cannot load maneuver in main view: ManeuverWindow already open in split view');
        warn('A ManeuverWindow is already open in split view. Close split view first before opening a maneuver page in the main view.');
        return;
      }
      // Normal click
      setSelectedMenu('MANEUVERS');
      setSelectedPage(viewName);
      setIsProjectMenuActive(false);
      loadManeuverWindow(viewName);
    }
  };

  // Function to load ManeuverWindow for split view
  const loadManeuverWindowForSplitView = async (viewName: string) => {
    try {
      // Use @pages alias so Vite resolves the chunk path correctly
      const module = await import('@pages/ManeuverWindow');
      const Component = module.default;
      
      const WrappedManeuverWindow = (props: any) => {
        return <Component {...props} view={viewName} />;
      };
      
      if (openInSplitView) {
        queueMicrotask(() => {
          openInSplitView(() => WrappedManeuverWindow, `MANEUVERS: ${viewName}`);
        });
      }
    } catch (error: any) {
      logError(`Error loading ManeuverWindow for split view with view ${viewName}:`, error);
    }
  };

  // Function to handle user page menu click
  const handleUserPageClick = (parentName: string, objectName: string | null = null, event: MouseEvent | null = null) => {
    const objects = userPageObjects().get(parentName) || [];
    const isCtrlPressed = event?.ctrlKey || (event as any)?.metaKey;
    const isShiftPressed = event?.shiftKey;
    
    // Guard: prevent opening the same explore page in split view if it's already on the left
    const isSameExploreAsLeft = () => {
      const normalizedLeftMenu = (selectedMenu() || '').toString().replace(/\s+/g, '').toLowerCase();
      const normalizedParent = (parentName || '').toString().replace(/\s+/g, '').toLowerCase();
      if (normalizedLeftMenu !== normalizedParent) return false;
      if (!objectName) return false;
      return (selectedPage() || '') === objectName;
    };
    
    if (objects.length === 1) {
      // Single object, navigate directly
      const object = objects[0];
      
      if (isCtrlPressed && isShiftPressed) {
        // Ctrl+Shift+click - open in new window
        openComponentInNewWindow(parentName.toUpperCase(), object.object_name);
      } else if (isCtrlPressed) {
        // Ctrl+click - open in split view WITHOUT updating selectedMenu
        // Don't update selectedMenu - keep the current left panel menu
        if (isSameExploreAsLeft()) {
          log('Split view prevented: same explore view already open on left');
          return;
        }
        // Use uppercase parentName to match menu item page_name format
        loadExploreComponentForSplitView(parentName.toUpperCase(), object.object_name, `${parentName}: ${object.object_name}`, `${parentName}_${object.object_name}`);
      } else {
        // Normal click
        setSelectedMenu(canonicalExploreMenuName(parentName));
        setSelectedPage(object.object_name);
        setIsProjectMenuActive(false);
        setSelectedMenu(canonicalExploreMenuName(parentName));
        setSelectedPage(object.object_name);
        setIsProjectMenuActive(false);
        // Use uppercase parentName to match menu item page_name format
        loadExploreComponent(parentName.toUpperCase(), object.object_name);
      }
    } else if (objectName) {
      // Multiple objects, user selected specific one
      if (isCtrlPressed && isShiftPressed) {
        // Ctrl+Shift+click - open in new window
        openComponentInNewWindow(parentName.toUpperCase(), objectName);
      } else if (isCtrlPressed) {
        // Ctrl+click - open in split view WITHOUT updating selectedMenu
        // Don't update selectedMenu - keep the current left panel menu
        if (isSameExploreAsLeft()) {
          log('Split view prevented: same explore view already open on left');
          return;
        }
        // Use uppercase parentName to match menu item page_name format
        loadExploreComponentForSplitView(parentName.toUpperCase(), objectName, `${parentName}: ${objectName}`, `${parentName}_${objectName}`);
      } else {
        // Normal click
        setSelectedMenu(canonicalExploreMenuName(parentName));
        setSelectedPage(objectName);
        setIsProjectMenuActive(false);
        setSelectedMenu(canonicalExploreMenuName(parentName));
        setSelectedPage(objectName);
        setIsProjectMenuActive(false);
        // Use uppercase parentName to match menu item page_name format
        loadExploreComponent(parentName.toUpperCase(), objectName);
      }
    } else {
      // Multiple objects, toggle dropdown
      toggleUserMenuDropdown(parentName);
    }
  };

  // Function to broadcast selection updates to all child windows
  const broadcastSelectionUpdate = (selectionData: any, excludeWindow: string | null = null) => {
    childWindows().forEach((windowRef, windowName) => {
      if (windowName !== excludeWindow && windowRef && !windowRef.closed) {
        // Check if window is visible before sending update
        try {
          if (!windowRef.document.hidden) {
            windowRef.postMessage({
              type: 'SELECTION_STORE_UPDATE',
              payload: selectionData
            }, window.location.origin);
          }
        } catch (error: any) {
          // Window might be closed or inaccessible, remove it from the map

          setChildWindows(prev => {
            const newMap = new Map(prev);
            newMap.delete(windowName);
            return newMap;
          });
        }
      }
    });
  };

  // Function to send selection updates - MOVED TO TOP
  const sendSelectionUpdateToChildren = (selectionData: any) => {
    broadcastSelectionUpdate(selectionData);
  };

  // Add this new function - MOVED TO TOP
  const openComponentInNewWindow = (pageName: string, objectName: string | null = null) => {
    const projectId = selectedProjectId();
    const className = selectedClassName();
    const datasetId = selectedDatasetId?.() ?? 0;
    const date = selectedDate?.() ?? '';

    // Determine whether we're in dataset mode or date (day) mode
    const hasValidDate = !!date && date !== '0';

    // Base path without dataset/date – we'll append the appropriate context below
    let path = `/window?project_id=${encodeURIComponent(projectId)}&page_name=${encodeURIComponent(pageName)}&class_name=${encodeURIComponent(className)}`;

    if (!hasValidDate) {
      // Dataset mode or fleet history (no date) -> use dataset_id
      path += `&dataset_id=${encodeURIComponent(datasetId)}`;
      // Fleet history: no date and no dataset → make context explicit so ManeuverWindow uses best-fleet-maneuvers
      if (pageName.toUpperCase() === 'MANEUVERS' && (datasetId === 0 || !datasetId)) {
        path += '&context=fleet';
      }
    } else {
      // Day / fleet mode (single date) -> pass date instead of dataset_id
      path += `&date=${encodeURIComponent(date)}`;
    }

    // Add object_name parameter if provided (for explore menus with specific objects)
    if (objectName) {
      path += `&object_name=${encodeURIComponent(objectName)}`;
    }
    
    // Ensure we always open the window over HTTPS using the current host
    let fullUrl = path;
    if (typeof window !== 'undefined') {
      const host = window.location.host;
      fullUrl = `https://${host}${path}`;
    }

    const windowFeatures = 'width=1200,height=800,scrollbars=yes,resizable=yes';
    const windowName = `component_${pageName}_${objectName || 'default'}_${Date.now()}`;
    window.open(fullUrl, windowName, windowFeatures);
  };

  const fetchClass = async () => {
    try {
      const projectId = selectedProjectId();
      debug('[Sidebar] fetchClass called with projectId:', projectId);
      
      if (!projectId || projectId <= 0) {
        logError('[Sidebar] fetchClass: Invalid projectId:', projectId);
        return;
      }
      
      const controller = new AbortController();
      const url = `${apiEndpoints.app.projects}/class?project_id=${encodeURIComponent(projectId)}`;
      debug('[Sidebar] fetchClass URL:', url);
      
      const response = await getData(url, controller.signal)

      debug('[Sidebar] fetchClass response:', response);
      
      if (response.success && response.data) {
        // Handle both old format (string) and new format (object with class_name, icon, and size_m)
        let className: string;
        let icon: string | null = null;
        let sizeM: number | null = null;
        let classObject: { class_name: string; icon?: string | null; size_m?: number | null } | null = null;
        
        if (typeof response.data === 'string') {
          // Backward compatibility: old format returns just the class name string
          className = response.data.toLowerCase();
          classObject = { class_name: className };
        } else if (response.data && typeof response.data === 'object') {
          // New format: object with class_name, icon, and size_m
          className = (response.data.class_name || '').toLowerCase();
          // Handle icon - check for both 'icon' and 'Icon' keys, and handle empty strings
          const iconValue = response.data.icon || response.data.Icon || null;
          icon = (iconValue && typeof iconValue === 'string' && iconValue.trim() !== '') ? iconValue.trim() : null;
          // Handle size_m - convert to number if present
          const sizeMValue = response.data.size_m !== null && response.data.size_m !== undefined 
            ? Number(response.data.size_m) 
            : null;
          sizeM = (!isNaN(sizeMValue as number) && sizeMValue !== null) ? sizeMValue : null;
          // Store the full object
          classObject = {
            class_name: className,
            icon: icon,
            size_m: sizeM
          };
          debug('[Sidebar] Extracted class data from response:', { rawIcon: iconValue, processedIcon: icon, sizeM, responseData: response.data });
        } else {
          logError('[Sidebar] fetchClass: Unexpected response data format:', response.data);
          return;
        }
        
        debug('[Sidebar] Setting selectedClassName to:', className);
        debug('[Sidebar] Setting selectedClassIcon to:', icon);
        debug('[Sidebar] Setting selectedClassSizeM to:', sizeM);
        debug('[Sidebar] Setting selectedClassObject to:', classObject);
        setSelectedClassName(className);
        setSelectedClassIcon(icon);
        setSelectedClassSizeM(sizeM);
        setSelectedClassObject(classObject);
        debug('[Sidebar] selectedClassName after setSelectedClassName call:', selectedClassName());
      } else {
        logError('[Sidebar] fetchClass failed or no data:', response);
        // Try to get className from projects data as fallback
        const currentProject = projects()?.find(p => p.project_id === projectId);
        if (currentProject && currentProject.class_name) {
          const fallbackClassName = currentProject.class_name.toLowerCase();
          warn('[Sidebar] Using className from project data as fallback:', fallbackClassName);
          setSelectedClassName(fallbackClassName);
          setSelectedClassIcon(null); // No icon available from fallback
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        debug('[Sidebar] fetchClass aborted');
      } else {
        logError('Error fetching class:', error);
      }
    }
  };

  // Function to fetch user page object names for a specific parent_name
  const fetchUserPageNames = async (parentName: string) => {
    try {
      const controller = new AbortController();
      const currentUser = user();
      if (!currentUser || !currentUser.user_id) {
        warn('[Sidebar] User not available, skipping fetchUserPageNames');
        return [];
      }
      
      const normalizedParentName = parentName.toLowerCase().replace(/\s+/g, '');
      const url = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=${normalizedParentName}`;
      
      const response = await getData(url, controller.signal);
      
      if (response.success && response.data) {
        // Ensure we return an array of objects with object_name property
        const result = Array.isArray(response.data) ? response.data : [];
        return result;
      }
      return [];
    } catch (error: any) {
      logError(`Error fetching user page names for ${parentName}:`, error);
      return [];
    }
  };

  // Function to fetch maneuver menus
  const fetchManeuverMenus = async () => {
    try {
      if (!selectedClassName() || !selectedProjectId()) {
        debug('🔄 Sidebar: fetchManeuverMenus skipped - missing className or projectId');
        return;
      }
      
      const controller = new AbortController();
      const url = `${apiEndpoints.app.classes}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&object_name=maneuver_menus`;
      debug('🔄 Sidebar: Fetching maneuver menus from:', url);
      
      const response = await getData(url, controller.signal);
      
      // Only log full response in very verbose mode
      if (import.meta.env.VITE_VERBOSE === 'true') {
        debug('🔄 Sidebar: Maneuver menus response:', response);
      }
      
      if (response.success && response.data) {
        // Handle both array and object with array property
        const menus = Array.isArray(response.data) ? response.data : (response.data.menus || response.data.list || []);
        
        // Only log raw data in very verbose mode
        if (import.meta.env.VITE_VERBOSE === 'true') {
          debug('🔄 Sidebar: Raw menus data:', menus);
        }
        
        // Ensure menus have object_name property for consistency with user objects
        const formattedMenus = menus.map((menu: any) => {
          if (typeof menu === 'string') {
            return { object_name: menu };
          }
          return menu.object_name ? menu : { object_name: menu.name || menu };
        });
        
        // Only log formatted menus in very verbose mode
        if (import.meta.env.VITE_VERBOSE === 'true') {
          debug('🔄 Sidebar: Formatted maneuver menus:', formattedMenus);
        }
        setManeuverMenus(formattedMenus);
      } else {
        debug('🔄 Sidebar: No maneuver menus found in response');
        setManeuverMenus([]);
      }
    } catch (error: any) {
      logError('🔄 Sidebar: Error fetching maneuver menus:', error);
      setManeuverMenus([]);
    }
  };

  // Function to load user page objects
  // forceDayMode: when true (e.g. called from Day Exploration branch), use fleet_* parent names regardless of selectedDatasetId
  const loadUserPageObjects = async (forceDayMode?: boolean) => {
    if (!selectedClassName() || !selectedProjectId()) {
      return;
    }

    const currentUser = user();
    if (!currentUser || !currentUser.user_id) {
      return;
    }

    // Get explore menu items from dynamicMenuItems1 (loaded from API)
    const exploreMenuItems = dynamicMenuItems1() || [];
    // Kept for fallback/reference, but primarily using is_multiple flag from API
    const exploreMenuTypes = ['TIME SERIES', 'SCATTER', 'PROBABILITY', 'POLAR ROSE', 'TABLE', 'GRID', 'PARALLEL', 'VIDEO', 'BOAT', 'MAP'];
    
    const userPages = [];
    const objectsMap = new Map();

    // In day mode use fleet_* parent names: selectedDate set and no selected dataset. Use forceDayMode when called from Day Exploration branch; otherwise derive from selection.
    const isDayMode = forceDayMode === true || (isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0));

    const normalizePageName = (s: string) => (s || '').toLowerCase().replace(/\s+/g, '');
    for (const menuItem of exploreMenuItems) {
      // Map has no submenus; Overlay is internal to the map page - do not fetch or store user objects for it
      const itemKey = normalizePageName(menuItem.page_name || '');
      if (itemKey === 'map' || itemKey === 'overlay') continue;

      // Use is_multiple flag (1) or fallback to list check (API may return 'TIMESERIES' vs 'TIME SERIES')
      const isMultiple = menuItem.is_multiple === 1 || exploreMenuTypes.includes(menuItem.page_name) ||
        exploreMenuTypes.some(t => normalizePageName(t) === normalizePageName(menuItem.page_name || ''));
      
      if (isMultiple) {
        // In day mode, use fleet_* parent names for timeseries, scatter, probability
        let parentName = menuItem.page_name.toLowerCase().replace(/\s+/g, '');
        if (isDayMode) {
          if (menuItem.page_name === 'TIMESERIES' || menuItem.page_name === 'TIME SERIES') {
            parentName = 'fleet_timeseries';
            debug('[Sidebar] Using fleet_timeseries parent_name for TIME SERIES in day mode');
          } else if (menuItem.page_name === 'SCATTER') {
            parentName = 'fleet_scatter';
            debug('[Sidebar] Using fleet_scatter parent_name for SCATTER in day mode');
          } else if (menuItem.page_name === 'PROBABILITY') {
            parentName = 'fleet_probability';
            debug('[Sidebar] Using fleet_probability parent_name for PROBABILITY in day mode');
          }
        }

        const objectNames = await fetchUserPageNames(parentName);
        // Always store under the key we use for lookup (fleet_timeseries in day mode, timeseries in dataset mode)
        // so the sidebar can show the dropdown and "Add Chart" even when there are no saved charts yet
        objectsMap.set(parentName, objectNames);
        const menuData = {
          ...menuItem,
          hasMultiple: objectNames.length > 1,
          objects: objectNames
        };
        userPages.push(menuData);
        // In dataset mode only: also store under original key for backward compatibility
        if (!isDayMode) {
          const originalKey = menuItem.page_name.toLowerCase().replace(/\s+/g, '');
          if (originalKey !== parentName) {
            objectsMap.set(originalKey, objectNames);
          }
        }
      }
    }

    debug('userPages:', userPages);
    debug('objectsMap:', objectsMap);

    setUserPageMenus(userPages);
    setUserPageObjects(objectsMap);
  };

  // Function to load maneuver menus when MANEUVERS menu is found
  const loadManeuverMenus = async () => {
    if (!selectedClassName() || !selectedProjectId()) return;
    
    // Prevent duplicate calls
    if (isLoadingManeuverMenus) {
      debug('🔄 Sidebar: loadManeuverMenus already in progress, skipping');
      return;
    }
    
    isLoadingManeuverMenus = true;
    
    try {
      // Check if MANEUVERS menu exists in dynamicMenuItems1 or dynamicMenuItems2
      const allMenuItems = [...(dynamicMenuItems1() || []), ...(dynamicMenuItems2() || [])];
      const hasManeuversMenu = allMenuItems.some((item: any) => item.page_name === 'MANEUVERS');
      
      // Only log maneuver menu details in very verbose mode
      if (import.meta.env.VITE_VERBOSE === 'true') {
        debug('🔄 Sidebar: loadManeuverMenus called', {
          hasManeuversMenu,
          exploreItems: dynamicMenuItems1()?.length || 0,
          reportItems: dynamicMenuItems2()?.length || 0,
          allMenuNames: allMenuItems.map((item: any) => item.page_name)
        });
      }
    
      if (hasManeuversMenu) {
        await fetchManeuverMenus();
      } else {
        setManeuverMenus([]);
      }
    } finally {
      isLoadingManeuverMenus = false;
    }
  };

  // Helper function to check if video exists in the selected dataset or date
  const checkVideoExists = async () => {
    try {
      let dateToCheck = null;

      // If we have a selected dataset, get its date
      if (selectedDatasetId() > 0) {
        try {
          const controller = new AbortController();
          const response = await getData(
            `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`,
            controller.signal
          );
          
          if (response.success && response.data?.date) {
            let dateStr = response.data.date;
            // Convert YYYYMMDD to YYYY-MM-DD if needed
            if (dateStr.length === 8 && !dateStr.includes('-')) {
              dateStr = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
            }
            dateToCheck = dateStr;
          }
        } catch (error: any) {
          if (error.name !== 'AbortError') {
            debug('Error fetching dataset date for video check:', error);
          }
          return false;
        }
      }
      // Otherwise, if we have a selected date, use it
      else if (isValidDate(selectedDate())) {
        let dateStr = selectedDate();
        // Convert YYYYMMDD to YYYY-MM-DD if needed
        if (dateStr.length === 8 && !dateStr.includes('-')) {
          dateStr = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
        }
        dateToCheck = dateStr;
      }

      // If we don't have a date to check, video cannot exist
      if (!dateToCheck) {
        return false;
      }

      // Check if media sources exist for this date
      try {
        const controller = new AbortController();
        const response = await getData(
          `${apiEndpoints.media.sources}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(dateToCheck)}`,
          controller.signal
        );

        debug('Video existence check:', {
          date: dateToCheck,
          success: response.success,
          status: response.status,
          hasData: response.data && Array.isArray(response.data) && response.data.length > 0,
          dataLength: Array.isArray(response.data) ? response.data.length : 0,
          dataType: typeof response.data,
          data: response.data
        });

        // If we get a successful response with data array that has items, video exists
        if (response.success && response.data && Array.isArray(response.data) && response.data.length > 0) {
          debug('✅ Video exists for date:', dateToCheck);
          return true;
        }
        // No data or 204 means no media sources found
        debug('❌ No video found for date:', dateToCheck, 'Response:', response);
        return false;
      } catch (error: any) {
        if (error.name !== 'AbortError') {
          debug('Error checking video existence:', error);
        }
        return false;
      }
    } catch (error: any) {
      debug('Error in checkVideoExists:', error);
      return false;
    }
  };

  const fetchDynamicMenuItems = async () => {
    if (selectedClassName() && selectedProjectId()) {
      // Debug logging for source selection (only in very verbose mode)
      if (import.meta.env.VITE_VERBOSE === 'true') {
        debug('🔍 fetchDynamicMenuItems: Source debug info:', {
          selectedSourceId: selectedSourceId(),
          selectedSourceName: selectedSourceName(),
          selectedDatasetId: selectedDatasetId(),
          selectedDate: selectedDate(),
          selectedProjectId: selectedProjectId(),
          selectedClassName: selectedClassName()
        });
      }
      
      let response = undefined;

      // MODE 0: Live mode (highest priority)
      if (sidebarState() === 'live') {
        debug('🔴 MODE 0: Live mode active');
        // Clear tools menus in live mode
        setDividerLabelTools("");
        setDynamicMenuItemsTools([]);
        let found = false;
        
        try {
          const controller = new AbortController();
          const page_type = 'live/explore';
          response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller.signal)

          debug('Live explore response:', response);
          if (response.success && response.data && response.data.length > 0) {
            const data = response.data;
            
            setDividerLabel1("Live Exploration");
            setDynamicMenuItems1(data);
            setMenuFound(true);
            
            // Check if VIDEO menu is available and video exists in selected dataset/date
            const videoAvailable = data.some((item: any) => item.page_name === 'VIDEO');
            if (videoAvailable && (selectedDatasetId() > 0 || isValidDate(selectedDate())) && isLoggedIn()) {
              const videoExists = await checkVideoExists();
              setHasVideoMenu(videoExists);
            } else {
              setHasVideoMenu(videoAvailable);
            }
            
            // Load user page objects after dynamic menu items are set
            await loadUserPageObjects();
            
            // Load maneuver menus after dynamic menu items are set
            await loadManeuverMenus();
            
            // Auto-navigate to first menu item if current menu is not available
            // BUT: Don't override if we're explicitly showing "Dataset" (isProjectMenuActive)
            const currentMenu = selectedMenu();
            const isExplicitlyShowingDatasets = isProjectMenuActive() && (currentMenu === 'Dataset' || currentMenu === 'Datasets');
            const normalizedCurrentLive = (currentMenu || '').toString().replace(/\s+/g, '').toUpperCase();
            const isCurrentMenuAvailable = data.some((item: any) => item.page_name === currentMenu || (item.page_name || '').toString().replace(/\s+/g, '').toUpperCase() === normalizedCurrentLive);
            if (!isCurrentMenuAvailable && data.length > 0 && !isExplicitlyShowingDatasets && data[0]) {
              debug('🔄 Sidebar: Current menu', currentMenu, 'not available in live explore, switching to', data[0].page_name);
              setSelectedMenu(canonicalExploreMenuName(data[0].page_name));
              loadComponent(data[0].file_path);
              found = true;
            } else {
              // Check if current menu matches any available menu
              data.forEach((item: any) => {
                const normalizedItemName = item.page_name.replace(/\s+/g, '').toUpperCase();
                const normalizedSelectedMenu = selectedMenu().replace(/\s+/g, '').toUpperCase();
                const exactMatch = item.page_name === selectedMenu();
                const normalizedMatch = normalizedItemName === normalizedSelectedMenu;
                
                if ((exactMatch || normalizedMatch) && !found) {
                  // Menu matches, load component
                  loadComponent(item.file_path);
                  found = true;
                }
              });
            }

          } else {
            debug('⚠️ No live explore pages found - this is OK, checking reports...');
            setDividerLabel1("");
            setDynamicMenuItems1([]);
            setHasVideoMenu(false);
          }

          // Fetch live reports (always fetch, even if explore is empty)
          try {
            const controller2 = new AbortController();
            const page_type = 'live/reports';
            response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller2.signal)

            debug('Live reports response:', response);
            if (response.success && response.data && response.data.length > 0) {
              const data = response.data;
              
              setDividerLabel2("Live Reports");
              setDynamicMenuItems2(data);
              setMenuFound(true);
      
              // Check if current menu matches any report menu
              data.forEach((item: any) => {
                if (item.page_name == selectedMenu() && !found) {
                  // Menu matches, load component
                  loadComponent(item.file_path);
                  found = true;
                }
              })
            } else {
              debug('⚠️ No live reports pages found');
              setDividerLabel2("");
              setDynamicMenuItems2([]);
            }
          } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
              logError('Error fetching live reports:', error);
            }
            setDividerLabel2("");
            setDynamicMenuItems2([]);
          }

          // Now check if current selected menu is still available after both explore and reports are loaded
          const currentMenu = selectedMenu();
          const allMenuItems = [...(dynamicMenuItems1() || []), ...(dynamicMenuItems2() || [])];
          const normalizedCurrentLive2 = (currentMenu || '').toString().replace(/\s+/g, '').toUpperCase();
          const isCurrentMenuAvailable = allMenuItems.some((item: any) => item.page_name === currentMenu || (item.page_name || '').toString().replace(/\s+/g, '').toUpperCase() === normalizedCurrentLive2);
          
          // Auto-navigate to first menu item if current menu is not available
          // BUT: Don't override if we're explicitly showing "Dataset" (isProjectMenuActive)
          const isExplicitlyShowingDatasets = isProjectMenuActive() && (currentMenu === 'Dataset' || currentMenu === 'Datasets');
          if (!found && !isCurrentMenuAvailable && allMenuItems.length > 0 && !isExplicitlyShowingDatasets) {
            debug('🔄 Sidebar: Current menu', currentMenu, 'not available in live explore or reports, switching to', allMenuItems[0].page_name);
            setSelectedMenu(allMenuItems[0].page_name);
            loadComponent(allMenuItems[0].file_path);
            found = true;
          }

          // If still not found and we have explore items, navigate to first one (only when current menu not available)
          if (!found && !isCurrentMenuAvailable && dynamicMenuItems1().length > 0 && !isExplicitlyShowingDatasets) {
            setSelectedMenu(dynamicMenuItems1()[0].page_name);
            loadComponent(dynamicMenuItems1()[0].file_path);
          }
        } catch (error: any) {
          if (error.name === 'AbortError') {
          } else {
            logError("Failed to fetch live menu items", error);
          }
          setDividerLabel1("");
          setDividerLabel2("");
          setDynamicMenuItems1([]);
          setDynamicMenuItems2([]);
          setDividerLabelTools("");
          setDynamicMenuItemsTools([]);
          setMenuFound(false);
        }
      }
      // When dataset is selected, check source selection first before defaulting to dataset mode
      else if (selectedDatasetId() > 0) {
        // Check source selection when dataset is selected
        const sourceId = selectedSourceId();
        const date = selectedDate();
        const hasValidDate = isValidDate(date);
        const currentSidebarState = sidebarState();
        
        // If sidebarState is explicitly 'dataset', prioritize dataset mode (MODE 1) over source mode
        // This happens when user clicks "View" on a dataset - they want dataset menus, not source menus
        // If single source is selected AND sidebarState is NOT 'dataset', use MODE 3 (Source History Mode)
        if (sourceId > 0 && currentSidebarState !== 'dataset') {
          debug('🔍 MODE 3: Dataset selected with single source (datasetId:', selectedDatasetId(), ', sourceId:', sourceId, ', sourceName:', selectedSourceName(), ')');
          let found = false;
          
          try {
            const controller = new AbortController();
            const page_type = 'project/source/explore';
            response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller.signal)

            debug('Project source explore response:', response);
            if (response.success && response.data && response.data.length > 0) {
              const data = response.data;
              
              setDividerLabel1("Explore History");
              setDynamicMenuItems1(data);
              setMenuFound(true);
              
              // Check if VIDEO menu is available and video exists in selected dataset/date
              const videoAvailable = data.some((item: any) => item.page_name === 'VIDEO');
              if (videoAvailable && (selectedDatasetId() > 0 || isValidDate(selectedDate())) && isLoggedIn()) {
                const videoExists = await checkVideoExists();
                setHasVideoMenu(videoExists);
              } else {
                setHasVideoMenu(videoAvailable);
              }
              
              // In source mode, don't auto-select - let user choose
              debug('📋 MODE 3: Explore pages loaded, no auto-selection in source mode');

            } else {
              debug('⚠️ No project source explore pages found - this is OK, checking reports...');
              setDividerLabel1("");
              setDynamicMenuItems1([]);
              setHasVideoMenu(false);
            }

            // Fetch project source reports (always fetch, even if explore is empty)
            try {
              const controller2 = new AbortController();
              const page_type = 'project/source/reports';
              response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller2.signal)

              debug('Project source reports response:', response);
              if (response.success && response.data && response.data.length > 0) {
                const data = response.data;
                
                setDividerLabel2("Historical Reports");
                setDynamicMenuItems2(data);
                setMenuFound(true);

                // In source mode, don't auto-select - let user choose
                debug('📋 MODE 3: Reports pages loaded, no auto-selection in source mode');
              } else {
                debug('⚠️ No project source reports pages found');
                setDividerLabel2("");
                setDynamicMenuItems2([]);
              }
            } catch (error: any) {
              if (error.name === 'AbortError') {
              } else {
                logError('Error fetching project source reports:', error);
              }
              setDividerLabel2("");
              setDynamicMenuItems2([]);
            }

            // Fetch project source tools (if any)
            if (selectedDatasetId() === 0 && !selectedDate()) {
              try {
                const controllerTools = new AbortController();
                const page_type_tools = 'tools';
                response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type_tools)}`, controllerTools.signal)

                debug('Project source tools response:', response);
                if (response.success && response.data && response.data.length > 0) {
                  const data = response.data;
                  setDividerLabelTools("Tools");
                  setDynamicMenuItemsTools(data);
                  setMenuFound(true);
                } else {
                  setDividerLabelTools("");
                  setDynamicMenuItemsTools([]);
                }
              } catch (error: any) {
                if (error.name === 'AbortError') {
                } else {
                  logError('Error fetching project source tools:', error);
                }
                setDividerLabelTools("");
                setDynamicMenuItemsTools([]);
              }
            }
          } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
              logError("Failed to fetch project source menu items", error);
            }
            setDividerLabel1("");
            setDividerLabel2("");
            setDynamicMenuItems1([]);
            setDynamicMenuItems2([]);
            setDividerLabelTools("");
            setDynamicMenuItemsTools([]);
            setMenuFound(false);
          }
        }
        // If all sources (sourceId === 0) and date is valid, use MODE 2 (Day Mode)
        else if (sourceId === 0 && hasValidDate) {
          debug('📅 MODE 2: Dataset selected with all sources and date (datasetId:', selectedDatasetId(), ', date:', date, ')');
          // Ensure ALL sources in day mode
          try {
            setSelectedSourceId(0);
            setSelectedSourceName('ALL');
          } catch (_) {}
          // Clear tools menus in day mode
          setDividerLabelTools("");
          setDynamicMenuItemsTools([]);
          let found = false;
          
          try {
            const controller = new AbortController();
            const page_type = 'day/explore';
            const dateNorm = dateNormForRaces(date);
            const dayExploreUrl = dateNorm.length === 8
              ? `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}&date=${encodeURIComponent(dateNorm)}`
              : `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`;
            response = await getData(dayExploreUrl, controller.signal)

            // Only log full response in very verbose mode
            if (import.meta.env.VITE_VERBOSE === 'true') {
              debug('Day explore response:', response);
            } else {
              debug('Day explore:', response.success ? `Success (${response.data?.length || 0} items)` : 'Failed');
            }
            if (response.success && response.data && response.data.length > 0) {
              const data = response.data;
              
              setDividerLabel1("Day Exploration");
              setDynamicMenuItems1(data);
              setMenuFound(true);
              
              // Check if VIDEO menu is available and video exists in selected dataset/date
              const videoAvailable = data.some((item: any) => item.page_name === 'VIDEO');
              if (videoAvailable && (selectedDatasetId() > 0 || isValidDate(selectedDate())) && isLoggedIn()) {
                const videoExists = await checkVideoExists();
                setHasVideoMenu(videoExists);
              } else {
                setHasVideoMenu(videoAvailable);
              }
              
              // Load user page objects after dynamic menu items are set
              await loadUserPageObjects();
              
              // Load maneuver menus after dynamic menu items are set
              await loadManeuverMenus();

              data.forEach((item: any) => {
                const normalizedItemName = item.page_name.replace(/\s+/g, '').toUpperCase();
                const normalizedSelectedMenu = selectedMenu().replace(/\s+/g, '').toUpperCase();
                const exactMatch = item.page_name === selectedMenu();
                const normalizedMatch = normalizedItemName === normalizedSelectedMenu;
                // Don't auto-load if we're in project mode (explicitly showing datasets)
                const isExplicitlyShowingDatasets = isProjectMenuActive() && (selectedMenu() === 'Dataset' || selectedMenu() === 'Datasets');
                
                if ((exactMatch || normalizedMatch) && !found && !isExplicitlyShowingDatasets) {
                  setSelectedMenu(canonicalExploreMenuName(item.page_name));
                  loadComponent(item.file_path);
                  found = true;
                }
              })

            } else {
              debug('⚠️ No day explore pages found - this is OK, checking reports...');
              setDividerLabel1("");
              setDynamicMenuItems1([]);
              setHasVideoMenu(false);
            }

            // Fetch day reports from day_pages for the selected date only
            try {
              const dateNorm = dateNormForRaces(date);
              if (dateNorm.length !== 8) {
                setDividerLabel2("");
                setDynamicMenuItems2([]);
              } else {
                const controller2 = new AbortController();
                response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=day/reports&date=${encodeURIComponent(dateNorm)}`, controller2.signal);

                if (response.success && response.data && response.data.length > 0) {
                  const data = response.data;
                  setDividerLabel2("Day Reports");
                  setDynamicMenuItems2(data);
                  setMenuFound(true);
                  data.forEach((item: any) => {
                    if (item.page_name == selectedMenu() && !found) {
                      setSelectedMenu(canonicalExploreMenuName(item.page_name));
                      const path = getDayReportFilePath(item.page_name) || item.file_path;
                      loadComponent(path);
                      found = true;
                    }
                  });
                } else {
                  setDividerLabel2("");
                  setDynamicMenuItems2([]);
                }
              }
            } catch (error: any) {
              if (error.name === 'AbortError') {
              } else {
                logError('Error fetching day reports:', error);
              }
              setDividerLabel2("");
              setDynamicMenuItems2([]);
            }

            // Auto-load first page from either explore or reports
            // BUT: Don't override if we're explicitly showing "Dataset" (isProjectMenuActive)
            // AND: Only auto-select if no menu is currently selected
            const currentMenu = selectedMenu();
            const isExplicitlyShowingDatasets = isProjectMenuActive() && (currentMenu === 'Dataset' || currentMenu === 'Datasets');
            
            // When transitioning to day mode (menu is empty or "Datasets"), always open first menu
            // Priority: first report menu if available, otherwise first explore menu
            // Only auto-select if no other menu is currently selected
            const isTransitioningToDayMode = (currentMenu === '' || currentMenu === 'Datasets' || currentMenu === 'Dataset') && !isExplicitlyShowingDatasets;
            
            // Also check if menu is empty after restoreLastMenuForMode (no last menu was restored)
            const menuIsEmpty = !currentMenu || currentMenu === '' || currentMenu === 'Datasets' || currentMenu === 'Dataset';
            
            // Auto-select first report menu if menu is empty (after restoreLastMenuForMode completes or if no menu was restored)
            // Use setTimeout to ensure restoreLastMenuForMode has time to complete
            if ((isTransitioningToDayMode || menuIsEmpty || (!found && !isExplicitlyShowingDatasets)) && !isExplicitlyShowingDatasets) {
              // Small delay to allow restoreLastMenuForMode to complete
              setTimeout(() => {
                const finalMenu = selectedMenu();
                const finalMenuIsEmpty = !finalMenu || finalMenu === '' || finalMenu === 'Datasets' || finalMenu === 'Dataset';
                
                // Only auto-select if menu is still empty after restoreLastMenuForMode
                if (finalMenuIsEmpty && !isProjectMenuActive()) {
                  // Prefer first report menu if available, otherwise first explore menu
                  const reportMenus = dynamicMenuItems2() || [];
                  const exploreMenus = dynamicMenuItems1() || [];
                  const defaultMenu = reportMenus.length > 0 ? reportMenus[0] : (exploreMenus.length > 0 ? exploreMenus[0] : null);
                  if (defaultMenu) {
                    debug('🔄 Sidebar: Day mode - auto-selecting first menu (no menu restored):', defaultMenu.page_name, reportMenus.length > 0 ? '(report menu)' : '(explore menu)');
                    setSelectedMenu(canonicalExploreMenuName(defaultMenu.page_name));
                    const path = reportMenus.length > 0 ? (getDayReportFilePath(defaultMenu.page_name) || defaultMenu.file_path) : (getDayExploreFilePath(defaultMenu.page_name) || defaultMenu.file_path);
                    loadComponent(path);
                  } else {
                    debug('⚠️ Sidebar: Day mode - no menus available to auto-select');
                  }
                }
              }, 100); // Small delay to allow restoreLastMenuForMode to complete
            }
          } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
              logError("Failed to fetch day menu items", error);
            }
            setDividerLabel1("");
            setDividerLabel2("");
            setDynamicMenuItems1([]);
            setDynamicMenuItems2([]);
            setDividerLabelTools("");
            setDynamicMenuItemsTools([]);
            setMenuFound(false);
          }
        }
        // If all sources (sourceId === 0) and no date, use MODE 5 (Fleet History Mode)
        else if (sourceId === 0 && !hasValidDate) {
          debug('🌐 MODE 5: Dataset selected with all sources, no date (datasetId:', selectedDatasetId(), ', sourceId:', sourceId, ', sourceName:', selectedSourceName(), ')');
          
          try {
            const controller = new AbortController();
            const page_type = 'project/all/explore';
            response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller.signal)

            if (response.success && response.data && response.data.length > 0) {
              const data = response.data;
              
              setDividerLabel1("Explore History");
              setDynamicMenuItems1(data);
              setMenuFound(true);
              
              // Check if VIDEO menu is available and video exists in selected dataset/date
              const videoAvailable = data.some((item: any) => item.page_name === 'VIDEO');
              if (videoAvailable && (selectedDatasetId() > 0 || isValidDate(selectedDate())) && isLoggedIn()) {
                const videoExists = await checkVideoExists();
                setHasVideoMenu(videoExists);
              } else {
                setHasVideoMenu(videoAvailable);
              }
              
              debug('✅ Project/all explore pages found:', data.length);

              // In project mode, don't auto-select - let user choose
              debug('📋 MODE 5: Explore pages loaded, no auto-selection in project mode');
            } else {
              debug('⚠️ No project/all explore pages found - this is OK, checking reports...');
              setDividerLabel1("");
              setDynamicMenuItems1([]);
              setHasVideoMenu(false);
            }

            // Fetch project all reports (always fetch, even if explore is empty)
            try {
              const controller2 = new AbortController();
              const page_type = 'project/all/reports';
              response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller2.signal)

              debug('Project all reports response:', response);
              if (response.success && response.data && response.data.length > 0) {
                const data = response.data;
                
                setDividerLabel2("Historical Reports");
                setDynamicMenuItems2(data);
                setMenuFound(true);
                debug('✅ Project/all reports pages found:', data.length);

                // In project mode, don't auto-select - let user choose
                debug('📋 MODE 5: Reports pages loaded, no auto-selection in project mode');
                } else {
                  debug('⚠️ No project/all reports pages found');
                  setDividerLabel2("");
                  setDynamicMenuItems2([]);
                }
              } catch (error: any) {
                if (error.name === 'AbortError') {
                } else {
                  logError('Error fetching project all reports:', error);
                }
                setDividerLabel2("");
                setDynamicMenuItems2([]);
              }

            // Fetch project all tools (if any)
            if (selectedDatasetId() === 0 && !selectedDate()) {
              try {
                const controllerTools = new AbortController();
                const page_type_tools = 'tools';
                response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type_tools)}`, controllerTools.signal)

                debug('Project all tools response:', response);
                if (response.success && response.data && response.data.length > 0) {
                  const data = response.data;
                  setDividerLabelTools("Tools");
                  setDynamicMenuItemsTools(data);
                  setMenuFound(true);
                } else {
                  setDividerLabelTools("");
                  setDynamicMenuItemsTools([]);
                }
              } catch (error: any) {
                if (error.name === 'AbortError') {
                } else {
                  logError('Error fetching project tools:', error);
                }
                setDividerLabelTools("");
                setDynamicMenuItemsTools([]);
              }
            }

            // Load user page objects and maneuver menus after all menus are loaded
            await loadUserPageObjects();
            await loadManeuverMenus();
          } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
              logError("Failed to fetch project menu items", error);
            }
            setDividerLabel1("");
            setDividerLabel2("");
            setDynamicMenuItems1([]);
            setDynamicMenuItems2([]);
            setDividerLabelTools("");
            setDynamicMenuItemsTools([]);
            setMenuFound(false);
            setHasVideoMenu(false);
          }
        }
        // Fallback: MODE 1: Dataset selected (use when none of the above conditions are met)
        else {
          debug('📊 MODE 1: Dataset selected (id:', selectedDatasetId(), ') - fallback mode');
          // Clear tools menus in dataset mode
          setDividerLabelTools("");
          setDynamicMenuItemsTools([]);
          let found = false;
          
          try {
            const controller = new AbortController();
            const page_type = 'dataset/explore';
            const currentUser = user();
            if (!currentUser || !currentUser.user_id) {
              warn('[Sidebar] User not available, skipping fetchDynamicMenuItems');
              return;
            }
            const datasetId = selectedDatasetId();
            const pagesUrl = datasetId > 0
              ? `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&page_type=${encodeURIComponent(page_type)}&dataset_id=${encodeURIComponent(datasetId)}`
              : `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&page_type=${encodeURIComponent(page_type)}`;
            response = await getData(pagesUrl, controller.signal)

            debug('response:', response);
            if (response.success && response.data && response.data.length > 0) {
              const data = response.data;
              
              setDividerLabel1("Dataset Exploration");
              setDynamicMenuItems1(data);
              setMenuFound(true);
              
              // Check if VIDEO menu is available and video exists in selected dataset/date
              const videoAvailable = data.some((item: any) => item.page_name === 'VIDEO');
              debug('Video menu check - Dataset mode:', {
                videoAvailable,
                hasDataset: selectedDatasetId() > 0,
                hasDate: isValidDate(selectedDate()),
                datasetId: selectedDatasetId(),
                date: selectedDate()
              });
              
              if (videoAvailable && (selectedDatasetId() > 0 || isValidDate(selectedDate())) && isLoggedIn()) {
                const videoExists = await checkVideoExists();
                debug('Video exists check result (Dataset mode):', videoExists);
                setHasVideoMenu(videoExists);
              } else {
                debug('Setting hasVideoMenu to videoAvailable (no dataset/date check - Dataset mode):', videoAvailable);
                setHasVideoMenu(videoAvailable);
              }
              
              // Load user page objects after dynamic menu items are set
              await loadUserPageObjects();
              
              // Load maneuver menus after dynamic menu items are set
              await loadManeuverMenus();
              
              // Don't check menu availability here - wait for reports to load too
              // (The availability check happens after both explore and reports are loaded)
              const userPageTypesWithObjectName = new Set(['TIMESERIES', 'PARALLEL', 'SCATTER', 'PROBABILITY', 'MAP', 'VIDEO', 'PERFORMANCE', 'TARGETS', 'POLARROSE', 'GRID', 'TABLE']);
              for (const item of data) {
                // Normalize both names for comparison (remove spaces and convert to uppercase)
                const normalizedItemName = item.page_name.replace(/\s+/g, '').toUpperCase();
                const normalizedSelectedMenu = selectedMenu().replace(/\s+/g, '').toUpperCase();
                const exactMatch = item.page_name === selectedMenu();
                const normalizedMatch = normalizedItemName === normalizedSelectedMenu;
                
                // Skip auto-loading if this is MANEUVERS and we have a selectedPage
                // (restoreStateFromStore will handle loading ManeuverWindow instead)
                const isManeuversWithPage = (item.page_name === 'MANEUVERS' || normalizedItemName === 'MANEUVERS') && selectedPage() && selectedPage() !== '';
                // Don't auto-load if we're in project mode (explicitly showing datasets)
                const isExplicitlyShowingDatasets = isProjectMenuActive() && (selectedMenu() === 'Dataset' || selectedMenu() === 'Datasets');
                
                if ((exactMatch || normalizedMatch) && !found && !isManeuversWithPage && !isExplicitlyShowingDatasets) {
                  setSelectedMenu(canonicalExploreMenuName(item.page_name));
                  // Load with objectName for user page types (GRID, POLAR ROSE, etc.) so saved chart is shown after builder save. Use item.file_path directly to avoid findMenuItemByPageName lookup before state is committed.
                  if (userPageTypesWithObjectName.has(normalizedItemName)) {
                    const objectNameVal = selectedPage() || 'default';
                    await ensureSourcesReady();
                    const Component = await loadComponentFromPath(item.file_path);
                    setComponent(() => (props: any) => <Component {...props} objectName={objectNameVal} />);
                    setSelectedPage(objectNameVal);
                  } else {
                    await loadComponent(item.file_path);
                  }
                  found = true;
                  break;
                }
              }

            } else {
              debug('⚠️ No dataset explore pages found - this is OK, checking reports...');
              setDividerLabel1("");
              setDynamicMenuItems1([]);
              setHasVideoMenu(false);
            }

            // Fetch dataset reports (always fetch, even if explore is empty)
            try {
              const controller2 = new AbortController();
              const page_type = 'dataset/reports';
              const currentUser = user();
              if (!currentUser || !currentUser.user_id) {
                warn('[Sidebar] User not available, skipping dataset reports fetch');
                return;
              }
              const datasetId = selectedDatasetId();
              const reportsUrl = datasetId > 0
                ? `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&page_type=${page_type}&dataset_id=${encodeURIComponent(datasetId)}`
                : `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&page_type=${page_type}`;
              response = await getData(reportsUrl, controller2.signal)

              debug('Dataset reports response:', response);
              if (response.success && response.data && response.data.length > 0) {
                const data = response.data;
                
                setDividerLabel2("Dataset Reports");
                setDynamicMenuItems2(data);
                setMenuFound(true);
        
                data.forEach((item: any) => {
                  // Skip auto-loading if this is MANEUVERS and we have a selectedPage
                  // (restoreStateFromStore will handle loading ManeuverWindow instead)
                  const isManeuversWithPage = item.page_name === 'MANEUVERS' && selectedPage() && selectedPage() !== '';
                  // Don't auto-load if we're in project mode (explicitly showing datasets)
                  const isExplicitlyShowingDatasets = isProjectMenuActive() && (selectedMenu() === 'Dataset' || selectedMenu() === 'Datasets');
                  const exactMatch = item.page_name === selectedMenu();
                  const normalizedMatch = (item.page_name || '').toString().replace(/\s+/g, '').toUpperCase() === (selectedMenu() || '').toString().replace(/\s+/g, '').toUpperCase();
                  if ((exactMatch || normalizedMatch) && !found && !isManeuversWithPage && !isExplicitlyShowingDatasets) {
                    setSelectedMenu(canonicalExploreMenuName(item.page_name));
                    loadComponent(item.file_path);
                    found = true;
                  }
                })
              } else {
                debug('⚠️ No dataset reports pages found');
                setDividerLabel2("");
                setDynamicMenuItems2([]);
              }
            } catch (error: any) {
              if (error.name === 'AbortError') {
              } else {
                logError('Error fetching dataset reports:', error);
              }
              setDividerLabel2("");
              setDynamicMenuItems2([]);
            }

            // Now check if current selected menu is still available after both explore and reports are loaded
            // Check in both dynamicMenuItems1 (explore) and dynamicMenuItems2 (reports)
            // Also reload maneuver menus now that both explore and reports are loaded
            await loadManeuverMenus();
            
            const currentMenu = selectedMenu();
            const allMenuItems = [...(dynamicMenuItems1() || []), ...(dynamicMenuItems2() || [])];
            const normalizedCurrentMenu = (currentMenu || '').toString().replace(/\s+/g, '').toUpperCase();
            const isCurrentMenuAvailable = allMenuItems.some((item: any) => {
              const exactMatch = item.page_name === currentMenu;
              const normalizedMatch = (item.page_name || '').toString().replace(/\s+/g, '').toUpperCase() === normalizedCurrentMenu;
              return exactMatch || normalizedMatch;
            });
            
            // Don't auto-load if we're explicitly showing datasets
            const isExplicitlyShowingDatasets = isProjectMenuActive() && (currentMenu === 'Dataset' || currentMenu === 'Datasets');
            
            // When transitioning to dataset mode (menu is empty or "Datasets"), or current menu not available
            const isTransitioningToDatasetMode = (currentMenu === '' || currentMenu === 'Datasets' || currentMenu === 'Dataset') && !isExplicitlyShowingDatasets;
            const needDefaultMenu = (isTransitioningToDatasetMode || (!found && !isCurrentMenuAvailable)) && allMenuItems.length > 0 && !isExplicitlyShowingDatasets;

            // No menu items at all: default to Add Chart (navigate to builder)
            if (allMenuItems.length === 0 && (isTransitioningToDatasetMode || (!found && !isCurrentMenuAvailable)) && !isExplicitlyShowingDatasets) {
              debug('🔄 Sidebar: Dataset mode - no menu items, navigating to Add Chart (timeseries-builder)');
              setSelectedMenu('TIME SERIES');
              setSelectedPage('');
              navigate('/timeseries-builder?object_name=new%20chart');
              found = true;
            } else if (needDefaultMenu) {
              const reportMenus = dynamicMenuItems2() || [];
              const exploreMenus = dynamicMenuItems1() || [];
              const norm = (s: string) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
              const lastMenu = await restoreLastMenuForMode('dataset');
              const lastMenuItem = lastMenu ? allMenuItems.find((item: any) => norm(item.page_name) === norm(lastMenu)) : null;
              const defaultMenu = lastMenuItem ?? (reportMenus.length > 0 ? reportMenus[0] : (exploreMenus.length > 0 ? exploreMenus[0] : allMenuItems[0]));
              const userPageTypes = new Set(['TIMESERIES', 'PARALLEL', 'SCATTER', 'PROBABILITY', 'MAP', 'VIDEO', 'PERFORMANCE', 'TARGETS', 'POLARROSE', 'GRID', 'TABLE']);
              const normalizedDefaultName = (defaultMenu.page_name || '').toString().replace(/\s+/g, '').toUpperCase();

              // If chosen submenu is a chart type with no saved charts, navigate to builder (Add Chart) instead of explore page
              if (userPageTypes.has(normalizedDefaultName) && normalizedDefaultName !== 'MAP' && normalizedDefaultName !== 'VIDEO') {
                const parentNameForNames = normalizedDefaultName === 'TIMESERIES' ? 'timeseries' : normalizedDefaultName.toLowerCase().replace(/\s+/g, '');
                const currentUser = user();
                if (currentUser?.user_id) {
                  const namesUrl = `${apiEndpoints.app.users}/object/names?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=${parentNameForNames}`;
                  const namesResponse = await getData(namesUrl);
                  const namesList = namesResponse?.success && Array.isArray(namesResponse?.data) ? namesResponse.data as { object_name: string }[] : [];
                  if (namesList.length === 0) {
                    const slug = getBuilderSlug(normalizedDefaultName, defaultMenu.page_name);
                    const newChartName = 'new chart';
                    const builderPath = `/${slug}-builder?object_name=${encodeURIComponent(newChartName)}`;
                    debug('🔄 Sidebar: Dataset mode - no saved charts for', defaultMenu.page_name, ', navigating to Add Chart:', builderPath);
                    setSelectedMenu(canonicalExploreMenuName(defaultMenu.page_name));
                    setSelectedPage('');
                    navigate(builderPath);
                    found = true;
                  }
                }
              }

              if (!found) {
                if (lastMenuItem) {
                  debug('🔄 Sidebar: Dataset mode, using last loaded submenu:', defaultMenu.page_name);
                } else {
                  debug('🔄 Sidebar: Dataset mode, last submenu not in list, using first:', defaultMenu.page_name, reportMenus.length > 0 ? '(report menu)' : '(explore menu)');
                }
                setSelectedMenu(canonicalExploreMenuName(defaultMenu.page_name));
                if (userPageTypes.has(normalizedDefaultName)) {
                  // Pass selectedPage from API only if set; otherwise let the explore page resolve (first from object/names)
                  const objectNameVal = selectedPage() || undefined;
                  await ensureSourcesReady();
                  const Component = await loadComponentFromPath(defaultMenu.file_path);
                  setComponent(() => (props: any) => <Component {...props} objectName={objectNameVal} />);
                  if (objectNameVal) setSelectedPage(objectNameVal);
                } else {
                  loadComponent(defaultMenu.file_path);
                }
                found = true;
              }
            }

            if (!found && !isCurrentMenuAvailable && dynamicMenuItems1().length > 0 && !isExplicitlyShowingDatasets) {
              setSelectedMenu(canonicalExploreMenuName(dynamicMenuItems1()[0].page_name));
              loadComponent(dynamicMenuItems1()[0].file_path);
            }
          } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
              logError("Failed to fetch dynamic menu items", error);
            }
            setDividerLabel1("");
            setDividerLabel2("");
            setDynamicMenuItems1([]);
            setDynamicMenuItems2([]);
            setDividerLabelTools("");
            setDynamicMenuItemsTools([]);
            setMenuFound(false);
          }
        }
      }
      // MODE 2: Date selected (day view - all sources for a specific date)
      else if (isValidDate(selectedDate())) {
        debug('📅 MODE 2: Date selected (date:', selectedDate(), ')');
        // Ensure ALL sources in day mode
        try {
          setSelectedSourceId(0);
          setSelectedSourceName('ALL');
        } catch (_) {}
        // Clear tools menus in day mode
        setDividerLabelTools("");
        setDynamicMenuItemsTools([]);
        let found = false;
        
        try {
          const controller = new AbortController();
          const page_type = 'day/explore';
          const dateNorm = dateNormForRaces(selectedDate());
          const dayExploreUrl = dateNorm.length === 8
            ? `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}&date=${encodeURIComponent(dateNorm)}`
            : `${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`;
          response = await getData(dayExploreUrl, controller.signal)

          // Only log full response in very verbose mode
          if (import.meta.env.VITE_VERBOSE === 'true') {
            debug('Day explore response:', response);
          } else {
            debug('Day explore:', response.success ? `Success (${response.data?.length || 0} items)` : 'Failed');
          }
          if (response.success && response.data && response.data.length > 0) {
            const data = response.data;
            
            setDividerLabel1("Day Exploration");
            setDynamicMenuItems1(data);
            setMenuFound(true);
            
            // Check if VIDEO menu is available and video exists in selected dataset/date
            const videoAvailable = data.some((item: any) => item.page_name === 'VIDEO');
            if (videoAvailable && (selectedDatasetId() > 0 || isValidDate(selectedDate())) && isLoggedIn()) {
              const videoExists = await checkVideoExists();
              setHasVideoMenu(videoExists);
            } else {
              setHasVideoMenu(videoAvailable);
            }
            
            // Load user page objects for Day Exploration - use fleet_* parent names (timeseries -> fleet_timeseries, etc.)
            await loadUserPageObjects(true);
            
            // Load maneuver menus after dynamic menu items are set
            await loadManeuverMenus();
            
            // Check if current selected menu is still available
            // BUT: Don't auto-select here - wait for reports to load so we can use priority logic
            // (prefer first report menu, otherwise first explore menu)
            const currentMenu = selectedMenu();
            const isExplicitlyShowingDatasets = isProjectMenuActive() && (currentMenu === 'Dataset' || currentMenu === 'Datasets');
            // Only check availability, don't auto-select - let the final check after reports handle it with priority

            data.forEach((item: any) => {
              const normalizedItemName = item.page_name.replace(/\s+/g, '').toUpperCase();
              const normalizedSelectedMenu = selectedMenu().replace(/\s+/g, '').toUpperCase();
              const exactMatch = item.page_name === selectedMenu();
              const normalizedMatch = normalizedItemName === normalizedSelectedMenu;
              // Don't auto-load if we're in project mode (explicitly showing datasets)
              const isExplicitlyShowingDatasets = isProjectMenuActive() && (selectedMenu() === 'Dataset' || selectedMenu() === 'Datasets');
              // Skip auto-loading if this is MANEUVERS and we have a selectedPage (restoreStateFromStore will load ManeuverWindow)
              const isManeuversWithPage = (item.page_name === 'MANEUVERS' || normalizedItemName === 'MANEUVERS') && selectedPage() && selectedPage() !== '';
              
              if ((exactMatch || normalizedMatch) && !found && !isExplicitlyShowingDatasets && !isManeuversWithPage) {
                setSelectedMenu(canonicalExploreMenuName(item.page_name));
                loadComponent(item.file_path);
                found = true;
              }
            })

          } else {
            debug('⚠️ No day explore pages found - this is OK, checking reports...');
            setDividerLabel1("");
            setDynamicMenuItems1([]);
            setHasVideoMenu(false);
          }

          // Fetch day reports from day_pages for the selected date only
          try {
            const dateNorm = dateNormForRaces(selectedDate());
            if (dateNorm.length !== 8) {
              setDividerLabel2("");
              setDynamicMenuItems2([]);
            } else {
              const controller2 = new AbortController();
              response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=day/reports&date=${encodeURIComponent(dateNorm)}`, controller2.signal);

              if (response.success && response.data && response.data.length > 0) {
                const data = response.data;
                setDividerLabel2("Day Reports");
                setDynamicMenuItems2(data);
                setMenuFound(true);
                data.forEach((item: any) => {
                  const isManeuversWithPage = item.page_name === 'MANEUVERS' && selectedPage() && selectedPage() !== '';
                  if (item.page_name == selectedMenu() && !found && !isManeuversWithPage) {
                    setSelectedMenu(canonicalExploreMenuName(item.page_name));
                    const path = getDayReportFilePath(item.page_name) || item.file_path;
                    loadComponent(path);
                    found = true;
                  }
                });
              } else {
                setDividerLabel2("");
                setDynamicMenuItems2([]);
              }
            }
          } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
              logError('Error fetching day reports:', error);
            }
            setDividerLabel2("");
            setDynamicMenuItems2([]);
          }

          // Auto-load first page from either explore or reports
          // BUT: Don't override if we're explicitly showing "Dataset" (isProjectMenuActive)
          // Auto-select if:
          // 1. No menu was found/loaded (found === false), OR
          // 2. Menu is empty or "Datasets" (transitioning to day mode)
          const currentMenu = selectedMenu();
          const isExplicitlyShowingDatasets = isProjectMenuActive() && (currentMenu === 'Dataset' || currentMenu === 'Datasets');
          
          // Check if we need to auto-select:
          // - No menu was matched and loaded (found === false), OR
          // - Menu is empty or "Datasets" (transitioning to day mode)
          const needsAutoSelect = (!found || currentMenu === '' || currentMenu === 'Datasets' || currentMenu === 'Dataset') && !isExplicitlyShowingDatasets;
          
          // Also check if the current menu is available in the loaded menus
          // (in case menu was restored but isn't available in day menus)
          const allDayMenus = [...(dynamicMenuItems1() || []), ...(dynamicMenuItems2() || [])];
          const isCurrentMenuAvailable = currentMenu && allDayMenus.some((item: any) => {
            const normalizedItemName = item.page_name.replace(/\s+/g, '').toUpperCase();
            const normalizedCurrentMenu = currentMenu.replace(/\s+/g, '').toUpperCase();
            return item.page_name === currentMenu || normalizedItemName === normalizedCurrentMenu;
          });
          
          // Auto-select if: needs auto-select OR current menu is not available in day menus
          const shouldAutoSelect = (needsAutoSelect || (currentMenu && !isCurrentMenuAvailable && !isExplicitlyShowingDatasets));
          
          if (shouldAutoSelect) {
            const reportMenus = dynamicMenuItems2() || [];
            const exploreMenus = dynamicMenuItems1() || [];
            if (allDayMenus.length === 0) {
              debug('⚠️ Sidebar: Day mode - no menu items, cannot auto-select');
            } else {
              // Restore last submenu from user settings (API), then prefer last if in list else first
              const lastMenu = await restoreLastMenuForMode('day');
              const norm = (s: string) => (s || '').toString().toLowerCase().replace(/\s+/g, '');
              const lastMenuItem = lastMenu ? allDayMenus.find((item: any) => norm(item.page_name) === norm(lastMenu)) : null;
              const defaultMenu = lastMenuItem ?? (reportMenus.length > 0 ? reportMenus[0] : (exploreMenus.length > 0 ? exploreMenus[0] : allDayMenus[0]));
              if (defaultMenu) {
                if (lastMenuItem) {
                  debug('🔄 Sidebar: Day mode - using last loaded submenu from API:', defaultMenu.page_name);
                } else {
                  debug('🔄 Sidebar: Day mode - last submenu not in list, using first:', defaultMenu.page_name);
                }
                setSelectedMenu(canonicalExploreMenuName(defaultMenu.page_name));
                const path = reportMenus.length > 0 && defaultMenu === reportMenus[0]
                  ? (getDayReportFilePath(defaultMenu.page_name) || defaultMenu.file_path)
                  : (getDayExploreFilePath(defaultMenu.page_name) || defaultMenu.file_path);
                loadComponent(path);
              }
            }
          } else if (found || isCurrentMenuAvailable) {
            debug('🔄 Sidebar: Day mode - using restored/selected menu:', currentMenu);
          }
        } catch (error: any) {
          if (error.name === 'AbortError') {
          } else {
            logError("Failed to fetch day menu items", error);
          }
          setDividerLabel1("");
          setDividerLabel2("");
          setDynamicMenuItems1([]);
          setDynamicMenuItems2([]);
          setDividerLabelTools("");
          setDynamicMenuItemsTools([]);
          setMenuFound(false);
        }
      }
      // MODE 3: Single source selected (project-level, source-specific)
      else if (selectedDatasetId() === 0 && !selectedDate() && selectedSourceId() > 0) {
        debug('🔍 MODE 3: Single source selected (sourceId:', selectedSourceId(), ', sourceName:', selectedSourceName(), ')');
        let found = false;
        
        try {
          const controller = new AbortController();
          const page_type = 'project/source/explore';
          response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller.signal)

          debug('Project source explore response:', response);
          if (response.success && response.data && response.data.length > 0) {
            const data = response.data;
            
            setDividerLabel1("Explore History");
            setDynamicMenuItems1(data);
            setMenuFound(true);
            
            // Check if VIDEO menu is available and video exists in selected dataset/date
            const videoAvailable = data.some((item: any) => item.page_name === 'VIDEO');
            if (videoAvailable && (selectedDatasetId() > 0 || isValidDate(selectedDate())) && isLoggedIn()) {
              const videoExists = await checkVideoExists();
              setHasVideoMenu(videoExists);
            } else {
              setHasVideoMenu(videoAvailable);
            }
            
            // In source mode, don't auto-select - let user choose
            debug('📋 MODE 3: Explore pages loaded, no auto-selection in source mode');

          } else {
            debug('⚠️ No project source explore pages found - this is OK, checking reports...');
            setDividerLabel1("");
            setDynamicMenuItems1([]);
            setHasVideoMenu(false);
          }

          // Fetch project source reports (always fetch, even if explore is empty)
          try {
            const controller2 = new AbortController();
            const page_type = 'project/source/reports';
            response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller2.signal)

            debug('Project source reports response:', response);
            if (response.success && response.data && response.data.length > 0) {
              const data = response.data;
              
              setDividerLabel2("Historical Reports");
              setDynamicMenuItems2(data);
              setMenuFound(true);

              // In source mode, don't auto-select - let user choose
              debug('📋 MODE 3: Reports pages loaded, no auto-selection in source mode');
            } else {
              debug('⚠️ No project source reports pages found');
              setDividerLabel2("");
              setDynamicMenuItems2([]);
            }
          } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
              logError('Error fetching project source reports:', error);
            }
            setDividerLabel2("");
            setDynamicMenuItems2([]);
          }

          // Fetch project source tools (if any)
          if (selectedDatasetId() === 0 && !selectedDate()) {
            try {
              const controllerTools = new AbortController();
              const page_type_tools = 'tools';
              response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type_tools)}`, controllerTools.signal)

              debug('Project source tools response:', response);
              if (response.success && response.data && response.data.length > 0) {
                const data = response.data;
                setDividerLabelTools("Tools");
                setDynamicMenuItemsTools(data);
                setMenuFound(true);
              } else {
                setDividerLabelTools("");
                setDynamicMenuItemsTools([]);
              }
            } catch (error: any) {
              if (error.name === 'AbortError') {
              } else {
                logError('Error fetching project source tools:', error);
              }
              setDividerLabelTools("");
              setDynamicMenuItemsTools([]);
            }
          }
        } catch (error: any) {
          if (error.name === 'AbortError') {
          } else {
            logError("Failed to fetch project source menu items", error);
          }
          setDividerLabel1("");
          setDividerLabel2("");
          setDynamicMenuItems1([]);
          setDynamicMenuItems2([]);
          setDividerLabelTools("");
          setDynamicMenuItemsTools([]);
          setMenuFound(false);
        }
      }
      // MODE 4: Project level (no dataset, no date, no source selected)
      else if (selectedDatasetId() === 0 && !selectedDate() && selectedSourceId() === 0) {
        debug('🏢 MODE 4: Project level (no dataset, no date, no source selected)');
        
        try {
          const controller = new AbortController();
          const page_type = 'project/all/explore';
          response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller.signal)

          if (response.success && response.data && response.data.length > 0) {
            const data = response.data;
            
            setDividerLabel1("Project Exploration");
            setDynamicMenuItems1(data);
            setMenuFound(true);
            
            // Check if VIDEO menu is available and video exists in selected dataset/date
            const videoAvailable = data.some((item: any) => item.page_name === 'VIDEO');
            if (videoAvailable && (selectedDatasetId() > 0 || isValidDate(selectedDate())) && isLoggedIn()) {
              const videoExists = await checkVideoExists();
              setHasVideoMenu(videoExists);
            } else {
              setHasVideoMenu(videoAvailable);
            }
            
            // Check if current selected menu is still available, if not update to first available menu
            // BUT: Don't auto-load if we're in project mode (explicitly showing datasets)
            const currentMenu = selectedMenu();
            const isExplicitlyShowingDatasets = isProjectMenuActive() && (currentMenu === 'Dataset' || currentMenu === 'Datasets');
            const normalizedCurrentProj = (currentMenu || '').toString().replace(/\s+/g, '').toUpperCase();
            const isCurrentMenuAvailable = data.some((item: any) => item.page_name === currentMenu || (item.page_name || '').toString().replace(/\s+/g, '').toUpperCase() === normalizedCurrentProj);
            if (!isCurrentMenuAvailable && data.length > 0 && !isExplicitlyShowingDatasets && data[0]) {
              debug('🔄 Sidebar: Current menu', currentMenu, 'not available, switching to', data[0].page_name);
              setSelectedMenu(canonicalExploreMenuName(data[0].page_name));
              loadComponent(data[0].file_path);
            }
            
            debug('✅ Project exploration pages found:', data.length);

            // In project mode, don't auto-select - let user choose
            debug('📋 MODE 4: Explore pages loaded, no auto-selection in project mode');
          } else {
            debug('⚠️ No project exploration pages found - this is OK, checking reports...');
            setDividerLabel1("");
            setDynamicMenuItems1([]);
            setHasVideoMenu(false);
          }

          // Fetch project reports (always fetch, even if explore is empty)
          try {
            const controller2 = new AbortController();
            const page_type = 'project/all/reports';
            response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller2.signal)

            debug('Project reports response:', response);
            if (response.success && response.data && response.data.length > 0) {
              const data = response.data;
              
              setDividerLabel2("Historical Reports");
              setDynamicMenuItems2(data);
              setMenuFound(true);

              // In project mode, don't auto-select - let user choose
              debug('📋 MODE 4: Reports pages loaded, no auto-selection in project mode');
            } else {
              debug('⚠️ No project reports pages found');
              setDividerLabel2("");
              setDynamicMenuItems2([]);
            }
          } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
              logError('Error fetching project reports:', error);
            }
            setDividerLabel2("");
            setDynamicMenuItems2([]);
          }

          // Fetch project tools (if any)
            try {
            const controllerTools = new AbortController();
            const page_type_tools = 'tools';
            const className = selectedClassName();
            response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type_tools)}`, controllerTools.signal)

            debug('Project tools response:', response);
            if (response.success && response.data && response.data.length > 0) {
              const data = response.data;
              setDividerLabelTools("Tools");
              setDynamicMenuItemsTools(data);
              setMenuFound(true);
            } else {
              setDividerLabelTools("");
              setDynamicMenuItemsTools([]);
            }
          } catch (error: any) {
            if (error.name === 'AbortError') {
            } else {
              logError('Error fetching project tools:', error);
            }
            setDividerLabelTools("");
            setDynamicMenuItemsTools([]);
          }

          // Load user page objects and maneuver menus after all menus are loaded
          await loadUserPageObjects();
          await loadManeuverMenus();
        } catch (error: any) {
          if (error.name === 'AbortError') {
          } else {
            logError("Failed to fetch project menu items", error);
          }
          setDividerLabel1("");
          setDividerLabel2("");
          setDynamicMenuItems1([]);
          setDynamicMenuItems2([]);
          setDividerLabelTools("");
          setDynamicMenuItemsTools([]);
          setMenuFound(false);
          setHasVideoMenu(false);
        } finally {
          isFetchingMenus = false;
        }
      }
      // MODE 5: All sources selected (project-level, all sources)
      else {
        debug('🌐 MODE 5: All sources (sourceId:', selectedSourceId(), ', sourceName:', selectedSourceName(), ')');
        
        try {
          const controller = new AbortController();
          const page_type = 'project/all/explore';
          response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller.signal)

          if (response.success && response.data && response.data.length > 0) {
            const data = response.data;
            
            setDividerLabel1("Explore History");
            setDynamicMenuItems1(data);
            setMenuFound(true);
            
            // Check if VIDEO menu is available and video exists in selected dataset/date
            const videoAvailable = data.some((item: any) => item.page_name === 'VIDEO');
            if (videoAvailable && (selectedDatasetId() > 0 || isValidDate(selectedDate())) && isLoggedIn()) {
              const videoExists = await checkVideoExists();
              setHasVideoMenu(videoExists);
            } else {
              setHasVideoMenu(videoAvailable);
            }
            
            debug('✅ Project/all explore pages found:', data.length);

            // In project mode, don't auto-select - let user choose
            debug('📋 MODE 5: Explore pages loaded, no auto-selection in project mode');
          } else {
            debug('⚠️ No project/all explore pages found - this is OK, checking reports...');
            setDividerLabel1("");
            setDynamicMenuItems1([]);
            setHasVideoMenu(false);
          }

          // Fetch project all reports (always fetch, even if explore is empty)
          try {
            const controller2 = new AbortController();
            const page_type = 'project/all/reports';
            response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type)}`, controller2.signal)

            debug('Project all reports response:', response);
            if (response.success && response.data && response.data.length > 0) {
              const data = response.data;
              
              setDividerLabel2("Historical Reports");
              setDynamicMenuItems2(data);
              setMenuFound(true);
              debug('✅ Project/all reports pages found:', data.length);

              // In project mode, don't auto-select - let user choose
              debug('📋 MODE 5: Reports pages loaded, no auto-selection in project mode');
              } else {
                debug('⚠️ No project/all reports pages found');
                setDividerLabel2("");
                setDynamicMenuItems2([]);
              }
            } catch (error: any) {
              if (error.name === 'AbortError') {
              } else {
                logError('Error fetching project all reports:', error);
              }
              setDividerLabel2("");
              setDynamicMenuItems2([]);
            }

          // Fetch project all tools (if any)
          if (selectedDatasetId() === 0 && !selectedDate()) {
            try {
              const controllerTools = new AbortController();
              const page_type_tools = 'tools';
              response = await getData(`${apiEndpoints.app.pages}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&page_type=${encodeURIComponent(page_type_tools)}`, controllerTools.signal)

              debug('Project all tools response:', response);
              if (response.success && response.data && response.data.length > 0) {
                const data = response.data;
                setDividerLabelTools("Tools");
                setDynamicMenuItemsTools(data);
                setMenuFound(true);
              } else {
                setDividerLabelTools("");
                setDynamicMenuItemsTools([]);
              }
            } catch (error: any) {
              if (error.name === 'AbortError') {
              } else {
                logError('Error fetching project all tools:', error);
              }
              setDividerLabelTools("");
              setDynamicMenuItemsTools([]);
            }
          }

          // Load user page objects and maneuver menus after all menus are loaded
          await loadUserPageObjects();
          await loadManeuverMenus();
        } catch (error: any) {
          if (error.name === 'AbortError') {
          } else {
            logError("Failed to fetch project all menu items", error);
          }
          setDividerLabel1("");
          setDividerLabel2("");
          setDynamicMenuItems1([]);
          setDynamicMenuItems2([]);
          setDividerLabelTools("");
          setDynamicMenuItemsTools([]);
          setMenuFound(false);
        } finally {
          isFetchingMenus = false;
        }
      }
    }

    setFetchMenuTrigger(0)
    setUpdateMenus(false)
    setSidebarMenuRefreshTrigger(0)
  };

  // Message handler for cross-window communication
  const handleMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    
    if (event.data.type === 'WINDOW_READY') {
      setChildWindows(prev => {
        const newMap = new Map(prev);
        // Accept event.source if it exists and has postMessage (it's a Window-like object)
        // The instanceof check can fail across different window contexts, so we check for postMessage instead
        if (event.source && typeof (event.source as any).postMessage === 'function') {
          newMap.set(event.data.windowName, event.source as Window);
        } else {
          warn('📢 Sidebar: WINDOW_READY received but event.source is not valid', {
            windowName: event.data.windowName,
            hasSource: !!event.source
          });
        }
        return newMap;
      });
    } else if (event.data.type === 'FILTER_UPDATE_FROM_CHILD') {
      // Receive filter updates from child windows and broadcast to ALL windows (including sender for confirmation)
      const payload = event.data.payload || {};
      debug('📢 Sidebar: Received filter update from child, broadcasting to all windows', payload);
      childWindows().forEach((childWindow, windowName) => {
        if (!childWindow.closed) {
          try {
            childWindow.postMessage({
              type: 'FILTER_STORE_UPDATE',
              payload,
              windowName: window.name
            }, window.location.origin);
          } catch (err) {
            warn('Error forwarding filter update to child window:', err);
          }
        }
      });
    } else if (event.data.type === 'GLOBAL_STORE_UPDATE_FROM_CHILD') {
      // Receive global store updates from child windows and broadcast to ALL windows (including sender for confirmation)
      const payload = event.data.payload || {};
      debug('📢 Sidebar: Received global store update from child, broadcasting to all windows', payload);
      
      // Update local store first
      if (payload.eventType !== undefined) {
        setEventType(payload.eventType);
      }
      if (payload.phase !== undefined) {
        setPhase(payload.phase);
      }
      if (payload.color !== undefined) {
        setColor(payload.color);
      }
      if (payload.groupDisplayMode !== undefined) {
        setGroupDisplayMode(payload.groupDisplayMode);
      } else if (payload.grouped !== undefined) {
        setGrouped(payload.grouped);
      }
      
      // Add cross-window sync markers to payload
      const crossWindowPayload = {
        ...payload,
        _crossWindowSync: true,
        _timestamp: Date.now(),
        _sourceWindow: window.name
      };
      
      // Broadcast to all child windows
      childWindows().forEach((childWindow, windowName) => {
        if (!childWindow.closed) {
          try {
            childWindow.postMessage({
              type: 'GLOBAL_STORE_UPDATE',
              payload: crossWindowPayload,
              windowName: window.name
            }, window.location.origin);
          } catch (err) {
            warn('Error forwarding global store update to child window:', err);
          }
        }
      });
    } else if (event.data.type === 'PLAYBACK_UPDATE_FROM_CHILD') {
      // Forward playback/time updates to all child windows
      const payload = event.data.payload || {};
      // Update parent's playback store so createEffect does not overwrite with stale false and cause play to pause immediately
      if (payload.isPlaying !== undefined) {
        setIsPlaying(!!payload.isPlaying);
        if (payload.isPlaying === true) {
          lastPlayFromChildAt = Date.now();
          setTimeout(() => {
            lastPlayFromChildAt = 0;
          }, PLAY_HOLD_MS);
        }
      }
      childWindows().forEach((childWindow, windowName) => {
        if (windowName !== event.data.windowName && !childWindow.closed) {
          try {
            childWindow.postMessage({
              type: 'PLAYBACK_STORE_UPDATE',
              payload,
              windowName: window.name
            }, window.location.origin);
          } catch (err) {
            warn('Error forwarding playback update to child window:', err);
          }
        }
      });
      } else if (event.data.type === 'SELECTION_UPDATE_FROM_CHILD') {
      // Handle regular selection updates (non-filter)
      // Update main window's selection store so selectedGroupKeys (and others) stay in sync when child updates
      window.dispatchEvent(new CustomEvent('selectionStoreUpdate', { detail: event.data.payload }));
      broadcastSelectionUpdate(event.data.payload, event.data.windowName);
    } else if (event.data.type === 'REQUEST_FILTER_STATE') {
      // Send current filter state to requesting child window
      debug('📢 Sidebar: Received REQUEST_FILTER_STATE from', event.data.windowName);
      const requestingWindow = childWindows().get(event.data.windowName);
      if (requestingWindow && !requestingWindow.closed) {
        const payload = {
          selectedStates: selectedStatesTimeseries(),
          selectedRaces: selectedRacesTimeseries(),
          selectedLegs: selectedLegsTimeseries(),
          selectedGrades: selectedGradesTimeseries(),
          raceOptions: raceOptions(),
          legOptions: legOptions(),
          gradeOptions: gradeOptions(),
          selectedHeadsailCodes: selectedHeadsailCodes(),
          selectedMainsailCodes: selectedMainsailCodes()
        };
        debug('📢 Sidebar: Sending filter state to', event.data.windowName, payload);
        requestingWindow.postMessage({
          type: 'FILTER_STORE_UPDATE',
          payload
        }, window.location.origin);
      }
    } else if (event.data.type === 'REQUEST_SELECTION_STATE') {
      // Send current selection state to requesting window (include selectedGroupKeys for grouped maneuver timeseries)
      const requestingWindow = childWindows().get(event.data.windowName);
      
      if (requestingWindow && !requestingWindow.closed) {
        const payload = {
          type: 'SELECTION_CHANGE',
          selection: selection(),
          hasSelection: hasSelection(),
          isCut: isCut(),
          selectedEvents: selectedEvents(),
          selectedRange: selectedRange(),
          selectedRanges: selectedRanges(),
          selectedGroupKeys: selectedGroupKeys(),
          cutEvents: cutEvents()
        };
        try {
          requestingWindow.postMessage({
            type: 'SELECTION_STORE_UPDATE',
            payload
          }, window.location.origin);
        } catch (err) {
          warn('Error sending selection state to child window:', err);
        }
      } else {
        warn('📢 Sidebar: Cannot send SELECTION_STORE_UPDATE - window not found or closed', {
          windowName: event.data.windowName
        });
      }
    } else if (event.data.type === 'REQUEST_PERSISTENT_STATE') {
      // Send current persistent store state to requesting window
      const requestingWindow = childWindows().get(event.data.windowName);
      if (requestingWindow && !requestingWindow.closed) {
        const payload = {
          selectedSourceId: selectedSourceId(),
          selectedSourceName: selectedSourceName(),
          selectedDatasetId: selectedDatasetId(),
          selectedDate: selectedDate(),
          selectedClassName: selectedClassName(),
          selectedProjectId: selectedProjectId()
        };
        debug('📢 Sidebar: Sending persistent store state to', event.data.windowName, payload);
        requestingWindow.postMessage({
          type: 'PERSISTENT_STORE_UPDATE',
          payload
        }, window.location.origin);
      }
    } else if (event.data.type === 'REQUEST_GLOBAL_STATE') {
      // Send current global store state to requesting window
      const requestingWindow = childWindows().get(event.data.windowName);
      
      if (requestingWindow && !requestingWindow.closed) {
        const payload = {
          eventType: eventType(),
          phase: phase(),
          color: color(),
          tws: tws(),
          grade: grade(),
          grouped: grouped(),
          groupDisplayMode: groupDisplayMode(),
          _crossWindowSync: true,
          _timestamp: Date.now(),
          _sourceWindow: window.name
        };
        debug('📢 Sidebar: Sending global store state to', event.data.windowName, payload);
        try {
          requestingWindow.postMessage({
            type: 'GLOBAL_STORE_UPDATE',
            payload
          }, window.location.origin);
        } catch (err) {
          warn('Error sending global store state to child window:', err);
        }
      } else {
        warn('📢 Sidebar: Cannot send GLOBAL_STORE_UPDATE - window not found or closed', {
          windowName: event.data.windowName
        });
      }
    }
  };

  // Resize handler function
  const handleResize = () => {
    checkScreenSize();
  };

  // Initialize sidebar when projects are loaded
  const initializeSidebar = async () => {
    debug('[Sidebar] initializeSidebar called');
    
    // Check if cache needs initialization (fallback check in case Dashboard missed it)
    const { isCacheInitialized, initializeApplicationCache } = persistantStore;
    if (!isCacheInitialized()) {
      debug('[Sidebar] Cache not initialized, triggering initialization before sidebar setup...');
      try {
        await initializeApplicationCache();
        debug('[Sidebar] Cache initialization completed');
      } catch (err) {
        logError('[Sidebar] Error during cache initialization:', err);
        // Continue anyway - don't block sidebar initialization
      }
    }
    
    if (!projects() || projects().length === 0) {
      debug('[Sidebar] No projects available yet, waiting...');
      return;
    }

    debug('[Sidebar] Projects loaded, initializing sidebar', {
      projectsCount: projects().length,
      selectedProjectId: selectedProjectId(),
      selectedClassName: selectedClassName()
    });

    // Set initialized flag BEFORE calling setSelectedProjectId to prevent infinite loop
    setIsInitialized(true);
    
    // Always ensure we have a valid project ID if projects are available
    const currentProjectId = selectedProjectId();
    debug('[Sidebar] Current project ID:', currentProjectId);
    
    if (currentProjectId && currentProjectId > 0) {
      // Project already selected, keep it
      debug('[Sidebar] Keeping existing project selection:', currentProjectId);
      setSelectedProjectId(currentProjectId);
    } else {
      // No project selected or invalid project ID, choose the first one
      const firstProject = ensureInteger(projects()[0].project_id);
      debug('[Sidebar] No valid project selected, choosing first project:', firstProject);
      if (firstProject !== null) {
        setSelectedProjectId(firstProject);
      }
    }

    // Load persistent settings FIRST (API is source of truth)
    let settingsLoaded = false;
    try {
      debug('[Sidebar] Loading persistent settings from API (source of truth)');
      settingsLoaded = await persistantStore.loadPersistentSettings();
      if (settingsLoaded) {
        debug('[Sidebar] Persistent settings loaded from API');
        debug('[Sidebar] Settings loaded from API:', {
          selectedProjectId: selectedProjectId(),
          selectedClassName: selectedClassName(),
          selectedSourceId: selectedSourceId(),
          selectedSourceName: selectedSourceName(),
          selectedDatasetId: selectedDatasetId(),
          selectedMenu: selectedMenu()
        });
      } else {
        debug('[Sidebar] No persistent settings found in API');
      }
    } catch (settingsError) {
      warn('[Sidebar] Failed to load persistent settings from API, will use fetchClass fallback:', settingsError);
    }

    // Always fetch class info from database to get the latest icon value
    // This ensures we have the correct icon even if saved settings have null/old values
    if (selectedProjectId() > 0) {
      debug('[Sidebar] Fetching class info from database to get latest icon');
      debug('[Sidebar] selectedClassName before fetchClass:', selectedClassName());
      debug('[Sidebar] selectedClassIcon before fetchClass:', selectedClassIcon());
      await fetchClass();
      debug('[Sidebar] selectedClassName after fetchClass:', selectedClassName());
      debug('[Sidebar] selectedClassIcon after fetchClass:', selectedClassIcon());
    } else if (!selectedClassName()) {
      // Only if we don't have a projectId, check if we need to fetch className
      debug('[Sidebar] No className from persistent settings and no projectId, cannot fetchClass');
    } else {
      debug('[Sidebar] Using className from persistent settings (no projectId to fetch icon):', selectedClassName());
    }

    // Only initialize settings if they weren't loaded from API and we have both className and projectId
    if (!settingsLoaded && selectedClassName() && selectedProjectId() > 0) {
      try {
        const currentUser = user();
        if (currentUser?.user_id) {
          debug('[Sidebar] No settings found in API, initializing with current values');
          await persistantStore.initializeAndSaveSettings(currentUser.user_id, selectedClassName(), selectedProjectId());
        }
      } catch (initError) {
        warn('[Sidebar] Failed to initialize settings:', initError);
      }
    }

    // Add a small delay to ensure signal updates are processed
    await new Promise(resolve => setTimeout(resolve, 10));
    

    // Ensure we have a valid className before proceeding
    let className = selectedClassName();
    debug('[Sidebar] className after fetchClass and delay:', className);
    
    if (!className) {
      logError('[Sidebar] No className available after fetchClass, cannot proceed');
      logError('[Sidebar] Current state:', {
        selectedProjectId: selectedProjectId(),
        selectedClassName: selectedClassName(),
        projects: projects()
      });

      // Try to use a fallback className based on common patterns
      const fallbackClassName = 'gp50'; // Default fallback
      warn('[Sidebar] Using fallback className:', fallbackClassName);
      setSelectedClassName(fallbackClassName);
      className = fallbackClassName;
    }

    // Apply theme from loaded settings
    try {
      const currentSettings = persistentSettingsService.getCurrentSettings();
      if (currentSettings['teamshare-theme']) {
        const { themeStore } = await import('../../store/themeStore');
        themeStore.setTheme(currentSettings['teamshare-theme']);
      }
    } catch (themeError) {
      warn('[Sidebar] Failed to apply theme from settings:', themeError);
    }

    // Reconcile source name if we have a valid sourceId but missing/ALL name
    try {
      if (selectedSourceId() > 0 && (!selectedSourceName() || selectedSourceName() === 'ALL')) {
        // Wait for sourcesStore to be ready
        let attempts = 0;
        while (!sourcesStore.isReady() && attempts < 10) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
        }
        if (sourcesStore.isReady()) {
          const sources = sourcesStore.sources();
          const match = sources.find(src => src.source_id === selectedSourceId());
          if (match && match.source_name) {
            setSelectedSourceName(match.source_name);
          }
        }
      }
    } catch (e) {
      warn('[Sidebar] Failed to reconcile source name from ID:', e);
    }

    // Reconcile source ID if ID is 0 but we have a concrete name (not ALL)
    try {
      const name = selectedSourceName();
      if (selectedSourceId() === 0 && name && name !== 'ALL') {
        // Wait for sourcesStore to be ready
        let attempts = 0;
        while (!sourcesStore.isReady() && attempts < 10) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
        }
        if (sourcesStore.isReady()) {
          const sourceId = sourcesStore.getSourceId(name);
          if (sourceId) {
            setSelectedSourceId(sourceId);
            setHasSources(true);
          }
        }
      }
    } catch (e) {
      warn('[Sidebar] Failed to reconcile source ID from name:', e);
    }

    // Auto-select first source if no source is selected (but respect 'ALL')
    debug('[Sidebar] Checking source selection:', {
      selectedSourceId: selectedSourceId(),
      selectedSourceName: selectedSourceName(),
      settingsLoaded: settingsLoaded
    });
    
    if (selectedSourceId() === 0 && selectedSourceName() !== 'ALL') {
      try {
        debug('[Sidebar] No source selected, waiting for sourcesStore to auto-select first one');
        // Wait for sourcesStore to be ready
        let attempts = 0;
        while (!sourcesStore.isReady() && attempts < 10) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
        }
        
        if (sourcesStore.isReady()) {
          const sources = sourcesStore.sources();
          if (sources && sources.length > 0) {
            const firstSource = sources[0];
            debug('[Sidebar] Auto-selecting first source:', firstSource);
            setSelectedSourceId(firstSource.source_id);
            setSelectedSourceName(firstSource.source_name);
            setHasSources(true);
          } else {
            debug('[Sidebar] No sources available');
            setHasSources(false);
          }
        } else {
          debug('[Sidebar] sourcesStore not ready after waiting');
          setHasSources(false);
        }
      } catch (error: any) {
        debug('[Sidebar] Error getting sources from sourcesStore:', error);
        logError('[Sidebar] Error getting sources from sourcesStore:', error);
        setHasSources(false);
      }
    } else if (selectedSourceId() === 0 && selectedSourceName() === 'ALL') {
      // 'ALL' is an intentional selection for fleet mode; consider sources available
      debug('[Sidebar] Fleet mode detected (ALL sources). Skipping auto-select.');
      setHasSources(true);
    } else {
      // Source is already selected, assume sources are available
      debug('[Sidebar] Source already selected from settings:', {
        selectedSourceId: selectedSourceId(),
        selectedSourceName: selectedSourceName()
      });
      setHasSources(true);
    }

    // Load dataset component AFTER fetchClass completes and className is set
    try {
      debug('[Sidebar] Loading dataset component for className:', className);
      
      if (!className) {
        logError('[Sidebar] ERROR: className is empty, cannot load dataset component');
        return;
      }
      
      const module = await import(`../../reports/${className}/Datasets.tsx`);
      const WrappedDatasetsComponent = (props: any) => <module.default {...props} fetchMenuTrigger={fetchMenuTrigger} setFetchMenuTrigger={setFetchMenuTrigger} />;
      setDatasetsComponent(() => WrappedDatasetsComponent);
      debug('[Sidebar] Dataset component loaded successfully');
    } catch (error: any) {
      logError("Failed to load the dataset component:", error);
    }

    await fetchDynamicMenuItems();
    
    // Ensure sources are initialized before restoring state or loading components
    // This ensures correct source information is available for drawing
    await ensureSourcesReady();
    
    // Restore last selected menu/page from persistent store so refresh returns user to where they were
    const isProjectMode = sidebarState() === 'project' || isProjectMenuActive();
    const hasNoDataset = selectedDatasetId() === 0;
    const hasNoDate = !selectedDate() || selectedDate() === '';
    const currentMenu = selectedMenu();
    const currentPage = selectedPage();
    const hasDataset = selectedDatasetId() > 0;
    const hasDate = selectedDate() && selectedDate() !== '';
    
    debug('[Sidebar] Menu restoration check:', {
      currentMenu,
      currentPage,
      selectedDatasetId: selectedDatasetId(),
      selectedDate: selectedDate(),
      selectedSourceId: selectedSourceId(),
      selectedSourceName: selectedSourceName(),
      settingsLoaded,
      isProjectMode,
      hasNoDataset,
      hasNoDate,
      hasDataset,
      hasDate
    });
    
    // When in project mode with no dataset/date: restore persisted menu if set, otherwise default to Datasets
    if (isProjectMode && hasNoDataset && hasNoDate) {
      if (currentMenu && currentMenu !== '' && currentMenu !== 'Datasets' && currentMenu !== 'Dataset') {
        debug('[Sidebar] Restoring persisted menu in project mode (no dataset/date):', currentMenu);
        await restoreStateFromStore();
      } else {
        debug('[Sidebar] Project mode, no persisted menu - defaulting to Datasets');
        setSelectedMenu('Datasets');
        setSelectedPage('');
        if (DatasetsComponent()) {
          setComponent(() => DatasetsComponent());
        } else {
          const className = selectedClassName();
          if (className) {
            import(`../../reports/${className}/Datasets.tsx`).then((module) => {
              const WrappedDatasetsComponent = (props: any) => <module.default {...props} fetchMenuTrigger={fetchMenuTrigger} setFetchMenuTrigger={setFetchMenuTrigger} />;
              setDatasetsComponent(() => WrappedDatasetsComponent);
              setComponent(() => WrappedDatasetsComponent);
              debug('[Sidebar] Loaded Datasets component during project initialization');
            }).catch((error) => {
              logError('[Sidebar] Failed to load Datasets component during project initialization:', error);
            });
          }
        }
      }
      setSidebarInitialized(true);
      return;
    }
    
    // Check if we have a meaningful selection (not just default "Datasets")
    if (currentMenu && currentMenu !== '' && currentMenu !== 'Datasets') {
      // Restore menu and component (works for dataset, day, or project context)
      if (hasDataset || hasDate) {
        debug('[Sidebar] Restoring state from store with', hasDataset ? 'dataset' : 'day', 'context');
        await restoreStateFromStore();
      } else {
        // Project-level menu (e.g. Events, Target Review) - restore it instead of clearing
        debug('[Sidebar] Restoring project-level menu from store:', currentMenu);
        await restoreStateFromStore();
      }
    } else if (hasDataset || hasDate) {
      // We have a dataset or date but no menu - try to restore menu from settings
      debug('[Sidebar] Have dataset/date but no menu, attempting to restore menu');
      await restoreStateFromStore();
    } else if (!hasExistingDataset) {
      // No persistent state, fall back to datasets page
      debug('[Sidebar] No persistent state, falling back to datasets page');
      setSelectedMenu('Datasets');
      setSelectedPage('');
      if (DatasetsComponent()) {
        setComponent(() => DatasetsComponent());
      }
    }

    setSidebarInitialized(true);
  };

  onMount(async () => {
    // Initialize responsive state
    checkScreenSize();
    
    // Add resize listener
    window.addEventListener('resize', handleResize);

    // Don't call initializeSidebar here - let the reactive effect handle it
    debug('[Sidebar] onMount completed, waiting for projects to load');
    
    // Note: Sidebar initialization is handled by createEffect when projects load
    // No need for fallback timeout since Dashboard now handles empty state

    // Make this available globally
    if (typeof window !== 'undefined') {
      // @ts-ignore
      window.sendSelectionUpdateToChildren = sendSelectionUpdateToChildren;
    }

    // Preserve sidebar state across page reloads
    // If user was in live mode, keep them there - the live page will handle streaming availability
    const currentState = sidebarState();
    debug('[Sidebar] Sidebar state on mount:', currentState);
    
    // Only set sidebar state if it's not already set to a valid mode
    // This preserves live mode across page reloads
    if (currentState === 'live') {
      debug('[Sidebar] Preserving live mode across page reload');
      // Keep live mode - don't reset it
    } else if (selectedDatasetId() > 0 || selectedDate() !== "") {
      setSidebarState('dataset');
    } else if (!currentState || currentState === 'project') {
      // Only set to project if not already in a specific mode
      setSidebarState('project');
    }

    // Add message listener for cross-window communication
    window.addEventListener('message', handleMessage);
    
    // Listen for global store updates from the main window and broadcast to all child windows
    // This ensures child windows sync when the main window changes color, phase, eventType, etc.
    const handleGlobalStoreUpdate = (event: CustomEvent) => {
      const payload = event.detail;
      if (!payload) {
        return;
      }
      
      const childWindowsList = childWindows();
      const childCount = childWindowsList.size;
      
      // Only broadcast if there are child windows
      if (childCount === 0) {
        return;
      }
      
      // Broadcast to all child windows via postMessage
      // Add cross-window sync markers to payload
      const crossWindowPayload = {
        ...payload,
        _crossWindowSync: true,
        _timestamp: Date.now(),
        _sourceWindow: window.name
      };
      
      childWindowsList.forEach((childWindow, windowName) => {
        if (!childWindow.closed) {
          try {
            childWindow.postMessage({
              type: 'GLOBAL_STORE_UPDATE',
              payload: crossWindowPayload,
              windowName: window.name
            }, window.location.origin);
          } catch (err) {
            warn('Error forwarding global store update to child window:', err);
          }
        }
      });
      
      // Also broadcast via BroadcastChannel for windows that don't have opener (moved tabs)
      // This allows windows that were moved from tabs to still receive updates
      try {
        const broadcastChannel = new BroadcastChannel('global-store-updates');
        broadcastChannel.postMessage({
          type: 'GLOBAL_STORE_UPDATE',
          payload: crossWindowPayload,
          sourceWindow: window.name
        });
        broadcastChannel.close(); // Close immediately after sending
      } catch (err) {
        // BroadcastChannel might not be available in some browsers/contexts
        debug('Sidebar: BroadcastChannel not available for global store updates');
      }
    };
    
    window.addEventListener('globalStoreUpdate', handleGlobalStoreUpdate as EventListener);
    
    // Listen for filter store updates from the main window and broadcast to all child windows
    // This ensures child windows sync when the main window changes filters
    const handleFilterStoreUpdate = (event: CustomEvent) => {
      const payload = event.detail;
      if (!payload) {
        return;
      }
      
      const childWindowsList = childWindows();
      const childCount = childWindowsList.size;
      
      // Only broadcast if there are child windows
      if (childCount === 0) {
        return;
      }
      
      // Broadcast to all child windows via postMessage
      childWindowsList.forEach((childWindow, windowName) => {
        if (!childWindow.closed) {
          try {
            childWindow.postMessage({
              type: 'FILTER_STORE_UPDATE',
              payload,
              windowName: window.name
            }, window.location.origin);
          } catch (err) {
            warn('Error forwarding filter store update to child window:', err);
          }
        }
      });
      
      debug('📢 Sidebar: Broadcasted filter store update to child windows', {
        childCount,
        payload
      });
    };
    
    window.addEventListener('filterStoreUpdate', handleFilterStoreUpdate as EventListener);
    
    // Broadcast main window play/pause state to all child windows so they stay in sync
    createEffect(() => {
      const playing = isPlaying();
      const list = childWindows();
      if (list.size === 0) return;
      list.forEach((childWindow, windowName) => {
        if (!childWindow.closed) {
          try {
            childWindow.postMessage({
              type: 'PLAYBACK_STORE_UPDATE',
              payload: { isPlaying: playing },
              windowName: window.name
            }, window.location.origin);
          } catch (err) {
            warn('Error sending playback state to child window:', err);
          }
        }
      });
    });

    // Broadcast main window selectedTime and timeWindow to child windows so PlaybackTimeSeries etc. stay in sync
    createEffect(() => {
      const time = selectedTime();
      const win = timeWindow();
      const list = childWindows();
      if (list.size === 0) return;
      const timeStr = time instanceof Date && Number.isFinite(time.getTime()) ? time.toISOString() : null;
      if (!timeStr) return;
      list.forEach((childWindow) => {
        if (!childWindow.closed) {
          try {
            childWindow.postMessage({
              type: 'PLAYBACK_STORE_UPDATE',
              payload: { type: 'TIME_CHANGE', selectedTime: timeStr, timeWindow: win },
              windowName: window.name
            }, window.location.origin);
          } catch (err) {
            warn('Error sending playback time to child window:', err);
          }
        }
      });
    });

    // Re-apply play when a stale BroadcastChannel "false" flips parent within PLAY_HOLD_MS of a child-initiated play
    createEffect(() => {
      const playing = isPlaying();
      if (!playing && lastPlayFromChildAt > 0 && Date.now() - lastPlayFromChildAt < PLAY_HOLD_MS) {
        setIsPlaying(true);
      }
    });
    
    // Store handler for cleanup
    // @ts-ignore
    window._globalStoreUpdateHandler = handleGlobalStoreUpdate;
    // @ts-ignore
    window._filterStoreUpdateHandler = handleFilterStoreUpdate;
  });

  // Cleanup event listener when component unmounts
  onCleanup(() => {
    window.removeEventListener('message', handleMessage);
    window.removeEventListener('resize', handleResize);
    
    // Remove global store update listener
    // @ts-ignore
    if (window._globalStoreUpdateHandler) {
      window.removeEventListener('globalStoreUpdate', window._globalStoreUpdateHandler as EventListener);
      // @ts-ignore
      delete window._globalStoreUpdateHandler;
    }
    
    // Remove filter store update listener
    // @ts-ignore
    if (window._filterStoreUpdateHandler) {
      window.removeEventListener('filterStoreUpdate', window._filterStoreUpdateHandler as EventListener);
      // @ts-ignore
      delete window._filterStoreUpdateHandler;
    }
    
    // Clear any pending component loads to prevent memory leaks
    if (loadComponentTimeout) {
      clearTimeout(loadComponentTimeout);
      loadComponentTimeout = null;
    }
  });

  // Watch for projects to be loaded and initialize sidebar
  // Initialize when projects array exists (even if empty) - this allows "Add Project" button to show
  createEffect(async () => {
    const projectsData = projects();
    const projectsCount = projectsData?.length || 0;
    const initialized = isInitialized();
    // Check if projects has been loaded (array exists, even if empty)
    const projectsLoaded = Array.isArray(projectsData);

    debug('[Sidebar] createEffect triggered', {
      projectsCount,
      isInitialized: initialized,
      projectsLoaded,
      selectedProjectId: selectedProjectId(),
      projectsData: projectsData
    });
    
    // Initialize when projects array has been loaded (even if empty) and not yet initialized
    // This ensures the sidebar shows "Add Project" button even when there are no projects
    if (projectsLoaded && !initialized) {
      debug('[Sidebar] Projects loaded, initializing sidebar', { projectsCount });
      await initializeSidebar();
    } else {
      debug('[Sidebar] Effect conditions not met:', {
        projectsLoaded,
        notInitialized: !initialized,
        projectsCount,
        initialized
      });
    }
  });

  // Watch for sidebarState, selectedMenu, and dynamic menu items - rebuild settings menu
  // Include dynamicMenuItems so that when fetchDynamicMenuItems completes (e.g. after View for a day),
  // the sidebar menu list updates to show day reports instead of stale/empty menus
  createEffect(() => {
    const currentSidebarState = sidebarState();
    const currentMenu = selectedMenu();
    const currentDatasetCount = datasetCount();
    const currentProjectId = selectedProjectId();
    const currentUser = user(); // Watch user to rebuild menu when user becomes available
    const d1 = dynamicMenuItems1(); // Rebuild when day/dataset menus load
    const d2 = dynamicMenuItems2();
    debug('🔄 Sidebar: createEffect triggered', {
      sidebarState: currentSidebarState,
      selectedMenu: currentMenu,
      datasetCount: currentDatasetCount,
      projectId: currentProjectId,
      userAvailable: !!currentUser
    });
    
    // Always build settings menu when sidebarState is set
    // Also build it when we have a project selected but no datasets, to ensure
    // users can access settings to add sources even when there are no datasets
    // Also rebuild when user becomes available (for permission checks)
    if (currentSidebarState || (currentProjectId > 0 && currentDatasetCount === 0)) {
      debug('🔄 Sidebar: Calling buildSettingsMenuItems');
      buildSettingsMenuItems();
    } else {
      debug('🔄 Sidebar: Conditions not met, not calling buildSettingsMenuItems');
    }
  });

  // Watch for selection changes in main window and broadcast to child windows
  createEffect(() => {
    // Access all selection signals to trigger effect when any change (include selectedGroupKeys for grouped maneuver timeseries)
    const currentSelectedEvents = selectedEvents();
    const currentSelection = selection();
    const currentHasSelection = hasSelection();
    const currentIsCut = isCut();
    const currentSelectedRange = selectedRange();
    const currentSelectedRanges = selectedRanges();
    const currentSelectedGroupKeys = selectedGroupKeys();
    const currentCutEvents = cutEvents();
    
    // Only broadcast if we have child windows
    if (childWindows().size > 0) {
      const payload = {
        type: 'SELECTION_CHANGE',
        selection: currentSelection,
        hasSelection: currentHasSelection,
        isCut: currentIsCut,
        selectedEvents: currentSelectedEvents,
        selectedRange: currentSelectedRange,
        selectedRanges: currentSelectedRanges,
        selectedGroupKeys: currentSelectedGroupKeys,
        cutEvents: currentCutEvents
      };
      
      broadcastSelectionUpdate(payload);
    }
  });

  // Watch for global store changes (eventType, phase, color, grouped, groupDisplayMode) and broadcast to child windows
  createEffect(() => {
    const currentEventType = eventType();
    const currentPhase = phase();
    const currentColor = color();
    const currentGrouped = grouped();
    const currentGroupDisplayMode = groupDisplayMode();
    
    // Only broadcast if we have child windows
    if (childWindows().size > 0) {
      childWindows().forEach((windowRef, windowName) => {
        if (windowRef && !windowRef.closed) {
          try {
            if (!windowRef.document.hidden) {
              windowRef.postMessage({
                type: 'GLOBAL_STORE_UPDATE',
                payload: {
                  eventType: currentEventType,
                  phase: currentPhase,
                  color: currentColor,
                  grouped: currentGrouped,
                  groupDisplayMode: currentGroupDisplayMode
                }
              }, window.location.origin);
            }
          } catch (error: any) {
            // Window might be closed or inaccessible, remove it from the map
            setChildWindows(prev => {
              const newMap = new Map(prev);
              newMap.delete(windowName);
              return newMap;
            });
          }
        }
      });
    }
  });

  createEffect(async () => {
    if (fetchMenuTrigger() || updateMenus() || sidebarMenuRefreshTrigger()) {
      if (selectedClassName() && selectedProjectId()) {
        await fetchDynamicMenuItems();
      }
    }
  });

  // Watch for selectedDatasetId changes - trigger menu reload when dataset is selected
  let previousDatasetId = selectedDatasetId();
  createEffect(async () => {
    const datasetId = selectedDatasetId();
    
    // Only trigger if dataset ID actually changed and is now > 0
    if (datasetId !== previousDatasetId && datasetId > 0 && selectedClassName() && selectedProjectId()) {
      debug('🔄 Dataset selected, triggering menu reload:', datasetId, '(was:', previousDatasetId, ')');
      previousDatasetId = datasetId;
      setFetchMenuTrigger(1);
      // Also ensure sidebar state is set to dataset mode
      if (sidebarState() !== 'dataset') {
        setSidebarState('dataset');
      }
    } else if (datasetId !== previousDatasetId) {
      // Dataset ID changed (including to 0)
      previousDatasetId = datasetId;
    }
  });

  // Watch for selectedSource changes when dataset and date are not valid
  // Skip duplicate calls by tracking previous source ID
  let previousSourceIdForMenu = selectedSourceId();
  createEffect(async () => {
    const sourceId = selectedSourceId();
    const datasetId = selectedDatasetId();
    const date = selectedDate();
    
    // Only update menus if source actually changed and we don't have valid dataset/date
    // Skip if source hasn't changed (prevents duplicate calls during project init)
    if (sourceId === previousSourceIdForMenu) {
      return;
    }
    previousSourceIdForMenu = sourceId;
    
    if (sourceId !== undefined && selectedClassName() && selectedProjectId()) {
      const hasValidDataset = datasetId > 0;
      const hasValidDate = isValidDate(date);
      
      if (!hasValidDataset && !hasValidDate) {
        debug('🔄 Source changed and no valid dataset/date - updating sidebar menus');
        await fetchDynamicMenuItems();
      }
    }
  });

  // Watch for selectedProjectId changes and update className accordingly
  let previousProjectId = selectedProjectId();
  createEffect(async () => {
    const projectId = selectedProjectId();
    
    // Only fetch className if project actually changed and is valid
    if (projectId !== previousProjectId && projectId && projectId > 0) {
      debug('🔄 Project changed, fetching className for project:', projectId, '(was:', previousProjectId, ')');
      previousProjectId = projectId;
      
      try {
        await fetchClass();
        const className = selectedClassName();
        debug('🔄 Project className updated to:', className);
        
        // Load datasets component for the new className
        if (className) {
          try {
            debug('[Sidebar] Loading dataset component for className:', className);
            const module = await import(`../../reports/${className}/Datasets.tsx`);
            const WrappedDatasetsComponent = (props: any) => <module.default {...props} fetchMenuTrigger={fetchMenuTrigger} setFetchMenuTrigger={setFetchMenuTrigger} />;
            setDatasetsComponent(() => WrappedDatasetsComponent);
            debug('[Sidebar] Dataset component loaded successfully');
            
            // Clear any existing component first to prevent other components from loading
            setComponent(null);
            
            // Explicitly set Datasets as the menu FIRST, then set the component
            // This ensures Datasets is the first page loaded after project initialization
            setSelectedMenu("Datasets");
            setSelectedPage("");
            
            // Set datasets as the current component
            // This ensures Datasets loads when project changes via the reactive effect
            if (DatasetsComponent()) {
              setComponent(() => DatasetsComponent());
              debug('[Sidebar] Project change effect: Set Datasets as active menu and component');
            } else {
              debug('[Sidebar] Project change effect: Datasets component not yet available');
            }
            
            // Navigate to dashboard if not already there
            const currentPath = location.pathname;
            if (currentPath !== '/dashboard') {
              debug('[Sidebar] Navigating to dashboard for new project');
              navigate('/dashboard');
            }
          } catch (error: any) {
            logError("Failed to load the dataset component after project change:", error);
          }
        }
      } catch (error) {
        logError('[Sidebar] Error fetching className after project change:', error);
      }
    } else if (projectId !== previousProjectId) {
      // Project ID changed (including to 0 or invalid)
      previousProjectId = projectId;
    }
  });

  const projectLabel = () => {
    const project_id = ensureInteger(selectedProjectId());
    const selected = projects()?.find(project => ensureInteger(project.project_id) === project_id);
    return selected ? selected.description : "Select Project";
  };

  const handleAddDataset = async () => {
    debug('[Sidebar] handleAddDataset: Starting, selectedProjectId:', selectedProjectId(), 'selectedClassName:', selectedClassName());
    
    let className = '';
    
    // Always fetch className from API when we have a projectId to ensure accuracy
    // The store value might be stale or incorrect
    if (selectedProjectId() && selectedProjectId() > 0) {
      try {
        const url = `${apiEndpoints.app.projects}/class?project_id=${encodeURIComponent(selectedProjectId())}`;
        debug('[Sidebar] handleAddDataset: Fetching className from API:', url);
        
        const response = await getData(url);
        debug('[Sidebar] handleAddDataset: API response:', response);
        
        if (response.success && response.data) {
          // Handle both old format (string) and new format (object with class_name, icon, and size_m)
          let classObject: { class_name: string; icon?: string | null; size_m?: number | null } | null = null;
          
          if (typeof response.data === 'string') {
            // Backward compatibility: old format returns just the class name string
            className = response.data.toLowerCase().trim();
            classObject = { class_name: className };
          } else if (response.data && typeof response.data === 'object') {
            // New format: object with class_name, icon, and size_m
            className = (response.data.class_name || '').toLowerCase().trim();
            const iconValue = response.data.icon || response.data.Icon || null;
            const icon = (iconValue && typeof iconValue === 'string' && iconValue.trim() !== '') ? iconValue.trim() : null;
            const sizeMValue = response.data.size_m !== null && response.data.size_m !== undefined 
              ? Number(response.data.size_m) 
              : null;
            const sizeM = (!isNaN(sizeMValue as number) && sizeMValue !== null) ? sizeMValue : null;
            classObject = {
              class_name: className,
              icon: icon,
              size_m: sizeM
            };
            setSelectedClassIcon(icon);
            setSelectedClassSizeM(sizeM);
          } else {
            warn('[Sidebar] handleAddDataset: Unexpected response data format:', response.data);
            className = String(response.data).toLowerCase().trim();
            classObject = { class_name: className };
          }
          
          debug('[Sidebar] handleAddDataset: Got className from API:', className);
          // Update the store with the correct values
          setSelectedClassName(className);
          setSelectedClassObject(classObject);
        } else {
          warn('[Sidebar] handleAddDataset: Failed to fetch className from API, response:', response);
        }
      } catch (error) {
        logError('[Sidebar] handleAddDataset: Error fetching className:', error);
      }
    }
    
    // If API fetch failed, try to use className from store as fallback
    if (!className || className.trim().length === 0) {
      const storeClassName = selectedClassName();
      if (storeClassName && storeClassName.trim().length > 0) {
        className = storeClassName.trim();
        debug('[Sidebar] handleAddDataset: Using className from store as fallback:', className);
      }
    }
    
    // If still not available, try to extract from current route pathname
    if (!className || className.trim().length === 0) {
      const pathname = location.pathname;
      debug('[Sidebar] handleAddDataset: Trying to extract from route:', pathname);
      // Check for class-specific routes like /dashboard/gp50, /reports/gp50, etc.
      const routeMatch = pathname.match(/\/(?:dashboard|reports|upload-datasets)\/([^/]+)/);
      if (routeMatch && routeMatch[1]) {
        className = routeMatch[1].toLowerCase();
        debug('[Sidebar] handleAddDataset: Extracted className from route:', className);
      }
    }
    
    // Fallback to default if still not available
    if (!className || className.trim().length === 0) {
      warn('[Sidebar] handleAddDataset: No className found, falling back to gp50');
      className = 'gp50';
    }
    
    debug('[Sidebar] handleAddDataset: Final className:', className, 'Navigating to:', `/upload-datasets/${className}`);
    
    navigate(`/upload-datasets/${className}`);
  };

  const handleAddRaceCourse = () => {
    navigate("/upload-race-course");
  };

  const handleAddTargets = (value: string) => {
    navigate("/upload-targets", { state: { file_type: value }});
  };

  const handleAddVideo = (value: string) => {
    navigate("/upload-video", { state: { file_type: value }});
  };

  // Project click handler
  const handleProjectClick = async (reset: boolean) => {
    // Exit split screen mode if active
    if (isSplitView() && closeSplitView) {
      closeSplitView();
    }
    
    // If we were in live mode, switch to project mode
    const wasInLiveMode = sidebarState() === 'live';
    if (wasInLiveMode) {
      debug('[Sidebar] Switching from live mode to project mode');
      
      // IMMEDIATELY clean up streaming store to prevent blocking navigation
      if (streamingStore.isInitialized) {
        debug('[Sidebar] Exiting live mode - immediately cleaning up streaming store');
        try {
          streamingStore.cleanup();
        } catch (err) {
          debug('[Sidebar] Error cleaning up streaming store:', err);
        }
      }
      
      setSidebarState('project');
    }
    
    if (reset) {
        setSelectedDatasetId(0);
        setSelectedDate(""); // Clear selected date when project menu is clicked
        // Preserve current source selection when navigating to project datasets
        // Clear all selections, cuts, and time when switching projects
        try { setSelectedEvents([]); } catch (_) {}
        try { setSelectedRanges([]); } catch (_) {}
        try { setSelectedRange([]); } catch (_) {}
        try { setCutEvents([]); } catch (_) {}
        try { setHasSelection(false); } catch (_) {}
        try { setIsCut(false); } catch (_) {}
        try { setSelectedTime(new Date('1970-01-01T12:00:00Z'), 'sidebar'); } catch (_) {}
        // Clear all filters when navigating to datasets
        try { clearTimeseriesFilters(); } catch (_) {}
        setIsProjectMenuActive(true);
        setSelectedMenu("Dataset");
        // Always switch to project mode when clicking project (exit live mode)
        setSidebarState('project');
    }

    debug('[Sidebar] Setting component to DatasetsComponent');
    // Set component and ensure project menu is active BEFORE fetching menus
    setIsProjectMenuActive(true);
    setSelectedMenu("Dataset");
    setComponent(() => DatasetsComponent());
    setShowProjects(false);
    
    // Fetch dynamic menus to populate sidebar, but don't auto-load first item
    // The isProjectMenuActive flag should prevent auto-loading
    debug('[Sidebar] Fetching dynamic menu items for project mode');
    await fetchDynamicMenuItems();
  };

  // Project menu item click handler
  const handleProjectMenuClick = async (project: any) => {
    // Exit split screen mode if active
    if (isSplitView() && closeSplitView) {
      closeSplitView();
    }
    
    const project_id = ensureInteger(project.project_id);
    if (project_id === null) {
      logError("Invalid project ID");
      return;
    }

    // IMMEDIATELY clean up streaming store if we're exiting live mode
    // This prevents blocking navigation while live page operations complete
    const wasInLiveMode = sidebarState() === 'live';
    if (wasInLiveMode && streamingStore.isInitialized) {
      debug('[Sidebar] Exiting live mode - immediately cleaning up streaming store');
      try {
        streamingStore.cleanup();
      } catch (err) {
        debug('[Sidebar] Error cleaning up streaming store:', err);
      }
    }

    // IMMEDIATELY show Datasets page for instant feedback
    // This prevents showing stale data from the previous project
    setSelectedMenu("Datasets");
    setSelectedPage("");
    if (DatasetsComponent()) {
      setComponent(() => DatasetsComponent());
      debug('[Sidebar] Immediately showing Datasets page before project change');
    } else {
      // If Datasets component not loaded, clear component to show loading state
      setComponent(null);
      debug('[Sidebar] Clearing component, Datasets will load after project change');
    }

    // Clear state before switching projects
    setSelectedDatasetId(0);
    setSelectedDate(""); // Clear selected date when switching projects
    setSelectedSourceId(0); // Clear selected source to ensure MODE 4 (project/all) menus are fetched
    setSelectedSourceName(""); // Clear selected source name
    // Clear all selections, cuts, and time when switching projects
    try { setSelectedEvents([]); } catch (_) {}
    try { setSelectedRanges([]); } catch (_) {}
    try { setSelectedRange([]); } catch (_) {}
    try { setCutEvents([]); } catch (_) {}
    try { setHasSelection(false); } catch (_) {}
    try { setIsCut(false); } catch (_) {}
    try { setSelectedTime(new Date('1970-01-01T12:00:00Z'), 'sidebar'); } catch (_) {}
    // Clear all filters when switching projects
    try { clearTimeseriesFilters(); } catch (_) {}
    
    // Now change the project - this will trigger reinitialization
    setSelectedProjectId(project_id);
    
    // Fetch className for the newly selected project
    debug('[Sidebar] Project changed, fetching className for project:', project_id);
    try {
      await fetchClass();
      const className = selectedClassName();
      debug('[Sidebar] className updated to:', className);
      
      // Load datasets component for the new className
      if (className) {
        try {
          debug('[Sidebar] Loading dataset component for className:', className);
          const module = await import(`../../reports/${className}/Datasets.tsx`);
          const WrappedDatasetsComponent = (props: any) => <module.default {...props} fetchMenuTrigger={fetchMenuTrigger} setFetchMenuTrigger={setFetchMenuTrigger} />;
          setDatasetsComponent(() => WrappedDatasetsComponent);
          debug('[Sidebar] Dataset component loaded successfully');
        } catch (error: any) {
          logError("Failed to load the dataset component after project change:", error);
        }
      }
    } catch (error) {
      logError('[Sidebar] Error fetching className after project change:', error);
    }
    
    setIsProjectMenuActive(true);
    // Preserve live mode if active, otherwise set to project
    if (sidebarState() !== 'live') {
      setSidebarState('project');
    }
    setShowProjects(false);
    
    // Clear any existing component to prevent FleetPerformance or other components from loading
    setComponent(null);
    
    // Set Datasets as the active menu and component BEFORE fetching dynamic menus
    // This ensures Datasets loads first and won't be overridden by fetchDynamicMenuItems
    setSelectedMenu("Datasets");
    setSelectedPage("");
    if (DatasetsComponent()) {
      setComponent(() => DatasetsComponent());
      debug('[Sidebar] Set Datasets as active menu and component before fetching menus');
    } else {
      debug('[Sidebar] DatasetsComponent not yet loaded, will be set by project change effect');
    }
    
    // Navigate to dashboard if not already there
    const currentPath = location.pathname;
    if (currentPath !== '/dashboard') {
      debug('[Sidebar] Navigating to dashboard for new project');
      navigate('/dashboard');
    }
    
    // Fetch dynamic menus to populate sidebar
    // Note: We've already set Datasets as the active menu above, so this won't override it
    await fetchDynamicMenuItems();
  };

  const handleMenuClick = async (item: any, event: MouseEvent) => {
    const isCtrlPressed = event?.ctrlKey || event?.metaKey;
    const isShiftPressed = event?.shiftKey;
    const isLiveMode = sidebarState() === 'live';
    const currentMenu = selectedMenu();
    
    debug('[Sidebar] handleMenuClick called', {
      pageName: item.page_name,
      filePath: item.file_path,
      currentMenu,
      isLiveMode,
      isCtrlPressed,
      isShiftPressed,
      isSplitView: isSplitView()
    });
    
    // Guard: prevent opening the same regular menu in split view if it's already on the left. Use canonical name so Map/Overlay are the same.
    const isSameRegularAsLeft = () => canonicalExploreMenuName(selectedMenu() || '') === canonicalExploreMenuName(item.page_name || '');
    
      // Helper function to get default object name for reports that need it
      const getDefaultObjectName = async (pageName: string) => {
      if (pageName === 'PERFORMANCE') {
        const objectNames = await fetchUserPageNames('performance');
        if (objectNames.length > 0) {
          // Handle both object format {object_name: '...'} and string format
          const firstObject = objectNames[0];
          return typeof firstObject === 'string' ? firstObject : (firstObject.object_name || 'performance_default');
        }
        return 'performance_default';
      } else if (pageName === 'TARGETS') {
        const objectNames = await fetchUserPageNames('targets');
        if (objectNames.length > 0) {
          // Handle both object format {object_name: '...'} and string format
          const firstObject = objectNames[0];
          return typeof firstObject === 'string' ? firstObject : (firstObject.object_name || 'targets_default');
        }
        return 'targets_default';
      }
      return '';
    };

    const isDayMode = isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0);
    const pathForItem = isDayMode ? (getDayExploreFilePath(item.page_name) || getDayReportFilePath(item.page_name) || item.file_path) : item.file_path;
    
    if (isCtrlPressed && isShiftPressed) {
      // Ctrl+Shift+click - open in new window
      openComponentInNewWindow(item.page_name);
    } else if (isCtrlPressed) {
      // Ctrl+click - open in split view WITHOUT updating selectedMenu
      debug('[Sidebar] ===== CTRL+CLICK SPLIT VIEW START =====');
      debug('[Sidebar] Ctrl+click detected', { 
        pageName: item.page_name, 
        filePath: item.file_path,
        selectedMenu: selectedMenu(),
        selectedDate: selectedDate(),
        selectedDatasetId: selectedDatasetId()
      });
      
      setIsProjectMenuActive(false);
      // Don't update selectedMenu - keep the current left panel menu
      
      // Load component and open in split view
      const sameAsLeft = isSameRegularAsLeft();
      debug('[Sidebar] isSameRegularAsLeft check', { 
        result: sameAsLeft,
        leftMenu: selectedMenu(),
        clickedMenu: item.page_name,
        leftCanonical: canonicalExploreMenuName(selectedMenu() || ''),
        clickedCanonical: canonicalExploreMenuName(item.page_name || '')
      });
      
      if (sameAsLeft) {
        log('Split view prevented: same menu already open on left');
        return;
      }
      
      const isDayMode = isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0);
      debug('[Sidebar] Mode detection', { isDayMode, selectedDate: selectedDate(), selectedDatasetId: selectedDatasetId() });
      
      // In day mode use Fleet path for explore (FleetMap, FleetVideo, FleetTimeSeries) or day reports (FleetPerformance, FleetManeuvers, etc.); in dataset mode use item.file_path
      let pathToLoad: string;
      if (isDayMode) {
        let splitPath = getDayExploreFilePath(item.page_name) || getDayReportFilePath(item.page_name);
        debug('[Sidebar] getDayExploreFilePath/getDayReportFilePath result', { pageName: item.page_name, splitPath });
        
        if (!splitPath && item.file_path) {
          // Fallback: derive Fleet path from file_path when API page_name doesn't match (e.g. API returns dataset path in day context)
          const basePath = (item.file_path || '').replace(/\.(jsx|tsx|js|ts)$/, '');
          debug('[Sidebar] Attempting fallback from file_path', { filePath: item.file_path, basePath });
          
          if (basePath.includes('dataset/explore') || basePath.includes('day/explore')) {
            const lastSegment = basePath.split('/').pop() || '';
            let key = lastSegment.toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
            if (key.startsWith('fleet')) key = key.replace(/^fleet_?/, '') || key;
            const fleetName = DAY_EXPLORE_FLEET_ALIAS[key];
            debug('[Sidebar] Fallback derivation', { lastSegment, key, fleetName });
            if (fleetName) splitPath = `gp50/day/explore/${fleetName}`;
          }
          if (!splitPath && basePath.includes('dataset/reports')) {
            const lastSegment = basePath.split('/').pop() || '';
            const dayReportPath = getDayReportFilePath(lastSegment) || getDayReportFilePath(item.page_name);
            if (dayReportPath) splitPath = dayReportPath;
          }
        }
        pathToLoad = splitPath || item.file_path;
        debug('[Sidebar] Day mode final path', { splitPath, fallbackUsed: !splitPath, pathToLoad });
      } else {
        pathToLoad = item.file_path;
        debug('[Sidebar] Dataset mode path', { pathToLoad });
      }
      
      // In day mode pass left path so we load a fresh FleetMap for left panel (avoids SolidJS "push of null" when reusing live component)
      const leftPathForSplit = isDayMode ? (getDayExploreFilePath(selectedMenu() || '') || undefined) : undefined;
      debug('[Sidebar] About to call loadComponentForSplitView', { 
        pathToLoad, 
        leftPathForSplit,
        title: canonicalExploreMenuName(item.page_name),
        menuName: canonicalExploreMenuName(item.page_name)
      });
      
      loadComponentForSplitView(pathToLoad, canonicalExploreMenuName(item.page_name), canonicalExploreMenuName(item.page_name), leftPathForSplit);
      
      debug('[Sidebar] ===== CTRL+CLICK SPLIT VIEW END =====');
    } else {
      // Normal click - behavior depends on split view state
      if (isSplitView()) {
        // In split view: normal click always updates left panel (even if same menu)
        log('Normal click in split view, loading:', item.file_path);
        log('isSplitView() result:', isSplitView());
        log('updateLeftComponent available:', typeof updateLeftComponent);
        setIsProjectMenuActive(false);
        setSelectedMenu(canonicalExploreMenuName(item.page_name));
        // Set default object name for reports that need it
        const defaultObjectName = await getDefaultObjectName(item.page_name);
        setSelectedPage(defaultObjectName);
        const isDayModeLeft = isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0);
        const leftPath = isDayModeLeft ? getDayExploreFilePath(item.page_name) : null;
        loadComponentForLeftPanel(leftPath || pathForItem, item.page_name);
      } else if (isLiveMode || canonicalExploreMenuName(currentMenu || '') !== canonicalExploreMenuName(item.page_name || '')) {
        // In live mode, always allow navigation (even if same menu)
        // Otherwise, only load if different menu (canonical so Map/Overlay are the same)
        debug('[Sidebar] Loading component for menu item', {
          pageName: item.page_name,
          filePath: item.file_path,
          reason: isLiveMode ? 'live mode' : 'different menu'
        });
        setIsProjectMenuActive(false);
        setSelectedMenu(canonicalExploreMenuName(item.page_name));
        // Set default object name for reports that need it
        const defaultObjectName = await getDefaultObjectName(item.page_name);
        setSelectedPage(defaultObjectName);
        log('Normal click not in split view, loading:', pathForItem, isLiveMode ? '(live mode)' : '');
        loadComponent(pathForItem);
      } else {
        // Same menu already selected - special handling for certain menus
        if (item.page_name === 'MANEUVERS') {
          // For MANEUVERS menu, reload the maneuver report page
          debug('[Sidebar] MANEUVERS menu clicked, reloading maneuver report page');
          setIsProjectMenuActive(false);
          setSelectedMenu('MANEUVERS');
          setSelectedPage('');
          loadComponent(pathForItem);
        } else if (item.page_name === 'PERFORMANCE' || item.page_name === 'TARGETS') {
          debug('[Sidebar] Same menu selected, but fetching object name for', item.page_name);
          const defaultObjectName = await getDefaultObjectName(item.page_name);
          const currentPage = selectedPage();
          // Only reload if the object name has changed
          if (currentPage !== defaultObjectName) {
            debug('[Sidebar] Object name changed, reloading component', {
              old: currentPage,
              new: defaultObjectName
            });
            setSelectedPage(defaultObjectName);
            loadComponent(pathForItem);
          } else {
            debug('[Sidebar] Object name unchanged, skipping reload', {
              objectName: defaultObjectName
            });
          }
        } else {
          debug('[Sidebar] Skipping menu click - same menu already selected', {
            pageName: item.page_name,
            currentMenu
          });
        }
      }
    }
  };

  const handlePageSettings = (chartType: string) => {
    const objectName = selectedPage();

    debug('chartType', chartType);
    
    // Normalize chart type by removing spaces and converting to uppercase
    let normalizedChartType = chartType.replace(/\s+/g, '').toUpperCase();
    // Map fleet parent names to menu chart type for builder navigation
    if (normalizedChartType === 'FLEET_TIMESERIES') normalizedChartType = 'TIMESERIES';
    else if (normalizedChartType === 'FLEET_SCATTER') normalizedChartType = 'SCATTER';
    else if (normalizedChartType === 'FLEET_PROBABILITY') normalizedChartType = 'PROBABILITY';
    
    // Check if fleet mode should be enabled (when selectedDate is valid)
    const currentDate = selectedDate();
    const isDateValid = isValidDate(currentDate);
    const fleetParam = isDateValid ? '&fleet=true' : '';
    
    debug('handlePageSettings - Date check:', {
      selectedDate: currentDate,
      isDateValid: isDateValid,
      fleetParam: fleetParam,
      normalizedChartType: normalizedChartType
    });
    
    // Handle user page menu items - use selectedPage for object name
    if (objectName && objectName !== '') {
      debug('Navigating to builder with object_name:', objectName);
      switch (normalizedChartType) {
        case 'TIMESERIES':
          const timeseriesUrl = `/timeseries-builder?object_name=${objectName}${fleetParam}`;
          debug('Navigating to timeseries-builder:', timeseriesUrl);
          navigate(timeseriesUrl);
          break;
        case 'SCATTER':
          navigate(`/scatter-builder?object_name=${objectName}${fleetParam}`);
          break;
        case 'PROBABILITY':
          navigate(`/probability-builder?object_name=${objectName}${fleetParam}`);
          break;
        case 'PARALLEL':
          navigate(`/parallel-builder?object_name=${objectName}`);
          break;
        case 'PERFORMANCE':
          navigate(`/performance-builder?object_name=${objectName}`);
          break;
        case 'TARGETS':
          navigate(`/targets-builder?object_name=${objectName}`);
          break;
        case 'POLARROSE':
          navigate(`/polar-rose-builder?object_name=${objectName}`);
          break;
        case 'GRID':
          navigate(`/grid-builder?object_name=${objectName}`);
          break;
        case 'TABLE':
          navigate(`/table-builder?object_name=${objectName}`);
          break;
        case 'VIDEO':
          navigate(`/video-builder?object_name=${objectName}`);
          break;
        case 'MAP':
          navigate(`/overlay-builder?object_name=${objectName}`);
          break;
        case 'BOAT':
          navigate(`/boat-builder?object_name=${objectName}`);
          break;
        default:
          navigate(`/overlay-builder?object_name=${objectName}`);
      }
      return;
    }

    // Handle regular menu items (no selectedPage)
    if (normalizedChartType === 'SCATTER') {
      navigate(`/scatter-builder${fleetParam ? `?fleet=true` : ''}`);
    } else if (normalizedChartType === 'TIMESERIES') {
      const timeseriesUrl = `/timeseries-builder${fleetParam ? `?fleet=true` : ''}`;
      debug('Navigating to timeseries-builder (no object_name):', timeseriesUrl);
      navigate(timeseriesUrl);
    } else if (normalizedChartType === 'PROBABILITY') {
      navigate(`/probability-builder${fleetParam ? `?fleet=true` : ''}`);
    } else if (normalizedChartType === 'PARALLEL') {
      navigate(`/parallel-builder`);
    } else if (normalizedChartType === 'PERFORMANCE') {
      navigate(`/performance-builder`);
    } else if (normalizedChartType === 'TARGETS') {
      navigate(`/targets-builder`);
    } else if (normalizedChartType === 'POLARROSE') {
      navigate(`/polar-rose-builder`);
    } else if (normalizedChartType === 'GRID') {
      navigate(`/grid-builder`);
    } else if (normalizedChartType === 'TABLE') {
      navigate(`/table-builder`);
    } else if (normalizedChartType === 'VIDEO') {
      navigate(`/video-builder`);
    } else if (normalizedChartType === 'MAP') {
      navigate(`/overlay-builder`);
    } else if (normalizedChartType === 'BOAT') {
      navigate(`/boat-builder`);
    } else {
      navigate(`/overlay-builder`);
    }
  }

  const handleUpdateProjectMenuClick = () => {
    navigate("/project-info")
  };

  const handleUpdateDatasetMenuClick = () => {
    const className = selectedClassName() || 'gp50';
    navigate(`/dataset-info/${className}`)
  };

  const handleAdminMenuClick = () => {
    navigate("/admin")
  };

  const handleAddProject = () => {
    navigate("/project")
  };

  const loadComponent = async (componentPath: string) => {
    try {
      // Clear any pending loads to prevent race conditions
      if (loadComponentTimeout) {
        clearTimeout(loadComponentTimeout);
        loadComponentTimeout = null;
      }
      
      // If loading the same component that's already loaded, ensure it's set but skip reload
      if (currentLoadingPath === componentPath && currentComponent) {
        debug('[Sidebar] loadComponent: Component already loaded, ensuring it is set:', componentPath);
        // Still set the component to ensure it's displayed
        setComponent(() => currentComponent);
        return;
      }
      
      debug('[Sidebar] loadComponent called with:', componentPath);
      if (componentPath && componentPath.length > 0) {
        // Mark as loading (clear if different path)
        if (currentLoadingPath !== componentPath) {
          currentLoadingPath = componentPath;
          currentComponent = null; // Clear previous component when loading different one
          // Clear in-memory explore data cache when switching to a different chart/menu so the new
          // component always fetches with its own chartType and channels (avoids showing previous chart's data)
          if (componentPath.includes('/explore/') || componentPath.includes('dataset/explore')) {
            try {
              const cn = selectedClassName();
              const pid = selectedProjectId();
              const did = selectedDatasetId();
              const sid = selectedSourceId();
              if (cn && pid != null && did != null && sid != null) {
                const dataKey = `${cn}_${pid}_${did}_${sid}`;
                unifiedDataStore.clearCacheForDataSource(dataKey);
                debug('[Sidebar] Cleared explore data cache for context on menu switch:', dataKey);
              }
            } catch (e) {
              debug('[Sidebar] clearCacheForDataSource on menu switch:', e);
            }
          }
        }
        
        // Load component without clearing first to prevent flash
        const Component = await loadComponentFromPath(componentPath);
        debug('[Sidebar] Component loaded, setting component');
        
        // Store the loaded component only if still loading the same path
        if (currentLoadingPath === componentPath) {
          currentComponent = Component;
        }
        
        // Use a micro-task to ensure smooth transition
        loadComponentTimeout = setTimeout(() => {
          // Double-check we're still loading the same component
          if (currentLoadingPath !== componentPath) {
            debug('[Sidebar] Component path changed during load, skipping set');
            loadComponentTimeout = null;
            return;
          }
          // Don't overwrite with base MANEUVERS report when user has a maneuver view restored
          // (restoreStateFromStore sets ManeuverWindow; a deferred loadComponent would replace it)
          const menu = selectedMenu();
          const page = selectedPage();
          const isManeuversWithView = (menu || '').toString().toUpperCase() === 'MANEUVERS' && page && page !== '';
          const isBaseManeuversReport = componentPath.toLowerCase().includes('maneuvers') && componentPath.toLowerCase().includes('report');
          if (isManeuversWithView && isBaseManeuversReport) {
            debug('[Sidebar] Skipping setComponent: MANEUVERS view already restored, not overwriting with base report');
            loadComponentTimeout = null;
            return;
          }
          setComponent(() => Component);
          debug('[Sidebar] Component set successfully');
          loadComponentTimeout = null;
        }, 0) as any;
      } else {
        debug('[Sidebar] loadComponent: componentPath is empty, clearing component');
        currentLoadingPath = null;
        currentComponent = null;
        setComponent(null);
      }
    } catch (error: any) {
      logError(`Error loading component ${componentPath}:`, error);
      if (currentLoadingPath === componentPath) {
        currentLoadingPath = null;
        currentComponent = null;
      }
      setComponent(null);
    }
  };

  const loadComponentForLeftPanel = async (componentPath: string, title: string) => {
    debug('loadComponentForLeftPanel called with:', componentPath, title);
    try {
      if (componentPath.length > 0) {
        const Component = await loadComponentFromPath(componentPath);
        
        // Update the left component directly when in split view
        if (isSplitView()) {
          debug('In split view, updating left component');
          if (typeof updateLeftComponent === 'function') {
            debug('updateLeftComponent function available, calling it');
            queueMicrotask(() => updateLeftComponent(() => Component));
          } else {
            debug('updateLeftComponent function not available');
          }
        } else {
          debug('Not in split view, cannot update left component');
        }
      }
    } catch (error: any) {
      logError(`Error loading component for left panel ${componentPath}:`, error);
    }
  };

  const loadExploreComponentForLeftPanel = async (parentName: string, objectName: string) => {
    debug('loadExploreComponentForLeftPanel called with:', parentName, objectName);
    try {
      const menuPageName = parentNameToMenuPageName(parentName);
      const menuItem = findMenuItemByPageName(menuPageName.toUpperCase().replace(/\s+/g, ' '));
      
      if (!menuItem) {
        logError(`Menu item not found for parent name: ${parentName}`);
        return;
      }

      // Check if page name contains 'Live' - require live mode to be enabled
      if (menuItem.page_name && menuItem.page_name.toLowerCase().includes('live')) {
        if (!liveMode()) {
          logError(`Cannot load "${menuItem.page_name}" - Live mode must be enabled first`);
          return;
        }
        debug('Sidebar: Loading Live component, live mode is enabled');
      }

      // In day mode use day/explore Fleet path so we load FleetMap/FleetVideo/FleetTimeSeries
      const isDayModeExplore = isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0);
      const componentPath = isDayModeExplore ? (getDayExploreFilePath(menuItem.page_name) || menuItem.file_path) : menuItem.file_path;
      
      debug('Loading component from path:', componentPath);
      
      // Load the component
      const Component = await loadComponentFromPath(componentPath);
      
      debug('Component loaded:', Component);
      
      // Create a wrapper component that passes the object_name as a prop
      const WrappedExplore = (props: any) => {
        return <Component {...props} objectName={objectName} />;
      };
      
      debug('WrappedExplore component created:', WrappedExplore);
      
      // Update the left component directly when in split view
      if (isSplitView()) {
        debug('In split view, updating left component with explore component');
        if (typeof updateLeftComponent === 'function') {
          debug('updateLeftComponent function available, calling it with WrappedExplore');
          queueMicrotask(() => updateLeftComponent(() => WrappedExplore));
        } else {
          debug('updateLeftComponent function not available');
        }
      } else {
        debug('Not in split view, cannot update left component');
      }
    } catch (error: any) {
      logError('Error in loadExploreComponentForLeftPanel:', error);
      logError(`Error loading explore component for left panel ${parentName}/${objectName}:`, error);
    }
  };

  const loadComponentForSplitView = async (componentPath: string, title: string, menuName: string | null = null, leftPath?: string) => {
    debug('[Sidebar] ===== loadComponentForSplitView ENTRY =====');
    debug('[Sidebar] loadComponentForSplitView called', { componentPath, title, menuName, leftPath, pathLength: componentPath.length });
    
    try {
      if (componentPath.length > 0) {
        // When leftPath provided (day mode), load fresh left component to avoid reusing live FleetMap (prevents SolidJS "push of null")
        let LeftComponent: any = null;
        if (leftPath && leftPath.length > 0) {
          debug('[Sidebar] Loading LEFT component from path', { leftPath });
          LeftComponent = await loadComponentFromPath(leftPath);
          debug('[Sidebar] Left component loaded', { hasLeft: !!LeftComponent });
        }

        debug('[Sidebar] Loading component from path', { componentPath });
        const Component = await loadComponentFromPath(componentPath);
        debug('[Sidebar] Component loaded successfully', { hasComponent: !!Component });
        
        if (typeof openInSplitView === 'function') {
          debug('[Sidebar] openInSplitView function available, scheduling call');
          const rightComponentFn = () => Component;
          const leftComponentFn = LeftComponent != null ? () => LeftComponent : undefined;
          // Use setTimeout(0) so state update runs in next macrotask (avoids race with Map/effects that can reset UI)
          setTimeout(() => {
            debug('[Sidebar] Calling openInSplitView NOW', { title, menuName, hasLeft: !!leftComponentFn });
            openInSplitView(rightComponentFn, title, menuName, leftComponentFn);
            debug('[Sidebar] openInSplitView call completed');
          }, 0);
        } else {
          warn('[Sidebar] openInSplitView function NOT available!');
        }
      } else {
        warn('[Sidebar] componentPath is empty, cannot load');
      }
    } catch (error: any) {
      logError(`[Sidebar] Error loading component for split view ${componentPath}:`, error);
    }
    
    debug('[Sidebar] ===== loadComponentForSplitView EXIT =====');
  };

  // Function to get the icon component based on the name
  const getIcon = (iconName: string) => {
    const IconComponent = iconMapping[iconName] || FiFile; // Default to FiFile if iconName is not found
    return <IconComponent size={20} />;
  };

  // Function to get tooltip text for menu items (Cmd on macOS, Ctrl elsewhere)
  const getMenuTooltip = () => {
    const mod = isMacOS() ? "Cmd" : "Ctrl";
    return `${mod} + Click to Show in Splitview\n${mod} + Shift + Click to Show in new Window`;
  };

  return (
    <>
      {/* Mobile Menu Button */}
      <Show when={isMobile()}>
        <button 
          class="mobile-menu-button"
          onClick={toggleSidebar}
        >
          <Show when={showMobileMenu()} fallback={<FiMenu size={24} />}>
            <FiX size={24} />
          </Show>
        </button>
      </Show>

      {/* Mobile Overlay */}
      <Show when={isMobile() && showMobileMenu()}>
        <div 
          class="mobile-overlay show"
          onClick={() => setShowMobileMenu(false)}
        />
      </Show>

      <div 
        class={`sidebar ${isCollapsed() && !isMobile() ? 'collapsed' : ''} ${isMobile() ? 'mobile' : ''} ${isMobile() && showMobileMenu() ? 'show' : ''}`} 
        onContextMenu={(e) => e.preventDefault()}
        onDblClick={handleSidebarDoubleClick}
      >
        {/* Main Content Area */}
        <div class="sidebar-main-content">
          <div class="sidebar-label">
            <span class="divider-label">Available Projects</span>
          </div>
      <div class="menu-container">
        <Show when={projects() && projects().length === 0 && user() && (Array.isArray(user()?.permissions) ? user()?.permissions?.[0] : user()?.permissions) === "administrator"} fallback={
          <button
            class={`menu-item ${isProjectMenuActive() && selectedMenu() == 'Dataset' ? "active" : ""}`} // Highlight only if the project menu is explicitly active
            onClick={() => handleProjectClick(true)}
            title={isCollapsed() && !isMobile() ? (projectLabel() || "") : ""}
          >
            <FiFolder size={20} /> 
            <Show when={!isCollapsed() || isMobile()}>
              <span>{projectLabel()}</span>
            </Show>
          </button>
        }>
          <button class="menu-item" onClick={() => handleAddProject()}>
            <FiPlus size={20} /> Add New Project
          </button>
        </Show>

        <Show when={user() && (Array.isArray(user()?.permissions) ? user()?.permissions?.[0] : user()?.permissions) === "administrator" && projects() && projects().length > 0 && (!isCollapsed() || isMobile())}>
        <button class="dropdown-toggle" onClick={(e) => {
            e.stopPropagation();
            setShowProjects(!showProjects()); 
          }}>
          <FiChevronDown 
            class={`transition-transform duration-200 ${showProjects() ? 'rotate-180' : ''}`}
            size={16} 
          />
        </button>
        </Show>
      </div>

      <Show when={showModal()}>
        <Pages setUpdateMenus={setUpdateMenus} setShowModal={setShowModal} />
      </Show>

      {showProjects() && (
        <div class="submenu">
          {projects()
            ?.filter((project) => ensureInteger(project.project_id) !== selectedProjectId())
            .map((project) => (
              <button 
                class="submenu-item" 
                onClick={(e) => {
                  const isCtrlPressed = e?.ctrlKey || e?.metaKey;
                  
                  if (isCtrlPressed) {
                    // Ctrl+click - open project in new window
                    const date = selectedDate?.() ?? '';
                    const datasetId = selectedDatasetId?.() ?? 0;
                    const hasValidDate = !!date && date !== '0';

                    let path = `/window?project_id=${encodeURIComponent(project.project_id)}&page_name=Dashboard&class_name=${encodeURIComponent(selectedClassName())}`;

                    if (!hasValidDate) {
                      path += `&dataset_id=${encodeURIComponent(datasetId)}`;
                    } else {
                      path += `&date=${encodeURIComponent(date)}`;
                    }

                    let fullUrl = path;
                    if (typeof window !== 'undefined') {
                      const host = window.location.host;
                      fullUrl = `https://${host}${path}`;
                    }
                    const windowFeatures = 'width=1200,height=800,scrollbars=yes,resizable=yes';
                    const windowName = `project_${project.project_id}_${Date.now()}`;
                    window.open(fullUrl, windowName, windowFeatures);
                  } else {
                    // Normal click - switch project in current window
                    handleProjectMenuClick(project);
                  }
                }}
              >
                <FiFile size={18} /> {project.description}
              </button>
            ))}
          <Show when={user() && (Array.isArray(user()?.permissions) ? user()?.permissions?.[0] : user()?.permissions) === "administrator" && projects() && projects().length > 0}>
            {projects() && projects().length > 1 && <div class="divider"></div>}
            <button class="submenu-item add-project" onClick={() => handleAddProject()}>
              <FiPlus size={18} /> Add Project
            </button>
          </Show>
        </div>
      )}

      <Show when={menuFound() && dividerLabel2() && reportMenuItemsDisplay().length > 0 && datasetCount() > 0}>
            <div class="sidebar-label">
              <span class="divider-label">{dividerLabel2()}</span>
            </div>
          </Show>
          <Show when={reportMenuItemsDisplay().length > 0 && datasetCount() > 0}>
            <div class="menu">
              {reportMenuItemsDisplay().map((item: any) => {
                const IconComponent = getIcon(item.icon);
                const isManeuversMenu = item.page_name === 'MANEUVERS';
                const maneuvers = isManeuversMenu ? maneuverMenus() : [];
                const hasManeuvers = maneuvers.length > 0;
                const isManeuversExpanded = isManeuversMenu ? expandedMenus().has('maneuvers') : false;

                return (
                  <div>
                    <div class="menu-container">
                      <button
                        class={`menu-item ${isMenuActive(item.page_name) ? "active" : ""}`}
                        onClick={(e) => {
                          const isCtrlPressed = e?.ctrlKey || e?.metaKey;
                          
                          // Prevent default behavior for Ctrl+click and Ctrl+Shift+click
                          if (isCtrlPressed) {
                            e.preventDefault();
                          }
                          
                          if (isManeuversMenu) {
                            // Always load the base Maneuvers component when clicking the main menu item
                            // The dropdown arrow is used to toggle submenus
                            handleMenuClick(item, e);
                          } else {
                            handleMenuClick(item, e);
                          }
                        }}
                        title={isCollapsed() && !isMobile() ? item.page_name : getMenuTooltip()}
                      >
                        {IconComponent}
                        <Show when={!isCollapsed() || isMobile()}>
                          <span>{item.page_name}</span>
                        </Show>
                      </button>
                      
                      <Show when={isManeuversMenu && maneuverMenus().length > 0 && maneuverMenus().length > 1 && (!isCollapsed() || isMobile())}>
                        <button 
                          class="dropdown-toggle" 
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleUserMenuDropdown('maneuvers');
                          }}
                        >
                          <FiChevronDown 
                            class={`transition-transform duration-200 ${isManeuversExpanded ? 'rotate-180' : ''}`}
                            size={16}
                          />
                        </button>
                      </Show>
                    </div>
                    
                    <Show when={isManeuversMenu && maneuverMenus().length > 0 && isManeuversExpanded && (!isCollapsed() || isMobile())}>
                      <div class="ml-4 space-y-1">
                        {maneuverMenus().map((maneuver) => (
                          <button
                            class={`menu-item text-sm ${isMenuActive(`MANEUVERS_${maneuver.object_name}`) ? "active" : ""}`}
                            onClick={(e) => {
                              handleManeuverMenuClick(maneuver.object_name, e);
                            }}
                            title={getMenuTooltip()}
                          >
                            <span class="ml-6">{maneuver.object_name}</span>
                          </button>
                        ))}
                      </div>
                    </Show>
                  </div>
                );
              })}
            </div>
          </Show>

      <Show when={menuFound()}>
            <div class="sidebar-label" style="display: flex; align-items: center; justify-content: space-between;">
              <span class="divider-label">{dividerLabel1()}</span>
              <div>
                {(selectedDatasetId() > 0 || selectedDate()) ? (
                  <FiPlusCircle
                    size={20}
                    color="white"
                    style={{ cursor: "pointer" }}
                    title="Add / remove pages"
                    onClick={() => setShowModal(true)}
                  />
                ) : null}
              </div>
            </div>
          </Show>
          <Show when={dynamicMenuItems1()}>
            <div class="menu">
              {dynamicMenuItems1().filter((item: any) => {
                // Filter out VIDEO menu if video doesn't exist
                if (item.page_name === 'VIDEO') {
                  const shouldShow = hasVideoMenu();
                  debug('Filtering VIDEO menu item:', { shouldShow, hasVideoMenu: hasVideoMenu() });
                  return shouldShow;
                }
                return true;
              }).map((item: any) => {
                const IconComponent = getIcon(item.icon);
                // Kept for reference but primarily using is_multiple flag; normalize so API 'TIMESERIES' matches 'TIME SERIES'
                const exploreMenuTypes = ['TIME SERIES', 'SCATTER', 'PROBABILITY', 'POLAR ROSE', 'TABLE', 'GRID', 'PARALLEL', 'VIDEO', 'BOAT', 'MAP'];
                const normalizePageForMatch = (s: string) => (s || '').toLowerCase().replace(/\s+/g, '');
                const isExploreMenu = item.is_multiple === 1 || exploreMenuTypes.includes(item.page_name) ||
                  exploreMenuTypes.some((t: string) => normalizePageForMatch(t) === normalizePageForMatch(item.page_name || ''));
                const isManeuversMenu = item.page_name === 'MANEUVERS';
                
                // When selectedDate is set and no selectedDataset_id: use fleet_* parent names for timeseries submenus
                const isDayMode = isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0);
                
                // In day mode, use fleet_* parent names for timeseries, scatter, probability
                // API may return page_name as 'TIMESERIES' (no space) or 'TIME SERIES'; normalize both for lookup
                let parentName = isExploreMenu ? item.page_name.toLowerCase().replace(/\s+/g, '') : null;
                if (isExploreMenu && isDayMode) {
                  if (item.page_name === 'TIME SERIES' || item.page_name === 'TIMESERIES') parentName = 'fleet_timeseries';
                  else if (item.page_name === 'SCATTER') parentName = 'fleet_scatter';
                  else if (item.page_name === 'PROBABILITY') parentName = 'fleet_probability';
                }
                
                const userObjects = isExploreMenu ? userPageObjects().get(parentName) || [] : [];
                // Map has no submenus; Overlay is internal - never show dropdown or Add Chart for map page
                const isMapPage = normalizePageForMatch(item.page_name || '') === 'map' || normalizePageForMatch(item.page_name || '') === 'overlay';
                const normalizedPageForBuilder = (item.page_name || '').toUpperCase().replace(/\s+/g, '');
                // VIDEO is FleetVideo only (multi-source); no submenu or Add Chart (single-source builder)
                const isVideoMenu = normalizedPageForBuilder === 'VIDEO';
                const hasUserObjects = isMapPage ? false : (isVideoMenu ? false : (userObjects.length > 0));
                // Show "Add Chart" (or "Add Table" / "Add Grid") for chart types that have a builder; MAP and VIDEO do not get add submenu
                const builderPageNames = new Set(['TIMESERIES', 'SCATTER', 'PROBABILITY', 'PARALLEL', 'PERFORMANCE', 'TARGETS', 'POLARROSE', 'GRID', 'TABLE', 'VIDEO', 'BOAT']);
                const isBuilderPage = builderPageNames.has(normalizedPageForBuilder);
                const showAddChartInSubmenu = (isMapPage || isVideoMenu) ? false : ((item.is_multiple === 1 && item.has_builder === 1) || isBuilderPage);
                const addSubmenuLabel = normalizedPageForBuilder === 'TABLE' ? 'Add Table' : normalizedPageForBuilder === 'GRID' ? 'Add Grid' : 'Add Chart';
                const isExpanded = isExploreMenu ? expandedMenus().has(parentName) : false;
                const maneuvers = isManeuversMenu ? maneuverMenus() : [];
                const hasManeuvers = maneuvers.length > 0;
                const isManeuversExpanded = isManeuversMenu ? expandedMenus().has('maneuvers') : false;
                
                // Debug logging for MANEUVERS menu
                if (isManeuversMenu) {
                  debug('🔄 Sidebar: Rendering MANEUVERS menu (dynamicMenuItems1)', {
                    pageName: item.page_name,
                    hasManeuvers,
                    maneuversCount: maneuvers.length,
                    maneuvers: maneuvers.map(m => m.object_name),
                    isExpanded: isManeuversExpanded,
                    maneuverMenusSignal: maneuverMenus()
                  });
                }

                return (
                  <div>
                    <div class="menu-container group relative">
                      <button
                        class={`menu-item ${isMenuActive(item.page_name) ? "active" : ""}`}
                        onClick={(e) => {
                          const isCtrlPressed = e?.ctrlKey || e?.metaKey;
                          const isShiftPressed = e?.shiftKey;
                          
                          // Prevent default behavior for Ctrl+click and Ctrl+Shift+click
                          if (isCtrlPressed) {
                            e.preventDefault();
                          }
                          
                          // Handle MANEUVERS menu
                          if (isManeuversMenu) {
                            // Always load the base Maneuvers component when clicking the main menu item
                            // The dropdown arrow is used to toggle submenus
                            handleMenuClick(item, e);
                            return;
                          }
                          
                          if (isCtrlPressed && isShiftPressed) {
                            // Ctrl+Shift+click - open in new window
                            if (isExploreMenu && hasUserObjects) {
                              // Open the first user object in new window
                              openComponentInNewWindow(item.page_name, userObjects[0].object_name);
                            } else {
                              // Regular menu - open in new window
                              openComponentInNewWindow(item.page_name);
                            }
                          } else if (isCtrlPressed) {
                            // Ctrl+click - open in split view (always use handleMenuClick so Map+Ctrl+click Scatter works same as Scatter+Ctrl+click Map)
                            handleMenuClick(item, e);
                          } else if (isExploreMenu) {
                            debug('=== EXPLORE MENU LOGIC ===');
                            debug('isExploreMenu:', isExploreMenu);
                            debug('hasUserObjects:', hasUserObjects);
                            debug('parentName:', parentName);
                            // For explore menu items, check split view state
                            if (hasUserObjects) {
                              // If this is a multiple-chart page but we clicked the main menu item, 
                              // we might want to toggle the dropdown OR go to the first chart.
                              // Existing logic goes to first chart.
                              // Let's modify: if it has multiple charts, go to first.
                              
                              debug('Has user objects, checking split view state');
                              if (isSplitView()) {
                                // In split view: normal click updates left panel with first user object
                                debug('Explore menu with user objects in split view, loading first user object:', userObjects[0].object_name);
                                debug('isSplitView() result:', isSplitView());
                                debug('updateLeftComponent available:', typeof updateLeftComponent);
                                setSelectedMenu(canonicalExploreMenuName(item.page_name));
                                setSelectedPage(userObjects[0].object_name);
                                setIsProjectMenuActive(false);
                                // For explore menu items with user objects, we need to load the explore component
                                // and then update the left panel with the result
                                loadExploreComponentForLeftPanel(parentName, userObjects[0].object_name);
                              } else {
                                debug('Not in split view, calling handleUserPageClick');
                                // If there are user objects, navigate to the first object automatically
                                handleUserPageClick(parentName, userObjects[0].object_name, e);
                              }
                            } else {
                              // No user objects (or empty list) – navigate to builder so user can create first chart
                              // VIDEO always loads FleetVideo (sources from project_objects or media/sources); never redirect to video-builder
                              if (showAddChartInSubmenu && !isVideoMenu) {
                                 // Determine builder path - use "new chart" so builder opens with placeholder name
                                 const normalizedName = (item.page_name || '').toString().replace(/\s+/g, '').toUpperCase();
                                 const slug = getBuilderSlug(normalizedName, item.page_name);
                                 const isDayModeClick = isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0);
                                 const useFleetBuilder = isDayModeClick && (normalizedName === 'TIMESERIES' || normalizedName === 'SCATTER' || normalizedName === 'PROBABILITY');
                                 const newChartName = 'new chart';
                                 const builderPath = useFleetBuilder
                                   ? `/${slug}-builder?fleet=true&object_name=${encodeURIComponent(newChartName)}`
                                   : `/${slug}-builder?object_name=${encodeURIComponent(newChartName)}`;
                                 debug(`Navigating to builder (empty list): ${builderPath}`);
                                 navigate(builderPath);
                                 return;
                              }
                              if (isVideoMenu) {
                                setSelectedMenu(canonicalExploreMenuName(item.page_name));
                                setSelectedPage('');
                                setIsProjectMenuActive(false);
                              }

                              debug('No user objects, checking split view state');
                              // No user objects, check split view state
                              if (isSplitView()) {
                                // In split view: normal click always updates left panel (even if same menu)
                                debug('Explore menu normal click in split view, loading:', item.file_path);
                                debug('isSplitView() result:', isSplitView());
                                debug('updateLeftComponent available:', typeof updateLeftComponent);
                                setSelectedMenu(canonicalExploreMenuName(item.page_name));
                                setSelectedPage('');
                                setIsProjectMenuActive(false);
                                const isDayModeNoObjs = isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0);
                                const noObjsPath = isDayModeNoObjs ? getDayExploreFilePath(item.page_name) : null;
                                loadComponentForLeftPanel(noObjsPath || item.file_path, item.page_name);
                              } else if (isVideoMenu || sidebarState() === 'live' || canonicalExploreMenuName(selectedMenu() || '') !== canonicalExploreMenuName(item.page_name || '')) {
                                debug('Not in split view, different menu or live mode, loading explore component');
                                // In live mode, always allow navigation (even if same menu)
                                // Otherwise, only load if different menu
                                setSelectedMenu(canonicalExploreMenuName(item.page_name));
                                setSelectedPage('');
                                setIsProjectMenuActive(false);
                                loadExploreComponent(parentName, ''); // Pass empty string explicitly
                              } else {
                                debug('Not in split view, same menu, doing nothing');
                              }
                            }
                          } else {
                            debug('=== NORMAL MENU LOGIC ===');
                            // Normal menu behavior
                            handleMenuClick(item, e);
                          }
                        }}
                        title={isCollapsed() && !isMobile() ? getExploreMenuDisplayName(item.page_name) : getMenuTooltip()}
                      >
                        <div class="flex items-center">
                          {IconComponent}
                          <Show when={!isCollapsed() || isMobile()}>
                            <span class="ml-2">{getExploreMenuDisplayName(item.page_name)}</span>
                          </Show>
                        </div>
                      </button>
                      
                      <Show when={((isExploreMenu && (hasUserObjects || showAddChartInSubmenu)) || (isManeuversMenu && maneuverMenus().length > 0 && maneuverMenus().length > 1)) && (!isCollapsed() || isMobile())}>
                        <button 
                          class="dropdown-toggle" 
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isManeuversMenu) {
                              toggleUserMenuDropdown('maneuvers');
                            } else {
                              toggleUserMenuDropdown(parentName);
                            }
                          }}
                        >
                          <FiChevronDown 
                            class={`transition-transform duration-200 ${(isManeuversMenu ? isManeuversExpanded : isExpanded) ? 'rotate-180' : ''}`}
                            size={16}
                          />
                        </button>
                      </Show>
                    </div>
                    
                      <Show when={isExploreMenu && (hasUserObjects || showAddChartInSubmenu) && isExpanded && (!isCollapsed() || isMobile())}>
                        <div class="ml-4 space-y-1">
                          {userObjects.map((object: any) => {
                            // Explicitly capture object_name to avoid closure issues
                            const objectName = object.object_name;
                            const currentParentName = parentName;
                            
                            return (
                              <button
                                class={`menu-item text-sm ${isMenuActive(`${currentParentName}_${objectName}`) ? "active" : ""}`}
                                onClick={(e: MouseEvent) => {
                                  const isCtrlPressed = e?.ctrlKey || (e as any)?.metaKey;
                                  const isShiftPressed = e?.shiftKey;
                                  
                                  // Prevent default behavior for Ctrl+click and Ctrl+Shift+click
                                  if (isCtrlPressed) {
                                    e.preventDefault();
                                  }
                                  
                                  if (isCtrlPressed && isShiftPressed) {
                                    // Ctrl+Shift+click - open in new window
                                    openComponentInNewWindow(currentParentName.toUpperCase(), objectName);
                                  } else if (isCtrlPressed) {
                                    // Ctrl+click - open in split view
                                    handleUserPageClick(currentParentName, objectName, e);
                                  } else {
                                    // Normal click - navigate in current window
                                    handleUserPageClick(currentParentName, objectName, e);
                                  }
                                }}
                                title={getMenuTooltip()}
                              >
                                <span class="ml-6">{objectName}</span>
                              </button>
                            );
                          })}
                          
                          {/* Add New Chart Option in Dropdown - show for is_multiple+has_builder from API, or for TIME SERIES (like scatter/probability). VIDEO always loads FleetVideo, never builder. */}
                          <Show when={showAddChartInSubmenu}>
                             <button
                               class="submenu-item add-project"
                               onClick={(e) => {
                                 e.preventDefault();
                                 e.stopPropagation();
                                 
                                 const name = item.page_name.toUpperCase().replace(/\s+/g, '');
                                 if (name === 'VIDEO') {
                                   setSelectedMenu(canonicalExploreMenuName(item.page_name));
                                   setSelectedPage('');
                                   setIsProjectMenuActive(false);
                                   loadExploreComponent(parentName, '');
                                   return;
                                 }
                                 // Determine builder path (same slug logic as empty-list and handlePageSettings)
                                 const slug = getBuilderSlug(name, item.page_name);
                                 const isDayMode = isValidDate(selectedDate()) && (!selectedDatasetId() || selectedDatasetId() === 0);
                                 const useFleetBuilder = isDayMode && (name === 'TIMESERIES' || name === 'SCATTER' || name === 'PROBABILITY');
                                 const newChartName = 'new chart';
                                 const builderPath = useFleetBuilder
                                   ? `/${slug}-builder?fleet=true&object_name=${encodeURIComponent(newChartName)}`
                                   : `/${slug}-builder?object_name=${encodeURIComponent(newChartName)}`;
                                 debug(`Navigating to builder with new chart: ${builderPath}`);
                                 setSelectedPage("");
                                 navigate(builderPath);
                               }}
                             >
                                 <FiPlus size={18} /> {addSubmenuLabel}
                             </button>
                          </Show>
                        </div>
                      </Show>
                    
                    <Show when={isManeuversMenu && maneuverMenus().length > 0 && isManeuversExpanded && (!isCollapsed() || isMobile())}>
                      <div class="ml-4 space-y-1">
                        {maneuverMenus().map((maneuver) => (
                          <button
                            class={`menu-item text-sm ${isMenuActive(`MANEUVERS_${maneuver.object_name}`) ? "active" : ""}`}
                            onClick={(e) => {
                              handleManeuverMenuClick(maneuver.object_name, e);
                            }}
                            title={getMenuTooltip()}
                          >
                            <span class="ml-6">{maneuver.object_name}</span>
                          </button>
                        ))}
                      </div>
                    </Show>

                  </div>
                );
              })}
            </div>
          </Show>

      {/* Tools Divider */}
      <Show when={dividerLabelTools() && dynamicMenuItemsTools().length > 0 && datasetCount() > 0}>
        <div class="sidebar-label">
          <span class="divider-label">{dividerLabelTools()}</span>
        </div>
      </Show>
      <Show when={dynamicMenuItemsTools() && datasetCount() > 0}>
        <div class="menu">
          {dynamicMenuItemsTools().map((item: any) => {
            const IconComponent = getIcon(item.icon);

            return (
              <button
                class={`menu-item ${isMenuActive(item.page_name) ? "active" : ""}`}
                onClick={(e) => handleMenuClick(item, e)}
                title={isCollapsed() && !isMobile() ? item.page_name : getMenuTooltip()}
              >
                {IconComponent}
                <Show when={!isCollapsed() || isMobile()}>
                  <span>{item.page_name}</span>
                </Show>
              </button>
            );
          })}
        </div>
      </Show>

          <Show when={selectedProjectId() > 0}>
            {/* Consolidated Options Section */}
            {/* Hide entire Options section when a dataset is selected */}
            <Show when={shouldShowOptions()}>
              <div class="sidebar-label">
                <span class="divider-label">Options</span>
              </div>

              {/* Video Upload Option */}
              <Show when={selectedMenu() == 'VIDEO' && user() && (Array.isArray(user()?.permissions) ? user()?.permissions?.[0] : user()?.permissions) !== 'reader'}>
                <button 
                  class="menu-item" 
                  onClick={() => handleAddVideo('video')}
                  title={isCollapsed() && !isMobile() ? "Add Video" : undefined}
                >
                  <FiPlus size={20} /> 
                  <Show when={!isCollapsed() || isMobile()}>
                    <span>Upload Video</span>
                  </Show>
                </button>
              </Show>

              {/* Dataset and Race Course Options (hidden on targets/polars pages) */}
              {/* Show Add Dataset button when: admin/publisher, not live mode, no dataset selected, no valid date, and not on TARGETREVIEW/POLAR REVIEW pages */}
              {/* Hide when a dataset is selected (selectedDatasetId > 0) */}
              <Show when={() => {
                const isAdmin = isAdminOrPublisher();
                const notLive = sidebarState() !== 'live';
                const noDataset = selectedDatasetId() === 0;
                const noDate = !isValidDate(selectedDate());
                const menu = (selectedMenu() || '').replace(/\s+/g, '').toUpperCase();
                const notTargetReview = menu !== 'TARGETREVIEW';
                const notPolarReview = selectedMenu() !== 'POLAR REVIEW';
                
                const shouldShow = isAdmin && notLive && noDataset && noDate && notTargetReview && notPolarReview;
                
                return shouldShow;
              }}>
                <button 
                  type="button"
                  class="menu-item" 
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    debug('[Sidebar] Add Dataset button clicked');
                    debug('[Sidebar] Add Dataset button clicked - calling handleAddDataset');
                    handleAddDataset().catch(error => {
                      logError('[Sidebar] Error in handleAddDataset:', error);
                    });
                  }}
                  title={isCollapsed() && !isMobile() ? (selectedSourceName() === 'ALL' && selectedMenu() == 'Dataset' ? "Add Datasets" : "Add Dataset") : undefined}
                >
                  <FiPlus size={20} /> 
                  <Show when={!isCollapsed() || isMobile()}>
                    <span>{selectedSourceName() === 'ALL' && selectedMenu() == 'Dataset' ? "Add Datasets" : "Add Dataset"}</span>
                  </Show>
                </button>

                {/* Add Video - show when project has VIDEO page (VIDEO uses page_type dataset/explore; we fetch that in add-dataset state) */}
                <Show when={projectHasVideoPage()}>
                  <button 
                    type="button"
                    class="menu-item" 
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      debug('[Sidebar] Add Video button clicked');
                      handleAddVideo('video');
                    }}
                    title={isCollapsed() && !isMobile() ? "Add Video" : undefined}
                  >
                    <FiPlus size={20} /> 
                    <Show when={!isCollapsed() || isMobile()}>
                      <span>Add Video</span>
                    </Show>
                  </button>
                </Show>

                {/* Upload Targets - only show when no datasets are available */}
                <Show when={!hasDatasets()}>
                  <button 
                    type="button"
                    class="menu-item" 
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      debug('[Sidebar] Upload Targets button clicked');
                      handleAddTargets('target');
                    }}
                    title={isCollapsed() && !isMobile() ? "Upload Targets" : undefined}
                  >
                    <FiTarget size={20} /> 
                    <Show when={!isCollapsed() || isMobile()}>
                      <span>Upload Targets</span>
                    </Show>
                  </button>
                </Show>
                  
                {/* Upload Polars - only show when no datasets are available */}
                <Show when={!hasDatasets()}>
                  <button 
                    type="button"
                    class="menu-item" 
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      debug('[Sidebar] Upload Polars button clicked');
                      handleAddTargets('polar');
                    }}
                    title={isCollapsed() && !isMobile() ? "Upload Polars" : undefined}
                  >
                    <FiTarget size={20} /> 
                    <Show when={!isCollapsed() || isMobile()}>
                      <span>Upload Polars</span>
                    </Show>
                  </button>
                </Show>

                {/* Add Race Course - only show when datasets are available and no dataset is selected (not in live mode) */}
                <Show when={hasDatasets() && selectedDatasetId() === 0 && sidebarState() !== 'live'}>
                  <button 
                    class="menu-item" 
                    onClick={() => handleAddRaceCourse()}
                    title={isCollapsed() && !isMobile() ? "Add Race Course" : undefined}
                  >
                    <FiPlus size={20} /> 
                    <Show when={!isCollapsed() || isMobile()}>
                      <span>Add Race Course</span>
                    </Show>
                  </button>
                </Show>
              </Show>

              {/* Targets Page Option */}
              <Show when={selectedDatasetId() == 0 && (selectedMenu() || '').replace(/\s+/g, '').toUpperCase() === 'TARGETREVIEW'}>
                <button 
                  class="menu-item" 
                  onClick={() => handleAddTargets("target")}
                  title={isCollapsed() && !isMobile() ? "Add Targets" : ""}
                >
                  <FiPlus size={20} /> 
                  <Show when={!isCollapsed() || isMobile()}>
                    <span>Add Targets</span>
                  </Show>
                </button>
              </Show>

              {/* Polars Page Option - Add Polars (upload) only for admin/publisher */}
              <Show when={selectedDatasetId() == 0 && selectedMenu() == 'POLAR REVIEW' && isAdminOrPublisher()}>
                <button 
                  class="menu-item" 
                  onClick={() => handleAddTargets("polar")}
                  title={isCollapsed() && !isMobile() ? "Add Polars" : ""}
                >
                  <FiPlus size={20} /> 
                  <Show when={!isCollapsed() || isMobile()}>
                    <span>Add Polars</span>
                  </Show>
                </button>
              </Show>

              {/* Live Mode Race Course Option */}
              <Show when={isAdminOrPublisher() && sidebarState() === 'live'}>
                <button 
                  class="menu-item" 
                  onClick={() => handleAddRaceCourse()}
                  title={isCollapsed() && !isMobile() ? "Add Race Course" : undefined}
                >
                  <FiPlus size={20} /> 
                  <Show when={!isCollapsed() || isMobile()}>
                    <span>Add Race Course</span>
                  </Show>
                </button>
              </Show>
            </Show>
            
            <div class="spacer"></div>
          </Show>

          {/* Settings menu in mobile mode - positioned after menus */}
          <Show when={isMobile() && settingsMenuItems().length > 0}>
            <SidebarSettings 
              menuItems={settingsMenuItems()}
              isCollapsed={isCollapsed}
              isMobile={isMobile}
              toggleSidebar={toggleSidebar}
            />
          </Show>

        </div>

        {/* Bottom Section - Always visible, fixed at bottom (desktop only) */}
        <div class="sidebar-bottom">
          <Show when={!isMobile() && settingsMenuItems().length > 0}>
            <SidebarSettings 
              menuItems={settingsMenuItems()}
              isCollapsed={isCollapsed}
              isMobile={isMobile}
              toggleSidebar={toggleSidebar}
            />
          </Show>
        </div>
      </div>
    </>
  );
};

export default Sidebar;
