import { onMount, Show, createEffect, createSignal } from "solid-js";
import { IoPlay, IoPause, IoChevronBack, IoChevronForward } from "solid-icons/io";
import { FiFastForward, FiRefreshCw } from "solid-icons/fi";

import { isPlaying, setIsPlaying, playbackSpeed, setPlaybackSpeed, selectedTime, setSelectedTime, initializeIsPlayingFollowEffect, setManeuverVideoResetTrigger, maneuverVideoStartOffsetSeconds, setManeuverVideoStartOffsetSeconds, releaseTimeControl } from "../../store/playbackStore";
import { selectedEvents } from "../../store/selectionStore";
import { tabledata } from "../../store/globalStore";

export interface ManeuverPlayPauseProps {
  position?: "bottom-left" | "bottom-bottom-left" | "top-right" | "videosync-bottom-left" | "inline-centered";
  allowFastFwd?: boolean;
}

const ManeuverPlayPauseComponent = (props: ManeuverPlayPauseProps) => {
  let containerRef: HTMLElement | undefined;

  const togglePlay = () => {
    if (isPlaying()) {
      setIsPlaying(false);
      return;
    }
    // Release maneuver-video control so playback can take over and advance selectedTime (fixes play button not incrementing in maneuver window).
    releaseTimeControl("maneuvers-video");
    setIsPlaying(true);
  };

  const handleReset = () => {
    const ids = selectedEvents();
    if (!Array.isArray(ids) || ids.length === 0) return;
    setIsPlaying(false);
    setDisplaySeconds(maneuverVideoStartOffsetSeconds());
    const firstId = ids[0];
    const table = tabledata();
    const tableArr = Array.isArray(table) ? table : [];
    const row = tableArr.find((r: { event_id?: number }) => r?.event_id === firstId) as Record<string, unknown> | undefined;
    const raw = row ? (row.datetime ?? row.Datetime ?? row.DATETIME ?? row.date ?? row.Date) as string | undefined : undefined;
    if (raw == null || (typeof raw === "string" && !raw.trim())) return;
    try {
      const maneuverDate = new Date(typeof raw === "string" ? raw.trim() : raw);
      if (Number.isNaN(maneuverDate.getTime())) return;
      const clipStartMs = maneuverDate.getTime() + maneuverVideoStartOffsetSeconds() * 1000;
      setSelectedTime(new Date(clipStartMs), "maneuvers-video", true);
      setManeuverVideoResetTrigger((t) => t + 1);
    } catch (_) {}
  };

  const INIT_TIME_TOLERANCE_SEC = 0.1;
  /** At init when display counter is within 0.1s of the start offset (for step-buttons visibility). Uses local display only. */
  const isAtInitTime = (): boolean => {
    const offset = maneuverVideoStartOffsetSeconds();
    return Math.abs(displaySeconds() - offset) <= INIT_TIME_TOLERANCE_SEC;
  };

  const getManeuverDate = (): Date | null => {
    const ids = selectedEvents();
    if (!Array.isArray(ids) || ids.length === 0) return null;
    const table = tabledata();
    const tableArr = Array.isArray(table) ? table : [];
    const row = tableArr.find((r: { event_id?: number }) => r?.event_id === ids[0]) as Record<string, unknown> | undefined;
    const raw = row ? (row.datetime ?? row.Datetime ?? row.DATETIME ?? row.date ?? row.Date) as string | undefined : undefined;
    if (raw == null || (typeof raw === "string" && !raw.trim())) return null;
    const d = new Date(typeof raw === "string" ? raw.trim() : raw);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  /** Left/right only adjust init time (start offset) in 5s intervals. No time stepping when not at init. */
  const handleStepLeft = () => {
    if (!isAtInitTime()) return;
    const maneuverDate = getManeuverDate();
    if (!maneuverDate) return;
    const newOffset = Math.max(-60, maneuverVideoStartOffsetSeconds() - 5);
    setManeuverVideoStartOffsetSeconds(newOffset);
    setDisplaySeconds(newOffset);
    const clipStartMs = maneuverDate.getTime() + newOffset * 1000;
    setSelectedTime(new Date(clipStartMs), "maneuvers-video", true);
    setManeuverVideoResetTrigger((t) => t + 1);
  };

  const handleStepRight = () => {
    if (!isAtInitTime()) return;
    const maneuverDate = getManeuverDate();
    if (!maneuverDate) return;
    const newOffset = Math.min(0, maneuverVideoStartOffsetSeconds() + 5);
    setManeuverVideoStartOffsetSeconds(newOffset);
    setDisplaySeconds(newOffset);
    const clipStartMs = maneuverDate.getTime() + newOffset * 1000;
    setSelectedTime(new Date(clipStartMs), "maneuvers-video", true);
    setManeuverVideoResetTrigger((t) => t + 1);
  };

  const toggleSpeed = () => {
    const speeds = [1, 2, 3, 4, 5, 6];
    const speedValue = typeof playbackSpeed() === "number" ? playbackSpeed() : 1;
    const currentIndex = speeds.indexOf(Number(speedValue) || 1);
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % speeds.length;
    setPlaybackSpeed(speeds[nextIndex]);
  };

  // Display-only counter: maneuver page owns it. -15 to unbounded, 0.1s steps, 1 real second = 1 second at 1x. No store.
  const DISPLAY_MIN_SEC = -15;
  const DISPLAY_UPDATE_MS = 100;

  const [displaySeconds, setDisplaySeconds] = createSignal(DISPLAY_MIN_SEC);
  let displayIntervalId: ReturnType<typeof setInterval> | null = null;

  createEffect(() => {
    const playing = isPlaying();
    const ids = selectedEvents();
    const hasEvents = Array.isArray(ids) && ids.length > 0;

    if (displayIntervalId != null) {
      clearInterval(displayIntervalId);
      displayIntervalId = null;
    }

    if (!hasEvents) {
      setDisplaySeconds(DISPLAY_MIN_SEC);
      return;
    }
    if (!playing) {
      // Keep current display value when pausing; do not overwrite with store (store can be out of sync on maneuver page).
      return;
    }
    let anchorDisplaySeconds = displaySeconds();
    let anchorRealTimeMs = Date.now();
    let lastSpeed = playbackSpeed();
    displayIntervalId = setInterval(() => {
      const speed = playbackSpeed();
      if (speed !== lastSpeed) {
        anchorDisplaySeconds = displaySeconds();
        anchorRealTimeMs = Date.now();
        lastSpeed = speed;
      }
      const elapsedRealSec = (Date.now() - anchorRealTimeMs) / 1000;
      const next = Math.max(DISPLAY_MIN_SEC, anchorDisplaySeconds + elapsedRealSec * speed);
      setDisplaySeconds(next);
    }, DISPLAY_UPDATE_MS);
    return () => {
      if (displayIntervalId != null) {
        clearInterval(displayIntervalId);
        displayIntervalId = null;
      }
    };
  });

  const formatElapsedDisplay = (): string => {
    const countdownStartSec = Math.abs(maneuverVideoStartOffsetSeconds());
    const initDisplay = `-${countdownStartSec.toFixed(1)}s`;
    const ids = selectedEvents();
    if (!Array.isArray(ids) || ids.length === 0) return initDisplay;
    const sec = displaySeconds();
    return `${Math.max(DISPLAY_MIN_SEC, sec).toFixed(1)}s`;
  };

  const isInlineCentered = () => props.position === "inline-centered";

  function makeDraggable(el: HTMLElement | null) {
    if (!el || isInlineCentered()) return;
    containerRef = el;
    if (el.style.left === "" && el.style.top === "") {
      const isInSplitView = () => {
        if (document.querySelector(".split-view-content")) return true;
        if (el.closest(".split-panel")) return true;
        const parent = el.closest(".map-container");
        return !!(parent?.parentElement?.classList.contains("split-panel"));
      };
      if (isInSplitView()) {
        el.style.left = "calc(20% + 20px)";
        el.style.top = "75%";
      }
    }
    el.addEventListener("mousedown", (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest("button")) return;
      const offsetX = event.clientX - el.offsetLeft;
      const offsetY = event.clientY - el.offsetTop;
      function onMouseMove(moveEvent: MouseEvent) {
        el.style.left = `${moveEvent.clientX - offsetX}px`;
        el.style.top = `${moveEvent.clientY - offsetY}px`;
        if (el.style.bottom) el.style.bottom = "auto";
      }
      function onMouseUp() {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      }
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      event.preventDefault();
    });
  }

  onMount(() => {
    makeDraggable(containerRef);
    try {
      initializeIsPlayingFollowEffect();
    } catch {}
  });

  return (
    <div
      ref={el => (containerRef = el as HTMLElement)}
      class={`play-pause-container${isInlineCentered() ? " maneuver-video-inline" : ""}`}
    >
      <Show when={isAtInitTime()}>
        <button type="button" onClick={handleStepLeft} onContextMenu={(e) => e.preventDefault()} class="play-pause-button" title="Decrease start offset (5s)" aria-label="Decrease start offset (5s)">
          <IoChevronBack />
        </button>
      </Show>
      <button type="button" onClick={handleReset} onContextMenu={(e) => e.preventDefault()} class="play-pause-button" title="Reset to maneuver start time" aria-label="Reset to start">
        <FiRefreshCw />
      </button>
      <button onClick={togglePlay} onContextMenu={(e) => e.preventDefault()} class="play-pause-button">
        {isPlaying() ? <IoPause /> : <IoPlay />}
      </button>
      <div class="time-display maneuver-elapsed-display">{formatElapsedDisplay()}</div>
      {props.allowFastFwd !== false && (
        <button onClick={toggleSpeed} onContextMenu={(e) => e.preventDefault()} class="fast-forward-button">
          <FiFastForward />
          <span class="speed-label">{playbackSpeed() !== undefined ? `${playbackSpeed()}x` : ""}</span>
        </button>
      )}
      <Show when={isAtInitTime()}>
        <button type="button" onClick={handleStepRight} onContextMenu={(e) => e.preventDefault()} class="play-pause-button" title="Increase start offset (5s)" aria-label="Increase start offset (5s)">
          <IoChevronForward />
        </button>
      </Show>
    </div>
  );
};

export default ManeuverPlayPauseComponent;
