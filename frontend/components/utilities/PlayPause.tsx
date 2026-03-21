import { onMount, Show, createEffect } from "solid-js";
import { IoPlay, IoPause } from "solid-icons/io";
import { FiFastForward, FiClock } from "solid-icons/fi";

import { selectedTime, isPlaying, setIsPlaying, playbackSpeed, setPlaybackSpeed, timeWindow, setTimeWindow, initializeIsPlayingFollowEffect, videoTime } from "../../store/playbackStore";
import { selectedRange, setSelectedRange, setHasSelection, clearSelection } from "../../store/selectionStore";
import { getCurrentDatasetTimezone } from "../../store/datasetTimezoneStore";

export interface PlayPauseComponentProps {
  position?: "bottom-left" | "bottom-bottom-left" | "top-right" | "videosync-bottom-left" | "bottom-center" | "map-area-bottom" | "timeline-top" | "timeline-overlay" | "page-bottom-center";
  allowFastFwd?: boolean;
  allowTimeWindow?: boolean;
  /** When true, time-window control never shows or uses "Full" (0); default is 1 min. */
  hideFullTimeWindow?: boolean;
}

const PlayPauseComponent = (props: PlayPauseComponentProps) => {
  let containerRef: HTMLElement | undefined;

  const togglePlay = () => {
    const newState = !isPlaying();
    setIsPlaying(newState);
  };

  const toggleSpeed = () => {
    // Speed options: 1x, 2x, 3x, 4x, 5x, 6x (cycles back to 1x)
    // 1x = 1 second per second, 2x = 2 seconds per 1 second, etc.
    const speeds = [1, 2, 3, 4, 5, 6];
    
    const speedValue = typeof playbackSpeed() === "number" ? playbackSpeed() : 1;
    const currentIndex = speeds.indexOf(Number(speedValue) || 1);
    
    // If current speed is not in the available speeds, reset to 1x, otherwise cycle to next speed
    let nextIndex: number;
    if (currentIndex === -1) {
      // Current speed not in list - reset to 1x
      nextIndex = 0;
    } else {
      // Cycle to next speed
      nextIndex = (currentIndex + 1) % speeds.length;
    }
    
    setPlaybackSpeed(speeds[nextIndex]);
  };

  const toggleTimeWindow = () => {
    const timeWindows = props.hideFullTimeWindow ? [0.5, 1, 2, 5, 15, 30] : [0.5, 1, 2, 5, 15, 30, 0]; // 0 = full (omit when hideFullTimeWindow)
    const currentWindow = typeof timeWindow() === "number" ? timeWindow() : 0;
    const currentIndex = timeWindows.indexOf(Number(currentWindow) || 0);
    const range = selectedRange && typeof selectedRange === 'function' ? selectedRange() : [];
    const hasBrush = Array.isArray(range) && range.length > 0;
    // If current index not found, start from beginning (0.5 = 30 seconds)
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % timeWindows.length;
    const nextWindowMin = (hasBrush && currentWindow === 0) ? 0.5 : timeWindows[nextIndex];

    // Special case: when a brush exists and current window is Full (0), we jump straight to 30sec
    // and perform updates in an order that avoids a transient "Full" label flash.
    if (hasBrush && currentWindow === 0) {
      try {
        // Switch directly to 30sec timewindow and clear any selection
        setTimeWindow(0.5);
        clearSelection();
        // Clear only brush visuals (defensive) on next tick
        setTimeout(() => {
          try { if ((window as any).clearTimeSeriesBrush) (window as any).clearTimeSeriesBrush(); } catch {}
          try { if ((window as any).clearMapBrush) (window as any).clearMapBrush(); } catch {}
        }, 0);
        return;
      } catch (_) {}
    }

    const valueToSet = props.hideFullTimeWindow && currentWindow === 0 ? 1 : nextWindowMin;
    setTimeWindow(valueToSet);

    try {
      if (hasBrush && nextWindowMin > 0) {
        // Entering timewindow from an existing brush: clear selection and brush UI
        clearSelection();
        try { if ((window as any).clearTimeSeriesBrush) (window as any).clearTimeSeriesBrush(); } catch {}
        try { if ((window as any).clearMapBrush) (window as any).clearMapBrush(); } catch {}
      }

      if (hasBrush && nextWindowMin === 0) {
        clearSelection();
      }
    } catch (_) {}
  };

  function makeDraggable(el: HTMLElement | null) {
    if (!el) return;
    containerRef = el;

    // bottom-center / map-area-bottom / timeline-top / timeline-overlay / page-bottom-center: positioned by CSS; no drag.
    if (props.position === "bottom-center" || props.position === "map-area-bottom" || props.position === "timeline-top" || props.position === "timeline-overlay" || props.position === "page-bottom-center") {
      el.style.position = "";
      el.style.left = "";
      el.style.top = "";
      el.style.right = "";
      el.style.bottom = "";
      el.style.transform = "";
      el.style.zIndex = "";
      return;
    }

    // Only keep dynamic positioning logic, static styles are in CSS
    if (el.style.left === "" && el.style.top === "") {
      // Check if we're in split view by looking for split-view-content in the DOM
      // Use a more reliable method that checks multiple indicators
      const isInSplitView = () => {
        // Check for split view container
        const splitViewContent = document.querySelector('.split-view-content');
        if (splitViewContent) return true;
        
        // Check if we're inside a split panel
        const splitPanel = el.closest('.split-panel');
        if (splitPanel) return true;
        
        // Check if the parent container has split view classes
        const parentContainer = el.closest('.map-container');
        if (parentContainer && parentContainer.parentElement?.classList.contains('split-panel')) {
          return true;
        }
        
        return false;
      };
      
      const inSplitView = isInSplitView();
      
      if (inSplitView) {
        // In split view, keep fixed positioning but adjust coordinates
        el.style.position = 'fixed';
        el.style.zIndex = '100000';
      }
      
      if (props.position === "bottom-left") {
        if (inSplitView) {
          // In split view, position relative to viewport
          el.style.left = "100px";
          el.style.top = "calc(100vh - 250px)";
        } else {
          el.style.left = "20%";
          el.style.top = "75%";
        }
      } else if (props.position === "bottom-bottom-left") {
        if (inSplitView) {
          el.style.left = "10px";
          el.style.top = "calc(100vh - 70px)";
        } else {
          el.style.left = "2%";
          el.style.top = "92%";
        }
      } else if (props.position === "top-right") {
        if (inSplitView) {
          el.style.left = "calc(100vw - 400px)";
          el.style.top = "10px";
        } else {
          el.style.left = "75%";
          el.style.top = "10%";
        }
      } else if (props.position === "videosync-bottom-left") {
        // VideoSync specific positioning: 20px from left, 20px from bottom
        el.style.position = 'fixed';
        el.style.left = "20px";
        el.style.bottom = "20px";
        el.style.top = "auto";
        el.style.zIndex = '100000';
      } else {
        if (inSplitView) {
          el.style.left = "calc(100vw - 400px)";
          el.style.top = "calc(100vh - 100px)";
        } else {
          el.style.left = "20%";
          el.style.top = "75%";
        }
      }
    }

    el.addEventListener("mousedown", (event: MouseEvent) => {
      // Only handle drag if clicking on the container itself, not on buttons
      if (
        event.target === el ||
        (event.target as HTMLElement).classList.contains("time-display")
      ) {
        // Convert bottom positioning to top positioning for dragging
        if (el.style.bottom && el.style.top === "auto") {
          const rect = el.getBoundingClientRect();
          el.style.top = `${window.innerHeight - rect.bottom}px`;
          el.style.bottom = "auto";
        }
        
        const offsetX = event.clientX - el.offsetLeft;
        const offsetY = event.clientY - el.offsetTop;

        function onMouseMove(moveEvent: MouseEvent) {
          el.style.left = `${moveEvent.clientX - offsetX}px`;
          el.style.top = `${moveEvent.clientY - offsetY}px`;
          // Ensure bottom is cleared when dragging
          if (el.style.bottom) {
            el.style.bottom = "auto";
          }
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

  // Format the time for display
  const formatTimeDisplay = () => {
    try { 
      const time = selectedTime();
      const timezone = getCurrentDatasetTimezone();

      const options: Intl.DateTimeFormatOptions = {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 1,
        hour12: false,
        timeZone: timezone || undefined,
      };

      return new Intl.DateTimeFormat('en-US', options).format(time);
    } catch {
      return "Invalid Time"
    }
  };

  // When Full is hidden (e.g. fleet map no-races), normalize 0 to 1 min so we never show "Full".
  createEffect(() => {
    if (props.hideFullTimeWindow && timeWindow() === 0) {
      setTimeWindow(1);
    }
  });

  // Format the time window for display
  const formatTimeWindowDisplay = () => {
    const range = selectedRange && typeof selectedRange === 'function' ? selectedRange() : [];
    const window = timeWindow();
    if (window === 0 && Array.isArray(range) && range.length > 0) {
      return "Brush";
    }
    if (window === 0) {
      return props.hideFullTimeWindow ? "1min" : "Full";
    } else if (window === 0.5) {
      return "30sec";
    } else if (window === 1) {
      return "1min";
    } else {
      return `${window}min`;
    }
  };

  // Strict boolean so UI never sees undefined (avoids wrong/missing icon on first load when sync hydrates late on Chrome/macOS)
  const playing = () => isPlaying() === true;

  onMount(() => {
    // Ensure the component is draggable after mount
    makeDraggable(containerRef);
    // Initialize isPlaying follow effect from a Solid root
    try { initializeIsPlayingFollowEffect(); } catch {}
  });

  return (
    <div
      ref={el => (containerRef = el as HTMLElement)}
      class={`play-pause-container${props.position === "bottom-center" ? " position-bottom-center" : ""}${props.position === "map-area-bottom" ? " map-area-bottom" : ""}${props.position === "timeline-top" ? " position-timeline-top" : ""}${props.position === "timeline-overlay" ? " position-timeline-overlay" : ""}${props.position === "page-bottom-center" ? " position-page-bottom-center" : ""}`}
    >
      <button onClick={togglePlay} onContextMenu={(e) => e.preventDefault()} class="play-pause-button" aria-label={playing() ? "Pause" : "Play"}>
        <span class="play-pause-icon-wrap">
          <span classList={{ "play-pause-icon-visible": !playing(), "play-pause-icon-hidden": playing() }} aria-hidden={playing()}>
            <IoPlay />
          </span>
          <span classList={{ "play-pause-icon-visible": playing(), "play-pause-icon-hidden": !playing() }} aria-hidden={!playing()}>
            <IoPause />
          </span>
        </span>
      </button>

      <div class="time-display">{formatTimeDisplay()}</div>

      <Show when={props.allowFastFwd}>
        <button onClick={toggleSpeed} onContextMenu={(e) => e.preventDefault()} class="fast-forward-button">
          <FiFastForward />
          <span class="speed-label">
            {playbackSpeed() !== undefined ? `${playbackSpeed()}x` : ""}
          </span>
        </button>
      </Show>

      <Show when={props.allowTimeWindow}>
        <button onClick={toggleTimeWindow} onContextMenu={(e) => e.preventDefault()} class="time-window-button">
          <FiClock />
          <span class="time-window-label">
            {formatTimeWindowDisplay()}
          </span>
        </button>
      </Show>
    </div>
  );
};

export default PlayPauseComponent;

