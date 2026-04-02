import { createSignal, onMount, Show, Switch, Match, createEffect, type Component as SolidComponent } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useNavigate } from "@solidjs/router";

import Header from "../components/app/Header";
import SelectionBanner from "../components/app/SelectionBanner";
import Sidebar from "../components/dashboard/Sidebar";

import { setUser } from "../store/userStore";
import { getData, notifySplitPanelResize } from "../utils/global";
import { warn, error as logError, log } from "../utils/console";
import { authManager } from "../utils/authManager";
import { apiEndpoints } from "@config/env";

import { isCut, hasSelection, selectedEvents, selectedRange, selectedRanges } from "../store/selectionStore";
import { selectedFilters } from "../store/filterStore";
import { persistantStore } from "../store/persistantStore";
import { unifiedDataStore } from "../store/unifiedDataStore";

// Global signal to track which components are active
const [activeComponents, setActiveComponents] = createSignal<Set<string>>(new Set());

// Export the setter so components can register themselves
export const registerActiveComponent = (componentType: string) => {
  setActiveComponents(prev => new Set([...prev, componentType]));
};

export const unregisterActiveComponent = (componentType: string) => {
  setActiveComponents(prev => {
    const newSet = new Set(prev);
    newSet.delete(componentType);
    return newSet;
  });
};
const { projects, setProjects, selectedDatasetId, selectedProjectId, selectedClassName, setSelectedProjectId, setSelectedClassName, selectedMenu } = persistantStore;

