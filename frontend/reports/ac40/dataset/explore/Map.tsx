import { createSignal, createEffect, onMount, onCleanup, Show } from "solid-js";
import "../../../../styles/thirdparty/mapbox-gl.css";
import Map from "../../../../components/charts/Map";
import LoadingOverlay from "../../../../components/utilities/Loading";
import { debug } from "../../../../utils/console";
import { waitForPaint } from "../../../../utils/waitForRender";
import { persistantStore } from "../../../../store/persistantStore";
import { timeWindow, setTimeWindow, selectedTime, setSelectedTime, requestTimeControl, releaseTimeControl } from "../../../../store/playbackStore";
import { selectedRange, hasSelection } from "../../../../store/selectionStore";
import * as d3 from "d3";

interface MapComponentProps {
  objectName?: string;
  [key: string]: any;
}

export default function MapComponent(props: MapComponentProps) {
  const [isLoading, setIsLoading] = createSignal<boolean>(true);
  let hasInitializedTime = false;
  let checkInterval: ReturnType<typeof setInterval> | null = null;
  const SESSION_STORAGE_KEY = 'explore_map_timeWindow';
  const DEFAULT_TIME_WINDOW = 0; // 0 = full timeline

  // Check if timeline is drawn (has SVG with x-axis)
  const isTimelineDrawn = () => {
    try {
      const chartContainer = document.querySelector('.map-container .chart-container');
      if (!chartContainer) return false;
      
      const svg = d3.select(chartContainer).select('svg');
      if (svg.empty()) return false;
      
      const xAxisGroup = svg.select('.x-axis');
      if (xAxisGroup.empty()) return false;
      
      // Check if axis has ticks (indicating it's fully drawn)
      const ticks = xAxisGroup.selectAll('.tick');
      return !ticks.empty();
    } catch (error) {
      return false;
    }
  };

  // Get minimum time from timeline domain (with retry logic)
  const getMinTimeFromTimeline = (): number | null => {
    try {
      const chartContainer = document.querySelector('.map-container .chart-container');
      if (!chartContainer) return null;
      
      const svg = d3.select(chartContainer).select('svg');
      if (svg.empty()) return null;
      
      // Try multiple ways to get the xScale
      // @ts-ignore - xScale is set globally by MapTimeSeries
      let xScale = (window as any).timeseriesTimeScale;
      
      // If not available, try to get it from the SVG directly
      if (!xScale) {
        // Try to extract domain from the x-axis ticks
        const xAxisGroup = svg.select('.x-axis');
        if (!xAxisGroup.empty()) {
          const ticks = xAxisGroup.selectAll('.tick');
          if (!ticks.empty()) {
            const firstTick = ticks.nodes()[0];
            if (firstTick) {
              const tickText = d3.select(firstTick).select('text');
              const tickValue = tickText.text();
              if (tickValue) {
                // Try to parse the first tick as a date
                const firstDate = new Date(tickValue);
                if (!isNaN(firstDate.getTime())) {
                  // Get the last tick to determine the domain
                  const lastTick = ticks.nodes()[ticks.size() - 1];
                  if (lastTick) {
                    const lastTickText = d3.select(lastTick).select('text');
                    const lastTickValue = lastTickText.text();
                    if (lastTickValue) {
                      const lastDate = new Date(lastTickValue);
                      if (!isNaN(lastDate.getTime())) {
                        return firstDate.getTime();
                      }
                    }
                  }
                }
              }
            }
          }
        }
        return null;
      }
      
      const domain = xScale.domain();
      if (domain && domain.length === 2 && !isNaN(domain[0]) && !isNaN(domain[1]) && domain[0] !== domain[1]) {
        return domain[0].getTime();
      }
    } catch (error) {
      debug('Map: Error getting min time from timeline', error);
    }
    return null;
  };

  // Function to hide loading once timeline is drawn and data is ready
  const checkTimelineReady = async () => {
    if (hasInitializedTime) return;

    // Check if timeline is drawn - if so, wait for simple paint before hiding loading
    if (isTimelineDrawn()) {
      // Initialize timeWindow from session storage or default
      const savedTimeWindow = sessionStorage.getItem(SESSION_STORAGE_KEY);
      const initialTimeWindow = savedTimeWindow ? parseFloat(savedTimeWindow) : DEFAULT_TIME_WINDOW;
      setTimeWindow(initialTimeWindow);
      debug('Map: Initialized timeWindow', { value: initialTimeWindow, fromStorage: !!savedTimeWindow });

      // Wait a bit for xScale to be available, then initialize selectedTime
      // Retry getting minTime a few times since xScale might not be ready immediately
      let minTime: number | null = null;
      for (let retry = 0; retry < 10; retry++) {
        minTime = getMinTimeFromTimeline();
        if (minTime !== null) break;
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms between retries
      }

      if (minTime !== null) {
        const currentTime = selectedTime();
        const defaultTime = new Date('1970-01-01T12:00:00Z');
        const isDefault = currentTime.getTime() === defaultTime.getTime();
        
        // Check if current time is at or very close to minimum (within 10 seconds)
        const timeDiff = Math.abs(currentTime.getTime() - minTime);
        const isAtMinTime = timeDiff < 10000;

        // Only set if it's default or at minimum time
        if (isDefault || isAtMinTime) {
          const targetTime = new Date(minTime + (initialTimeWindow * 60 * 1000)); // Add timeWindow minutes
          
          if (requestTimeControl('explore_map')) {
            debug('Map: Setting selectedTime to minimum + timeWindow', {
              minTime: new Date(minTime).toISOString(),
              currentTime: currentTime.toISOString(),
              targetTime: targetTime.toISOString(),
              timeWindow: initialTimeWindow,
              isDefault,
              isAtMinTime
            });
            setSelectedTime(targetTime, 'explore_map');
            setTimeout(() => {
              releaseTimeControl('explore_map');
            }, 100);
          }
        }
      } else {
        debug('Map: Could not get minTime from timeline after retries');
      }

      // Use simple paint detection to avoid blocking UI
      waitForPaint(2).then(() => {
        debug('Map: Paint complete, hiding loading overlay');
        setIsLoading(false);
        hasInitializedTime = true;
      }).catch((error) => {
        debug('Map: Error waiting for paint, hiding loading anyway:', error);
        setIsLoading(false);
        hasInitializedTime = true;
      });
    }
  };

  // Poll for timeline to be ready
  onMount(() => {
    // Set maptype to DEFAULT when explore/map page loads
    persistantStore.setColorType('DEFAULT');
    debug('Map: Set maptype to DEFAULT on explore/map page load');
    
    let attempts = 0;
    const maxAttempts = 50; // Try for up to 5 seconds (50 * 100ms)
    
    checkInterval = setInterval(() => {
      attempts++;
      
      if (hasInitializedTime) {
        if (checkInterval) {
          clearInterval(checkInterval);
        }
        return;
      }
      
      if (attempts > maxAttempts) {
        debug('Map: Max attempts reached waiting for timeline');
        setIsLoading(false); // Hide loading even if timeline didn't initialize
        if (checkInterval) {
          clearInterval(checkInterval);
        }
        return;
      }

      // Check if timeline is ready
      checkTimelineReady();
    }, 100); // Check every 100ms
  });

  onCleanup(() => {
    if (checkInterval) {
      clearInterval(checkInterval);
    }
  });

  // Watch for timeWindow changes and save to session storage
  // Also restore saved timeWindow if it becomes 0 when there's no selection
  createEffect(() => {
    const currentTimeWindow = timeWindow();
    const currentHasSelection = hasSelection();
    const currentSelectedRange = selectedRange();
    
    // Only act if we've initialized
    if (!hasInitializedTime) {
      return;
    }
    
    // Save to session storage (unless it's being set to 0 due to selection)
    if (currentTimeWindow > 0) {
      sessionStorage.setItem(SESSION_STORAGE_KEY, currentTimeWindow.toString());
      debug('Map: Saved timeWindow to session storage', { value: currentTimeWindow });
    }
    
    // If timeWindow becomes 0 and there's no selection, restore the saved value
    if (currentTimeWindow === 0 && 
        !currentHasSelection && 
        (!currentSelectedRange || currentSelectedRange.length === 0)) {
      const savedTimeWindow = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (savedTimeWindow) {
        const restoredTimeWindow = parseFloat(savedTimeWindow);
        if (!isNaN(restoredTimeWindow) && restoredTimeWindow > 0) {
          // Use setTimeout to avoid infinite loops and ensure this runs after other effects
          setTimeout(() => {
            // Double-check conditions haven't changed
            const stillNoSelection = !hasSelection() && 
                                    (!selectedRange() || selectedRange().length === 0);
            const stillZero = timeWindow() === 0;
            
            if (stillNoSelection && stillZero) {
              debug('Map: timeWindow became 0 with no selection, restoring saved timeWindow', { 
                value: restoredTimeWindow
              });
              setTimeWindow(restoredTimeWindow);
            }
          }, 10); // Small delay to ensure other effects have completed
        }
      }
    }
  });


  return (
    <div style="position: relative; width: 100%; height: 100%;">
      <Show when={isLoading()}>
        <LoadingOverlay message="Loading map data..." containerStyle="transform: translateY(-100px);" />
      </Show>
      <Map objectName={props?.objectName} sourceMode={'single'} mapFilterScope="raceLegOnly" />
    </div>
  );
}
