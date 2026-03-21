import { createEffect, onMount, onCleanup, createSignal, Show } from "solid-js";
import { For } from "solid-js/web";
import { useNavigate } from "@solidjs/router";

import VideoSyncTimeSeries from "../components/utilities/VideoSyncTimeSeries";
import VideoSyncHelper from "../components/utilities/VideoSyncHelper";
import VideoComponent from "../components/charts/Video";
import BackButton from "../components/buttons/BackButton";
import PlayPause from "../components/utilities/PlayPause";

import { isPlaying, setIsPlaying, playbackSpeed, selectedTime, setSelectedTime, syncSelectedTimeManual, isManualTimeChange, setIsManualTimeChange, requestTimeControl, releaseTimeControl, activeComponent } from "../store/playbackStore";
import { debug as logDebug, warn as logWarn, error as logError, info as logInfo } from "../utils/console";
import { persistantStore } from "../store/persistantStore";
import { setCurrentDataset } from "../store/datasetTimezoneStore";
import { user } from "../store/userStore";
import { apiEndpoints } from "@config/env";
import { getData, getTimezoneForDate, localTimeInTimezoneToUtcDate, formatTime } from "../utils/global";

const { selectedClassName, selectedProjectId, selectedPage, selectedDate, setSelectedDate, selectedDatasetId } = persistantStore;

// Epoch default from playbackStore – treat as "uninitialized" so we can set from data/date
const EPOCH_TIME_MS = new Date('1970-01-01T12:00:00.000Z').getTime();
const isEpochTime = (d: Date) => d.getTime() === EPOCH_TIME_MS;

// Extend Window interface for custom properties
declare global {
  interface Window {
    unifiedDataStore?: {
      getTimeRange?: () => { start: Date | string; end: Date | string } | null;
    };
    mapFrequencyAnalysis?: {
      timeRange?: { start: Date | string; end: Date | string };
    };
    globalDataStore?: {
      timeRange?: { start: Date | string; end: Date | string };
    };
    videoTimeRange?: {
      start: Date | string;
      end: Date | string;
    };
  }
}

