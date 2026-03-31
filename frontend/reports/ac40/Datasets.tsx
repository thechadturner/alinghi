import { createSignal, createEffect, Show, onMount, onCleanup } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";

import Loading from "../../components/utilities/Loading";
import DropDownButton from "../../components/buttons/DropDownButton";
import WaitingModal from "../../components/utilities/WaitingModal";

import { getData, postData, deleteData, setupMediaContainerScaling } from "../../utils/global";
import { user } from "../../store/userStore";
import { logPageLoad } from "../../utils/logging";
import { persistantStore } from "../../store/persistantStore";
import { setSidebarState } from "../../store/globalStore";
import { clearAllFilters } from "../../store/filterStore";
import { setSelectedEvents, setSelectedRanges, setSelectedRange, setCutEvents, setHasSelection, setIsCut } from "../../store/selectionStore";
import { apiEndpoints } from "@config/env";
import { info, debug, warn, error as logError } from "../../utils/console";
import { sseManager } from "../../store/sseManager";
import { processStore } from "../../store/processStore";
import { toastStore } from "../../store/toastStore";
import { streamingStatusStore } from "../../store/streamingStatusStore";

const { selectedClassName,
  selectedProjectId,
  selectedSourceId,
  selectedSourceName,
  setSelectedSourceName,
  setSelectedSourceId,
  selectedDatasetId,
  setSelectedDatasetId,
  setSelectedDate,
  selectedYear,
  setSelectedYear,
  selectedEvent,
  setSelectedEvent,
  setSelectedPage,
  setSelectedMenu } = persistantStore;

interface Source {
  source_id: number;
  source_name: string;
  [key: string]: any;
}

interface Dataset {
  dataset_id: number;
  source_name: string;
  date: string;
  // Optional fields used in various views / filters
  year_name?: string;
  project_id?: number;
  source_id?: number;
  report_name?: string;
  event_name?: string;
  description?: string;
  [key: string]: any;
}

interface DatasetsProps {
  setFetchMenuTrigger: (value: number) => void;
}

