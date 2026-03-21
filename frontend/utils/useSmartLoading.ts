// Smart Loading Hook for SolidJS Components
import { createSignal, createEffect, onCleanup, Accessor } from 'solid-js';

// Type definitions
type LoadingType = 'spinner' | 'dots' | 'pulse' | 'skeleton';

interface LoadingOptions {
  message?: string;
  progress?: number | null;
  type?: LoadingType;
  showProgress?: boolean;
}

interface ProgressStep {
  progress: number;
  message: string;
}

interface SmartLoadingHook {
  startLoading: (key: string, options?: LoadingOptions) => void;
  stopLoading: (key: string) => void;
  updateProgress: (key: string, progress: number, message?: string | null) => void;
  updateMessage: (key: string, message: string) => void;
  isLoading: (key: string) => boolean;
  getMessage: (key: string) => string;
  getProgress: (key: string) => number | null;
  getType: (key: string) => LoadingType;
  loadingStates: Record<string, boolean>;
}

interface DataLoadingOptions {
  message?: string;
  showProgress?: boolean;
  type?: LoadingType;
}

interface DataLoadingHook {
  loadData: (key: string, dataLoader: () => Promise<any>, options?: DataLoadingOptions) => Promise<any>;
  isLoading: (key: string) => boolean;
  getMessage: (key: string) => string;
  getProgress: (key: string) => number | null;
  getType: (key: string) => LoadingType;
}

interface ChartLoadingOptions {
  message?: string;
  showProgress?: boolean;
  type?: LoadingType;
}

interface ChartLoadingHook {
  loadChart: (key: string, chartLoader: () => Promise<any>, options?: ChartLoadingOptions) => Promise<any>;
  isLoading: (key: string) => boolean;
  getMessage: (key: string) => string;
  getProgress: (key: string) => number | null;
  getType: (key: string) => LoadingType;
}

interface MapLoadingOptions {
  message?: string;
  showProgress?: boolean;
  type?: LoadingType;
}

interface MapLoadingHook {
  loadMap: (key: string, mapLoader: () => Promise<any>, options?: MapLoadingOptions) => Promise<any>;
  isLoading: (key: string) => boolean;
  getMessage: (key: string) => string;
  getProgress: (key: string) => number | null;
  getType: (key: string) => LoadingType;
}

/**
 * Hook for managing smart loading states with progress tracking
 */
export function useSmartLoading(): SmartLoadingHook {
  const [loadingStates, setLoadingStates] = createSignal<Record<string, boolean>>({});
  const [loadingMessages, setLoadingMessages] = createSignal<Record<string, string>>({});
  const [progressValues, setProgressValues] = createSignal<Record<string, number | null>>({});
  const [loadingTypes, setLoadingTypes] = createSignal<Record<string, LoadingType>>({});

  const startLoading = (key: string, options: LoadingOptions = {}): void => {
    const {
      message = 'Loading...',
      progress = null,
      type = 'spinner',
      showProgress = false
    } = options;

    setLoadingStates(prev => ({ ...prev, [key]: true }));
    setLoadingMessages(prev => ({ ...prev, [key]: message }));
    setProgressValues(prev => ({ ...prev, [key]: progress }));
    setLoadingTypes(prev => ({ ...prev, [key]: type }));
  };

  const updateProgress = (key: string, progress: number, message: string | null = null): void => {
    setProgressValues(prev => ({ ...prev, [key]: progress }));
    if (message) {
      setLoadingMessages(prev => ({ ...prev, [key]: message }));
    }
  };

  const updateMessage = (key: string, message: string): void => {
    setLoadingMessages(prev => ({ ...prev, [key]: message }));
  };

  const stopLoading = (key: string): void => {
    setLoadingStates(prev => ({ ...prev, [key]: false }));
    setLoadingMessages(prev => ({ ...prev, [key]: '' }));
    setProgressValues(prev => ({ ...prev, [key]: null }));
    setLoadingTypes(prev => ({ ...prev, [key]: 'spinner' }));
  };

  const isLoading = (key: string): boolean => loadingStates()[key] || false;
  const getMessage = (key: string): string => loadingMessages()[key] || '';
  const getProgress = (key: string): number | null => progressValues()[key] || null;
  const getType = (key: string): LoadingType => loadingTypes()[key] || 'spinner';

  return {
    startLoading,
    stopLoading,
    updateProgress,
    updateMessage,
    isLoading,
    getMessage,
    getProgress,
    getType,
    loadingStates: loadingStates()
  };
}