export default function VideoSyncPage() {
  logInfo('VideoSync: Page mounted');
  const navigate = useNavigate();

  // Video player state (single player kept for sync logic; grid shows multiple sources)
  let videoRef: HTMLVideoElement | undefined;
  let previousPlayState = false;
  let isVideoInitialized = false;
  let videoDuration: number | null = null;
  let videoUpdateInterval: ReturnType<typeof setInterval> | null = null;
  let videoLoadTimeout: ReturnType<typeof setTimeout> | null = null;
  const [isVideoLoading, setIsVideoLoading] = createSignal(true);
  const [videoError, setVideoError] = createSignal<string | null>(null);
  const [videoConfig, setVideoConfig] = createSignal<any>(null);
  const [currentVideoSource, setCurrentVideoSource] = createSignal(0);
  const [selectedWindows, setSelectedWindows] = createSignal<any[]>([]);
  /** When set, video grid shows only this source (full screen). Cleared when user double-clicks bar again or clicks Back. */
  const [fullScreenSourceId, setFullScreenSourceId] = createSignal<string | null>(null);
  /** Date (YYYYMMDD) used for media API; passed to timeline so it loads bars for the same day. */
  const [mediaDateYmd, setMediaDateYmd] = createSignal<string | null>(null);
  let videoSyncTimeSeriesRef: any = null;
  
  // Cache the first detected data time range to keep mapping stable
  let fixedDataStart: Date | null = null;
  let fixedDataEnd: Date | null = null;
  // Fallback mapping when no external range is available
  let fallbackDataStart: Date | null = null;

  // Calculate data time range when data is available
  const getDataTimeRange = () => {
    try {
      logDebug('🎥 VideoSync: Getting data time range...');
      
      // Try to get time range from the unified data store
      const dataStore = window['unifiedDataStore'];
      logDebug('🎥 VideoSync: Data store available:', !!dataStore);
      if (dataStore && dataStore.getTimeRange) {
        const timeRange = dataStore.getTimeRange();
        logDebug('🎥 VideoSync: Data store time range:', timeRange);
        if (timeRange && timeRange.start && timeRange.end) {
          const start = new Date(timeRange.start);
          const end = new Date(timeRange.end);
          if (!fixedDataStart || !fixedDataEnd) {
            fixedDataStart = new Date(start);
            fixedDataEnd = new Date(end);
            logDebug('🎥 VideoSync: Fixed data range set from unifiedDataStore', { start: fixedDataStart.toISOString(), end: fixedDataEnd.toISOString() });
          }
          return { start: fixedDataStart || start, end: fixedDataEnd || end };
        }
      }
      
      // Fallback: try to get from map frequency analysis
      const frequencyAnalysis = window['mapFrequencyAnalysis'];
      logDebug('🎥 VideoSync: Frequency analysis available:', !!frequencyAnalysis);
      if (frequencyAnalysis && frequencyAnalysis.timeRange) {
        logDebug('🎥 VideoSync: Frequency analysis time range:', frequencyAnalysis.timeRange);
        const start = new Date(frequencyAnalysis.timeRange.start);
        const end = new Date(frequencyAnalysis.timeRange.end);
        if (!fixedDataStart || !fixedDataEnd) {
          fixedDataStart = new Date(start);
          fixedDataEnd = new Date(end);
          logDebug('🎥 VideoSync: Fixed data range set from frequencyAnalysis', { start: fixedDataStart.toISOString(), end: fixedDataEnd.toISOString() });
        }
        return { start: fixedDataStart || start, end: fixedDataEnd || end };
      }
      
      // Additional fallback: try to get from global data
      const globalData = window['globalDataStore'];
      logDebug('🎥 VideoSync: Global data store available:', !!globalData);
      if (globalData && globalData.timeRange) {
        logDebug('🎥 VideoSync: Global data time range:', globalData.timeRange);
        const start = new Date(globalData.timeRange.start);
        const end = new Date(globalData.timeRange.end);
        if (!fixedDataStart || !fixedDataEnd) {
          fixedDataStart = new Date(start);
          fixedDataEnd = new Date(end);
          logDebug('🎥 VideoSync: Fixed data range set from globalData', { start: fixedDataStart.toISOString(), end: fixedDataEnd.toISOString() });
        }
        return { start: fixedDataStart || start, end: fixedDataEnd || end };
      }
      
      // Manual fallback: check for manually set time range
      //@ts-ignore
      const manualTimeRange = window.videoTimeRange;
      logDebug('🎥 VideoSync: Manual time range available:', !!manualTimeRange);
      if (manualTimeRange && manualTimeRange.start && manualTimeRange.end) {
        logDebug('🎥 VideoSync: Using manual time range:', manualTimeRange);
        return {
          start: new Date(manualTimeRange.start),
          end: new Date(manualTimeRange.end)
        };
      }
      
      // If no data range available, return null (expected when no dataset selected, e.g. opening from upload)
      const dsId = typeof selectedDatasetId === 'function' ? selectedDatasetId() : null;
      if (!dsId) logDebug('🎥 VideoSync: No data time range found (no dataset selected)');
      else logWarn('🎥 VideoSync: No data time range found');
      return null;
    } catch (error: any) {
      logWarn('🎥 VideoSync: Error getting data time range', error);
      return null;
    }
  };

  // Convert selectedTime to video time
  const selectedTimeToVideoTime = (selectedTime: Date): number => {
    const timeRange = getDataTimeRange();
    if (!timeRange || !videoDuration) return 0;

    const dataDuration = timeRange.end.getTime() - timeRange.start.getTime();
    const timeOffset = selectedTime.getTime() - timeRange.start.getTime();
    const ratio = timeOffset / dataDuration;
    
    return Math.max(0, Math.min(videoDuration, ratio * videoDuration));
  };

  // Convert video time to selectedTime (data time)
  const videoTimeToSelectedTime = (videoTimeSeconds: number): Date => {
    const timeRange = getDataTimeRange();
    if (!timeRange || !videoDuration) return new Date();

    const ratio = videoTimeSeconds / videoDuration;
    const dataDuration = timeRange.end.getTime() - timeRange.start.getTime();
    const timeOffset = ratio * dataDuration;
    
    return new Date(timeRange.start.getTime() + timeOffset);
  };

  // selectedTime is always stored as UTC (Date). UI shows and accepts local time (dataset timezone or browser); convert to UTC when setting from user input (e.g. Go to time).
  // Initialize selectedTime from data range, selectedDate, or dataset API when still at epoch
  createEffect(() => {
    const current = selectedTime();
    if (!current || !isEpochTime(current)) return;

    const timeRange = getDataTimeRange();
    if (timeRange?.start && timeRange?.end) {
      setSelectedTime(new Date(timeRange.start.getTime()), 'videosync');
      logDebug('🎥 VideoSync: selectedTime initialized from data range', { start: timeRange.start.toISOString() });
      return;
    }

    const dateStr = typeof selectedDate === 'function' ? selectedDate() : '';
    if (dateStr && dateStr.trim() !== '') {
      const norm = dateStr.replace(/-/g, '').trim();
      const yyyy = norm.slice(0, 4);
      const mm = norm.slice(4, 6);
      const dd = norm.slice(6, 8);
      if (yyyy && mm && dd) {
        const utcNoon = new Date(Date.UTC(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), 12, 0, 0, 0));
        if (!isNaN(utcNoon.getTime())) {
          setSelectedTime(utcNoon, 'videosync');
          logDebug('🎥 VideoSync: selectedTime initialized from selectedDate (UTC noon)', { dateStr, utc: utcNoon.toISOString() });
        }
      }
      return;
    }

    // When navigating from Video with a dataset selected: no data store yet, no selectedDate – fetch dataset time range
    const datasetId = typeof selectedDatasetId === 'function' ? selectedDatasetId() : 0;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    if (datasetId && Number(datasetId) > 0 && className && projectId != null) {
      const url = `${apiEndpoints.app.events}/dataset-time-range?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&dataset_ids=${encodeURIComponent(JSON.stringify([datasetId]))}&timezone=UTC`;
      getData(url)
        .then((res: any) => {
          const data = res?.data ?? res;
          if (data?.start_time != null && data?.end_time != null) {
            const start = new Date(data.start_time);
            const end = new Date(data.end_time);
            if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
              fixedDataStart = start;
              fixedDataEnd = end;
              setSelectedTime(new Date(start.getTime()), 'videosync');
              logDebug('🎥 VideoSync: selectedTime initialized from dataset-time-range API', { start: start.toISOString(), end: end.toISOString(), datasetId });
            }
          }
        })
        .catch((err: unknown) => {
          logWarn('🎥 VideoSync: Failed to fetch dataset time range for init', err);
        });
    }
  });

  // Sync video currentTime with selectedTime - video is now passive
  createEffect(() => {
    const currentSelectedTime = selectedTime();
    
    logDebug('🎥 VideoSync: selectedTime changed', {
      selectedTime: currentSelectedTime?.toISOString(),
      videoInitialized: isVideoInitialized,
      videoDuration: videoDuration,
      videoRef: !!videoRef
    });
    
    if (videoRef && currentSelectedTime instanceof Date && videoDuration) {
      let timeRange = getDataTimeRange();
      
      // Only sync if we have a valid time range
      if (timeRange && timeRange.start && timeRange.end) {
        const videoTimeSeconds = selectedTimeToVideoTime(currentSelectedTime);
        const currentVideoTime = videoRef.currentTime;
        
        logDebug('🎥 VideoSync: Calculating video sync', {
          selectedTime: currentSelectedTime.toISOString(),
          timeRange: {
            start: timeRange.start.toISOString(),
            end: timeRange.end.toISOString()
          },
          calculatedVideoTime: videoTimeSeconds,
          currentVideoTime: currentVideoTime,
          timeDifference: Math.abs(currentVideoTime - videoTimeSeconds)
        });
        
        // Always sync video to selectedTime (video is passive)
        // Force seek on manual changes, otherwise use a small threshold
        const forceSeek = !!isManualTimeChange && typeof isManualTimeChange === 'function' ? isManualTimeChange() : false;
        const diff = Math.abs(currentVideoTime - videoTimeSeconds);
        if (forceSeek || diff > 0.1) {
          logDebug('🎥 VideoSync: Syncing to selectedTime', {
            selectedTime: currentSelectedTime.toISOString(),
            videoTime: videoTimeSeconds,
            currentVideoTime: currentVideoTime,
            timeRange: {
              start: timeRange.start.toISOString(),
              end: timeRange.end.toISOString()
            }
          });
          
          try {
            videoRef.currentTime = videoTimeSeconds;
            logDebug('🎥 VideoSync: Successfully synced video to', videoTimeSeconds);
          } catch (error: any) {
            logWarn('🎥 VideoSync: Failed to sync video time', error);
            // Try again after a short delay if video isn't ready
            if (!isVideoInitialized) {
              setTimeout(() => {
                try {
                  videoRef.currentTime = videoTimeSeconds;
                  logDebug('🎥 VideoSync: Delayed sync successful', videoTimeSeconds);
                } catch (retryError) {
                  logWarn('🎥 VideoSync: Delayed sync also failed', retryError);
                }
              }, 100);
            }
          }
        } else {
          logDebug('🎥 VideoSync: Video already in sync, skipping update');
        }
      } else {
        // Fallback: if no external time range is available, assume the first observed
        // selectedTime is the data minimum, and compute end based on video duration
        if (!fallbackDataStart) {
          fallbackDataStart = new Date(currentSelectedTime);
          logDebug('🎥 VideoSync: Fallback data start set to', fallbackDataStart.toISOString());
        }
        const fallbackStart = fallbackDataStart;
        const fallbackEnd = new Date(fallbackStart.getTime() + videoDuration * 1000);
        const dataDuration = fallbackEnd.getTime() - fallbackStart.getTime();
        const timeOffset = currentSelectedTime.getTime() - fallbackStart.getTime();
        const ratio = dataDuration > 0 ? (timeOffset / dataDuration) : 0;
        const videoTimeSeconds = Math.max(0, Math.min(videoDuration, ratio * videoDuration));
        const currentVideoTime = videoRef.currentTime;
        const diff = Math.abs(currentVideoTime - videoTimeSeconds);
        const forceSeek = !!isManualTimeChange && typeof isManualTimeChange === 'function' ? isManualTimeChange() : false;
        logWarn('🎥 VideoSync: Using fallback mapping for sync', {
          fallbackStart: fallbackStart.toISOString(),
          fallbackEnd: fallbackEnd.toISOString(),
          selectedTime: currentSelectedTime.toISOString(),
          calculatedVideoTime: videoTimeSeconds,
          currentVideoTime
        });
        if (forceSeek || diff > 0.1) {
          try {
            videoRef.currentTime = videoTimeSeconds;
            logDebug('🎥 VideoSync: Fallback sync applied to', videoTimeSeconds);
          } catch (error: any) {
            logWarn('🎥 VideoSync: Fallback sync failed', error);
          }
        }
      }
    } else {
      logDebug('🎥 VideoSync: Cannot sync - missing requirements', {
        videoRef: !!videoRef,
        isVideoInitialized,
        selectedTime: currentSelectedTime,
        videoDuration
      });
    }
  });

  // Stop all video intervals
  const stopVideoIntervals = () => {
    if (videoUpdateInterval) {
      clearInterval(videoUpdateInterval);
      videoUpdateInterval = null;
    }
  };

  const handleTimeUpdate = () => {
    // We'll handle time updates through our own interval instead of relying on video events
    // This is just for fallback logging
    if (videoRef && isVideoInitialized && isPlaying()) {

    }
  };

  const handleVideoLoaded = () => {
    // Prevent multiple calls to this function
    if (isVideoInitialized) {
      logDebug('🎥 VideoSync: handleVideoLoaded called but already initialized');
      return;
    }
    
    // Clear the load timeout
    if (videoLoadTimeout) {
      clearTimeout(videoLoadTimeout);
      videoLoadTimeout = null;
    }
    
    isVideoInitialized = true;
    videoDuration = videoRef.duration;
    setIsVideoLoading(false);
    logDebug('🎥 VideoSync: Video loaded successfully', {
      duration: videoDuration,
      src: getCurrentVideoSrc(),
      videoElement: videoRef
    });

    // Force sync to get latest selectedTime from other components
    syncSelectedTimeManual();
    
    // Initialize previousPlayState to current state (don't force opposite)
    previousPlayState = isPlaying();
    
    // Sync video to current selectedTime immediately when loaded
    const currentSelectedTime = selectedTime();
    logDebug('🎥 VideoSync: Video loaded, syncing to current selectedTime', {
      selectedTime: currentSelectedTime.toISOString(),
      videoDuration: videoDuration
    });
    
    if (videoRef && videoDuration) {
      const videoTimeSeconds = selectedTimeToVideoTime(currentSelectedTime);
      logDebug('🎥 VideoSync: Setting initial video time', {
        selectedTime: currentSelectedTime.toISOString(),
        videoTime: videoTimeSeconds
      });
      videoRef.currentTime = videoTimeSeconds;
    }
  };

  const handleDurationChange = () => {
    if (videoRef && !isVideoInitialized) {
      videoDuration = videoRef.duration;
    }
  };

  const handleCanPlay = () => {
    // Only handle this if video isn't initialized yet
    if (!isVideoInitialized) {
      logDebug('🎥 VideoSync: Can play event fired');
      handleVideoLoaded();
    }
  };

  const handleVideoError = (e) => {
    logError('🎥 VideoSync: Error occurred', {
      error: e,
      src: getCurrentVideoSrc(),
      networkState: videoRef?.networkState,
      readyState: videoRef?.readyState,
      videoError: videoRef?.error,
      errorCode: videoRef?.error?.code,
      errorMessage: videoRef?.error?.message
    });
    
    setIsVideoLoading(false);
    
    // Try to get more specific error information
    if (videoRef?.error) {
      const error = videoRef.error;
      let errorMessage = 'Unknown error';
      switch (error.code) {
        case 1:
          errorMessage = 'Video loading was aborted';
          logError('🎥 VideoSync: MEDIA_ERR_ABORTED - Video loading was aborted');
          break;
        case 2:
          errorMessage = 'Network error occurred';
          logError('🎥 VideoSync: MEDIA_ERR_NETWORK - Network error occurred');
          break;
        case 3:
          errorMessage = 'Video decode error';
          logError('🎥 VideoSync: MEDIA_ERR_DECODE - Video decode error');
          break;
        case 4:
          errorMessage = 'Video format not supported';
          logError('🎥 VideoSync: MEDIA_ERR_SRC_NOT_SUPPORTED - Video format not supported');
          break;
        default:
          errorMessage = `Unknown error code: ${error.code}`;
          logError('🎥 VideoSync: Unknown error code:', error.code);
      }
      setVideoError(errorMessage);
    }
  };

  const handleLoadStart = () => {
    logDebug('🎥 VideoSync: Load started', { src: getCurrentVideoSrc() });
    setIsVideoLoading(true);
    
    // Set a timeout to detect if video takes too long to load
    if (videoLoadTimeout) {
      clearTimeout(videoLoadTimeout);
    }
    
    videoLoadTimeout = setTimeout(() => {
      if (!isVideoInitialized) {
        logWarn('🎥 VideoSync: Load timeout - video taking too long to load', {
          src: getCurrentVideoSrc(),
          networkState: videoRef?.networkState,
          readyState: videoRef?.readyState
        });
        setIsVideoLoading(false);
        setVideoError('Video loading timeout - file may be too large (159MB)');
      }
    }, 15000); // Increased to 15 seconds for large files
  };

  const handleLoadedData = () => {
    logDebug('🎥 VideoSync: Data loaded', { 
      duration: videoRef?.duration,
      readyState: videoRef?.readyState 
    });
  };

  // State for media sources; increment after sync so Video components refetch and show updated times
  const [mediaSources, setMediaSources] = createSignal([]);
  const [mediaWindows, setMediaWindows] = createSignal([]);
  const [selectedSourceId, setSelectedSourceId] = createSignal(null);
  const [mediaRefreshKey, setMediaRefreshKey] = createSignal(0);
  // When we find sources by trying adjacent days, use this date for media windows (file_name paths use folder date e.g. 20260215)
  let effectiveMediaDateYmd: string | null = null;

  // Go to time: user enters time in local (dataset or browser); we convert to UTC for selectedTime
  const [goToTimeInput, setGoToTimeInput] = createSignal("");
  const [resolvedTimezone, setResolvedTimezone] = createSignal<string | null>(null);
  createEffect(() => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const t = selectedTime();
    const dateStr = typeof selectedDate === "function" ? selectedDate() : "";
    const dateDisplay = dateStr && String(dateStr).trim() !== ""
      ? String(dateStr).replace(/-/g, "").length >= 8
        ? `${String(dateStr).replace(/-/g, "").slice(0, 4)}-${String(dateStr).replace(/-/g, "").slice(4, 6)}-${String(dateStr).replace(/-/g, "").slice(6, 8)}`
        : String(dateStr)
      : t
        ? `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`
        : "";
    if (!className || !projectId || !dateDisplay) {
      setResolvedTimezone(null);
      return;
    }
    getTimezoneForDate(className, Number(projectId), dateDisplay.replace(/-/g, "").slice(0, 8))
      .then((tz) => setResolvedTimezone(tz))
      .catch(() => setResolvedTimezone(null));
  });
  const handleGoToTime = async () => {
    const raw = (goToTimeInput() || "").trim();
    if (!raw) return;
    const t = selectedTime();
    const dateStrFromStore = typeof selectedDate === "function" ? selectedDate() : "";
    const dateStr =
      dateStrFromStore && String(dateStrFromStore).trim() !== ""
        ? String(dateStrFromStore).replace(/-/g, "").length >= 8
          ? `${dateStrFromStore.replace(/-/g, "").slice(0, 4)}-${dateStrFromStore.replace(/-/g, "").slice(4, 6)}-${dateStrFromStore.replace(/-/g, "").slice(6, 8)}`
          : dateStrFromStore.replace(/\//g, "-")
        : t
          ? `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`
          : "";
    if (!dateStr) {
      logWarn("VideoSync: no date for Go to time");
      return;
    }
    const timezone = resolvedTimezone();
    const utcDate = localTimeInTimezoneToUtcDate(dateStr, raw, timezone);
    if (!utcDate) {
      logWarn("VideoSync: could not parse time as local", { time: raw, dateStr, timezone });
      return;
    }
    if (requestTimeControl("videosync")) {
      setSelectedTime(utcDate, "videosync");
      logInfo("VideoSync: Go to time (local → UTC)", { localTime: raw, dateStr, timezone, utc: utcDate.toISOString() });
    }
  };
  // Use same rule as VideoSyncTimeSeries x-axis: when dataset TZ is UTC/Etc/UTC show browser local, else dataset local.
  const displayTimezone = () => {
    const tz = resolvedTimezone();
    if (!tz || /^(UTC|Etc\/UTC|GMT|Z)$/i.test(String(tz).trim())) return null;
    return tz;
  };
  const currentTimeLocal = () => {
    const t = selectedTime();
    if (!t) return "";
    return formatTime(t, displayTimezone()) ?? formatTime(t, null) ?? t.toISOString();
  };

  // Date for media API: YYYYMMDD from selectedDate (dataset local) or selectedTime UTC. Backend uses UTC.
  const getDateYmdForMediaApi = (): string => {
    const dateStr = typeof selectedDate === 'function' ? selectedDate() : '';
    if (dateStr && dateStr.trim() !== '') {
      const ymd = dateStr.replace(/-/g, '').trim();
      if (ymd.length >= 8) return ymd.slice(0, 8);
    }
    const t = selectedTime();
    if (!t) return new Date().toISOString().split('T')[0].replace(/-/g, '');
    return t.toISOString().split('T')[0].replace(/-/g, '');
  };

  // Async: prefer dataset date when a dataset is selected so we load sources for that day even before selectedTime is set.
  const getDateYmdForMediaApiAsync = async (): Promise<string> => {
    const dateStr = typeof selectedDate === 'function' ? selectedDate() : '';
    if (dateStr && dateStr.trim() !== '') {
      const ymd = dateStr.replace(/-/g, '').trim();
      if (ymd.length >= 8) return ymd.slice(0, 8);
    }
    const datasetId = typeof selectedDatasetId === 'function' ? selectedDatasetId() : null;
    if (datasetId != null && Number(datasetId) > 0) {
      try {
        const res = await getData(
          `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
        );
        if (res?.success && res?.data?.date) {
          let d = String(res.data.date).trim();
          d = d.replace(/-/g, '');
          if (d.length >= 8) {
            logInfo('VideoSync: Using dataset date for media fetch', { datasetId, dateYmd: d.slice(0, 8) });
            return d.slice(0, 8);
          }
        }
      } catch (e) {
        logWarn('VideoSync: Could not get dataset date for media fetch', e);
      }
    }
    const t = selectedTime();
    if (t && !isEpochTime(t)) return t.toISOString().split('T')[0].replace(/-/g, '');
    return new Date().toISOString().split('T')[0].replace(/-/g, '');
  };

  // Fetch media windows for a specific source
  const fetchMediaWindows = async (sourceId) => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      const currentTime = selectedTime();
      
      if (!className || !projectId || !currentTime || !sourceId) {
        logWarn('VideoSync: Missing required data for fetching media windows', { className, projectId, currentTime, sourceId });
        return;
      }
      
      const dateYmd = effectiveMediaDateYmd ?? getDateYmdForMediaApi();
      const url = `/api/media?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateYmd)}&media_source=${encodeURIComponent(sourceId)}`;
      logDebug('VideoSync: Fetching media windows', { url, sourceId, dateYmd });

      const response = await getData(url);
      if (!response.success || response.data == null) {
        setMediaWindows([]);
        return;
      }
      const list = Array.isArray(response.data) ? response.data : [];
      const windows = list
        .map((r) => {
          const start = r.start_time || r.start || r.begin || r.ts_start;
          const end = r.end_time || r.end || r.finish || r.ts_end;
          const startDate = start ? new Date(start) : null;
          const endDate = end ? new Date(end) : null;
          if (!startDate || !endDate || isNaN(startDate) || isNaN(endDate)) return null;
          const fileName = r.file_name || r.file || r.filename || '';
          const id = r.media_id || r.id || undefined;
          return { sourceId, start: startDate, end: endDate, fileName, id };
        })
        .filter(Boolean);
      
      setMediaWindows(windows);
      logInfo('VideoSync: Loaded media windows', { windows, count: windows.length, sourceId });
      
    } catch (error: any) {
      logError('VideoSync: Error fetching media windows', error);
      setMediaWindows([]);
    }
  };

  const addDayYmd = (ymd: string, delta: number): string => {
    const y = parseInt(ymd.slice(0, 4), 10);
    const m = parseInt(ymd.slice(4, 6), 10) - 1;
    const d = parseInt(ymd.slice(6, 8), 10);
    const date = new Date(Date.UTC(y, m, d + delta));
    return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  };

  // Fetch media sources; try adjacent days when primary date has no media (folder date may differ e.g. 20260215).
  // When overrideDateYmd is provided, currentTime is not required (so we can load on mount before selectedTime is set).
  // Returns the date (YYYYMMDD) that had sources so the timeline can use the same date for bars.
  const fetchMediaSources = async (overrideDateYmd?: string): Promise<string | null> => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      const currentTime = selectedTime();
      const dateYmd = overrideDateYmd ?? getDateYmdForMediaApi();

      if (!className || !projectId) {
        logWarn('VideoSync: Missing className or projectId for fetching media sources', { className, projectId });
        return null;
      }
      if (!overrideDateYmd && !currentTime) {
        logWarn('VideoSync: Missing currentTime and no override date for fetching media sources', { currentTime });
        return null;
      }
      const tryDate = async (d: string) => {
        const url = `/api/media/sources?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(d)}`;
        const response = await getData(url);
        if (!response.success || response.data == null) return [];
        const list = Array.isArray(response.data) ? response.data : [];
        return list.map((r: any, i: number) => ({
          id: r.id || r.media_source || r.name || `src_${i}`,
          name: r.name || r.media_source || r.id || `Source ${i + 1}`,
        }));
      };
      let sources = await tryDate(dateYmd);
      effectiveMediaDateYmd = dateYmd;
      if (sources.length === 0) {
        const next = await tryDate(addDayYmd(dateYmd, 1));
        if (next.length > 0) {
          sources = next;
          effectiveMediaDateYmd = addDayYmd(dateYmd, 1);
          logDebug('VideoSync: no sources for primary date, using next day', { primary: dateYmd, used: effectiveMediaDateYmd });
        }
      }
      if (sources.length === 0) {
        const prev = await tryDate(addDayYmd(dateYmd, -1));
        if (prev.length > 0) {
          sources = prev;
          effectiveMediaDateYmd = addDayYmd(dateYmd, -1);
          logDebug('VideoSync: no sources for primary date, using previous day', { primary: dateYmd, used: effectiveMediaDateYmd });
        }
      }
      setMediaSources(sources);
      const used = effectiveMediaDateYmd ?? dateYmd;
      setMediaDateYmd(used);
      logInfo('VideoSync: Loaded media sources', { sources, count: sources.length, dateYmdUsed: used });
      return used;
    } catch (error: any) {
      logError('VideoSync: Error fetching media sources', error);
      setMediaSources([]);
      return null;
    }
  };

  const gridSources = () => {
    const sources = mediaSources();
    const focusId = fullScreenSourceId();
    if (focusId) {
      const single = sources.filter((s) => (s?.id || "").toLowerCase() === focusId.toLowerCase());
      logDebug('VideoSync: gridSources (full screen)', { focusId, single: single.length });
      return single.length > 0 ? single : sources.slice(0, 8);
    }
    logDebug('VideoSync: gridSources called', { sourcesCount: sources.length });
    return sources.slice(0, 8);
  };

  const handleSyncAllSourcesRequest = async (offsetMs: number) => {
    const windows = mediaWindows();
    if (!windows || windows.length === 0) {
      logWarn('VideoSync: Sync all sources – no media windows to update');
      return;
    }
    const confirmed = window.confirm(
      'This will update start/end times for all video from all media sources to match the known time. Continue?'
    );
    if (!confirmed) {
      logInfo('VideoSync: Sync all sources cancelled by user');
      return;
    }
    const className = selectedClassName();
    const projectId = selectedProjectId();
    if (!className || !projectId) {
      logError('VideoSync: Missing className or projectId for sync all');
      return;
    }
    const getCookie = (name: string): string => {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return parts.pop()?.split(';').shift() ?? '';
      return '';
    };
    const csrfToken = getCookie('csrf_token') || '';
    const mediaUrl = '/api/admin/media';
    try {
      const updatePromises = windows.map(async (window: { id?: string | number; start: Date; end: Date; sourceId?: string }) => {
        if (!window.id) {
          logWarn('VideoSync: Sync all – window missing ID, skipping', window);
          return;
        }
        const start = window.start instanceof Date ? window.start : new Date(window.start);
        const end = window.end instanceof Date ? window.end : new Date(window.end);
        const newStart = new Date(start.getTime() + offsetMs);
        const newEnd = new Date(end.getTime() + offsetMs);
        const response = await fetch(mediaUrl, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({
            class_name: className,
            project_id: projectId,
            media_id: Number(window.id),
            start_time: newStart.toISOString(),
            end_time: newEnd.toISOString(),
          }),
        });
        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`Failed to update media ${window.id}: ${response.status} ${errorText}`);
        }
        logInfo('VideoSync: Sync all – updated media', window.id);
      });
      await Promise.all(updatePromises);
      logInfo('VideoSync: Sync all – all media windows updated', { count: windows.length });
      const uniqueDatesBySource = new Map<string, Set<string>>();
      windows.forEach((window: { start: Date; end: Date; sourceId?: string }) => {
        const sid = window.sourceId ?? '';
        if (!uniqueDatesBySource.has(sid)) uniqueDatesBySource.set(sid, new Set());
        const start = window.start instanceof Date ? window.start : new Date(window.start);
        const startDateStr = start.toISOString().split('T')[0];
        uniqueDatesBySource.get(sid)!.add(startDateStr);
        const newStart = new Date(start.getTime() + offsetMs);
        uniqueDatesBySource.get(sid)!.add(newStart.toISOString().split('T')[0]);
      });
      const { mediaFilesService } = await import('../services/mediaFilesService');
      for (const [sourceId, dateStrs] of uniqueDatesBySource) {
        for (const dateStr of dateStrs) {
          const date = new Date(dateStr + 'T00:00:00');
          await mediaFilesService.refreshCache(sourceId, date);
          logInfo('VideoSync: Sync all – refreshed media cache', { sourceId, date: dateStr });
        }
      }
      if (videoSyncTimeSeriesRef?.refreshData) {
        await videoSyncTimeSeriesRef.refreshData(mediaDateYmd() ?? undefined);
      }
      setMediaRefreshKey((k) => k + 1);
      const currentTime = selectedTime();
      if (currentTime && videoRef && isVideoInitialized) {
        setSelectedTime(new Date(currentTime.getTime() + 1), 'videosync');
        requestAnimationFrame(() => setSelectedTime(currentTime, 'videosync'));
      }
    } catch (error) {
      logError('VideoSync: Sync all – error applying time corrections', error);
    }
  };

  // Function to start the selectedTime update interval
  const startSelectedTimeUpdateInterval = () => {
    // Stop any existing interval first
    stopVideoIntervals();
    
    // Don't request time control here - we release it when playback starts
    // and let the playback system handle it. We'll update selectedTime
    // directly during playback (playback allows video-driven updates)
    const currentActive = activeComponent && typeof activeComponent === 'function' ? activeComponent() : null;
    const hasControl = currentActive === 'videosync';
    
    if (!hasControl && currentActive !== 'playback') {
      // Only request control if playback doesn't have it and we don't have it
      // This handles the case where playback hasn't started yet
      const requested = requestTimeControl('videosync');
      if (!requested) {
        logDebug('🎥 VideoSync: Could not get time control, will try direct updates');
      }
    }
    
    const updateInterval = () => {
      if (!videoRef || !isVideoInitialized || !isPlaying()) {
        logDebug('🎥 VideoSync: Stopping update interval - conditions not met', {
          hasVideoRef: !!videoRef,
          isVideoInitialized,
          isPlaying: isPlaying()
        });
        stopVideoIntervals();
        return;
      }
      
      // Don't update if video is paused (even if isPlaying() is true, video might not be playing yet)
      if (videoRef.paused) {
        logDebug('🎥 VideoSync: Video is paused, skipping update');
        return;
      }
      
      try {
        const videoTimeSeconds = videoRef.currentTime;
        const timeRange = getDataTimeRange();
        
        if (!timeRange || !timeRange.start || !timeRange.end || !videoDuration) {
          logDebug('🎥 VideoSync: Missing time range or video duration', {
            hasTimeRange: !!timeRange,
            hasStart: !!timeRange?.start,
            hasEnd: !!timeRange?.end,
            videoDuration
          });
          return;
        }
        
        // Convert video time back to data time (selectedTime)
        const ratio = videoTimeSeconds / videoDuration;
        const dataDuration = timeRange.end.getTime() - timeRange.start.getTime();
        const dataTime = new Date(timeRange.start.getTime() + (ratio * dataDuration));
        
        // Check if this update would cause a significant jump (more than 1 second)
        // This prevents overriding user's manual time selection
        const currentSelectedTime = selectedTime();
        if (currentSelectedTime) {
          const timeDiff = Math.abs(dataTime.getTime() - currentSelectedTime.getTime());
          if (timeDiff > 1000) {
            // Large difference - might be a manual change or video seek, skip this update
            logDebug('🎥 VideoSync: Skipping update - large time difference', {
              videoTime: videoTimeSeconds,
              calculatedTime: dataTime.toISOString(),
              currentSelectedTime: currentSelectedTime.toISOString(),
              diffMs: timeDiff
            });
            return;
          }
        }
        
        // During playback, we don't need to request control - playback system handles it
        // But we still need to update selectedTime based on video time
        // Try to update without requesting control first (if playback has control, it will allow it)
        // If that fails, try requesting control
        const currentActive = activeComponent && typeof activeComponent === 'function' ? activeComponent() : null;
        if (currentActive === 'playback') {
          // Playback system has control - update directly (it will allow video-driven updates)
          setSelectedTime(dataTime, 'videosync');
          logDebug('🎥 VideoSync: Updated selectedTime from video (playback has control)', {
            videoTime: videoTimeSeconds,
            selectedTime: dataTime.toISOString()
          });
        } else if (requestTimeControl('videosync')) {
          setSelectedTime(dataTime, 'videosync');
          logDebug('🎥 VideoSync: Updated selectedTime from video', {
            videoTime: videoTimeSeconds,
            selectedTime: dataTime.toISOString()
          });
        } else {
          logDebug('🎥 VideoSync: Could not get time control for update, trying direct update');
          // Last resort: try updating anyway (might work if no one has control)
          try {
            setSelectedTime(dataTime, 'videosync');
          } catch (e) {
            logWarn('🎥 VideoSync: Direct update also failed', e);
          }
        }
      } catch (error: any) {
        logWarn('🎥 VideoSync: Error updating selectedTime from video', error);
      }
    };
    
    // Update selectedTime based on video playback
    // Use a reasonable interval (e.g., 100ms) to keep selectedTime in sync
    logInfo('🎥 VideoSync: Starting selectedTime update interval', { hasControl });
    videoUpdateInterval = setInterval(updateInterval, 100);
    
    // Also call immediately to set initial time
    updateInterval();
  };

  // Handle play/pause state - video is now passive
  createEffect(() => {
    const currentPlayState = isPlaying();
    const speed = playbackSpeed();

    // Always release control when playback starts, even if video isn't initialized yet
    // This allows the playback system to get control immediately
    if (currentPlayState && currentPlayState !== previousPlayState) {
      logDebug('🎥 VideoSync: Playback state changed to playing', { speed, videoInitialized: isVideoInitialized });
      
      // Release time control IMMEDIATELY to allow playback system to take over
      // Do this synchronously before any async operations to prevent race conditions
      releaseTimeControl('videosync');
      const currentActive = activeComponent && typeof activeComponent === 'function' ? activeComponent() : null;
      logInfo('🎥 VideoSync: Released time control for playback system', {
        currentActive,
        wasVideosync: currentActive === 'videosync'
      });
    }

    if (videoRef && isVideoInitialized) {
      if (currentPlayState && (currentPlayState !== previousPlayState || videoRef.paused)) {
        logDebug('🎥 VideoSync: Starting playback', { speed });
        
        // If video hasn't started loading yet, trigger it now
        if (videoRef.readyState === 0) {
          logDebug('🎥 VideoSync: Triggering video load for playback');
          videoRef.load();
        }

        // For speed = 1, play normally
        // For speed > 1, we'll handle frame skipping in a separate effect
        videoRef.playbackRate = 1.0;
        
        videoRef.play().then(() => {
          logDebug('🎥 VideoSync: Video play() resolved, starting update interval');
          // Start interval after video actually starts playing
          // Small delay to ensure video is playing and playback system has control
          setTimeout(() => {
            if (isPlaying() && videoRef && !videoRef.paused) {
              startSelectedTimeUpdateInterval();
            }
          }, 150); // Increased delay to ensure playback system has time to get control
        }).catch(error => {
          logError('🎥 VideoSync: Play failed', error);
        });
        
      } else if (!currentPlayState && currentPlayState !== previousPlayState) {
        logDebug('🎥 VideoSync: Pausing playback');
        videoRef.pause();
        stopVideoIntervals();
        // Re-request time control when playback stops (for timeline clicks)
        requestTimeControl('videosync');
      }
    }
    previousPlayState = currentPlayState;
  });
  
  // Ensure interval is running if playback is active (safety check)
  // Note: Manual time changes (timeline clicks) should stop playback, not restart it
  createEffect(() => {
    const playing = isPlaying();
    const manualChange = isManualTimeChange();
    
    // Only ensure interval is running if playing and NOT during a manual change
    // Manual changes should stop playback (handled in onTimelineClick)
    if (playing && videoRef && isVideoInitialized && !manualChange) {
      // Safety check: ensure interval is running if it's missing
      if (!videoUpdateInterval) {
        logInfo('🎥 VideoSync: Playback active but no interval, starting it');
        startSelectedTimeUpdateInterval();
      }
    }
  });

  // Handle playback speed changes - implement frame skipping for speed > 1
  createEffect(() => {
    const speed = playbackSpeed();
    const playing = isPlaying();
    
    logDebug('🎥 VideoSync: Speed/Play state changed', { speed, playing, videoInitialized: isVideoInitialized });
    
    if (videoRef && isVideoInitialized) {
      if (playing && speed > 1) {
        logDebug('🎥 VideoSync: Speed > 1, implementing frame skipping', { speed });
        
        // For speed > 1, we need to skip frames
        // We'll advance the video position based on the speed and data timestep
        // Use fixed 1Hz (1000ms) for non-live data
        const baseInterval = 1000; // Fixed 1Hz interval
        
        // Calculate how much to advance video time per frame
        const videoAdvancement = baseInterval * speed; // milliseconds
        
        // Set up frame skipping interval
        stopVideoIntervals();
        videoUpdateInterval = setInterval(() => {
          if (!isPlaying() || playbackSpeed() <= 1) {
            logDebug('🎥 VideoSync: Stopping frame skipping interval');
            clearInterval(videoUpdateInterval);
            videoUpdateInterval = null;
            return;
          }
          
          // Advance video by the calculated amount
          const currentTime = videoRef.currentTime;
          const newTime = currentTime + (videoAdvancement / 1000); // Convert to seconds
          
          if (newTime < videoDuration) {
            videoRef.currentTime = newTime;
            
            // Update selectedTime based on new video time
            const timeRange = getDataTimeRange();
            if (timeRange && timeRange.start && timeRange.end && videoDuration) {
              const ratio = newTime / videoDuration;
              const dataDuration = timeRange.end.getTime() - timeRange.start.getTime();
              const dataTime = new Date(timeRange.start.getTime() + (ratio * dataDuration));
              
              if (requestTimeControl('videosync')) {
                setSelectedTime(dataTime, 'videosync');
              }
            }
          } else {
            // Reached end of video, pause
            logDebug('🎥 VideoSync: Reached end of video, pausing');
            setIsPlaying(false);
          }
        }, baseInterval / speed); // Update at the speed-adjusted interval
        
      } else if (playing && speed === 1) {
        logDebug('🎥 VideoSync: Speed = 1, normal playback');
        // Normal playback - video plays at 1x speed
        videoRef.playbackRate = 1.0;
        // Don't stop intervals here - the play/pause effect handles the selectedTime update interval
        // The interval should already be running from the play/pause effect
        // Make sure video is playing for normal speed
        if (videoRef.paused) {
          videoRef.play().catch(error => {
            logError('🎥 VideoSync: Play failed for normal speed', error);
          });
        }
        
        // Ensure the update interval is running (in case it was cleared)
        if (!videoUpdateInterval && videoRef && isVideoInitialized) {
          logInfo('🎥 VideoSync: Speed=1 detected missing interval, ensuring it restarts via play/pause effect');
          // The play/pause effect should handle restarting, but we can trigger it by toggling
          // Actually, don't do anything - let the play/pause effect handle it
        }
      } else {
        // Not playing or speed <= 1, stop any frame skipping and pause video
        logDebug('🎥 VideoSync: Stopping playback and frame skipping');
        stopVideoIntervals();
        if (!videoRef.paused) {
          videoRef.pause();
        }
      }
    }
  });

  // Load video configuration
  const loadVideoConfig = async () => {
    try {
      const response = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user().user_id)}&parent_name=video&object_name=${selectedPage()}`);
      
      if (response.success && response.data) {
        setVideoConfig(response.data);
        logInfo('VideoSync: Loaded video config', response.data);
        logDebug('VideoSync: Video config sources', response.data.sources);
        logDebug('VideoSync: Full response data structure', {
          hasChartInfo: !!response.data.chart_info,
          chartInfo: response.data.chart_info,
          sources: response.data.sources,
          sourcesType: typeof response.data.sources,
          sourcesLength: response.data.sources?.length
        });
      } else {
        // Use default configuration
        const defaultConfig = {
          layout: 1,
          sources: ['Youtube']
        };
        setVideoConfig(defaultConfig);
        logInfo('VideoSync: Using default video config', defaultConfig);
      }
    } catch (error: any) {
      logError('VideoSync: Error loading video config', error);
      // Use default configuration on error
      const defaultConfig = {
        layout: 1,
        sources: ['Youtube']
      };
      setVideoConfig(defaultConfig);
    }
  };

  onMount(async () => {
    logInfo('VideoSync: onMount starting');
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const dateParam = params.get('date') || params.get('selecteddate');
    if (dateParam) {
      const ymd = String(dateParam).replace(/\D/g, '').trim().slice(0, 8);
      if (ymd.length === 8) {
        setSelectedDate(ymd);
        logDebug('VideoSync: set selectedDate from URL param', { date: ymd });
      }
    }
    // Set current dataset so Video component can use getCurrentDatasetTimezone() for media API date (backend media.date is in dataset TZ)
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const datasetId = typeof selectedDatasetId === "function" ? selectedDatasetId() : null;
    if (className && projectId && datasetId && datasetId > 0) {
      await setCurrentDataset(className, projectId, datasetId);
    }
    await loadVideoConfig();
    const dateYmd = await getDateYmdForMediaApiAsync();
    logInfo('VideoSync: date for initial media fetch', { dateYmd });
    await fetchMediaSources(dateYmd);
    
    // Add global sync function for debugging
    //@ts-ignore
    window.syncVideoToSelectedTime = () => {
      const currentTime = selectedTime();
      if (videoRef && currentTime instanceof Date && videoDuration) {
        const videoTimeSeconds = selectedTimeToVideoTime(currentTime);
        logDebug('🎥 VideoSync: Manual sync called', {
          selectedTime: currentTime.toISOString(),
          videoTime: videoTimeSeconds,
          videoDuration: videoDuration
        });
        try {
          videoRef.currentTime = videoTimeSeconds;
          logDebug('🎥 VideoSync: Manual sync successful');
        } catch (error: any) {
          logWarn('🎥 VideoSync: Manual sync failed', error);
        }
      } else {
        logWarn('🎥 VideoSync: Manual sync failed - missing requirements', {
          videoRef: !!videoRef,
          currentTime: currentTime?.toISOString(),
          videoDuration: videoDuration
        });
      }
    };

    // Add global function to set time range manually
    //@ts-ignore
    window.setVideoTimeRange = (startTime, endTime) => {
      logDebug('🎥 VideoSync: Setting manual time range', {
        start: startTime,
        end: endTime
      });
      //@ts-ignore
      window.videoTimeRange = {
        start: new Date(startTime),
        end: new Date(endTime)
      };
    };

    // Add global function to test video sync with current data
    //@ts-ignore
    window.testVideoSync = () => {
      logDebug('🎥 VideoSync: Testing video sync...');
      const currentTime = selectedTime();
      const timeRange = getDataTimeRange();
      const videoTime = selectedTimeToVideoTime(currentTime);
      
      logDebug('🎥 VideoSync: Test results', {
        selectedTime: currentTime?.toISOString(),
        timeRange: timeRange ? {
          start: timeRange.start.toISOString(),
          end: timeRange.end.toISOString()
        } : null,
        videoDuration: videoDuration,
        calculatedVideoTime: videoTime,
        videoRef: !!videoRef,
        videoCurrentTime: videoRef?.currentTime
      });
      
      if (videoRef && videoTime > 0) {
        try {
          videoRef.currentTime = videoTime;
          logDebug('🎥 VideoSync: Test sync successful - set to', videoTime);
        } catch (error: any) {
          logWarn('🎥 VideoSync: Test sync failed', error);
        }
      }
    };
  });

  // Handle cleanup when component unmounts
  onCleanup(() => {
    logDebug('🎥 VideoSync: Cleaning up component');
    stopVideoIntervals();
    
    // Clear video load timeout
    if (videoLoadTimeout) {
      clearTimeout(videoLoadTimeout);
      videoLoadTimeout = null;
    }
    
    // Release time control when component unmounts
    releaseTimeControl('videosync');
    
    // Reset all flags and clean up global reference
    isVideoInitialized = false;
    videoDuration = null;
    previousPlayState = false;
    //@ts-ignore
    window.videoComponent = null;
  });

  return (
    <div class="video-sync-page h-screen bg-gray-100 dark:bg-gray-900">
      <div class="vs-grid" style={{ height: '100%', width: '100%', 'grid-template-rows': '65% 20% 1fr', display: 'grid' }}>
        {/* Row 1: Video Grid (65%) */}
        <div class="relative overflow-hidden" style={{ padding: '8px', 'padding-right': '30px' }}>
          <Show when={fullScreenSourceId()}>
            <button
              type="button"
              onClick={() => setFullScreenSourceId(null)}
              class="absolute top-3 left-3 z-10 px-3 py-1.5 text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white rounded shadow"
              title="Show all videos"
            >
              Back to all videos
            </button>
          </Show>
          <div class="w-full h-full vs-video-grid" style={{ display: 'grid', gap: '8px', 'grid-template-columns': fullScreenSourceId() ? '1fr' : 'repeat(auto-fit, minmax(200px, 1fr))', height: '100%', 'max-height': '100%', 'align-items': 'stretch' }}>
            <Show when={gridSources().length > 0} fallback={<div class="col-span-full flex items-center justify-center text-gray-500">No video sources available</div>}>
              <For each={gridSources()}>
                {(source, idx) => {
                  logDebug('VideoSync: Rendering video source', { source, idx: idx(), totalSources: gridSources().length });
                  return (
                <div
                  class="relative bg-black flex flex-col"
                  style={{ position: 'relative', width: '100%', height: '100%', 'max-height': '100%', 'min-height': '150px', border: '2px solid rgba(255,255,255,0.3)', 'border-radius': '8px', overflow: 'visible', display: 'flex', 'flex-direction': 'column', 'box-sizing': 'border-box', 'align-self': 'stretch' }}
                >
                  <div style={{ position: 'absolute', top: '6px', left: '6px', 'z-index': 2, 'background-color': 'rgba(0,0,0,0.7)', color: '#fff', padding: '4px 8px', 'border-radius': '4px', 'font-size': '12px', 'font-weight': 'bold', 'pointer-events': 'none' }}>
                    {source.name}
                  </div>
                  <div class="flex-1 relative" style={{ height: 'auto', width: '100%', overflow: 'hidden', 'flex-grow': 1, 'min-height': '0' }}>
                    <VideoComponent
                      media_source={source.id}
                      mediaDateYmd={mediaDateYmd() ?? (() => { const sd = typeof selectedDate === 'function' ? selectedDate() : ''; return (sd && String(sd).trim()) ? String(sd).replace(/-/g, '').trim().slice(0, 8) : null; })()}
                      mediaRefreshTrigger={mediaRefreshKey()}
                      width="100%"
                      height="100%"
                      style="width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: cover; border-radius: 6px; display: block;"
                    />
                  </div>
                  <div style={{ width: '100%', 'z-index': 3, 'flex-shrink': 0, position: 'relative' }}>
                    <VideoSyncHelper
                      mediaSource={source}
                      mediaWindows={mediaWindows().filter(w => w.sourceId?.toLowerCase() === source.id?.toLowerCase())}
                      selectedWindows={selectedWindows().filter(w => w.sourceId?.toLowerCase() === source.id?.toLowerCase())}
                      datasetTimezone={resolvedTimezone()}
                      mediaDateYmd={mediaDateYmd() ?? (() => { const sd = typeof selectedDate === 'function' ? selectedDate() : ''; return (sd && String(sd).trim()) ? String(sd).replace(/-/g, '').trim().slice(0, 8) : null; })()}
                      onUpdateComplete={async () => {
                        // Refresh media windows for this source
                        await fetchMediaWindows(source.id);
                        // Refresh timeline so bars show updated start/end
                        if (videoSyncTimeSeriesRef && videoSyncTimeSeriesRef.refreshData) {
                          logInfo('VideoSync: Refreshing timeline after media update');
                          await videoSyncTimeSeriesRef.refreshData(mediaDateYmd() ?? undefined);
                        }
                        // Tell Video components to refetch media files (cache already refreshed by VideoSyncHelper)
                        setMediaRefreshKey((k) => k + 1);
                        // Force video sync to update with new start/end times
                        const currentTime = selectedTime();
                        if (currentTime && videoRef && isVideoInitialized) {
                          logInfo('VideoSync: Forcing video sync after offset update', {
                            selectedTime: currentTime.toISOString()
                          });
                          setSelectedTime(new Date(currentTime.getTime() + 1), 'videosync');
                          requestAnimationFrame(() => {
                            setSelectedTime(currentTime, 'videosync');
                          });
                        }
                      }}
                      onTimelineRefresh={() => {
                        // Refresh VideoSyncTimeSeries timeline
                        if (videoSyncTimeSeriesRef && videoSyncTimeSeriesRef.refreshData) {
                          logInfo('VideoSync: Refreshing timeline after media update (onTimelineRefresh)');
                          videoSyncTimeSeriesRef.refreshData();
                        }
                      }}
                      onSyncAllSourcesRequest={handleSyncAllSourcesRequest}
                    />
                  </div>
                </div>
                  );
                }}
              </For>
            </Show>
          </div>
        </div>

        {/* Row 2: Timeline (20%) - always visible so axes and timeline show */}
        <div class="relative video-sync-timeline-row" style={{ height: '100%', minHeight: '120px' }}>
          <VideoSyncTimeSeries
            datasetTimezone={resolvedTimezone()}
            initialDateYmd={mediaDateYmd()}
            ref={(el) => (videoSyncTimeSeriesRef = el)}
            onWindowDoubleClick={(window) => {
              if (window) {
                setFullScreenSourceId(window.sourceId ?? null);
                const startDate = window.start instanceof Date ? window.start : new Date(window.start);
                if (requestTimeControl('videosync')) {
                  setSelectedTime(new Date(startDate.getTime()), 'videosync');
                  logInfo('VideoSync: Full screen for source, selectedTime at window start', { sourceId: window.sourceId, start: startDate.toISOString() });
                }
                const cfg = videoConfig();
                if (cfg && Array.isArray(cfg.sources)) {
                  const name = mediaSources().find((s) => (s?.id || "").toLowerCase() === (window.sourceId || "").toLowerCase())?.name ?? window.sourceId;
                  const idx = cfg.sources.findIndex((s) => (s || "").toLowerCase() === String(name || window.sourceId).toLowerCase());
                  if (idx >= 0) setCurrentVideoSource(idx);
                }
              } else {
                setFullScreenSourceId(null);
                logInfo('VideoSync: Back to all videos');
              }
            }}
            onSelectSource={({ id, name }) => {
              try {
                // Set selected source and fetch media windows
                setSelectedSourceId(id);
                fetchMediaWindows(id);
                
                // Switch the current video source index if present in config
                const cfg = videoConfig();
                if (cfg && Array.isArray(cfg.sources)) {
                  const idx = cfg.sources.findIndex(s => (s || '').toLowerCase() === String(name || id).toLowerCase());
                  if (idx >= 0) {
                    setCurrentVideoSource(idx);
                    logInfo('VideoSync: source selected from timeline, switching video', { id, name, idx });
                  } else {
                    // If not found by name, try id matching if cfg stores ids
                    const idxById = cfg.sources.findIndex(s => (s && s.id) ? String(s.id) === String(id) : false);
                    if (idxById >= 0) {
                      setCurrentVideoSource(idxById);
                      logInfo('VideoSync: source selected by id, switching video', { id, name, idx: idxById });
                    } else {
                      logWarn('VideoSync: clicked source not in current config.sources', { id, name, sources: cfg.sources });
                    }
                  }
                }
              } catch (e) {
                logWarn('VideoSync: error selecting source from timeline', e);
              }
            }}
            onSelectionChange={(selectedWindowsData) => {
              setSelectedWindows(selectedWindowsData);
              logInfo('VideoSync: selection changed', { 
                count: selectedWindowsData.length,
                selectedWindows: selectedWindowsData.map(w => ({ id: w.id, fileName: w.fileName, sourceId: w.sourceId }))
              });
            }}
            onMediaWindowsChange={(allWindows) => {
              setMediaWindows(allWindows);
              logInfo('VideoSync: media windows updated', { 
                count: allWindows.length,
                windows: allWindows.map(w => ({ id: w.id, fileName: w.fileName, sourceId: w.sourceId }))
              });
            }}
            onTimelineClick={(clickedTime) => {
              try {
                // clickedTime is UTC instant from VideoSyncTimeSeries (scale domain is UTC).
                if (isPlaying()) {
                  logInfo('VideoSync: Timeline clicked during playback - stopping playback');
                  setIsPlaying(false);
                  stopVideoIntervals();
                  if (videoRef && isVideoInitialized) {
                    videoRef.pause();
                  }
                }
                if (requestTimeControl('videosync')) {
                  setIsManualTimeChange(true);
                  setSelectedTime(clickedTime instanceof Date ? clickedTime : new Date(clickedTime), 'videosync');
                  logInfo('VideoSync: timeline clicked, setting selectedTime (UTC)', { clickedTime: (clickedTime instanceof Date ? clickedTime : new Date(clickedTime)).toISOString() });
                } else {
                  logWarn('VideoSync: failed to get time control for timeline click');
                }
              } catch (e) {
                logWarn('VideoSync: error handling timeline click', e);
              }
            }}
          />
        </div>

        {/* Row 3: Controls (remaining space) – local time for sync: display current time in local, go to time input interpreted as local */}
        <div class="relative flex flex-wrap items-center justify-between gap-3 px-4">
          <BackButton />
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm text-gray-600 dark:text-gray-400">Time (local):</span>
            <span class="text-sm font-mono tabular-nums">{currentTimeLocal() || "—"}</span>
            <input
              type="text"
              class="w-24 rounded border border-gray-300 bg-white px-2 py-1 text-sm font-mono dark:border-gray-600 dark:bg-gray-800"
              placeholder="HH:mm"
              value={goToTimeInput()}
              onInput={(e) => setGoToTimeInput((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === "Enter" && handleGoToTime()}
            />
            <button
              type="button"
              class="rounded bg-primary px-3 py-1 text-sm text-white hover:opacity-90"
              onClick={handleGoToTime}
            >
              Go
            </button>
          </div>
          <PlayPause position="videosync-bottom-left" allowFastFwd={true} allowTimeWindow={false} />
        </div>
      </div>
    </div>
  );
}