const Datasets = (props: DatasetsProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [sources, setSources] = createSignal<Source[]>([]);
  const [source_names, setSourceNames] = createSignal<string[]>([]);
  const [years, setYears] = createSignal<number[]>([]);
  const [events, setEvents] = createSignal<string[]>([]);
  const [datasets, setDatasets] = createSignal<Dataset[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [isInitializing, setIsInitializing] = createSignal(true);
  const [count, setCount] = createSignal(0);
  const [showWaiting, setShowWaiting] = createSignal(false);
  const [currentStatus, setCurrentStatus] = createSignal("");
  const [refreshProcessId, setRefreshProcessId] = createSignal("");
  const [hasLiveData, setHasLiveData] = createSignal(false);
  const [liveSourceNames, setLiveSourceNames] = createSignal<string[]>([]);
  /** Cache: date string (YYYY-MM-DD) -> true if media exists for that date (project-scoped). */
  const [hasMediaByDate, setHasMediaByDate] = createSignal<Record<string, boolean>>({});

  const { setFetchMenuTrigger } = props;

  /** Normalize date to YYYY-MM-DD for API and cache keys. */
  const normalizeDate = (d: string): string => {
    if (!d || typeof d !== 'string') return '';
    const s = d.trim();
    if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    if (/^\d{4}[\/-]\d{2}[\/-]\d{2}$/.test(s)) return s.replace(/\//g, '-');
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return s;
  };

  const dict_to_array = <T,>(dict: T[], name: keyof T): any[] => dict.map(item => item[name]);

  // Helper function to check if a dataset is the latest and within the last 12 hours
  const isNewDataset = (dataset: Dataset): boolean => {
    // Skip live datasets
    if (dataset.isLive) return false;

    const allDatasets = datasets();
    // Filter out live datasets and get valid datasets with dates
    const validDatasets = allDatasets.filter(d => !d.isLive && d.date);

    if (validDatasets.length === 0) return false;

    // Find the latest dataset by date
    const latestDataset = validDatasets.reduce((latest, current) => {
      if (!latest) return current;
      if (!current.date) return latest;
      // Compare dates (YYYY-MM-DD format)
      return current.date > latest.date ? current : latest;
    });

    // Check if this is the latest dataset
    if (dataset.date !== latestDataset.date) return false;

    // Check if the date is today (within last 12 hours)
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD format

    return dataset.date === todayStr;
  };

  // Check if user has administrator access
  const isAdministrator = () => {
    const userData = user();
    if (!userData) return false;

    if (userData.is_super_user) return true;

    // Handle permissions as string, array, or object
    // Check for both administrator and publisher permissions
    if (typeof userData.permissions === 'string') {
      return userData.permissions === "administrator" || userData.permissions === "publisher";
    } else if (Array.isArray(userData.permissions)) {
      return userData.permissions.includes("administrator") || userData.permissions.includes("publisher");
    } else if (typeof userData.permissions === 'object' && userData.permissions !== null) {
      const permissionValues = Object.values(userData.permissions);
      return permissionValues.includes("administrator") || permissionValues.includes("publisher");
    }

    return false;
  };

  const fetchSources = async () => {
    try {
      const response = await getData(`${apiEndpoints.app.sources}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}`);

      if (response.success) {
        const data = response.data;

        // Filter to only show visible sources (visible === 1)
        const visibleSources = data.filter((source: Source) => source.visible === 1 || source.visible === true);

        setSources(visibleSources);

        if (visibleSources.length > 0) {
          let array = dict_to_array(visibleSources, 'source_name')
          if (visibleSources.length > 1) { array.push('ALL') }

          setSourceNames(array)

          if (selectedSourceName() == "") {
            // If no selection yet, prefer 'ALL' when available so it persists across refreshes
            if (array.includes('ALL')) {
              setSelectedSourceId(0);
              setSelectedSourceName('ALL');
            } else {
              setSelectedSourceId(visibleSources[visibleSources.length - 1].source_id);
              setSelectedSourceName(visibleSources[visibleSources.length - 1].source_name)
            }
          } else {
            // Check if currently selected source is still visible
            const currentSource = visibleSources.find((s: Source) => s.source_name === selectedSourceName());
            if (!currentSource && selectedSourceName() !== 'ALL') {
              // Selected source is no longer visible, reset to default
              if (array.includes('ALL')) {
                setSelectedSourceId(0);
                setSelectedSourceName('ALL');
              } else {
                setSelectedSourceId(visibleSources[visibleSources.length - 1].source_id);
                setSelectedSourceName(visibleSources[visibleSources.length - 1].source_name)
              }
            } else {
              handleSourceSelection(selectedSourceName())
            }
          }
        } else {
          // No visible sources
          setSourceNames([]);
          setSelectedSourceId(0);
          setSelectedSourceName("");
        }
      } else {
        setSources([]);
        setSelectedSourceId(0);
        setSelectedSourceName("")
      }
    } catch (error: any) {
      setSources([]);
      setSelectedSourceId(0);
      setSelectedSourceName("")
    }
  };

  const fetchYears = async () => {
    try {
      if (selectedSourceName() === 'ALL') {
        // For fleet view, get years from all sources by using the first available source
        if (sources().length > 0) {
          const firstSourceId = sources()[0].source_id;
          const url = `${apiEndpoints.app.datasets}/years?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(firstSourceId)}`;
          const response = await getData(url);

          if (response.success) {
            const data = response.data;
            if (data.length > 0) {
              let array = dict_to_array(data, 'year_name')
              if (data.length > 1) { array.push('ALL') }

              setYears(array)

              // Preserve the current selected year if it's still valid, otherwise default to 'ALL'
              const currentYear = selectedYear();
              if (currentYear && array.includes(currentYear)) {
                info('[Datasets] fetchYears: Preserving selected year:', currentYear);
                // Keep the current selection - don't change it
              } else {
                info('[Datasets] fetchYears: Current year not in list, setting to ALL');
                setSelectedYear('ALL');
              }
            }
          } else {
            setYears([]);
            setSelectedYear("");
          }
        } else {
          setYears([]);
          setSelectedYear("");
        }
      } else {
        // For specific source, use the normal endpoint
        const url = `${apiEndpoints.app.datasets}/years?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(selectedSourceId())}`;
        const response = await getData(url);

        if (response.success) {
          const data = response.data;

          if (data.length > 0) {
            let array = dict_to_array(data, 'year_name')
            if (data.length > 1) { array.push('ALL') }

            setYears(array)

            // Preserve the current selected year if it's still valid, otherwise default to 'ALL'
            const currentYear = selectedYear();
            if (currentYear && array.includes(currentYear)) {
              info('[Datasets] fetchYears: Preserving selected year:', currentYear);
              // Keep the current selection - don't change it
            } else {
              info('[Datasets] fetchYears: Current year not in list, setting to ALL');
              setSelectedYear('ALL');
            }
          }
        } else {
          setYears([]);
          setSelectedYear("");
        }
      }
    } catch (error: any) {
      setYears([]);
      setSelectedYear("");
    }
  };

  const fetchEvents = async () => {
    try {
      info('[Datasets] fetchEvents called with state:', {
        sourceName: selectedSourceName(),
        sourceId: selectedSourceId(),
        year: selectedYear()
      });

      // Determine which source_id to use
      let sourceIdToUse;
      if (selectedSourceName() === 'ALL') {
        // For fleet view, pass source_id = 0
        sourceIdToUse = 0;
        info('[Datasets] fetchEvents: Source is ALL, using source_id = 0');
      } else {
        // For specific source, use the selected source_id
        if (!selectedSourceId()) {
          info('[Datasets] fetchEvents: No source_id, setting events to ALL');
          setEvents(['ALL']);
          setSelectedEvent('ALL');
          return;
        }
        sourceIdToUse = selectedSourceId();
      }

      // Ensure we have a year value (default to 'ALL' if empty)
      // The API supports year_name = 'ALL' which returns all events for the source
      const yearValue = selectedYear() || 'ALL';

      let url = `${apiEndpoints.app.datasets}/events?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&source_id=${encodeURIComponent(sourceIdToUse)}`;

      url += `&year_name=${encodeURIComponent(yearValue)}`;

      debug(url)

      info('[Datasets] fetchEvents: Fetching events from:', url);
      info('[Datasets] fetchEvents: Parameters:', {
        source_id: sourceIdToUse,
        year: yearValue,
        source_name: selectedSourceName()
      });

      const response = await getData(url);

      info('[Datasets] fetchEvents: API response:', {
        success: response.success,
        dataType: typeof response.data,
        isArray: Array.isArray(response.data),
        dataLength: response.data?.length,
        data: response.data,
        message: response.message
      });

      if (response.success) {
        const data = response.data;

        if (data && Array.isArray(data) && data.length > 0) {
          let array = dict_to_array(data, 'event_name')
          if (data.length > 1) { array.push('ALL') }

          info('[Datasets] fetchEvents: Setting events to:', array);
          setEvents(array)

          // Preserve the current selected event if it's still valid, otherwise default to 'ALL'
          const currentEvent = selectedEvent();
          if (currentEvent && array.includes(currentEvent)) {
            info('[Datasets] fetchEvents: Preserving selected event:', currentEvent);
            // Keep the current selection - don't change it
          } else {
            info('[Datasets] fetchEvents: Current event not in list, setting to ALL');
            setSelectedEvent('ALL');
          }
        } else {
          // API returned success but no events - set to empty or ALL
          info('[Datasets] fetchEvents: No events found in response, setting to ALL');
          setEvents(['ALL']);
          setSelectedEvent('ALL');
        }
      } else {
        info('[Datasets] fetchEvents: API returned success=false:', response.message);
        setEvents(['ALL']);
        setSelectedEvent('ALL');
      }
    } catch (error: any) {
      info('[Datasets] Error fetching events:', error);
      setEvents(['ALL']);
      setSelectedEvent('ALL');
    }
  };

  const fetchDatasets = async () => {
    try {
      // Fetch from API
      let response;

      if (selectedSourceName() === 'ALL') {
        // Ensure year and event have valid values (default to 'ALL' if empty)
        const yearValue = selectedYear() || 'ALL';
        const eventValue = selectedEvent() || 'ALL';

        let url = `${apiEndpoints.app.datasets}/fleet?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}`;

        url += `&year_name=${encodeURIComponent(yearValue)}&event_name=${encodeURIComponent(eventValue)}`;

        debug('[Datasets] fetchDatasets: Fetching fleet datasets with:', { yearValue, eventValue, url });
        response = await getData(url);
      } else {
        // Ensure year and event have valid values (default to 'ALL' if empty)
        const yearValue = selectedYear() || 'ALL';
        const eventValue = selectedEvent() || 'ALL';

        let url = `${apiEndpoints.app.datasets}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}`;

        url += `&source_id=${encodeURIComponent(selectedSourceId())}`;
        url += `&year_name=${encodeURIComponent(yearValue)}`;
        url += `&event_name=${encodeURIComponent(eventValue)}`;

        response = await getData(url);
      }

      debug('[Datasets] fetchDatasets: API response:', {
        success: response.success,
        dataType: typeof response.data,
        isArray: Array.isArray(response.data),
        dataLength: response.data?.length,
        message: response.message
      });

      if (response.success) {
        const data = response.data || [];

        debug('[Datasets] fetchDatasets: Setting datasets, count:', data.length);
        // Debug visibility values to help diagnose issues
        if (data.length > 0 && isAdministrator()) {
          const visibilityDebug = data.slice(0, 5).map((ds: Dataset) => ({
            dataset_id: ds.dataset_id,
            date: ds.date,
            visible: ds.visible,
            visibleType: typeof ds.visible
          }));
          debug('[Datasets] fetchDatasets: Sample visibility values:', visibilityDebug);
        }

        // Prepend live row if streaming data is available
        // DOUBLE-CHECK: Verify hasLiveData signal is still true (defensive check)
        const shouldShowLive = hasLiveData();
        debug('[Datasets] fetchDatasets: Checking if LIVE row should be shown', { shouldShowLive, hasLiveData: hasLiveData() });

        if (shouldShowLive) {
          const today = new Date();
          const todayStr = today.toISOString().split('T')[0]; // YYYY-MM-DD format
          const currentYear = today.getFullYear();

          const liveRow: Dataset = {
            isLive: true,
            date: todayStr,
            report_name: 'LIVE',
            year_name: currentYear.toString(),
            event_name: 'NA',
            source_name: selectedSourceName() !== 'ALL' ? selectedSourceName() : liveSourceNames().join(', '),
            // For ALL sources view, show source names in sources column
            // For single source view, show source names in description column with prefix
            description: selectedSourceName() !== 'ALL' ? `Live streaming data: ${liveSourceNames().join(', ')}` : 'Live streaming data...',
            dataset_id: null as any,
            sources: selectedSourceName() === 'ALL' ? liveSourceNames().join(', ') : undefined,
            // For single source view, add empty tws/twd fields
            tws: selectedSourceName() !== 'ALL' ? '' : undefined,
            twd: selectedSourceName() !== 'ALL' ? '' : undefined
          };

          // Prepend live row to the beginning of the array
          setDatasets([liveRow, ...data]);
        } else {
          setDatasets(data);
        }
      } else {
        logError('[Datasets] fetchDatasets: API returned success=false:', {
          message: response.message,
          sourceName: selectedSourceName(),
          year: selectedYear(),
          event: selectedEvent()
        });

        // Even if API fails, show live row if available
        // DOUBLE-CHECK: Verify hasLiveData signal is still true
        const shouldShowLive = hasLiveData();
        debug('[Datasets] fetchDatasets: API failed, checking if LIVE row should be shown', { shouldShowLive });

        if (shouldShowLive) {
          const today = new Date();
          const todayStr = today.toISOString().split('T')[0];
          const currentYear = today.getFullYear();

          const liveRow: Dataset = {
            isLive: true,
            date: todayStr,
            report_name: 'LIVE',
            year_name: currentYear.toString(),
            event_name: 'NA',
            source_name: selectedSourceName() !== 'ALL' ? selectedSourceName() : liveSourceNames().join(', '),
            // For ALL sources view, show source names in sources column
            // For single source view, show source names in description column with prefix
            description: selectedSourceName() !== 'ALL' ? `Live streaming data: ${liveSourceNames().join(', ')}` : 'Live streaming data...',
            dataset_id: null as any,
            sources: selectedSourceName() === 'ALL' ? liveSourceNames().join(', ') : undefined,
            tws: selectedSourceName() !== 'ALL' ? '' : undefined,
            twd: selectedSourceName() !== 'ALL' ? '' : undefined
          };

          setDatasets([liveRow]);
        } else {
          setDatasets([]);
        }
      }
    } catch (error: any) {
      // Even if error, show live row if available
      // DOUBLE-CHECK: Verify hasLiveData signal is still true
      const shouldShowLive = hasLiveData();
      debug('[Datasets] fetchDatasets: Error occurred, checking if LIVE row should be shown', { shouldShowLive, error: error?.message });

      if (shouldShowLive) {
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        const currentYear = today.getFullYear();

        const liveRow: Dataset = {
          isLive: true,
          date: todayStr,
          report_name: 'LIVE',
          year_name: currentYear.toString(),
          event_name: 'NA',
          source_name: selectedSourceName() !== 'ALL' ? selectedSourceName() : liveSourceNames().join(', '),
          // For ALL sources view, show source names in sources column
          // For single source view, show source names in description column
          description: selectedSourceName() !== 'ALL' ? liveSourceNames().join(', ') : 'Live streaming data...',
          dataset_id: null as any,
          sources: selectedSourceName() === 'ALL' ? liveSourceNames().join(', ') : undefined,
          tws: selectedSourceName() !== 'ALL' ? '' : undefined,
          twd: selectedSourceName() !== 'ALL' ? '' : undefined
        };

        setDatasets([liveRow]);
      } else {
        setDatasets([]);
      }
    } finally {
      setLoading(false);
      // Update table width after datasets are loaded (table DOM is ready)
      if (window.innerWidth <= 768) {
        setTimeout(() => {
          updateTableWidth();
        }, 100);
      }
    }
  };

  const fetchDatasetCount = async () => {
    try {
      const response = await getData(`${apiEndpoints.app.datasets}/count?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}`);

      if (response.success) {
        const value = response.data;

        setCount(value)
      } else {
        setCount(0)
      }
    } catch (error: any) {
      setCount(0)
    }
  };

  // Use global streaming status store instead of making API calls
  const updateLiveDataFromStore = () => {
    const status = streamingStatusStore.status();
    const isStreamingActive = status().isStreamingActive;
    const sourceNames = status().sourceNames;

    debug('[Datasets] Updating live data from global store', {
      isStreamingActive,
      sourceCount: sourceNames.length,
      sourceNames: sourceNames.slice(0, 5), // Log first 5 for brevity
      lastUpdated: new Date(status().lastUpdated).toISOString(),
    });

    setHasLiveData(isStreamingActive);
    setLiveSourceNames(isStreamingActive ? sourceNames : []);
  };

  // Track if initial load has completed to avoid double-loading
  const [hasInitialLoad, setHasInitialLoad] = createSignal(false);

  // Watch streaming status store and update local state reactively
  createEffect(() => {
    const status = streamingStatusStore.status();
    // Access the signal to create a reactive dependency
    status();
    updateLiveDataFromStore();
  });

  // Initial data load on mount
  const loadInitialData = async () => {
    setIsInitializing(true);
    await logPageLoad('Datasets.jsx', 'Project Datasets Report');

    // Clear selected dataset when viewing project datasets page, but not when restoring
    // after refresh (first mount with existing selection should persist)
    if (!(!hasInitialLoad() && selectedDatasetId() > 0)) {
      setSelectedDatasetId(0);
    }

    // Use global streaming status store (no API call needed)
    updateLiveDataFromStore();

    await fetchDatasetCount();

    if (count() > 0 && selectedProjectId()) {
      setLoading(true);
      await fetchSources();
      await fetchYears();
      await fetchEvents();
      await fetchDatasets();
    } else {
      setDatasets([]);
    }

    setLoading(false);
    setIsInitializing(false);
    setHasInitialLoad(true);
  };

  // Track previous project ID to detect actual changes
  let previousProjectId = selectedProjectId();

  // Watch for selectedProjectId changes and reload data
  createEffect(async () => {
    const projectId = selectedProjectId();

    // Skip if initial load hasn't completed yet (will be handled by onMount)
    if (!hasInitialLoad()) {
      previousProjectId = projectId; // Update tracked value
      return;
    }

    // Only reload if project ID actually changed (not just on every read)
    if (projectId !== previousProjectId && projectId && projectId > 0) {
      debug('[Datasets] selectedProjectId changed, reloading data for project:', projectId, '(was:', previousProjectId, ')');

      // Clear selected dataset when project actually changes
      setSelectedDatasetId(0);
      previousProjectId = projectId; // Update tracked value

      setLoading(true);

      try {
        // Use global streaming status store (no API call needed)
        updateLiveDataFromStore();

        // Fetch count first
        await fetchDatasetCount();

        // If we have datasets, fetch all the data
        if (count() > 0) {
          await fetchSources();
          await fetchYears();
          await fetchEvents();
          await fetchDatasets();
        } else {
          setDatasets([]);
          setSources([]);
          setSourceNames([]);
          setYears([]);
          setEvents([]);
        }
      } catch (error: any) {
        logError('[Datasets] Error reloading data after project change:', error);
        setDatasets([]);
      } finally {
        setLoading(false);
      }
    } else if (projectId === 0 && previousProjectId !== 0) {
      // Project was cleared
      previousProjectId = 0;
      // No project selected, clear data
      debug('[Datasets] No project selected, clearing data');
      setDatasets([]);
      setSources([]);
      setSourceNames([]);
      setYears([]);
      setEvents([]);
      setLoading(false);
    }
  });

  // Function to calculate and set table width on mobile (similar to scaling function)
  // Defined outside onMount so it's accessible throughout the component
  const updateTableWidth = () => {
    const checkMobile = () => window.innerWidth <= 768;
    if (!checkMobile()) return; // Only run on mobile

    const mediaContainer = document.getElementById('media-container');
    if (!mediaContainer) return;

    // Calculate available width the same way scaling function does
    const isMobile = window.innerWidth <= 1000;
    let sidebarWidth = 0;
    if (!isMobile) {
      const sidebar = document.querySelector('.sidebar:not(.mobile)');
      if (sidebar) {
        sidebarWidth = sidebar.classList.contains('collapsed') ? 64 : 275;
      }
    }

    // Get viewport width (same as scaling function)
    const viewportWidth = window.innerWidth || 375;
    const availableWidth = Math.max(100, viewportWidth - sidebarWidth);

    // Find the table wrapper - try multiple selectors to find it
    const tableWrapper = document.querySelector('.datasets-table-wrapper') as HTMLElement;
    if (tableWrapper) {
      // Set width to available width, accounting for page padding (10px each side = 20px total)
      const tableWidth = Math.max(100, availableWidth - 20);
      // Use setProperty with important flag to override CSS
      tableWrapper.style.setProperty('width', `${tableWidth}px`, 'important');
      tableWrapper.style.setProperty('max-width', `${tableWidth}px`, 'important');
      debug('[Datasets] Mobile table wrapper width set to:', tableWidth, 'px (viewport:', viewportWidth, 'px, available:', availableWidth, 'px)');
    } else {
      warn('[Datasets] Table wrapper not found for width calculation');
    }

    // Also set the table itself to use 100% of wrapper
    const table = document.querySelector('.datasets-table') as HTMLElement;
    if (table) {
      table.style.setProperty('width', '100%', 'important');
      table.style.setProperty('max-width', '100%', 'important');
      debug('[Datasets] Mobile table width set to 100% of wrapper');
    } else {
      warn('[Datasets] Table not found for width calculation');
    }
  };

  // Set up dynamic scaling for media-container and load initial data
  let resizeHandler: (() => void) | null = null;
  let tableWidthResizeHandler: (() => void) | null = null;

  onMount(async () => {
    // Streaming status is now managed by global streamingStatusStore
    // The createEffect above watches the store and updates local state reactively
    // When status changes, it will trigger the effect which updates hasLiveData
    debug('[Datasets] ✅ Using global streaming status store (refreshes every minute)');

    // Watch for changes in hasLiveData and refresh datasets list when it changes
    createEffect(() => {
      // Access hasLiveData to create reactive dependency
      const currentHasLiveData = hasLiveData();
      // Only refresh if we've completed initial load
      if (hasInitialLoad() && currentHasLiveData !== undefined) {
        debug('[Datasets] Streaming status changed - refreshing datasets list', {
          hasLiveData: currentHasLiveData
        });
        // Force refresh datasets to update LIVE row visibility
        fetchDatasets().catch(err => {
          logError('[Datasets] Error refreshing datasets after status change:', err);
        });
      }
    });
    // Check if we're on mobile - disable scaling for datasets page on mobile
    const checkMobile = () => window.innerWidth <= 768;
    const isMobile = checkMobile();

    if (!isMobile) {
      setupMediaContainerScaling({
        logPrefix: 'Datasets'
      });
    } else {
      // On mobile, add a class to disable scaling
      // Use a small delay to ensure media-container exists
      const addMobileClass = () => {
        const mediaContainer = document.getElementById('media-container');
        if (mediaContainer) {
          mediaContainer.classList.add('datasets-mobile-no-scale');
          // Also prevent scale factor from being set
          document.documentElement.style.setProperty('--scale-factor', '1', 'important');
          debug('[Datasets] Mobile mode: scaling disabled');

          // Set table width after a short delay to ensure DOM is ready
          setTimeout(() => {
            updateTableWidth();
          }, 200);
        } else {
          // Retry if container doesn't exist yet
          setTimeout(addMobileClass, 100);
        }
      };
      addMobileClass();

      // Also listen for window resize to handle orientation changes
      resizeHandler = () => {
        const nowMobile = checkMobile();
        const mediaContainer = document.getElementById('media-container');
        if (mediaContainer) {
          if (nowMobile) {
            mediaContainer.classList.add('datasets-mobile-no-scale');
            document.documentElement.style.setProperty('--scale-factor', '1', 'important');
            // Update table width on resize
            updateTableWidth();
          } else {
            mediaContainer.classList.remove('datasets-mobile-no-scale');
            // Clear JavaScript-set width styles when switching to desktop
            const tableWrapper = document.querySelector('.datasets-table-wrapper') as HTMLElement;
            if (tableWrapper) {
              tableWrapper.style.removeProperty('width');
              tableWrapper.style.removeProperty('max-width');
              debug('[Datasets] Desktop mode: cleared JavaScript-set table width');
            }
            // Re-enable scaling if switching to desktop
            setupMediaContainerScaling({
              logPrefix: 'Datasets'
            });
          }
        }
      };
      window.addEventListener('resize', resizeHandler);

      // Set up table width resize handler
      tableWidthResizeHandler = () => {
        if (checkMobile()) {
          updateTableWidth();
        }
      };
      window.addEventListener('resize', tableWidthResizeHandler);

      // Also use ResizeObserver for more accurate width tracking
      const mediaContainer = document.getElementById('media-container');
      if (mediaContainer) {
        const resizeObserver = new ResizeObserver(() => {
          if (checkMobile()) {
            updateTableWidth();
          }
        });
        resizeObserver.observe(mediaContainer);

        // Cleanup observer on unmount
        onCleanup(() => {
          resizeObserver.disconnect();
        });
      }
    }

    // Load initial data on mount
    await loadInitialData();
  });

  // Cleanup resize handlers and streaming status polling on unmount
  onCleanup(() => {
    if (resizeHandler) {
      window.removeEventListener('resize', resizeHandler);
    }
    if (tableWidthResizeHandler) {
      window.removeEventListener('resize', tableWidthResizeHandler);
    }
    // No cleanup needed - global streamingStatusStore manages its own lifecycle
  });

  const handleAddDataset = () => {
    const className = selectedClassName() || 'ac40';
    navigate(`/upload-datasets/${className}`);
  };

  const handleSelectDataset = (dataset_id: number) => {
    setSelectedDatasetId(dataset_id);
    setSelectedDate(""); // Clear date when dataset is selected
    // Clear all selections and cuts when selecting a new dataset
    try { setSelectedEvents([]); } catch (_) { }
    try { setSelectedRanges([]); } catch (_) { }
    try { setSelectedRange([]); } catch (_) { }
    try { setCutEvents([]); } catch (_) { }
    try { setHasSelection(false); } catch (_) { }
    try { setIsCut(false); } catch (_) { }
    clearAllFilters(); // Clear all filters when selecting a new dataset
    setSidebarState('dataset');
    // Don't clear menu - let restoreLastMenuForMode handle restoring last menu
    // If no last menu exists, it will remain empty and first menu will open
    setSelectedPage('');
    setFetchMenuTrigger(1);

    // Check if we're already on the dashboard - if so, just trigger menu reload
    // If not, navigate to dashboard after a brief delay to allow state to propagate
    const currentPath = location.pathname;
    if (currentPath === '/dashboard') {
      // Already on dashboard, state change will trigger menu reload
      // No navigation needed
    } else {
      // Use queueMicrotask to ensure state updates propagate before navigation
      // This allows the sidebar to react to the dataset change
      queueMicrotask(() => {
        navigate("/dashboard");
      });
    }
  };

  const handleSelectDate = (date: string) => {
    setSelectedDate(date);
    setSelectedDatasetId(0); // Clear dataset when date is selected
    // Clear all selections and cuts when selecting a new date
    try { setSelectedEvents([]); } catch (_) { }
    try { setSelectedRanges([]); } catch (_) { }
    try { setSelectedRange([]); } catch (_) { }
    try { setCutEvents([]); } catch (_) { }
    try { setHasSelection(false); } catch (_) { }
    try { setIsCut(false); } catch (_) { }
    clearAllFilters(); // Clear all filters when selecting a new date
    setSidebarState('dataset'); // sidebarState is 'dataset' for both dataset and day modes
    // Clear menu to ensure first report (Performance) opens
    setSelectedMenu('');
    setSelectedPage('');
    setFetchMenuTrigger(1);

    // Check if we're already on the dashboard - if so, just trigger menu reload
    // If not, navigate to dashboard after a brief delay to allow state to propagate
    const currentPath = location.pathname;
    if (currentPath === '/dashboard') {
      // Already on dashboard, state change will trigger menu reload
      // No navigation needed
    } else {
      // Use queueMicrotask to ensure state updates propagate before navigation
      // This allows the sidebar to react to the date change
      queueMicrotask(() => {
        navigate("/dashboard");
      });
    }
  };

  const handleSelectLive = () => {
    // Switch to live mode
    setSidebarState('live');
    setSelectedDatasetId(0);
    setSelectedDate("");
    clearAllFilters(); // Clear all filters when entering live mode
    setFetchMenuTrigger(1);
    // Sidebar will auto-navigate to first live menu item
  };

  const handleEditDataset = (dataset_id: number) => {
    setSelectedDatasetId(dataset_id);
    const className = selectedClassName() || 'ac40';
    const pid = selectedProjectId();
    navigate(`/events/${className}?pid=${pid}&dataset_id=${dataset_id}`);
  };

  const handleEditDatasetInfo = (dataset_id: number) => {
    setSelectedDatasetId(dataset_id);
    const className = selectedClassName() || 'ac40';
    // Pass dataset_id in navigation state as backup in case state update hasn't propagated
    navigate(`/dataset-info/${className}`, { state: { dataset_id } });
  };

  // Navigate to DayInfo (fleet/day edit). DayInfo resolves dataset_id from date when needed.
  const handleEditDayInfo = (date: string) => {
    if (!date || !date.trim()) {
      logError('[Datasets] handleEditDayInfo: no date');
      return;
    }
    setSelectedDate(date);
    const className = selectedClassName() || 'ac40';
    navigate(`/day-info/${className}`, { state: { date } });
  };

  const handleSourceSelection = async (source_name: string) => {
    // Clear all selections and cuts when changing source
    try { setSelectedEvents([]); } catch (_) { }
    try { setSelectedRanges([]); } catch (_) { }
    try { setSelectedRange([]); } catch (_) { }
    try { setCutEvents([]); } catch (_) { }
    try { setHasSelection(false); } catch (_) { }
    try { setIsCut(false); } catch (_) { }

    if (source_name === 'ALL') {
      setSelectedSourceId(0); // Use 0 to indicate all sources
      setSelectedSourceName('ALL');
      // Fetch years and events first, then datasets
      await fetchYears();
      await fetchEvents();
      await fetchDatasets();
      return;
    }

    // Find the matching source
    const matchingSource = sources().find(source => source.source_name === source_name);
    if (matchingSource) {
      setSelectedSourceId(matchingSource.source_id);
      setSelectedSourceName(matchingSource.source_name);
      // Fetch years and events first, then datasets
      await fetchYears();
      await fetchEvents();
      await fetchDatasets();
    }
  };

  const handleYearSelection = (year: string | number) => {
    info('[Datasets] handleYearSelection called with year:', year);
    info('[Datasets] handleYearSelection - current state:', {
      currentYear: selectedYear(),
      currentSource: selectedSourceName(),
      currentSourceId: selectedSourceId()
    });
    setSelectedYear(String(year));
    info('[Datasets] handleYearSelection - year set to:', year);
    // Small delay to ensure signal is updated, then fetch events
    setTimeout(() => {
      info('[Datasets] handleYearSelection - calling fetchEvents after timeout');
      fetchEvents();
    }, 0);
    // setSelectedEvent('ALL')
    fetchDatasets();
  }

  const handleEventSelection = (event: string) => {
    setSelectedEvent(event);
    fetchDatasets();
  }


  // Helper function to verify a dataset is visible by fetching it
  const verifyDatasetVisible = async (datasetId: number): Promise<boolean> => {
    debug('[Datasets] verifyDatasetVisible called:', { datasetId });

    const maxRetries = 5;
    const retryDelay = 1000; // 1 second

    for (let retry = 0; retry < maxRetries; retry++) {
      try {
        const datasetResponse = await getData(
          `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
        );

        if (datasetResponse.success && datasetResponse.data) {
          debug('[Datasets] Dataset is visible:', { datasetId, retry });
          return true;
        }
      } catch (error) {
        debug('[Datasets] Error checking dataset visibility:', { datasetId, retry, error });
      }

      // Wait before retrying (except on last retry)
      if (retry < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    warn('[Datasets] Dataset not visible after retries:', { datasetId, maxRetries });
    return false;
  };

  // Helper function to check for running processes
  const checkRunningProcesses = async (): Promise<{ running_count: number; processes: any[] } | null> => {
    try {
      const response = await getData(apiEndpoints.python.running_processes);
      if (response.success && response.data) {
        return response.data;
      }
      return null;
    } catch (error) {
      debug('[Datasets] Error checking running processes:', error);
      return null;
    }
  };

  // Helper function to cancel a running process
  const cancelRunningProcess = async (processId: string): Promise<boolean> => {
    try {
      const response = await postData(apiEndpoints.python.cancel_process(processId), {});
      return response.success === true;
    } catch (error) {
      warn('[Datasets] Error cancelling process:', error);
      return false;
    }
  };

  const handleRefreshDataset = async (dataset_id: number, date: string, source_name: string) => {
    debug('[Datasets] handleRefreshDataset called:', {
      dataset_id: dataset_id,
      date: date,
      source_name: source_name
    });

    // Check for running processes before starting
    const runningInfo = await checkRunningProcesses();
    if (runningInfo && runningInfo.running_count > 0) {
      const processList = runningInfo.processes.map(p =>
        `- ${p.script_name} (${p.class_name}) - Started: ${p.started_at || 'unknown'}`
      ).join('\n');

      const message = `A process is already running:\n\n${processList}\n\nWould you like to cancel it and start the new process?`;
      const confirmed = window.confirm(message);

      if (!confirmed) {
        debug('[Datasets] User cancelled - not starting new process');
        return;
      }

      // Cancel all running processes
      for (const proc of runningInfo.processes) {
        const cancelled = await cancelRunningProcess(proc.process_id);
        if (cancelled) {
          debug('[Datasets] Cancelled process:', proc.process_id);
        } else {
          warn('[Datasets] Failed to cancel process:', proc.process_id);
        }
      }

      // Wait a moment for processes to cancel
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Show waiting modal
    setShowWaiting(true);
    setCurrentStatus("Initializing...");
    setRefreshProcessId("");

    // Add a small delay to ensure the modal renders
    await new Promise(resolve => setTimeout(resolve, 100));

    try {
      setCurrentStatus("Connecting to server...");
      // Pre-establish SSE connection for script execution
      await sseManager.connectToServer(8049);
      debug('[Datasets] SSE connection established for script execution');

      const controller = new AbortController();

      let parameters = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName().toString(),
        dataset_id: dataset_id.toString(),
        date: date,
        source_name: source_name,
        batch: false,
        verbose: true
      };

      let payload = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName().toString(),
        script_name: '2_process_and_execute.py',
        parameters: parameters
      };

      debug('[Datasets] Executing script with payload:', payload);
      setCurrentStatus("Starting...");

      let response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);

      debug('[Datasets] Script execution server response:', response_json);

      // Check if server returned "process already running" status
      if (response_json?.data?.process_already_running) {
        const runningProcesses = response_json.data.running_processes || [];
        const processList = runningProcesses.map((p: any) =>
          `- ${p.script_name} (${p.class_name}) - Started: ${p.started_at || 'unknown'}`
        ).join('\n');

        const message = `A process is already running:\n\n${processList}\n\nWould you like to cancel it and start the new process?`;
        const confirmed = window.confirm(message);

        if (!confirmed) {
          debug('[Datasets] User cancelled - not starting new process');
          setShowWaiting(false);
          return;
        }

        // Cancel all running processes
        for (const proc of runningProcesses) {
          const cancelled = await cancelRunningProcess(proc.process_id);
          if (cancelled) {
            debug('[Datasets] Cancelled process:', proc.process_id);
          } else {
            warn('[Datasets] Failed to cancel process:', proc.process_id);
          }
        }

        // Wait a moment for processes to cancel, then retry
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Retry the script execution
        const retryResponse = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        response_json = retryResponse;
      }

      if (!response_json?.success) {
        // Extract detailed error message for better user feedback
        let errorMessage = response_json?.message || 'Unknown error';
        const errorData = (response_json as any)?.errorResponse?.data || (response_json as any)?.data;

        // If there are error lines, use the last one as the error message
        if (errorData?.error_lines && Array.isArray(errorData.error_lines) && errorData.error_lines.length > 0) {
          const lastError = errorData.error_lines[errorData.error_lines.length - 1];
          if (lastError && typeof lastError === 'string' && lastError.trim()) {
            errorMessage = lastError.length > 150 ? lastError.substring(0, 150) + '...' : lastError;
          }
        }

        // Include return code if available
        if (errorData?.return_code !== undefined && errorData.return_code !== null && errorData.return_code !== 0) {
          errorMessage = `Script failed (code ${errorData.return_code}): ${errorMessage}`;
        }

        logError('[Datasets] Script start failed:', new Error(errorMessage), {
          response: response_json,
          message: response_json?.message || 'Unknown error',
          dataset_id: dataset_id,
          errorData: errorData
        });
        setShowWaiting(false);
        setCurrentStatus("");
        toastStore.showToast('error', 'Refresh Failed', `Failed to start processing: ${errorMessage}`);
        return;
      }

      // Extract process_id
      let pid: string | null = null;
      if ((response_json as any).process_id) {
        pid = (response_json as any).process_id;
      } else if ((response_json as any)?.data?.process_id) {
        pid = (response_json as any).data.process_id;
      }

      if (!pid) {
        warn('[Datasets] No process_id in successful server response');
        setShowWaiting(false);
        setCurrentStatus("");
        toastStore.showToast('error', 'Refresh Failed', 'No process ID returned from server');
        return;
      }

      debug('[Datasets] Using process_id:', pid);
      setRefreshProcessId(pid);

      // Start the process in the store to trigger SSE connection
      processStore.startProcess(pid, 'script_execution');

      // Explicitly disable toast for this process to avoid duplicate messages
      // Do this AFTER starting the process so the process exists in the store
      processStore.setShowToast(pid, false);
      debug('[Datasets] Toast disabled for process:', pid);

      // Clear custom status so SSE messages from the script will show in WaitingModal
      setCurrentStatus("");

      // Wait for the process to complete - SSE messages will show automatically via WaitingModal
      await new Promise<void>((resolve) => {
        let checkCount = 0;
        const maxInitialChecks = 20; // Wait up to 10 seconds for process to appear
        const startTime = Date.now();
        const maxTimeoutMs = 600000; // 10 minute timeout (increased to allow for server load)
        let timeoutCleared = false;

        const waitForCompletion = () => {
          const process = processStore.getProcess(pid);
          const elapsedTime = Date.now() - startTime;

          // Check if we've exceeded the timeout using actual elapsed time (not throttled setTimeout)
          if (elapsedTime >= maxTimeoutMs && !timeoutCleared) {
            // Before showing timeout, check if process is actually still running
            if (process && process.status === 'running') {
              warn('[Datasets] Script execution timeout - process still running');
              setShowWaiting(false);
              setCurrentStatus("");
              setRefreshProcessId("");
              toastStore.showToast('info', 'Refresh Timeout', 'Processing is taking longer than expected');
              timeoutCleared = true;
              resolve();
              return;
            } else if (!process) {
              // Process not found - might have completed while tab was in background
              // Check one more time after a short delay
              setTimeout(async () => {
                const finalCheck = processStore.getProcess(pid);
                if (finalCheck && finalCheck.status === 'complete') {
                  debug('[Datasets] Process completed while tab was in background');
                  setShowWaiting(false);
                  setCurrentStatus("Verifying dataset...");
                  setRefreshProcessId("");

                  // Verify dataset is visible before showing success
                  const isVisible = await verifyDatasetVisible(dataset_id);
                  if (isVisible) {
                    toastStore.showToast('success', 'Refresh Complete', 'Dataset has been successfully refreshed');
                  } else {
                    toastStore.showToast('warning', 'Refresh Complete', 'Processing completed, but dataset not yet visible. Please refresh the page.');
                  }

                  setTimeout(async () => {
                    await fetchDatasets();
                    await fetchDatasetCount();
                    debug('[Datasets] Datasets table refreshed after successful processing');
                  }, 500);
                  timeoutCleared = true;
                  resolve();
                } else {
                  warn('[Datasets] Script execution timeout - process not found');
                  setShowWaiting(false);
                  setCurrentStatus("");
                  setRefreshProcessId("");
                  toastStore.showToast('info', 'Refresh Timeout', 'Processing is taking longer than expected');
                  timeoutCleared = true;
                  resolve();
                }
              }, 1000);
              return;
            }
          }

          if (process) {
            if (process.status === 'complete') {
              debug('[Datasets] Script execution completed');
              if (!timeoutCleared) {
                timeoutCleared = true;
                setShowWaiting(false);
                setCurrentStatus("Verifying dataset...");
                setRefreshProcessId("");

                // Verify dataset is visible before showing success
                verifyDatasetVisible(dataset_id).then((isVisible) => {
                  setCurrentStatus("");

                  if (isVisible) {
                    toastStore.showToast('success', 'Refresh Complete', 'Dataset has been successfully refreshed');
                  } else {
                    toastStore.showToast('warning', 'Refresh Complete', 'Processing completed, but dataset not yet visible. Please refresh the page.');
                  }

                  // Add a small delay to ensure backend has processed the changes
                  setTimeout(async () => {
                    // Refresh the datasets list and count
                    await fetchDatasets();
                    await fetchDatasetCount();
                    debug('[Datasets] Datasets table refreshed after successful processing');
                  }, 500);
                }).catch((error) => {
                  warn('[Datasets] Error verifying dataset visibility:', error);
                  setCurrentStatus("");
                  toastStore.showToast('warning', 'Refresh Complete', 'Processing completed, but unable to verify dataset visibility. Please refresh the page.');
                });
                resolve();
              }
            } else if (process.status === 'error' || process.status === 'timeout') {
              if (!timeoutCleared) {
                warn('[Datasets] Script execution failed:', process.status);
                timeoutCleared = true;
                setShowWaiting(false);
                setCurrentStatus("");
                setRefreshProcessId("");
                toastStore.showToast('error', 'Refresh Failed', `Processing failed: ${process.status}`);
                resolve();
              }
            } else {
              // Still running, check again in 500ms
              setTimeout(waitForCompletion, 500);
            }
          } else {
            // Process not found yet - wait a bit longer before giving up
            checkCount++;
            if (checkCount < maxInitialChecks) {
              // Still waiting for process to appear, check again in 500ms
              setTimeout(waitForCompletion, 500);
            } else {
              // Process hasn't appeared after reasonable time, but don't show error
              // The process might still be running, just not tracked yet
              debug('[Datasets] Process not found in store after initial checks, but continuing to wait');
              setTimeout(waitForCompletion, 500);
            }
          }
        };

        // Start checking for completion
        waitForCompletion();
      });

    } catch (error: any) {
      if (error.name === 'AbortError') {
        warn('[Datasets] Request was aborted - this may be normal if the request completed');
        // Don't show error immediately - the process might still be running
        // Check if we have a process ID and wait for it
        if (refreshProcessId()) {
          debug('[Datasets] Request aborted but process ID exists, continuing to wait for process');
          // Continue waiting for the process - don't close modal yet
        } else {
          // No process ID, so the request really failed
          setShowWaiting(false);
          setCurrentStatus("");
          setRefreshProcessId("");
          toastStore.showToast('error', 'Refresh Failed', 'Request was cancelled or timed out');
        }
      } else {
        logError('Error executing script:', error);
        setShowWaiting(false);
        setCurrentStatus("");
        setRefreshProcessId("");
        toastStore.showToast('error', 'Refresh Failed', `Error: ${error.message || 'Unknown error'}`);
      }
    }
  };

  const handleDeleteDataset = async (dataset_id: number) => {
    debug('[Datasets] handleDeleteDataset called:', { dataset_id });

    // Confirm deletion
    if (!confirm('Are you sure you want to delete this dataset? This action cannot be undone.')) {
      return;
    }

    try {
      const payload = {
        class_name: selectedClassName(),
        project_id: selectedProjectId(),
        dataset_id: dataset_id
      };

      debug('[Datasets] Deleting dataset with payload:', payload);

      const response = await deleteData(`${apiEndpoints.app.datasets}`, payload);

      if (response.success) {
        debug('[Datasets] Dataset deleted successfully');
        // Add a small delay to ensure backend has processed the deletion
        setTimeout(async () => {
          // Refresh the datasets list and count
          await fetchDatasets();
          await fetchDatasetCount();
          debug('[Datasets] Datasets table refreshed after successful deletion');
        }, 500);
      } else {
        logError('[Datasets] Delete failed:', response.message);
      }
    } catch (error: any) {
      logError('Error deleting dataset:', error);
    }
  };

  const handleRemoveMedia = async (date: string) => {
    const normDate = normalizeDate(date);
    if (!normDate) {
      logError('[Datasets] handleRemoveMedia: invalid date', date);
      return;
    }
    if (!confirm('Remove all media for this date? This will delete physical files and remove media records.')) {
      return;
    }
    try {
      const payload = {
        class_name: selectedClassName(),
        project_id: selectedProjectId(),
        date: normDate
      };
      debug('[Datasets] Removing media by date:', payload);
      const response = await deleteData(apiEndpoints.admin.mediaRemoveByDate, payload);
      if (response.success) {
        setHasMediaByDate((prev) => ({ ...prev, [normDate]: false }));
        toastStore.showToast('success', 'Media removed', 'Media for this date has been removed.');
        debug('[Datasets] Media removed successfully for date:', normDate);
      } else {
        logError('[Datasets] Remove media failed:', (response as any)?.message ?? response);
        toastStore.showToast('error', 'Remove media failed', (response as any)?.message ?? 'Failed to remove media.');
      }
    } catch (error: any) {
      logError('[Datasets] Error removing media:', error);
      toastStore.showToast('error', 'Remove media failed', error?.message ?? 'Unknown error.');
    }
  };

  // Debug effect to track events changes
  createEffect(() => {
    const currentEvents = events();
    info('[Datasets] Events signal changed:', {
      count: currentEvents.length,
      events: currentEvents,
      selectedYear: selectedYear(),
      selectedSourceId: selectedSourceId(),
      selectedSourceName: selectedSourceName()
    });
  });

  // Effect to update table width when datasets are loaded (table DOM is ready)
  createEffect(() => {
    if (window.innerWidth <= 768 && datasets().length > 0 && !loading()) {
      // Table should be rendered now, update width
      setTimeout(() => {
        updateTableWidth();
      }, 100);
    }
  });

  // Effect: when datasets or project/class change, fetch hasMedia for each distinct date
  createEffect(() => {
    const list = datasets();
    const projectId = selectedProjectId();
    const className = selectedClassName();
    if (!list.length || !projectId || !className) {
      setHasMediaByDate({});
      return;
    }
    const dates = new Set<string>();
    for (const ds of list) {
      if (ds.isLive || !ds.date) continue;
      dates.add(normalizeDate(ds.date));
    }
    if (dates.size === 0) {
      setHasMediaByDate({});
      return;
    }
    const urlBase = `${apiEndpoints.media.sources}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}`;
    let cancelled = false;
    const next: Record<string, boolean> = {};
    (async () => {
      for (const date of dates) {
        if (cancelled) return;
        try {
          const res = await getData(`${urlBase}&date=${encodeURIComponent(date)}`);
          next[date] = !!(res.success && res.data && Array.isArray(res.data) && res.data.length > 0);
        } catch {
          next[date] = false;
        }
      }
      if (!cancelled) setHasMediaByDate((prev) => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
  });

  return (
    <Show when={!showWaiting()} fallback={
      <WaitingModal
        visible={true}
        title="Refreshing Dataset"
        subtitle="Processing dataset..."
        customStatus={currentStatus() || undefined}
        process_id={refreshProcessId() || undefined}
        disableAutoNavigation={true}
        onClose={() => setShowWaiting(false)}
      />
    }>
      <div id="media-container">
        <div class="datasets-page overflow-auto">
          <Show when={!isInitializing() && !loading()} fallback={<Loading />}>
            <div class="flex w-full">
              <div class="w-1/4 h-15 mt-5">
                <div class="flex gap-x-2">
                  <DropDownButton
                    options={source_names()}
                    defaultText={selectedSourceName()}
                    handleSelection={handleSourceSelection}
                    smallLabel="Source"
                    size="auto"
                  />

                  <DropDownButton
                    options={years().map(y => String(y))}
                    defaultText={String(selectedYear() || '')}
                    handleSelection={handleYearSelection}
                    smallLabel="Year"
                    size="auto"
                  />

                  <DropDownButton
                    options={events()}
                    defaultText={selectedEvent()}
                    handleSelection={handleEventSelection}
                    smallLabel="Event"
                    size="big"
                  />
                </div>
              </div>
              <Show when={datasets().length > 0}>
                <div class="w-3/4 h-15 mt-5">
                  <h1>Available Datasets</h1>
                </div>
              </Show>
            </div>
            <Show when={datasets().length > 0} fallback={
              <div class="datasets-table-wrapper flex flex-col items-center justify-center" style="min-height: 400px;">
                <p class="text-gray-500 text-lg mb-4">No datasets available</p>
                <Show when={isAdministrator()}>
                  <button
                    onClick={handleAddDataset}
                    class="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors duration-200 shadow-md hover:shadow-lg flex items-center gap-2"
                  >
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                    </svg>
                    Add Your First Dataset
                  </button>
                </Show>
              </div>
            }>
              <div class="datasets-table-wrapper">
                <Show when={isAdministrator()}
                  fallback={
                    <>
                      <table class="datasets-table">
                        <thead>
                          <tr>
                            <th class="options-column" style="width: 100px;">View</th>
                            <th class="date-column" style="width: 100px;">Date</th>
                            {selectedSourceName() === 'ALL' ? (
                              <>
                                <th class="day-column" style="width: 120px;">Day</th>
                                <th class="year-column-mobile" style="width: 80px;">Year</th>
                                <th class="event-column-mobile" style="width: 120px;">Event</th>
                                <th class="sources-column-mobile big">Sources</th>
                              </>
                            ) : (
                              <>
                                <th class="event-column-mobile" style="width: 120px;">Event</th>
                                <th class="day-column">DAY</th>
                                <th class="tws-column-mobile">TWS [KPH]</th>
                                <th class="twd-column-mobile">TWD</th>
                                <th class="big description-column">DESCRIPTION</th>
                              </>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {datasets().map((dataset) => (
                            <tr
                              id={`dataset-${dataset.dataset_id || dataset.date || 'live'}`}
                              style={dataset.isLive ? `background-color: rgba(239, 68, 68, 0.7);` : ''}
                            >
                              <td class="options-column" style="text-align: center;">
                                {dataset.isLive ? (
                                  <button onClick={() => handleSelectLive()}>
                                    View
                                  </button>
                                ) : isNewDataset(dataset) ? (
                                  selectedSourceName() === 'ALL' ? (
                                    <>
                                      <button
                                        onClick={() => handleSelectDate(dataset.date)}
                                        style="background-color: #3b82f6; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                      >
                                        New
                                      </button>
                                      <Show when={isAdministrator()}>
                                        <button
                                          onClick={() => handleEditDayInfo(dataset.date)}
                                          style="background-color: #10b981; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                          title="Edit day info"
                                        >
                                          Edit
                                        </button>
                                      </Show>
                                    </>
                                  ) : (
                                    <>
                                      <button
                                        onClick={() => handleSelectDataset(dataset.dataset_id)}
                                        style="background-color: #3b82f6; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                      >
                                        New
                                      </button>
                                      <Show when={isAdministrator()}>
                                        <button
                                          onClick={() => handleEditDatasetInfo(dataset.dataset_id)}
                                          style="background-color: #10b981; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                          title="Edit dataset info"
                                        >
                                          Edit
                                        </button>
                                      </Show>
                                    </>
                                  )
                                ) : selectedSourceName() === 'ALL' ? (
                                  <div style="display: flex; gap: 5px; align-items: center; justify-content: center; flex-wrap: wrap;">
                                    <button onClick={() => handleSelectDate(dataset.date)}>
                                      View
                                    </button>
                                    <Show when={isAdministrator()}>
                                      <button
                                        onClick={() => handleEditDayInfo(dataset.date)}
                                        style="background-color: #10b981; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                        title="Edit day info"
                                      >
                                        Edit
                                      </button>
                                    </Show>
                                  </div>
                                ) : (
                                  <button onClick={() => handleSelectDataset(dataset.dataset_id)}>
                                    View
                                  </button>
                                )}
                              </td>
                              <td class="date-column">{dataset.date}</td>
                              {selectedSourceName() === 'ALL' ? (
                                <>
                                  <td class="day-column">{dataset.report_name}</td>
                                  <td class="year-column-mobile">{dataset.year_name}</td>
                                  <td class="event-column-mobile">{dataset.event_name}</td>
                                  <td class="sources-column-mobile">{dataset.sources}</td>
                                </>
                              ) : (
                                <>
                                  <td class="event-column-mobile">{dataset.event_name || '-'}</td>
                                  <td class="day-column">{dataset.report_name}</td>
                                  <td class="tws-column-mobile">{dataset.tws}</td>
                                  <td class="twd-column-mobile">{dataset.twd}</td>
                                  <td class="description-column">{dataset.description}</td>
                                </>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  }
                >
                  <table class="datasets-table">
                    <thead>
                      <tr>
                        <th class="options-column" style="width: 60px;">Options</th>
                        <th class="date-column" style="width: 100px;">Date</th>
                        {selectedSourceName() === 'ALL' ? (
                          <>
                            <th class="day-column" style="width: 120px;">Report Name</th>
                            <th class="year-column-mobile" style="width: 80px;">Year</th>
                            <th class="event-column-mobile" style="width: 120px;">Event</th>
                            <th class="sources-column-mobile big">Sources</th>
                          </>
                        ) : (
                          <>
                            <th class="event-column-mobile" style="width: 120px;">Event</th>
                            <th class="day-column">DAY</th>
                            <th class="tws-column-mobile">TWS [KPH]</th>
                            <th class="twd-column-mobile">TWD</th>
                            <th class="big description-column">DESCRIPTION</th>
                          </>
                        )}
                        {selectedSourceName() !== 'ALL' && (
                          <th class="admin-delete-column" style="width: 60px;">Delete</th>
                        )}
                        <th class="admin-remove-media-column" style="width: 90px;">Media</th>
                      </tr>
                    </thead>
                    <tbody>
                      {datasets().map((dataset) => {
                        // Handle live row for admin view
                        if (dataset.isLive) {
                          return (
                            <tr
                              id="dataset-live"
                              style="background-color: rgba(239, 68, 68, 0.7);"
                            >
                              <td>
                                <div style={`display: flex; gap: 5px; align-items: center; justify-content: center;`}>
                                  <button onClick={() => handleSelectLive()}>
                                    View
                                  </button>
                                </div>
                              </td>
                              <td class="date-column">{dataset.date}</td>
                              {selectedSourceName() === 'ALL' ? (
                                <>
                                  <td class="day-column">{dataset.report_name}</td>
                                  <td class="year-column-mobile">{dataset.year_name}</td>
                                  <td class="event-column-mobile">{dataset.event_name}</td>
                                  <td class="sources-column-mobile">{dataset.sources}</td>
                                </>
                              ) : (
                                <>
                                  <td class="event-column-mobile">{dataset.event_name || '-'}</td>
                                  <td class="day-column">{dataset.report_name}</td>
                                  <td class="tws-column-mobile">{dataset.tws}</td>
                                  <td class="twd-column-mobile">{dataset.twd}</td>
                                  <td class="description-column">{dataset.description}</td>
                                </>
                              )}
                              {selectedSourceName() !== 'ALL' && (
                                <td class="admin-delete-column"></td>
                              )}
                              <td class="admin-remove-media-column">NA</td>
                            </tr>
                          );
                        }

                        // Get source_name for refresh functionality
                        let source_name = selectedSourceName();
                        if (selectedSourceName() === 'ALL' && dataset.source_id) {
                          // Find source name from sources array
                          const source = sources().find(s => s.source_id === dataset.source_id);
                          if (source) {
                            source_name = source.source_name;
                          }
                        } else if (dataset.source_name) {
                          source_name = dataset.source_name;
                        }

                        return (
                          <tr id={`dataset-${dataset.dataset_id || dataset.date}`}>
                            <td>
                              <div style={`display: flex; gap: 5px; align-items: center; justify-content: center;`}>
                                {selectedSourceName() === 'ALL' ? (
                                  isNewDataset(dataset) ? (
                                    <>
                                      <button
                                        onClick={() => handleSelectDate(dataset.date)}
                                        style="background-color: #3b82f6; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                      >
                                        New
                                      </button>
                                      <Show when={isAdministrator()}>
                                        <button
                                          class="admin-edit-button"
                                          onClick={() => handleEditDayInfo(dataset.date)}
                                          style="background-color: #10b981; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                          title="Edit day info"
                                        >
                                          Edit
                                        </button>
                                      </Show>
                                    </>
                                  ) : (
                                    <>
                                      <button onClick={() => handleSelectDate(dataset.date)}>
                                        View
                                      </button>
                                      <button
                                        class="admin-edit-button"
                                        onClick={() => handleEditDayInfo(dataset.date)}
                                        style="background-color: #10b981; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                        title="Edit day info"
                                      >
                                        Edit
                                      </button>
                                    </>
                                  )
                                ) : (dataset.visible === 1 || dataset.visible === true || dataset.visible === "1") ? (
                                  <>
                                    {isNewDataset(dataset) ? (
                                      <>
                                        <button
                                          onClick={() => handleSelectDataset(dataset.dataset_id)}
                                          style="background-color: #3b82f6; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                        >
                                          New
                                        </button>
                                        <Show when={isAdministrator() && dataset.dataset_id}>
                                          <button
                                            class="admin-edit-button"
                                            onClick={() => handleEditDatasetInfo(dataset.dataset_id)}
                                            style="background-color: #10b981; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                            title="Edit dataset info"
                                          >
                                            Edit
                                          </button>
                                        </Show>
                                      </>
                                    ) : (
                                      <button onClick={() => handleSelectDataset(dataset.dataset_id)}>
                                        View
                                      </button>
                                    )}
                                    {dataset.dataset_id && !isNewDataset(dataset) && (
                                      <button
                                        class="admin-edit-button"
                                        onClick={() => handleEditDatasetInfo(dataset.dataset_id)}
                                        style="background-color: #10b981; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                        title="Edit dataset info"
                                      >
                                        Edit
                                      </button>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    <button class="admin-edit-button" onClick={() => handleEditDataset(dataset.dataset_id)}>
                                      Edit
                                    </button>
                                    {(dataset.visible === 0 || dataset.visible === false || dataset.visible === "0" || dataset.visible === undefined || dataset.visible === null) && (
                                      <button
                                        class="admin-refresh-button"
                                        onClick={() => handleRefreshDataset(dataset.dataset_id, dataset.date, source_name)}
                                        style="background-color: #f59e0b; color: white; padding: 6px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;"
                                        title="Refresh dataset processing"
                                      >
                                        Refresh
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                            <td class="date-column">{dataset.date}</td>
                            {selectedSourceName() === 'ALL' ? (
                              <>
                                <td class="day-column">{dataset.report_name}</td>
                                <td class="year-column-mobile">{dataset.year_name}</td>
                                <td class="event-column-mobile">{dataset.event_name}</td>
                                <td class="sources-column-mobile">{dataset.sources}</td>
                              </>
                            ) : (
                              <>
                                <td class="event-column-mobile">{dataset.event_name || '-'}</td>
                                <td class="day-column">{dataset.report_name}</td>
                                <td class="tws-column-mobile">{dataset.tws}</td>
                                <td class="twd-column-mobile">{dataset.twd}</td>
                                <td class="description-column">{dataset.description}</td>
                              </>
                            )}
                            {selectedSourceName() !== 'ALL' && (
                              <td class="admin-delete-column" style="text-align: center;">
                                {dataset.dataset_id && (
                                  <button
                                    class="admin-delete-button"
                                    onClick={() => handleDeleteDataset(dataset.dataset_id)}
                                    style="background-color: #dc2626; color: white; padding: 4px 8px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px; margin: 0 auto;"
                                    title="Delete dataset"
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="stroke: white; fill: none;">
                                      <path d="M3 6h18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                      <line x1="10" y1="11" x2="10" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                      <line x1="14" y1="11" x2="14" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                                    </svg>
                                  </button>
                                )}
                              </td>
                            )}
                            <td class="admin-remove-media-column" style="text-align: center;">
                              {isAdministrator() && dataset.date && hasMediaByDate()[normalizeDate(dataset.date)] ? (
                                <button
                                  class="admin-remove-media-button"
                                  type="button"
                                  onClick={() => handleRemoveMedia(dataset.date)}
                                  title="Remove all media for this date"
                                >
                                  Remove media
                                </button>
                              ) : (
                                'NA'
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </Show>
  );
}

export default Datasets;
