import { createSignal, createEffect, Show } from "solid-js";
import { debug as logDebug, warn as logWarn, error as logError, info as logInfo } from "../../utils/console";
import { persistantStore } from "../../store/persistantStore";
import { selectedTime } from "../../store/playbackStore";
import { formatDateTime, getTimezoneForDate } from "../../utils/global";

interface MediaSource {
  id: string;
  name?: string;
}

interface MediaWindow {
  id?: string | number;
  start: Date;
  end: Date;
  fileName?: string;
  sourceId?: string;
  /** IANA timezone for this media (from media.timezone). Used for known-time local → UTC conversion. */
  timezone?: string | null;
}

export interface VideoSyncHelperProps {
  mediaSource?: MediaSource | null;
  mediaWindows?: MediaWindow[];
  selectedWindows?: MediaWindow[];
  /** Dataset timezone for the media date (e.g. Pacific/Auckland). When set, known time is interpreted as data local, not browser local. */
  datasetTimezone?: string | null;
  /** Media date YYYYMMDD for timezone context. Used with datasetTimezone for parsing/display. */
  mediaDateYmd?: string | null;
  onUpdateComplete?: () => void;
  onTimelineRefresh?: () => void;
  /** When set, "Sync all sources" is shown; called with computed offsetMs after user triggers sync-all (parent should confirm then apply to all windows). */
  onSyncAllSourcesRequest?: (offsetMs: number) => void;
}