/**
 * Hook for data loading with automatic progress simulation
 */
export function useDataLoading(): DataLoadingHook {
  const { 
    startLoading, 
    stopLoading, 
    updateProgress, 
    updateMessage, 
    isLoading, 
    getMessage, 
    getProgress, 
    getType 
  } = useSmartLoading();

  const loadData = async (
    key: string, 
    dataLoader: () => Promise<any>, 
    options: DataLoadingOptions = {}
  ): Promise<any> => {
    const {
      message = 'Loading data...',
      showProgress = true,
      type = 'spinner'
    } = options;

    startLoading(key, { message, showProgress, type });

    try {
      // Simulate progress updates for better UX
      if (showProgress) {
        const progressSteps: ProgressStep[] = [
          { progress: 20, message: 'Connecting to server...' },
          { progress: 40, message: 'Downloading data...' },
          { progress: 60, message: 'Processing data...' },
          { progress: 80, message: 'Rendering...' }
        ];

        for (const step of progressSteps) {
          updateProgress(key, step.progress, step.message);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      // Execute the actual data loading
      const result = await dataLoader();

      // Complete the progress
      if (showProgress) {
        updateProgress(key, 100, 'Complete!');
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      return result;
    } catch (error) {
      updateMessage(key, 'Loading failed. Retrying...');
      throw error;
    } finally {
      stopLoading(key);
    }
  };

  return {
    loadData,
    isLoading,
    getMessage,
    getProgress,
    getType
  };
}

/**
 * Hook for chart loading with specific progress stages
 */
export function useChartLoading(): ChartLoadingHook {
  const { 
    startLoading, 
    stopLoading, 
    updateProgress, 
    updateMessage, 
    isLoading, 
    getMessage, 
    getProgress, 
    getType 
  } = useSmartLoading();

  const loadChart = async (
    key: string, 
    chartLoader: () => Promise<any>, 
    options: ChartLoadingOptions = {}
  ): Promise<any> => {
    const {
      message = 'Loading chart...',
      showProgress = true,
      type = 'spinner'
    } = options;

    startLoading(key, { message, showProgress, type });

    try {
      if (showProgress) {
        const chartSteps: ProgressStep[] = [
          { progress: 10, message: 'Initializing chart...' },
          { progress: 25, message: 'Fetching data...' },
          { progress: 50, message: 'Processing data...' },
          { progress: 75, message: 'Rendering chart...' },
          { progress: 90, message: 'Adding interactions...' }
        ];

        for (const step of chartSteps) {
          updateProgress(key, step.progress, step.message);
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }

      const result = await chartLoader();

      if (showProgress) {
        updateProgress(key, 100, 'Chart ready!');
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return result;
    } catch (error) {
      updateMessage(key, 'Chart loading failed. Retrying...');
      throw error;
    } finally {
      stopLoading(key);
    }
  };

  return {
    loadChart,
    isLoading,
    getMessage,
    getProgress,
    getType
  };
}

/**
 * Hook for map loading with specific progress stages
 */
export function useMapLoading(): MapLoadingHook {
  const { 
    startLoading, 
    stopLoading, 
    updateProgress, 
    updateMessage, 
    isLoading, 
    getMessage, 
    getProgress, 
    getType 
  } = useSmartLoading();

  const loadMap = async (
    key: string, 
    mapLoader: () => Promise<any>, 
    options: MapLoadingOptions = {}
  ): Promise<any> => {
    const {
      message = 'Loading map...',
      showProgress = true,
      type = 'spinner'
    } = options;

    startLoading(key, { message, showProgress, type });

    try {
      if (showProgress) {
        const mapSteps: ProgressStep[] = [
          { progress: 15, message: 'Initializing map...' },
          { progress: 30, message: 'Loading map tiles...' },
          { progress: 50, message: 'Fetching location data...' },
          { progress: 70, message: 'Processing coordinates...' },
          { progress: 85, message: 'Rendering markers...' }
        ];

        for (const step of mapSteps) {
          updateProgress(key, step.progress, step.message);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      const result = await mapLoader();

      if (showProgress) {
        updateProgress(key, 100, 'Map ready!');
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      return result;
    } catch (error) {
      updateMessage(key, 'Map loading failed. Retrying...');
      throw error;
    } finally {
      stopLoading(key);
    }
  };

  return {
    loadMap,
    isLoading,
    getMessage,
    getProgress,
    getType
  };
}
