import { createSignal, createEffect, onCleanup, Accessor } from 'solid-js';
import { unifiedDataStore } from '../store/unifiedDataStore';
import { debug } from './console';

type ChartType = 'map' | 'overlay' | 'ts' | 'scatter' | 'probability' | 'polarrose' | 'parallel' | 'performance' | 'maneuvers';

export interface ProgressStage {
  progress: number;
  message: string;
  condition?: () => boolean;
}

export interface UseChartProgressOptions {
  chartType: ChartType;
  className: Accessor<string> | string;
  sourceId: Accessor<string | number> | string | number;
  stages?: ProgressStage[];
  pollInterval?: number; // Default 200ms
}

export interface UseChartProgressReturn {
  progress: Accessor<number>;
  message: Accessor<string>;
  isLoading: Accessor<boolean>;
  setProgress: (progress: number, message?: string) => void;
  reset: () => void;
}

/**
 * Hook for tracking chart data loading progress
 * Monitors unifiedDataStore loading states and provides progress updates
 */
export function useChartProgress(options: UseChartProgressOptions): UseChartProgressReturn {
  const {
    chartType,
    className: classNameAccessor,
    sourceId: sourceIdAccessor,
    stages = [],
    pollInterval = 200
  } = options;

  const [progress, setProgressSignal] = createSignal<number>(0);
  const [message, setMessage] = createSignal<string>('Loading...');
  const [isLoading, setIsLoading] = createSignal<boolean>(false);

  let progressCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Helper to get current values
  const getClassName = (): string => {
    return typeof classNameAccessor === 'function' ? classNameAccessor() : classNameAccessor;
  };

  const getSourceId = (): string | number => {
    return typeof sourceIdAccessor === 'function' ? sourceIdAccessor() : sourceIdAccessor;
  };

  // Set progress manually
  const setProgress = (newProgress: number, newMessage?: string) => {
    const clampedProgress = Math.max(0, Math.min(100, newProgress));
    setProgressSignal(clampedProgress);
    if (newMessage) {
      setMessage(newMessage);
    }
    
    // Update unifiedDataStore progress
    const className = getClassName();
    const sourceId = getSourceId();
    unifiedDataStore.setProgress(chartType, className, sourceId, clampedProgress, newMessage);
    
    // Update loading state based on progress
    setIsLoading(clampedProgress < 100);
  };

  // Reset progress
  const reset = () => {
    setProgressSignal(0);
    setMessage('Loading...');
    setIsLoading(false);
    const className = getClassName();
    const sourceId = getSourceId();
    unifiedDataStore.setProgress(chartType, className, sourceId, 0, 'Loading...');
  };

  // Monitor unifiedDataStore loading states and progress
  createEffect(() => {
    const className = getClassName();
    const sourceId = getSourceId();
    
    // Clear existing interval
    if (progressCheckInterval) {
      clearInterval(progressCheckInterval);
      progressCheckInterval = null;
    }

    // Start monitoring
    const startMonitoring = () => {
      progressCheckInterval = setInterval(() => {
        try {
          // Get loading message from unifiedDataStore
          const storeMessage = unifiedDataStore.getDataLoadingMessage(chartType, className, sourceId);
          const storeProgress = unifiedDataStore.getProgress(chartType, className, sourceId);
          const storeProgressMessage = unifiedDataStore.getProgressMessage(chartType, className, sourceId);
          const storeIsLoading = unifiedDataStore.getLoading(chartType);

          // Update loading state
          setIsLoading(storeIsLoading);

          // Use progress from store if available, otherwise infer from message
          if (storeProgress !== null && storeProgress !== undefined) {
            setProgressSignal(storeProgress);
            if (storeProgressMessage) {
              setMessage(storeProgressMessage);
            } else if (storeMessage && storeMessage !== 'Loading data...') {
              setMessage(storeMessage);
            }
          } else if (storeMessage && storeMessage !== 'Loading data...') {
            // Update message from store
            setMessage(storeMessage);
            
            // Increment progress slightly based on message (if not already set)
            const currentProgress = progress();
            if (currentProgress < 70) {
              if (storeMessage.includes('FILE')) {
                setProgressSignal(prev => Math.min(prev + 2, 50));
              } else if (storeMessage.includes('InfluxDB')) {
                setProgressSignal(prev => Math.min(prev + 2, 70));
              } else if (storeMessage.includes('Merging')) {
                setProgressSignal(prev => Math.min(prev + 2, 80));
              } else if (storeMessage.includes('Processing')) {
                setProgressSignal(prev => Math.min(prev + 2, 90));
              }
            }
          }

          // Check custom stages
          if (stages.length > 0) {
            for (const stage of stages) {
              if (stage.condition && stage.condition()) {
                setProgressSignal(stage.progress);
                setMessage(stage.message);
                break;
              }
            }
          }
        } catch (error) {
          debug('[useChartProgress] Error monitoring progress:', error);
        }
      }, pollInterval);
    };

    // Start monitoring if we have required values
    if (className && sourceId) {
      startMonitoring();
    }

    // Cleanup on effect re-run or unmount
    return () => {
      if (progressCheckInterval) {
        clearInterval(progressCheckInterval);
        progressCheckInterval = null;
      }
    };
  });

  // Cleanup on unmount
  onCleanup(() => {
    if (progressCheckInterval) {
      clearInterval(progressCheckInterval);
      progressCheckInterval = null;
    }
    reset();
  });

  return {
    progress,
    message,
    isLoading,
    setProgress,
    reset
  };
}