export default function VideoSyncHelper(props: VideoSyncHelperProps) {
  // Form state
  const [knownTime, setKnownTime] = createSignal("");
  const [knownTimeMode, setKnownTimeMode] = createSignal<'utc' | 'local'>('local');
  const [offsetSeconds, setOffsetSeconds] = createSignal("");
  const [isKnownTimeDisabled, setIsKnownTimeDisabled] = createSignal(false);
  const [isOffsetDisabled, setIsOffsetDisabled] = createSignal(false);
  const [isApplyEnabled, setIsApplyEnabled] = createSignal(false);
  const [isApplying, setIsApplying] = createSignal(false);
  const [isExpanded, setIsExpanded] = createSignal(false);
  /** When set, Apply was blocked (e.g. local mode but no timezone); show under Apply button. */
  const [applyBlockedMessage, setApplyBlockedMessage] = createSignal<string | null>(null);

  // Media source and windows from props
  const mediaSource = () => props.mediaSource || null;
  const mediaWindows = () => {
    const windows = props.mediaWindows || [];
    logInfo("VideoSyncHelper: mediaWindows", { 
      sourceId: mediaSource()?.id, 
      windowsCount: windows.length,
      windows: windows.map(w => ({ id: w.id, fileName: w.fileName, sourceId: w.sourceId }))
    });
    return windows;
  };
  const selectedWindows = () => {
    const selected = props.selectedWindows || [];
    logDebug("VideoSyncHelper: selectedWindows", { 
      sourceId: mediaSource()?.id, 
      selectedCount: selected.length,
      selected: selected.map(w => ({ id: w.id, fileName: w.fileName }))
    });
    return selected;
  };

  // Format date for input (YYYY-MM-DDTHH:MM:SS or with .sss for milliseconds) in browser local time
  const formatDateForInput = (date: Date | null, includeMs = true): string => {
    if (!date || !(date instanceof Date)) return "";
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    const timePart = includeMs ? `${hours}:${minutes}:${seconds}.${ms}` : `${hours}:${minutes}:${seconds}`;
    return `${year}-${month}-${day}T${timePart}`;
  };

  // Format UTC date for datetime-local input (seconds precision; milliseconds when supported). When mode is UTC show in UTC; when Local show in dataset timezone (or browser local).
  const formatKnownTimeForInput = (utcDate: Date | null, includeMs = true): string => {
    if (!utcDate || !(utcDate instanceof Date)) return "";
    if (knownTimeMode() === 'utc') {
      const y = utcDate.getUTCFullYear();
      const m = String(utcDate.getUTCMonth() + 1).padStart(2, "0");
      const d = String(utcDate.getUTCDate()).padStart(2, "0");
      const h = String(utcDate.getUTCHours()).padStart(2, "0");
      const min = String(utcDate.getUTCMinutes()).padStart(2, "0");
      const s = String(utcDate.getUTCSeconds()).padStart(2, "0");
      const ms = String(utcDate.getUTCMilliseconds()).padStart(3, "0");
      const timePart = includeMs ? `${h}:${min}:${s}.${ms}` : `${h}:${min}:${s}`;
      return `${y}-${m}-${d}T${timePart}`;
    }
    const tz = props.datasetTimezone;
    const ymd = props.mediaDateYmd;
    if (tz && ymd && String(ymd).trim().length >= 8) {
      const formatted = formatDateTime(utcDate, tz);
      if (formatted) {
        const withT = formatted.replace(" ", "T");
        if (includeMs && !withT.includes(".")) {
          const ms = String(utcDate.getUTCMilliseconds()).padStart(3, "0");
          return `${withT}.${ms}`;
        }
        return withT;
      }
    }
    return formatDateForInput(utcDate, includeMs);
  };

  // Handle known time input change
  const handleKnownTimeChange = (event: Event) => {
    const value = (event.target as HTMLInputElement).value;
    setKnownTime(value);
    
    if (value.trim()) {
      setIsOffsetDisabled(true);
      setIsKnownTimeDisabled(false);
    } else {
      setIsOffsetDisabled(false);
    }
    
    updateApplyButtonState();
  };

  // Handle offset input change
  const handleOffsetChange = (event: Event) => {
    const value = (event.target as HTMLInputElement).value;
    setOffsetSeconds(value);
    
    if (value.trim()) {
      setIsKnownTimeDisabled(true);
      setIsOffsetDisabled(false);
    } else {
      setIsKnownTimeDisabled(false);
    }
    
    updateApplyButtonState();
  };

  // Update apply button state
  const updateApplyButtonState = () => {
    const hasKnownTime = knownTime().trim() !== "";
    const hasOffset = offsetSeconds().trim() !== "";
    setIsApplyEnabled(hasKnownTime || hasOffset);
  };

  /** Normalize known time input to YYYY-MM-DDTHH:mm:ss for API (handles DD/MM/YYYY from locale). */
  const normalizeKnownTimeForApi = (raw: string): string => {
    const s = raw.trim();
    const sep = s.indexOf("T") >= 0 ? "T" : s.indexOf(" ") >= 0 ? " " : null;
    const idx = sep ? s.indexOf(sep) : -1;
    let datePart = idx >= 0 ? s.slice(0, idx) : s.slice(0, 10);
    let timePart = idx >= 0 ? s.slice(idx + 1) : "00:00:00";
    datePart = datePart.replace(/\//g, "-").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      // already YYYY-MM-DD
    } else if (/^\d{2}-\d{2}-\d{4}$/.test(datePart)) {
      const [d, m, y] = datePart.split("-");
      datePart = `${y}-${m}-${d}`;
    } else if (datePart.length >= 8 && /^\d+$/.test(datePart.replace(/-/g, ""))) {
      const n = datePart.replace(/-/g, "").slice(0, 8);
      if (n.length === 8) datePart = `${n.slice(0, 4)}-${n.slice(4, 6)}-${n.slice(6, 8)}`;
    }
    const parts = timePart.split(":");
    if (parts.length === 2) timePart = `${parts[0]}:${parts[1]}:00`;
    else if (parts.length === 1) timePart = `${parts[0]}:00:00`;
    return `${datePart}T${timePart}`;
  };

  /** Call backend to convert local datetime in timezone to UTC (single source of truth for sync). */
  const fetchConvertLocalToUtc = async (localDatetime: string, timezone: string): Promise<string | null> => {
    const getCookie = (name: string): string => {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop()?.split(";").shift() ?? "";
      return "";
    };
    const csrfToken = getCookie("csrf_token") || "";
    const res = await fetch("/api/admin/media/convert-local-to-utc", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ local_datetime: localDatetime, timezone }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logWarn("VideoSyncHelper: convert-local-to-utc failed", { status: res.status, text });
      return null;
    }
    const data = await res.json().catch(() => null);
    const utc = data?.data?.utc ?? data?.utc;
    return typeof utc === "string" ? utc : null;
  };

  // Parse known time to UTC for offset calculation (UTC mode only; local mode uses backend).
  const parseKnownTimeToUtcWith = (inputValue: string, _overrideTz?: string | null, _overrideDateYmd?: string | null): Date | null => {
    const raw = inputValue.trim();
    if (!raw) return null;
    if (knownTimeMode() === "utc") {
      const s = raw.indexOf("T") >= 0 ? raw : `${raw.slice(0, 10)}T00:00:00`;
      const hasOffset = /Z$/i.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
      const iso = hasOffset ? s.replace(/\s/g, "T") : `${s.replace(/\s/g, "T")}Z`;
      const utcDate = new Date(iso);
      return isNaN(utcDate.getTime()) ? null : utcDate;
    }
    // Local mode: conversion is done via backend in handleApply. Never use browser local here.
    return null;
  };

  // Calculate time offset based on known time vs selectedTime. Optional overrides for tz/date when props not set yet.
  const calculateTimeOffset = (overrideTz?: string | null, overrideDateYmd?: string | null): number | null => {
    const knownTimeValue = knownTime().trim();
    const offsetValue = offsetSeconds().trim();
    
    logInfo("VideoSyncHelper: calculateTimeOffset called", {
      knownTimeValue,
      offsetValue,
      hasKnownTime: !!knownTimeValue,
      hasOffset: !!offsetValue,
      overrideTz: !!overrideTz,
      overrideDateYmd: !!overrideDateYmd
    });
    
    if (offsetValue) {
      // Direct offset in seconds
      const offset = parseFloat(offsetValue);
      if (isNaN(offset)) {
        logWarn("VideoSyncHelper: Invalid offset value", offsetValue);
        return null;
      }
      const offsetMs = offset * 1000; // Convert to milliseconds
      logInfo("VideoSyncHelper: Using direct offset", {
        offsetSeconds: offset,
        offsetMs
      });
      return offsetMs;
    }
    
    if (knownTimeValue) {
      // Parse known time as dataset local when timezone/date available (props or override), else browser local
      const knownTimeUtc = parseKnownTimeToUtcWith(knownTimeValue, overrideTz, overrideDateYmd);
      const currentSelectedTime = selectedTime();
      
      if (!knownTimeUtc) {
        logWarn("VideoSyncHelper: Invalid known time format", knownTimeValue);
        return null;
      }
      
      if (!currentSelectedTime) {
        logWarn("VideoSyncHelper: No selectedTime available for comparison");
        return null;
      }
      
      const offset = knownTimeUtc.getTime() - currentSelectedTime.getTime();
      
      logInfo("VideoSyncHelper: Calculated offset from known time", {
        knownTimeUtc: knownTimeUtc.toISOString(),
        selectedTime: currentSelectedTime.toISOString(),
        offsetMs: offset,
        offsetSeconds: offset / 1000
      });
      
      return offset;
    }
    
    logWarn("VideoSyncHelper: No offset or known time provided");
    return null;
  };

  /** Compute offset from known time/offset inputs (same validation as handleApply). Returns null if validation fails. */
  const computeOffsetForApply = async (): Promise<number | null> => {
    setApplyBlockedMessage(null);
    logInfo("VideoSyncHelper: computeOffsetForApply", {
      knownTime: knownTime().trim(),
      offsetSeconds: offsetSeconds().trim()
    });
    let effectiveTz: string | null = null;
    const sel = selectedWindows();
    const wins = mediaWindows();
    if (sel.length > 0 && sel[0].timezone != null && String(sel[0].timezone).trim() !== '') {
      effectiveTz = String(sel[0].timezone).trim();
      logInfo("VideoSyncHelper: Using media timezone from selected window", { timezone: effectiveTz });
    } else if (wins.length > 0 && wins[0].timezone != null && String(wins[0].timezone).trim() !== '') {
      effectiveTz = String(wins[0].timezone).trim();
      logInfo("VideoSyncHelper: Using media timezone from first window", { timezone: effectiveTz });
    } else {
      effectiveTz = props.datasetTimezone ?? null;
    }
    let effectiveDateYmd: string | null = props.mediaDateYmd ?? null;
    if (knownTime().trim() && knownTimeMode() === 'local' && !effectiveTz) {
      const className = persistantStore.selectedClassName();
      const projectId = persistantStore.selectedProjectId();
      let dateYmd = effectiveDateYmd ?? (selectedTime() ? `${selectedTime()!.getUTCFullYear()}${String(selectedTime()!.getUTCMonth() + 1).padStart(2, "0")}${String(selectedTime()!.getUTCDate()).padStart(2, "0")}` : null);
      if (!dateYmd) {
        const raw = knownTime().trim();
        const idx = raw.indexOf("T");
        const datePart = idx >= 0 ? raw.slice(0, idx) : raw.slice(0, 10);
        if (datePart.length >= 8) {
          dateYmd = datePart.replace(/-/g, '').replace(/\//g, '').slice(0, 8);
        }
      }
      if (className && projectId && dateYmd) {
        try {
          const tz = await getTimezoneForDate(className, Number(projectId), dateYmd.length >= 8 ? `${dateYmd.slice(0, 4)}-${dateYmd.slice(4, 6)}-${dateYmd.slice(6, 8)}` : dateYmd);
          if (tz) {
            effectiveTz = tz;
            if (!effectiveDateYmd && dateYmd) effectiveDateYmd = dateYmd;
            logInfo("VideoSyncHelper: Resolved dataset timezone for known time (local → UTC)", { timezone: tz, dateYmd });
          }
        } catch (e) {
          logWarn("VideoSyncHelper: Could not fetch timezone for date", e);
        }
      }
    }
    if (knownTime().trim() && knownTimeMode() === 'local' && !effectiveTz) {
      const msg = "Timezone could not be resolved for local time. Load the timeline for the date, or use UTC if the time in the video is in UTC.";
      logWarn("VideoSyncHelper: " + msg);
      setApplyBlockedMessage(msg);
      return null;
    }
    let offset: number | null = null;
    const knownTimeValue = knownTime().trim();
    if (knownTimeValue && knownTimeMode() === "local" && effectiveTz) {
      const localNormalized = normalizeKnownTimeForApi(knownTimeValue);
      const utcFromBackend = await fetchConvertLocalToUtc(localNormalized, effectiveTz);
      if (!utcFromBackend) {
        const msg = "Could not convert local time to UTC. Check that the timezone is correct for this media.";
        setApplyBlockedMessage(msg);
        logWarn("VideoSyncHelper: " + msg, { local: localNormalized, timezone: effectiveTz });
        return null;
      }
      const st = selectedTime();
      if (!st) {
        logWarn("VideoSyncHelper: No selectedTime available for offset calculation");
        return null;
      }
      offset = new Date(utcFromBackend).getTime() - st.getTime();
      logInfo("VideoSyncHelper: local → UTC via backend", { local: localNormalized, timezone: effectiveTz, utc: utcFromBackend, offsetMs: offset });
    } else {
      offset = calculateTimeOffset(effectiveTz, effectiveDateYmd);
    }
    if (offset === null) {
      logWarn("VideoSyncHelper: Cannot calculate offset - aborting");
      return null;
    }
    logInfo("VideoSyncHelper: Offset calculated successfully", {
      offsetMs: offset,
      offsetSeconds: offset / 1000
    });
    return offset;
  };

  // Apply time corrections to media windows
  const handleApply = async (mode: 'all' | 'selection' | 'before' | 'after' = 'all') => {
    if (isApplying()) {
      logWarn("VideoSyncHelper: Already applying, ignoring request");
      return;
    }
    logInfo("VideoSyncHelper: handleApply called", { mode });
    const offset = await computeOffsetForApply();
    if (offset === null) return;

    const source = mediaSource();
    if (!source) {
      logWarn("VideoSyncHelper: No media source provided");
      return;
    }
    
    const sourceId = source.id;
    const currentTime = selectedTime();
    let windowsToUpdate: MediaWindow[];
    
    if (mode === 'selection') {
      // Use the single window containing selectedTime, or manually selected window
      const selected = selectedWindows();
      if (selected.length > 0) {
        windowsToUpdate = selected; // Use manually selected window(s)
      } else {
        // Find window containing selectedTime
        if (!currentTime) {
          logWarn("VideoSyncHelper: No selectedTime available for 'selection' mode");
          return;
        }
        if (mediaWindows().length === 0) {
          logWarn("VideoSyncHelper: No media windows for this source. Load the timeline first or use another source.");
          return;
        }
        const containingWindow = mediaWindows().find(w => {
          const windowStart = w.start instanceof Date ? w.start : new Date(w.start);
          const windowEnd = w.end instanceof Date ? w.end : new Date(w.end);
          const time = currentTime.getTime();
          return windowStart.getTime() <= time && time <= windowEnd.getTime();
        });
        windowsToUpdate = containingWindow ? [containingWindow] : [];
      }
      if (windowsToUpdate.length === 0) {
        logWarn("VideoSyncHelper: No window selected. Click a bar in the timeline to select a window, or use Before / After / All.");
        return;
      }
    } else if (mode === 'before') {
      if (!currentTime) {
        logWarn("VideoSyncHelper: No selectedTime available for 'before' mode");
        return;
      }
      // Include:
      // 1. Selected window (if exists)
      // 2. All windows where start < selectedTime
      // 3. All windows that overlap selectedTime (start <= selectedTime <= end)
      const selected = selectedWindows();
      const beforeWindows = mediaWindows().filter(w => {
        const windowStart = w.start instanceof Date ? w.start : new Date(w.start);
        const windowEnd = w.end instanceof Date ? w.end : new Date(w.end);
        const time = currentTime.getTime();
        // Window starts before selectedTime OR overlaps selectedTime
        return windowStart.getTime() < time || 
               (windowStart.getTime() <= time && time <= windowEnd.getTime());
      });
      // Combine selected and before, removing duplicates
      const allBefore = [...selected, ...beforeWindows];
      windowsToUpdate = allBefore.filter((w, index, self) => 
        index === self.findIndex(win => win.id === w.id)
      );
      if (windowsToUpdate.length === 0) {
        logWarn("VideoSyncHelper: No windows found before or overlapping selectedTime");
        return;
      }
    } else if (mode === 'after') {
      if (!currentTime) {
        logWarn("VideoSyncHelper: No selectedTime available for 'after' mode");
        return;
      }
      // Include:
      // 1. Selected window (if exists)
      // 2. All windows where end > selectedTime
      // 3. All windows that overlap selectedTime (start <= selectedTime <= end)
      const selected = selectedWindows();
      const afterWindows = mediaWindows().filter(w => {
        const windowStart = w.start instanceof Date ? w.start : new Date(w.start);
        const windowEnd = w.end instanceof Date ? w.end : new Date(w.end);
        const time = currentTime.getTime();
        // Window ends after selectedTime OR overlaps selectedTime
        return windowEnd.getTime() > time || 
               (windowStart.getTime() <= time && time <= windowEnd.getTime());
      });
      // Combine selected and after, removing duplicates
      const allAfter = [...selected, ...afterWindows];
      windowsToUpdate = allAfter.filter((w, index, self) => 
        index === self.findIndex(win => win.id === w.id)
      );
      if (windowsToUpdate.length === 0) {
        logWarn("VideoSyncHelper: No windows found after or overlapping selectedTime");
        return;
      }
    } else {
      // mode === 'all'
      windowsToUpdate = mediaWindows();
      if (windowsToUpdate.length === 0) {
        logWarn("VideoSyncHelper: No media windows found for source", sourceId);
        return;
      }
    }
    
    setIsApplying(true);
    logInfo("VideoSyncHelper: Applying time corrections", {
      sourceId,
      windowCount: windowsToUpdate.length,
      offsetMs: offset,
      offsetSeconds: offset / 1000,
      mode
    });
    
    try {
      const className = persistantStore.selectedClassName();
      const projectId = persistantStore.selectedProjectId();
      
      if (!className || !projectId) {
        throw new Error("Missing className or projectId");
      }
      
      // Update each media window
      const updatePromises = windowsToUpdate.map(async (window) => {
        if (!window.id) {
          logWarn("VideoSyncHelper: Window missing ID, skipping", window);
          return;
        }
        
        const newStart = new Date(window.start.getTime() + offset);
        const newEnd = new Date(window.end.getTime() + offset);
        
        logDebug("VideoSyncHelper: Updating window", {
          id: window.id,
          originalStart: window.start.toISOString(),
          originalEnd: window.end.toISOString(),
          newStart: newStart.toISOString(),
          newEnd: newEnd.toISOString()
        });
        
        // Persist UTC to database: start_time/end_time are always stored as UTC (timestamptz).
        // When known time mode is UTC, the user's input was interpreted as UTC; when Local, we converted local → UTC using timezone in parseKnownTimeToUtcWith.
        // Get CSRF token for the request
        const getCookie = (name: string): string => {
          const value = `; ${document.cookie}`;
          const parts = value.split(`; ${name}=`);
          if (parts.length === 2) return parts.pop()?.split(';').shift() ?? '';
          return '';
        };
        const csrfToken = getCookie('csrf_token') || '';
        
        // Always use relative URL - nginx handles routing
        const mediaUrl = '/api/admin/media';
        const response = await fetch(mediaUrl, {
          method: 'PUT',
          credentials: 'include',
          headers: { 
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken
          },
          body: JSON.stringify({
            class_name: className,
            project_id: projectId,
            media_id: Number(window.id),
            start_time: newStart.toISOString(),
            end_time: newEnd.toISOString()
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`Failed to update media ${window.id}: ${response.status} ${errorText}`);
        }
        
        logInfo("VideoSyncHelper: Successfully updated media", window.id);
      });
      
      await Promise.all(updatePromises);
      
      logInfo("VideoSyncHelper: All media windows updated successfully", {
        updatedCount: windowsToUpdate.length,
        sourceId
      });
      
      // Refresh media files cache for all updated windows
      // Refresh cache for BOTH old and new dates (in case media moved to different date)
      try {
        const { mediaFilesService } = await import('../../services/mediaFilesService');
        
        // Get unique dates from updated windows (both OLD and NEW dates)
        const uniqueDates = new Set();
        windowsToUpdate.forEach(window => {
          // Original date (before offset)
          const oldStart = window.start;
          const oldDateStr = oldStart.toISOString().split('T')[0];
          uniqueDates.add(oldDateStr);
          
          // New date (after offset)
          const newStart = new Date(window.start.getTime() + offset);
          const newDateStr = newStart.toISOString().split('T')[0];
          uniqueDates.add(newDateStr);
        });
        
        // Refresh cache for each unique date (both old and new)
        const refreshPromises = Array.from(uniqueDates).map(async (dateStr) => {
          // Convert YYYY-MM-DD to Date object
          const date = new Date(dateStr + 'T00:00:00');
          
          await mediaFilesService.refreshCache(sourceId, date);
          logInfo("VideoSyncHelper: Refreshed media files cache", { 
            sourceId, 
            date: date.toISOString(),
            dateStr
          });
        });
        
        await Promise.all(refreshPromises);
        logInfo("VideoSyncHelper: Refreshed all media files caches after apply", { 
          sourceId,
          datesRefreshed: Array.from(uniqueDates),
          windowsUpdated: windowsToUpdate.length
        });
      } catch (error) {
        logWarn("VideoSyncHelper: Failed to refresh media files cache", error);
      }
      
      // Clear form and collapse sync tools so user sees the result without reloading
      setKnownTime("");
      setOffsetSeconds("");
      setIsKnownTimeDisabled(false);
      setIsOffsetDisabled(false);
      setIsApplyEnabled(false);
      setIsExpanded(false);

      // Notify parent component to refresh data
      if (props.onUpdateComplete) {
        props.onUpdateComplete();
      }

      // Notify parent to refresh VideoSyncTimeSeries timeline
      if (props.onTimelineRefresh) {
        props.onTimelineRefresh();
      }
    } catch (error) {
      logError("VideoSyncHelper: Error applying time corrections", error);
    } finally {
      setIsApplying(false);
    }
  };

  const handleSyncAllSourcesClick = async () => {
    if (!props.onSyncAllSourcesRequest) return;
    const offset = await computeOffsetForApply();
    if (offset !== null) {
      logInfo("VideoSyncHelper: Invoking onSyncAllSourcesRequest", { offsetMs: offset });
      props.onSyncAllSourcesRequest(offset);
    }
  };

  // Initialize with current selectedTime as known time (displayed in dataset timezone when set)
  const initializeWithSelectedTime = () => {
    const currentTime = selectedTime();
    logInfo("VideoSyncHelper: initializeWithSelectedTime called", {
      currentTime: currentTime?.toISOString(),
      hasCurrentTime: !!currentTime
    });
    
    if (currentTime) {
      const formatted = formatKnownTimeForInput(currentTime);
      logInfo("VideoSyncHelper: Setting known time from selectedTime", {
        selectedTime: currentTime.toISOString(),
        formatted
      });
      setKnownTime(formatted);
      setIsKnownTimeDisabled(false);
      setIsOffsetDisabled(true);
      updateApplyButtonState();
    } else {
      logWarn("VideoSyncHelper: Cannot initialize - no selectedTime available");
    }
  };

  // Watch for selectedTime changes to update known time if it's empty (display in dataset timezone when set)
  createEffect(() => {
    const currentTime = selectedTime();
    if (currentTime && !knownTime().trim()) {
      setKnownTime(formatKnownTimeForInput(currentTime));
      updateApplyButtonState();
    }
  });

  const source = mediaSource();
  if (!source) return null;

  return (
    <div class="video-sync-helper-wrapper">
      <Show when={isApplying()}>
        <div class="video-sync-waiting-overlay" aria-live="polite" aria-busy="true">
          <div class="video-sync-waiting-spinner" aria-hidden="true" />
          <span class="video-sync-waiting-text">Synchronizing…</span>
        </div>
      </Show>
      <Show when={!isApplying()}>
      <div class="video-sync-helper bg-black bg-opacity-75 text-white p-2 rounded-b-lg">
        {/* Toggle Button */}
      <div class="flex justify-between items-center mb-2">
        <span class="text-xs font-medium text-gray-300">
          Sync Options
        </span>
        <button
          onClick={() => setIsExpanded(!isExpanded())}
          class="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded text-white"
        >
          {isExpanded() ? "Hide" : "Show"}
        </button>
      </div>

      {/* Expanded Controls */}
      <Show when={isExpanded()}>
        <div class="space-y-2 bg-black bg-opacity-75 p-2 rounded-t-lg">
          {/* Known Time + Offset on one row (centered) */}
          <div class="flex items-center gap-2 flex-wrap justify-center">
            <label class="text-xs text-gray-300 w-20 shrink-0">Known Time:</label>
            <div class="flex-1 min-w-0 relative max-w-xs">
              <input
                type="datetime-local"
                step="0.001"
                value={knownTime()}
                onInput={handleKnownTimeChange}
                disabled={isKnownTimeDisabled()}
                class="w-full px-2 py-1 pr-6 text-xs border border-gray-600 rounded bg-gray-800 text-white disabled:bg-gray-700 disabled:cursor-not-allowed"
                placeholder="YYYY-MM-DDTHH:MM:SS or .sss"
                title="Enter the time shown in the video (seconds and optional milliseconds). Use picker or type HH:MM:SS."
              />
              <div 
                class="absolute right-1 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white cursor-help"
                title="Enter the time shown in the video. Choose UTC if the video displays UTC; choose Local if it displays media/dataset timezone."
              >
                ℹ️
              </div>
            </div>
            <label class="text-xs text-gray-300 shrink-0">Offset (s):</label>
            <div class="w-24 relative shrink-0">
              <input
                type="number"
                step="0.1"
                value={offsetSeconds()}
                onInput={handleOffsetChange}
                disabled={isOffsetDisabled()}
                class="w-full px-2 py-1 pr-6 text-xs border border-gray-600 rounded bg-gray-800 text-white disabled:bg-gray-700 disabled:cursor-not-allowed"
                placeholder="0.0"
              />
              <div 
                class="absolute right-1 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white cursor-help"
                title="Direct seconds adjustment, + or - seconds to adjust the start/end time of the media"
              >
                ℹ️
              </div>
            </div>
          </div>
          
          {/* Local/UTC radios + Action buttons (centered) */}
          <div class="flex flex-wrap gap-2 items-center justify-center">
            <div class="flex items-center gap-3 shrink-0 mr-2">
              <label class="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer" title="Time shown in the video is in UTC.">
                <input
                  type="radio"
                  name="known-time-mode"
                  checked={knownTimeMode() === 'utc'}
                  onChange={() => { setKnownTimeMode('utc'); setApplyBlockedMessage(null); }}
                  class="rounded-full border-gray-500 text-blue-600 focus:ring-blue-500"
                />
                <span>UTC</span>
              </label>
              <label class="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer" title="Time shown in the video is in the media or dataset timezone (e.g. race local).">
                <input
                  type="radio"
                  name="known-time-mode"
                  checked={knownTimeMode() === 'local'}
                  onChange={() => setKnownTimeMode('local')}
                  class="rounded-full border-gray-500 text-blue-600 focus:ring-blue-500"
                />
                <span>Local</span>
              </label>
            </div>
            <button
              onClick={() => handleApply('selection')}
              disabled={!isApplyEnabled() || isApplying() || !selectedTime()}
              class={`px-3 py-1 text-xs disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded ${
                selectedWindows().length > 0 
                  ? "bg-blue-600 hover:bg-blue-700 font-semibold" 
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
              title={selectedWindows().length > 0 
                ? `Apply to ${selectedWindows().length} selected window${selectedWindows().length === 1 ? '' : 's'}` 
                : "Apply to window containing selectedTime (or manually select a window first)"}
            >
              {isApplying() ? "Applying..." : `Sync Selection${selectedWindows().length > 0 ? ` (${selectedWindows().length})` : ''}`}
            </button>
            <button
              onClick={() => handleApply('before')}
              disabled={!isApplyEnabled() || isApplying() || !selectedTime()}
              class="px-3 py-1 text-xs bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded"
              title="Apply to selected window and all windows that start before selectedTime (including overlapping windows)"
            >
              {isApplying() ? "Applying..." : "Sync Before"}
            </button>
            <button
              onClick={() => handleApply('after')}
              disabled={!isApplyEnabled() || isApplying() || !selectedTime()}
              class="px-3 py-1 text-xs bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded"
              title="Apply to selected window and all windows that end after selectedTime (including overlapping windows)"
            >
              {isApplying() ? "Applying..." : "Sync After"}
            </button>
            <button
              onClick={() => handleApply('all')}
              disabled={!isApplyEnabled() || isApplying()}
              class={`px-3 py-1 text-xs disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded ${
                selectedWindows().length > 0 
                  ? "bg-gray-600 hover:bg-gray-700" 
                  : "bg-green-600 hover:bg-green-700 font-semibold"
              }`}
              title={selectedWindows().length > 0 ? "Apply to all windows (ignoring selection)" : "Apply to all windows"}
            >
              {isApplying() ? "Applying..." : "All"}
            </button>
            <button
              onClick={() => handleSyncAllSourcesClick()}
              disabled={!isApplyEnabled() || isApplying() || !props.onSyncAllSourcesRequest}
              class="px-3 py-1 text-xs bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded"
              title="Apply known time/offset to all video from all media sources (confirmation required)"
            >
              Sync all sources
            </button>
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                logInfo("VideoSyncHelper: Set button clicked");
                setApplyBlockedMessage(null);
                initializeWithSelectedTime();
              }}
              class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-700 text-white rounded"
              title="Set known time to current selectedTime"
            >
              Set
            </button>
            <button
              onClick={() => {
                setKnownTime("");
                setOffsetSeconds("");
                setApplyBlockedMessage(null);
                setIsKnownTimeDisabled(false);
                setIsOffsetDisabled(false);
                setIsApplyEnabled(false);
              }}
              class="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-700 text-white rounded"
              title="Clear known time and offset"
            >
              Clear
            </button>
          </div>
          <Show when={applyBlockedMessage()}>
            <p class="text-xs text-amber-400 mt-1" role="alert">
              {applyBlockedMessage()}
            </p>
          </Show>
        </div>
      </Show>
      </div>
      </Show>
    </div>
  );
}
