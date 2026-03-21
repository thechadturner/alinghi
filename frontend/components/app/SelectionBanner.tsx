import { Show, createMemo, createSignal, onCleanup, createEffect } from "solid-js";
import { BiRegularCut } from "solid-icons/bi";
import { FiXCircle, FiEyeOff } from "solid-icons/fi";

import { hasSelection, isCut, selectedRange, selectedRanges, selectedGroupKeys, clearSelection, cutSelection, hideSelectedEvents, selectedEvents, cutEvents } from "../../store/selectionStore";
import { selectedFilters } from "../../store/filterStore";
import { log, error as logError } from "../../utils/console";

export default function SelectionBanner() {
  // Add state to track button disabled status
  const [isButtonDisabled, setIsButtonDisabled] = createSignal(false);
  let buttonDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let containerRef: HTMLDivElement | null = null;
  let isDraggable = false;

  // Debounced handler for the Clear button
  const handleClear = (event?: MouseEvent) => {
    if (event) {
      event.stopPropagation(); // Prevent drag from starting
    }
    if (isButtonDisabled()) return;
    
    log('🧹 SelectionBanner: Clear button clicked');
    setIsButtonDisabled(true);

    clearSelection();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("selection-banner-cleared"));
    }

    buttonDebounceTimer = setTimeout(() => {
      setIsButtonDisabled(false);
    }, 500); // Re-enable after 500ms
  };

  // Debounced handler for the Cut button
  const handleCut = (event?: MouseEvent) => {
    if (event) {
      event.stopPropagation(); // Prevent drag from starting
    }
    if (isButtonDisabled()) return;
    
    setIsButtonDisabled(true);

    cutSelection();
    
    buttonDebounceTimer = setTimeout(() => {
      setIsButtonDisabled(false);
    }, 500); // Re-enable after 500ms
  };

  // Debounced handler for the Hide button (move selected events to hidden list, then clear selection)
  const handleHide = (event?: MouseEvent) => {
    if (event) {
      event.stopPropagation(); // Prevent drag from starting
    }
    if (isButtonDisabled()) return;
    
    setIsButtonDisabled(true);

    hideSelectedEvents();
    
    buttonDebounceTimer = setTimeout(() => {
      setIsButtonDisabled(false);
    }, 500); // Re-enable after 500ms
  };

  // Clean up timer when component unmounts
  onCleanup(() => {
    if (buttonDebounceTimer) {
      clearTimeout(buttonDebounceTimer);
    }
  });

  // Make the banner draggable
  function makeDraggable(el: HTMLDivElement) {
    if (!el || isDraggable) return;
    containerRef = el;
    isDraggable = true;

    // Set initial position if not already set
    if (el.style.left === "" && el.style.top === "") {
      // Check if we're in split view
      const isInSplitView = () => {
        const splitViewContent = document.querySelector('.split-view-content');
        if (splitViewContent) return true;
        const splitPanel = el.closest('.split-panel');
        if (splitPanel) return true;
        const parentContainer = el.closest('#main-content');
        if (parentContainer && (parentContainer.parentElement as HTMLElement)?.classList.contains('split-panel')) {
          return true;
        }
        return false;
      };
      
      const inSplitView = isInSplitView();
      
      if (inSplitView) {
        el.style.position = 'fixed';
        el.style.zIndex = '1000';
        el.style.left = '50%';
        el.style.top = '10px';
        el.style.transform = 'translateX(-50%)';
      } else {
        // Default position: top-center
        el.style.position = 'fixed';
        el.style.zIndex = '1000';
        el.style.left = '50%';
        el.style.top = '10px';
        el.style.transform = 'translateX(-50%)';
      }
    }

    el.addEventListener("mousedown", (event: MouseEvent) => {
      // Only handle drag if clicking on the container itself or the message area, not on buttons
      const target = event.target as HTMLElement;
      
      // Don't drag if clicking on buttons or inside button container
      if (
        target.tagName === 'BUTTON' ||
        target.closest('button') ||
        target.closest('.flex.items-center.space-x-2') // Button container
      ) {
        return; // Don't start drag on button clicks
      }
      
      // Only handle drag if clicking on the container itself or the message area
      if (
        target === el ||
        target.closest('.flex.items-center.flex-1') ||
        target.tagName === 'P' ||
        target.tagName === 'svg'
      ) {
        // Make sure we're using fixed positioning for dragging
        if (el.style.position !== 'fixed') {
          el.style.position = 'fixed';
        }
        
        // Remove transform during drag for accurate positioning
        const currentLeft = el.style.left;
        const currentTop = el.style.top;
        let currentX = 0;
        let currentY = 0;
        
        if (currentLeft && currentTop) {
          // Parse current position
          if (currentLeft.includes('%')) {
            currentX = (parseFloat(currentLeft) / 100) * window.innerWidth;
          } else {
            currentX = parseFloat(currentLeft) || 0;
          }
          if (currentTop.includes('%')) {
            currentY = (parseFloat(currentTop) / 100) * window.innerHeight;
          } else {
            currentY = parseFloat(currentTop) || 0;
          }
        }
        
        const offsetX = event.clientX - currentX;
        const offsetY = event.clientY - currentY;

        function onMouseMove(moveEvent: MouseEvent) {
          const newX = moveEvent.clientX - offsetX;
          const newY = moveEvent.clientY - offsetY;
          
          // Keep banner within viewport bounds
          const maxX = window.innerWidth - el.offsetWidth;
          const maxY = window.innerHeight - el.offsetHeight;
          
          el.style.left = `${Math.max(0, Math.min(newX, maxX))}px`;
          el.style.top = `${Math.max(0, Math.min(newY, maxY))}px`;
          el.style.transform = 'none'; // Remove transform during drag
        }

        function onMouseUp() {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
        }

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);

        // Prevent text selection during drag
        event.preventDefault();
      }
    });
  }

  // Make the banner draggable when the ref is available
  createEffect(() => {
    if (containerRef) {
      makeDraggable(containerRef);
    }
  });

  // Chart filters state is now managed globally by individual pages
  // No need for local checking here

  const message = createMemo(() => {
    const groupKeys = selectedGroupKeys();
    if (!hasSelection() && !isCut() && selectedFilters().length === 0 && selectedEvents().length === 0 && groupKeys.length === 0) return "";
    
    const rangeItems = selectedRange();
    const rangesItems = selectedRanges();
    const cutItems = cutEvents();
    const eventItems = selectedEvents();
    const filterItems = selectedFilters();
    
    // Hierarchical display: Active selection > Cut data > Filters
    // Check if we're in cut mode (cuts exist) - this affects message display
    const isInCutMode = isCut() && cutItems && cutItems.length > 0;
    
    if (hasSelection() && rangesItems && rangesItems.length > 0) {
      // Active selection ranges (new unified approach)
      if (rangesItems.length > 1) {
        return `selected ranges`;
      } else {
        return `selected range`;
      }
    } else if (hasSelection() && rangeItems && rangeItems.length > 0) {
      // Active selection range (backward compatibility)
      return `selected range`;
    } else if (hasSelection() && groupKeys.length > 0) {
      // Group selection (grouped maneuver timeseries/table/map)
      return groupKeys.length > 1 ? `selections` : `selection`;
    } else if (hasSelection() && eventItems && eventItems.length > 0) {
      // Active selection events
      if (eventItems.length > 1) {
        return `selected events`;
      } else {
        return `selected event`;
      }
    } else if (eventItems && eventItems.length > 0) {
      // Events selected but no active selection (e.g., from performance page)
      if (eventItems.length > 1) {
        return `selected events`;
      } else {
        return `selected event`;
      }
    } else if (isCut() && cutItems && cutItems.length > 0) {
      // Cut data (no active selection)
      // Check if this is a time range (has start_time/end_time) or event IDs
      const firstCutItem = cutItems[0];
      
      if (firstCutItem.start_time && firstCutItem.end_time) {
        // Cut time ranges - handle multiple ranges
        if (cutItems.length > 1) {
          return `cut ranges`;
        } else {
          return `cut range`;
        }
      } else if (firstCutItem.event_id) {
        // Cut events (legacy format - shouldn't happen with the fix)
        if (cutItems.length > 1) {
          return `cut events`;
        } else {
          return `cut event`;
        }
      }
      return `cut data`;
    } else if (filterItems && filterItems.length > 0) {
      // Normal filter display
      if (filterItems.length > 1) {
        return `Filters applied: ${filterItems.join(', ')}`;
      } else {
        return `Filter applied: ${filterItems[0]}`;
      }
    }
    
    return "";
  });

  // Determine banner color based on filter state
  const bannerColor = createMemo(() => {
    // Default green for all cases
    return "bg-green-500";
  });

  return (
    <Show when={hasSelection() || isCut() || selectedFilters().length > 0 || selectedEvents().length > 0 || selectedGroupKeys().length > 0}>
      <div 
        ref={el => (containerRef = el)}
        class={`selection_banner ${bannerColor()} text-white text-sm font-bold px-4 py-3 rounded-lg shadow-lg`} 
        role="alert"
        style={{ cursor: 'move' }}
      >
        <div class="flex items-center justify-between w-full">
          <div class="flex items-center flex-1 min-w-0 hidden lg:flex">
            <svg class="fill-current w-4 h-4 mr-2 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
              <path d="M12.432 0c1.34 0 2.01.912 2.01 1.957 0 1.305-1.164 2.512-2.679 2.512-1.269 0-2.009-.75-1.974-1.99C9.789 1.436 10.67 0 12.432 0zM8.309 20c-1.058 0-1.833-.652-1.093-3.524l1.214-5.092c.211-.814.246-1.141 0-1.141-.317 0-1.689.562-2.502 1.117l-.528-.88c2.572-2.186 5.531-3.467 6.801-3.467 1.057 0 1.233 1.273.705 3.23l-1.391 5.352c-.246.945-.141 1.271.106 1.271.317 0 1.357-.392 2.379-1.207l.6.814C12.098 19.02 9.365 20 8.309 20z"/>
            </svg>
            <p class="truncate">{message()}</p>
          </div>

          <div class="flex items-center space-x-2 flex-shrink-0 ml-2">
            <button 
              onClick={handleClear} 
              class="selection-tools-button" 
              title="Clear Selection"
              disabled={isButtonDisabled()}
              style={isButtonDisabled() ? { opacity: '0.7' } : {}}
            >
              <FiXCircle />
            </button>

            <Show when={selectedEvents()?.length > 0}>
              <button 
                onClick={handleHide} 
                class="selection-tools-button" 
                title="Hide selected events"
                disabled={isButtonDisabled()}
                style={isButtonDisabled() ? { opacity: '0.7' } : {}}
              >
                <FiEyeOff />
              </button>
            </Show>
            <Show when={hasSelection() && (selectedEvents()?.length > 0 || selectedRange()?.length > 0)}>
              <button 
                onClick={handleCut} 
                class="selection-tools-button" 
                title="Cut Selection"
                disabled={isButtonDisabled()}
                style={isButtonDisabled() ? { opacity: '0.7' } : {}}
              >
                <BiRegularCut />
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
