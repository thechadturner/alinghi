// Debounced API Hook for SolidJS Components
import { createSignal, createEffect, onCleanup, Accessor } from 'solid-js';

// Type definitions
interface DebouncedAPIOptions {
  cache?: boolean;
  cacheTime?: number;
  retries?: number;
  retryDelay?: number;
}

interface CachedRequest {
  data: any;
  timestamp: number;
}

interface DebouncedAPIHook {
  debouncedCall: (key: string, apiCall: (signal: AbortSignal) => Promise<any>, delay?: number, options?: DebouncedAPIOptions) => Promise<any>;
  cancelRequest: (key: string) => void;
  clearCache: (key?: string) => void;
}

interface FilterState {
  [key: string]: any;
}

interface DebouncedFiltersHook {
  filterState: Accessor<FilterState>;
  isFiltering: Accessor<boolean>;
  updateFilters: (newFilters: FilterState, onFilterChange: (filters: FilterState) => Promise<void>) => void;
}

interface DebouncedDataFetchOptions {
  cache?: boolean;
  retries?: number;
}

interface DebouncedDataFetchHook {
  data: Accessor<any>;
  isLoading: Accessor<boolean>;
  error: Accessor<Error | null>;
  fetchData: (key: string, dataFetcher: (signal: AbortSignal) => Promise<any>, options?: DebouncedDataFetchOptions) => Promise<any>;
}

interface DebouncedChartUpdateOptions {
  cache?: boolean;
}

interface DebouncedChartUpdateHook {
  isUpdating: Accessor<boolean>;
  updateChart: (key: string, updateFunction: (signal: AbortSignal) => Promise<void>, options?: DebouncedChartUpdateOptions) => Promise<void>;
}

interface DebouncedSelectionHook {
  selection: Accessor<any>;
  isSelecting: Accessor<boolean>;
  updateSelection: (newSelection: any, onSelectionChange: (selection: any) => Promise<void>) => Promise<void>;
}

/**
 * Hook for debounced API calls with caching and request deduplication
 */
type TimeoutId = ReturnType<typeof setTimeout>;

export function useDebouncedAPI(): DebouncedAPIHook {
  const pendingRequests = new Map<string, TimeoutId>();
  const requestCache = new Map<string, CachedRequest>();
  const abortControllers = new Map<string, AbortController>();

  const debouncedCall = async (
    key: string, 
    apiCall: (signal: AbortSignal) => Promise<any>, 
    delay: number = 300, 
    options: DebouncedAPIOptions = {}
  ): Promise<any> => {
    const {
      cache = true,
      cacheTime = 5 * 60 * 1000, // 5 minutes
      retries = 3,
      retryDelay = 1000
    } = options;

    // Cancel previous request if it exists
    if (abortControllers.has(key)) {
      abortControllers.get(key)!.abort();
    }

    // Check cache first
    if (cache && requestCache.has(key)) {
      const cached = requestCache.get(key)!;
      if (Date.now() - cached.timestamp < cacheTime) {
        return cached.data;
      }
    }

    // Create new abort controller
    const abortController = new AbortController();
    abortControllers.set(key, abortController);

    return new Promise((resolve, reject) => {
      // Clear existing timeout
      if (pendingRequests.has(key)) {
        clearTimeout(pendingRequests.get(key)!);
      }

      // Set new timeout
      const timeoutId = setTimeout(async () => {
        try {
          let lastError: Error;
          
          // Retry logic
          for (let attempt = 0; attempt <= retries; attempt++) {
            try {
              const result = await apiCall(abortController.signal);
              
              // Cache successful result
              if (cache) {
                requestCache.set(key, {
                  data: result,
                  timestamp: Date.now()
                });
              }
              
              // Clean up
              pendingRequests.delete(key);
              abortControllers.delete(key);
              
              resolve(result);
              return;
              
            } catch (error) {
              lastError = error as Error;
              
              // Don't retry if aborted or not a network error
              if (error instanceof Error && (error.name === 'AbortError' || attempt === retries)) {
                break;
              }
              
              // Wait before retry
              await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
            }
          }
          
          // All retries failed
          pendingRequests.delete(key);
          abortControllers.delete(key);
          reject(lastError!);
          
        } catch (error) {
          pendingRequests.delete(key);
          abortControllers.delete(key);
          reject(error);
        }
      }, delay);

      pendingRequests.set(key, timeoutId);
    });
  };

  const cancelRequest = (key: string): void => {
    if (pendingRequests.has(key)) {
      clearTimeout(pendingRequests.get(key)!);
      pendingRequests.delete(key);
    }
    
    if (abortControllers.has(key)) {
      abortControllers.get(key)!.abort();
      abortControllers.delete(key);
    }
  };

  const clearCache = (key?: string): void => {
    if (key) {
      requestCache.delete(key);
    } else {
      requestCache.clear();
    }
  };

  // Cleanup on unmount
  onCleanup(() => {
    // Cancel all pending requests
    pendingRequests.forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    pendingRequests.clear();

    // Abort all ongoing requests
    abortControllers.forEach((controller) => {
      controller.abort();
    });
    abortControllers.clear();

    // Clear cache
    requestCache.clear();
  });

  return {
    debouncedCall,
    cancelRequest,
    clearCache
  };
}