function projectIdInList(list: { project_id?: unknown }[] | undefined, projectId: number): boolean {
  if (!Array.isArray(list) || !Number.isFinite(projectId) || projectId <= 0) return false;
  return list.some((p) => Number(p?.project_id) === projectId);
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [fetchMenuTrigger, setFetchMenuTrigger] = createSignal(false);
  const [sidebarInitialized, setSidebarInitialized] = createSignal(false);
  type DashboardComponent = SolidComponent<any>;
  const [component, setComponent] = createSignal<DashboardComponent | null>(null); 
  const [hasExistingDataset, setHasExistingDataset] = createSignal(false);
  // Initialize to true so sidebar shows immediately on first render
  // onMount will handle data fetching in background
  const [initialCheckComplete, setInitialCheckComplete] = createSignal(true);
  const [projectsFetchComplete, setProjectsFetchComplete] = createSignal(false);
  
  // Split view state management - proper SolidJS approach
  const [isSplitView, setIsSplitView] = createSignal(false);
  const [leftComponent, setLeftComponent] = createSignal<DashboardComponent | null>(null);
  const [rightComponent, setRightComponent] = createSignal<DashboardComponent | null>(null);
  const [splitViewTitle, setSplitViewTitle] = createSignal('');
  const [leftPanelWidth, setLeftPanelWidth] = createSignal(50); // Percentage
  const [isHoveringSplitView, setIsHoveringSplitView] = createSignal(false); // Track hover state for close button
  
  // Separate signal for right panel menu (Ctrl+click doesn't affect selectedMenu)
  const [rightPanelMenu, setRightPanelMenu] = createSignal(null);
  const [leftPanelMenu, setLeftPanelMenu] = createSignal<string | null>(null);

  const fetchUserInfo = async () => {
    const controller = new AbortController();
    
    try {
      const response = await authManager.getCurrentUser();
      if (response.success) {
        log('Authentication successful');
        const user_info = response.data;
        setUser(user_info);
      } else {
        log('Authentication failed, redirecting to login');
        navigate(`/login`);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Request was cancelled
      } else {
        warn('Dashboard: Authentication error, redirecting to login:', error.message);
        navigate(`/login`);
      }
    }
  };

  const fetchProjects = async () => {
    const controller = new AbortController();

    try {
      const response = await getData(`${apiEndpoints.app.projects}/type?type=user`, controller.signal);
      const raw = response.success ? response.data : [];
      const data = Array.isArray(raw) ? raw : [];
      setProjects(data);

      const currentId = Number(selectedProjectId());
      if (data.length === 0) {
        setSelectedProjectId(0);
        setSelectedClassName("");
      } else if (!projectIdInList(data, currentId)) {
        setSelectedProjectId(0);
        setSelectedClassName("");
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
      } else {
        logError('Error fetching projects:', error);
        setProjects([]);
        setSelectedProjectId(0);
        setSelectedClassName("");
      }
    } finally {
      setProjectsFetchComplete(true);
    }
  };

  const hasProjectInList = () => {
    const list = projects();
    return Array.isArray(list) && list.length > 0;
  };

  const hasValidSelectedProject = () => {
    const list = projects();
    const pid = Number(selectedProjectId());
    return projectIdInList(list, pid);
  };

  // Events are now loaded automatically when mapdata is loaded
  // No need for separate events loading in Dashboard

  // Function to update left component in split view
  const updateLeftComponent = (componentToLoad: () => DashboardComponent) => {
    log('updateLeftComponent called, isSplitView:', isSplitView(), 'componentToLoad:', componentToLoad);
    if (isSplitView()) {
      // componentToLoad is a factory, evaluate then store component value explicitly.
      setLeftComponent(() => componentToLoad());
      setLeftPanelMenu(selectedMenu());
      log('Left component updated');
    }
  };

  // Split view management functions - proper SolidJS approach
  // When leftComponent is provided (e.g. day mode), use it for left panel to avoid reusing the live main component (prevents SolidJS "push of null" when moving FleetMap).
  const openInSplitView = (
    componentToLoad: () => DashboardComponent,
    title: string,
    menuName: string | null = null,
    leftComponentFactory: (() => DashboardComponent) | null = null
  ) => {
    if (isSplitView()) {
      // If already in split view, replace the RIGHT component (Ctrl+click behavior)
      setRightComponent(() => componentToLoad());
      setSplitViewTitle(title);
      if (menuName) {
        setRightPanelMenu(menuName);
      }
    } else {
      // Start split view - left from fresh load when provided, else current main; new to right
      const leftToRender = leftComponentFactory != null ? leftComponentFactory() : component();
      setLeftComponent(() => leftToRender);
      setLeftPanelMenu(selectedMenu());
      setRightComponent(() => componentToLoad());
      setSplitViewTitle(title);
      setIsSplitView(true);
      if (menuName) {
        setRightPanelMenu(menuName);
      }
    }
    // Notify media-container scaling so content in the panel updates after layout
    setTimeout(notifySplitPanelResize, 100);
    setTimeout(notifySplitPanelResize, 450);
  };

  const closeSplitView = () => {
    setIsSplitView(false);
    setLeftComponent(null);
    setRightComponent(null);
    setSplitViewTitle('');
    setRightPanelMenu(null);
    setLeftPanelMenu(null);
    setLeftPanelWidth(50); // Reset to 50/50
  };

  // Drag functionality for resizing panels
  const handleDragStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const startX = e.clientX;
    const startWidth = leftPanelWidth();
    const container = document.querySelector('.split-view-container');
    
    if (!container) return;
    
    const handleDrag = (e) => {
      e.preventDefault();
      const containerWidth = container.offsetWidth;
      const deltaX = e.clientX - startX;
      const deltaPercent = (deltaX / containerWidth) * 100;
      const newWidth = Math.max(20, Math.min(80, startWidth + deltaPercent));
      
      setLeftPanelWidth(newWidth);
    };
    
    const handleDragEnd = (e) => {
      e.preventDefault();
      document.removeEventListener('mousemove', handleDrag);
      document.removeEventListener('mouseup', handleDragEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Notify media-container scaling so maneuver (and other) pages in split view update scale
      notifySplitPanelResize();
      // Again after transition (0.2s) so final size is applied
      setTimeout(notifySplitPanelResize, 250);
    };
    
    // Set cursor and prevent text selection
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    
    document.addEventListener('mousemove', handleDrag);
    document.addEventListener('mouseup', handleDragEnd);
  };
  
  // Removed selectedEvents effect - now handled by selection layers in map components

  onMount(async () => {
    log('[Dashboard] onMount started');
    
    
    // Check if there's already a selected dataset
    const currentDatasetId = selectedDatasetId();
    if (currentDatasetId && currentDatasetId > 0) {
      setHasExistingDataset(true);
    }
    
    // initialCheckComplete is already true (set in signal initialization)
    // This allows UI to render immediately while data loads in background
    
    log('[Dashboard] Starting background data fetch');
    // Fetch data in background - don't block rendering
    fetchUserInfo().catch((err) => {
      logError('[Dashboard] Error fetching user info:', err);
    });
    
    fetchProjects().catch((err) => {
      logError('[Dashboard] Error fetching projects:', err);
    });

    // Check if cache needs initialization and trigger it
    const { isCacheInitialized, initializeApplicationCache } = persistantStore;
    if (!isCacheInitialized()) {
      log('[Dashboard] Cache not initialized, triggering initialization...');
      initializeApplicationCache().catch((err) => {
        logError('[Dashboard] Error during cache initialization:', err);
      });
    }

    // Validate dataset cache if project and class are available
    // Run this asynchronously in background after a short delay to allow stores to initialize
    setTimeout(async () => {
      const projectId = selectedProjectId();
      const className = selectedClassName();
      if (projectId && projectId > 0 && className) {
        log('[Dashboard] Validating dataset cache on app initialization');
        unifiedDataStore.validateDatasetCache(className, projectId).catch((err) => {
          logError('[Dashboard] Error validating dataset cache:', err);
        });
      }
    }, 1000); // Wait 1 second for stores to initialize
  });
  
  // Watch for dataset changes
  createEffect(() => {
    const currentDatasetId = selectedDatasetId();
    // Dataset changed
  });

  return (
    <>
      <Header />
      <div id="dashboard" onContextMenu={(e) => e.preventDefault()}>
        {/* Show sidebar only when projects exist */}
        {log(`[Dashboard] Render check: initialCheckComplete=${initialCheckComplete()}, projectsFetchComplete=${projectsFetchComplete()}, projects=`, projects())}
        <Show when={initialCheckComplete() && projectsFetchComplete()}>
          <div id="sidebar">
            {log(`[Dashboard] Rendering Sidebar component`)}
            <Sidebar 
              setSidebarInitialized={setSidebarInitialized} 
              setComponent={setComponent} 
              fetchMenuTrigger={fetchMenuTrigger} 
              setFetchMenuTrigger={setFetchMenuTrigger}
              hasExistingDataset={hasExistingDataset()}
              openInSplitView={openInSplitView}
              isSplitView={isSplitView}
              updateLeftComponent={updateLeftComponent}
              rightPanelMenu={rightPanelMenu}
              closeSplitView={closeSplitView}
            />
          </div>
        </Show>

        <div id="main-content">
          {log(`[Dashboard] Rendering main-content, projectsFetchComplete=${projectsFetchComplete()}, hasValidSelectedProject=${hasValidSelectedProject()}, projects=`, projects())}
          <Show when={projectsFetchComplete() && !hasValidSelectedProject()}>
            <div class="dashboard-project-prompt">
              <Show when={!hasProjectInList()} fallback={<p>Select a project in the sidebar to continue.</p>}>
                <p>You do not have any projects yet. Use the project menu in the sidebar to add one.</p>
              </Show>
            </div>
          </Show>

          <Show when={hasValidSelectedProject()}>
            {/* In split view always show banner when there is selection (e.g. map timeseries brush); otherwise hide when map is active with all-sources or single-date mode. Include selectedRange/selectedRanges so banner stays visible when only time-range is set (avoids flash-disappear from sync/effect races). */}
            <Show when={(hasSelection() || isCut() || selectedFilters().length > 0 || selectedEvents().length > 0 || (selectedRange()?.length ?? 0) > 0 || (selectedRanges()?.length ?? 0) > 0) 
              && (isSplitView() || !(activeComponents().has('map') && (persistantStore.selectedSourceId && persistantStore.selectedSourceId() === 0)))
              && (isSplitView() || !(activeComponents().has('map') && (persistantStore.selectedDate && typeof persistantStore.selectedDate === 'function' && persistantStore.selectedDate() !== '')))}>
              <SelectionBanner />
            </Show>
            <Show when={sidebarInitialized() && initialCheckComplete()}>
            <div class="playback-view-wrapper">
              <Switch>
                <Match when={isSplitView()}>
                  {/* Clean Split View Layout with floating controls */}
                  <div class="split-view-container">
                    {/* Floating close button - only show when hovering over right panel */}
                    <Show when={isHoveringSplitView()}>
                      <div 
                        class="split-view-floating-controls"
                        onMouseEnter={() => setIsHoveringSplitView(true)}
                        onMouseLeave={() => setIsHoveringSplitView(false)}
                      >
                        <button 
                          class="split-view-close-btn" 
                          onClick={closeSplitView}
                          title="Close split view"
                        >
                          ×
                        </button>
                      </div>
                    </Show>
                    
                    <div class="split-view-content">
                      <div 
                        class="split-panel left-panel split-panel-with-playback"
                        style={`width: ${leftPanelWidth()}%`}
                      >
                        <Dynamic 
                          component={leftComponent()} 
                          setFetchMenuTrigger={setFetchMenuTrigger}
                          isInSplitView={true}
                          rightPanelMenu={rightPanelMenu()}
                          key="split-left"
                        />
                      </div>
                      <div 
                        class="split-divider" 
                        onMouseDown={handleDragStart}
                        title="Drag to resize panels"
                      ></div>
                      <div 
                        class="split-panel right-panel"
                        style={`width: ${100 - leftPanelWidth()}%`}
                        onMouseEnter={() => setIsHoveringSplitView(true)}
                        onMouseLeave={() => setIsHoveringSplitView(false)}
                      >
                        <Dynamic 
                          component={rightComponent()} 
                          setFetchMenuTrigger={setFetchMenuTrigger}
                          isInSplitView={true}
                          mainPanelMenu={leftPanelMenu()}
                          key="split-right"
                        />
                      </div>
                    </div>
                  </div>
                </Match>
                <Match when={component()}>
                  {/* Single View Layout - key includes selectedMenu so content remounts when menu changes */}
                  <Dynamic 
                    component={component()} 
                    setFetchMenuTrigger={setFetchMenuTrigger}
                    isInSplitView={false}
                    key={`single-view-${selectedMenu() || ''}`}
                  />
                </Match>
              </Switch>
            </div>
          </Show>
          </Show>
        </div>
      </div>
    </>
  );
};