/**
 * Hook for debounced filter changes
 */
export function useDebouncedFilters(delay: number = 500): DebouncedFiltersHook {
  const [filterState, setFilterState] = createSignal<FilterState>({});
  const [isFiltering, setIsFiltering] = createSignal<boolean>(false);
  const { debouncedCall } = useDebouncedAPI();

  const updateFilters = (newFilters: FilterState, onFilterChange: (filters: FilterState) => Promise<void>): void => {
    const filterKey = `filters_${JSON.stringify(newFilters)}`;
    
    setIsFiltering(true);
    
    debouncedCall(filterKey, async () => {
      setFilterState(newFilters);
      await onFilterChange(newFilters);
      setIsFiltering(false);
    }, delay, { cache: false });
  };

  return {
    filterState,
    isFiltering,
    updateFilters
  };
}

/**
 * Hook for debounced data fetching
 */
export function useDebouncedDataFetch(delay: number = 300): DebouncedDataFetchHook {
  const [data, setData] = createSignal<any>(null);
  const [isLoading, setIsLoading] = createSignal<boolean>(false);
  const [error, setError] = createSignal<Error | null>(null);
  const { debouncedCall } = useDebouncedAPI();

  const fetchData = async (
    key: string, 
    dataFetcher: (signal: AbortSignal) => Promise<any>, 
    options: DebouncedDataFetchOptions = {}
  ): Promise<any> => {
    const { cache = true, retries = 2 } = options;
    
    setIsLoading(true);
    setError(null);

    try {
      const result = await debouncedCall(key, dataFetcher, delay, { cache, retries });
      setData(result);
      return result;
    } catch (err) {
      const error = err as Error;
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    data,
    isLoading,
    error,
    fetchData
  };
}

/**
 * Hook for debounced chart updates
 */
export function useDebouncedChartUpdate(delay: number = 300): DebouncedChartUpdateHook {
  const [isUpdating, setIsUpdating] = createSignal<boolean>(false);
  const { debouncedCall } = useDebouncedAPI();

  const updateChart = async (
    key: string, 
    updateFunction: (signal: AbortSignal) => Promise<void>, 
    options: DebouncedChartUpdateOptions = {}
  ): Promise<void> => {
    const { cache = false } = options;
    
    setIsUpdating(true);

    try {
      await debouncedCall(key, updateFunction, delay, { cache });
    } finally {
      setIsUpdating(false);
    }
  };

  return {
    isUpdating,
    updateChart
  };
}

/**
 * Hook for debounced selection changes
 */
export function useDebouncedSelection(delay: number = 200): DebouncedSelectionHook {
  const [selection, setSelection] = createSignal<any>(null);
  const [isSelecting, setIsSelecting] = createSignal<boolean>(false);
  const { debouncedCall } = useDebouncedAPI();

  const updateSelection = async (
    newSelection: any, 
    onSelectionChange: (selection: any) => Promise<void>
  ): Promise<void> => {
    const selectionKey = `selection_${JSON.stringify(newSelection)}`;
    
    setIsSelecting(true);
    
    try {
      await debouncedCall(selectionKey, async () => {
        setSelection(newSelection);
        await onSelectionChange(newSelection);
      }, delay, { cache: false });
    } finally {
      setIsSelecting(false);
    }
  };

  return {
    selection,
    isSelecting,
    updateSelection
  };
}
