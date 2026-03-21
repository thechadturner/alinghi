import { createEffect, onMount, onCleanup, createSignal, createMemo, Show, untrack } from "solid-js";

// Removed Overlay import - moved to Video page

import { isPlaying, playbackSpeed, selectedTime, setSelectedTime, syncSelectedTimeManual } from "../../store/playbackStore";
import { persistantStore } from "../../store/persistantStore";
import { debug as logDebug, warn as logWarn, error as logError } from "../../utils/console";
// Local debug gate to reduce noisy logs during playback
const VIDEO_DEBUG_ENABLED = false;
/** Time to wait for initial video data before showing load timeout (ms). Large files / slow networks may need longer. */
const VIDEO_LOAD_TIMEOUT_MS = 60000;
import { config, apiEndpoints } from "../../config/env";
import { getData } from "../../utils/global";
import { mediaFilesService } from "../../services/mediaFilesService";
import { getCurrentDatasetTimezone } from "../../store/datasetTimezoneStore";
import { getMediaUrl, getAlternativeMediaUrls, testMediaServerConnectivity, getNetworkConfigString } from "../../utils/networkConfig";

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

interface VideoPlayerProps {
  [key: string]: any;
}

interface MediaFile {
  start: Date;
  end: Date;
  fileName: string;
  id: string;
}

interface PlaybackPerformance {
  lastCheck: number;
  frameCount: number;
  isSlow: boolean;
}

const VideoPlayer = (props: VideoPlayerProps) => {
  let videoRef: HTMLVideoElement | undefined;
  let previousPlayState = false;
  let isVideoInitialized = false;
  let videoDuration: number | null = null;
  let videoUpdateInterval: ReturnType<typeof setInterval> | null = null;
  let videoLoadTimeout: ReturnType<typeof setTimeout> | null = null;
  let transitionClearTimeout: ReturnType<typeof setTimeout> | null = null;
  let hasWarnedLoadTimeout = false; // Only warn once per instance to avoid console spam (e.g. multiple tiles)
  const [isVideoLoading, setIsVideoLoading] = createSignal(false);
  const [videoError, setVideoError] = createSignal<string | null>(null);
  // Cache the first detected data time range to keep mapping stable
  let fixedDataStart: Date | null = null;
  let fixedDataEnd: Date | null = null;

  
  // Media source and file management
  const [mediaFiles, setMediaFiles] = createSignal<MediaFile[]>([]); // [{ start, end, fileName, id }]
  const [currentFile, setCurrentFile] = createSignal<MediaFile | null>(null);
  const [currentQuality, setCurrentQuality] = createSignal(config.MEDIA_MED_RES_ONLY ? 'med_res' : 'high_res');
  const [qualityGracePeriod, setQualityGracePeriod] = createSignal<ReturnType<typeof setTimeout> | null>(null);
  const [playbackPerformance, setPlaybackPerformance] = createSignal<PlaybackPerformance>({ lastCheck: 0, frameCount: 0, isSlow: false });
  const [isTransitioning, setIsTransitioning] = createSignal(false);
  const [timeToNextVideo, setTimeToNextVideo] = createSignal<Date | null>(null);
  const [hasEnded, setHasEnded] = createSignal(false);
  const [mediaHealthy, setMediaHealthy] = createSignal(true);
  const [hasVideo, setHasVideo] = createSignal(false);
  const [nextVideo, setNextVideo] = createSignal<MediaFile | null>(null);
  const [isMuted, setIsMuted] = createSignal(true); // Start muted for autoplay compatibility
  const [isManualTimeChange, setIsManualTimeChange] = createSignal(false); // Local to each component
  const [isHovering, setIsHovering] = createSignal(false); // Track mouse hover state

  // Helpers for date values that may be Date or string (e.g. after IndexedDB/cache deserialization)
  const toDate = (d: Date | string | null | undefined): Date | null =>
    d == null ? null : d instanceof Date ? d : new Date(d as string);
  const toISO = (d: Date | string | null | undefined): string =>
    d == null ? '' : (d instanceof Date ? d : new Date(d as string)).toISOString();
  const toTime = (d: Date | string | null | undefined): number =>
    d == null ? 0 : (d instanceof Date ? d : new Date(d as string)).getTime();
  
  // Video preloading management
  const [preloadedVideos, setPreloadedVideos] = createSignal<Map<string, HTMLVideoElement>>(new Map()); // Map<fileName, videoElement>
  const MAX_PRELOADED_VIDEOS = 2; // Maximum videos to keep in memory

  // When currentTimeForTile is set (maneuver multi-tile), use it so each tile seeks/plays to (maneuver_i + offset). Else when fixedStartTime set (maneuver tile), when paused use selectedTime; when playing use global selectedTime.
  const effectiveTime = (): Date => {
    const ctf = props.currentTimeForTile;
    if (ctf != null && ctf !== undefined && (props.fixedStartTime != null || props.syncToSelectedTime === false)) {
      const d = typeof ctf === "string" ? new Date(ctf) : (ctf instanceof Date ? ctf : new Date(ctf as unknown as string));
      if (!Number.isNaN(d.getTime())) return d;
    }
    const t = props.fixedStartTime;
    if (t != null && t !== undefined && !isPlaying()) return selectedTime() ?? new Date(t);
    return selectedTime() ?? new Date();
  };

  // Maneuver tiles (fleet or dataset): do not sync to global selectedTime; use fixedStartTime as fallback so fleet never syncs even if prop is wrong.
  const isManeuverTile = (): boolean => props.syncToSelectedTime === false || props.fixedStartTime != null;

  // For initial file choice and fetch date only: use this tile's fixedStartTime when set (maneuver tiles), else effectiveTime().
  const timeForThisTile = (): Date => {
    const t = props.fixedStartTime;
    if (t != null && t !== undefined) {
      return typeof t === "string" ? new Date(t) : (t instanceof Date ? t : new Date(t as unknown as string));
    }
    return effectiveTime();
  };

  // Toggle mute state
  const toggleMute = () => {
    if (videoRef) {
      const newMutedState = !isMuted();
      videoRef.muted = newMutedState;
      setIsMuted(newMutedState);
      logDebug('🎥 Video: Mute toggled', { muted: newMutedState });
    }
  };


  // Sync video element muted state with our signal
  createEffect(() => {
    if (videoRef) {
      videoRef.muted = isMuted();
    }
  });

  // Manually manage video src to prevent unnecessary reloads
  let lastAppliedSrc: string | null = null;
  createEffect(() => {
    if (!videoRef) return;
    
    const newSrc = videoSrc();
    
    // Only update src if it actually changed (prevents reload when memo returns same value)
    // Compare with our tracked value, not videoRef.src (which might be modified by browser)
    if (newSrc !== lastAppliedSrc) {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Updating video src (single load path)', {
        from: lastAppliedSrc || '(empty)',
        to: newSrc ? '(url)' : '(empty)',
        fileName: currentFile()?.fileName
      });
      
      lastAppliedSrc = newSrc;
      
      if (newSrc) {
        videoRef.src = newSrc;
        videoRef.load();
        const handleMetadata = () => {
          const file = currentFile();
          if (!file) return;
          VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Video metadata loaded (from effect)', {
            fileName: file.fileName,
            duration: videoRef.duration
          });
          isVideoInitialized = true;
          videoDuration = videoRef.duration;
          if (isManeuverTile()) {
            if (props.fixedStartTime != null) {
              try {
                const fixedDate = typeof props.fixedStartTime === 'string' ? new Date(props.fixedStartTime) : new Date(props.fixedStartTime as any);
                const vt = selectedTimeToVideoTimeWithFile(fixedDate, file);
                videoRef.currentTime = vt;
                VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Sought to fixedStartTime on load (maneuver)', { fixedStartTime: String(props.fixedStartTime), videoTime: vt });
              } catch {}
            }
          } else {
            const st = effectiveTime();
            if (st instanceof Date) {
              try {
                const vt = selectedTimeToVideoTime(st);
                videoRef.currentTime = vt;
                VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Sought to selectedTime on load', { selectedTime: st.toISOString(), videoTime: vt });
              } catch {}
            }
          }
          if (isPlaying() && videoRef.paused) {
            videoRef.play().catch(error => {
              logWarn('🎥 Video: Failed to start playback after loading', error);
            });
          }
          handleVideoStart(file);
        };
        videoRef.addEventListener('loadedmetadata', handleMetadata, { once: true });
      } else {
        videoRef.src = '';
        videoRef.load();
      }
    }
  });

  // Debug black screen conditions
  createEffect(() => {
    const shouldShow = !hasVideo() || !mediaHealthy() || hasEnded() || (isVideoLoading() && !isManualTimeChange());
    VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Black screen condition check', {
      hasVideo: hasVideo(),
      mediaHealthy: mediaHealthy(),
      hasEnded: hasEnded(),
      isVideoLoading: isVideoLoading(),
      isManualTimeChange: isManualTimeChange(),
      shouldShow: shouldShow
    });
  });

  // Get transition message based on time to next video (accepts Date | string for cache compatibility)
  const getTransitionMessage = (nextVideoStartTime: Date | string | null): string => {
    const nextStart = toDate(nextVideoStartTime);
    VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: getTransitionMessage called', {
      nextVideoStartTime: toISO(nextVideoStartTime),
      hasNextVideoStartTime: !!nextStart
    });
    
    if (!nextStart) {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: No next video, returning black screen');
      return '';
    }
    
    const currentTime = effectiveTime();
    VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Current selectedTime', {
      currentTime: currentTime?.toISOString(),
      hasCurrentTime: !!currentTime
    });
    
    if (!currentTime) {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: No current time, returning black screen');
      return '';
    }
    
    const deltaSeconds = (nextStart.getTime() - currentTime.getTime()) / 1000;
    
    VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Calculating transition message', {
      currentTime: currentTime.toISOString(),
      nextVideoStart: nextStart.toISOString(),
      deltaSeconds: deltaSeconds,
      deltaMinutes: deltaSeconds / 60
    });
    
    if (deltaSeconds > 0) {
      const totalMins = Math.floor(deltaSeconds / 60);
      const secs = Math.floor(deltaSeconds % 60);
      let message: string;
      if (totalMins >= 24 * 60) {
        const days = Math.floor(totalMins / (24 * 60));
        const hours = Math.floor((totalMins % (24 * 60)) / 60);
        message = days > 0
          ? `Next Video in ${days}d ${hours}h`
          : `Next Video in ${hours}h`;
      } else {
        message = `Next Video in ${totalMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      }
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Returning countdown message', { message, deltaSeconds });
      return message;
    } else {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Next video should start now, returning black screen');
      return '';
    }
  };

  // Calculate data time range when data is available
  const getDataTimeRange = () => {
    try {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Getting data time range...');
      
      const dataStore = window['unifiedDataStore'];
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Data store available:', !!dataStore);
      if (dataStore && dataStore.getTimeRange) {
        const timeRange = dataStore.getTimeRange();
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Data store time range:', timeRange);
        if (timeRange && timeRange.start && timeRange.end) {
          const start = new Date(timeRange.start);
          const end = new Date(timeRange.end);
          if (!fixedDataStart || !fixedDataEnd) {
            fixedDataStart = new Date(start);
            fixedDataEnd = new Date(end);
            VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Fixed data range set from unifiedDataStore', { start: fixedDataStart.toISOString(), end: fixedDataEnd.toISOString() });
          }
          return { start: fixedDataStart || start, end: fixedDataEnd || end };
        }
      }
      
      const frequencyAnalysis = window['mapFrequencyAnalysis'];
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Frequency analysis available:', !!frequencyAnalysis);
      if (frequencyAnalysis && frequencyAnalysis.timeRange) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Frequency analysis time range:', frequencyAnalysis.timeRange);
        const start = new Date(frequencyAnalysis.timeRange.start);
        const end = new Date(frequencyAnalysis.timeRange.end);
        if (!fixedDataStart || !fixedDataEnd) {
          fixedDataStart = new Date(start);
          fixedDataEnd = new Date(end);
          VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Fixed data range set from frequencyAnalysis', { start: fixedDataStart.toISOString(), end: fixedDataEnd.toISOString() });
        }
        return { start: fixedDataStart || start, end: fixedDataEnd || end };
      }
      
      const globalData = window['globalDataStore'];
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Global data store available:', !!globalData);
      if (globalData && globalData.timeRange) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Global data time range:', globalData.timeRange);
        const start = new Date(globalData.timeRange.start);
        const end = new Date(globalData.timeRange.end);
        if (!fixedDataStart || !fixedDataEnd) {
          fixedDataStart = new Date(start);
          fixedDataEnd = new Date(end);
          VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Fixed data range set from globalData', { start: fixedDataStart.toISOString(), end: fixedDataEnd.toISOString() });
        }
        return { start: fixedDataStart || start, end: fixedDataEnd || end };
      }
      
      //@ts-ignore
      const manualTimeRange = window.videoTimeRange;
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Manual time range available:', !!manualTimeRange);
      if (manualTimeRange && manualTimeRange.start && manualTimeRange.end) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Using manual time range:', manualTimeRange);
        return {
          start: new Date(manualTimeRange.start),
          end: new Date(manualTimeRange.end)
        };
      }
      
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Available window properties:', Object.keys(window).filter(key => 
        key.includes('data') || key.includes('time') || key.includes('map') || key.includes('frequency')
      ));
      
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: No data time range found');
      return null;
    } catch (error: any) {
      logWarn('🎥 Video: Error getting data time range', error);
      return null;
    }
  };

  // Helper function to format date as YYYYMMDD for API calls
  const toYyyyMmDd = (d) => {
    try {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${yyyy}${mm}${dd}`;
    } catch (e) {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      return `${yyyy}${mm}${dd}`;
    }
  };

  // Date to use for media API: prefer selected date when selectedTime is still epoch (not yet set from data)
  const getDateForMediaFetch = (): Date => {
    const st = effectiveTime();
    const sd = persistantStore.selectedDate?.();
    const isEpoch =
      st.getUTCFullYear() === 1970 && st.getUTCMonth() === 0 && st.getUTCDate() === 1;
    if (isEpoch && sd && String(sd).trim()) {
      const d = new Date(String(sd).trim());
      if (!isNaN(d.getTime())) return d;
    }
    if (isEpoch) return new Date(); // Avoid 1970 when no selectedDate so we don't request media for epoch
    return st;
  };

  // Async version: when a dataset is selected, use its date for media API so we load video for that day
  const getDateForMediaFetchAsync = async (): Promise<Date> => {
    const datasetId = persistantStore.selectedDatasetId?.();
    if (datasetId && datasetId > 0) {
      try {
        const res = await getData(
          `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(persistantStore.selectedClassName())}&project_id=${encodeURIComponent(persistantStore.selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
        );
        if (res?.success && res?.data?.date) {
          let dateStr = String(res.data.date).trim();
          if (/^\d{8}$/.test(dateStr)) dateStr = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
          const d = new Date(dateStr);
          if (!isNaN(d.getTime())) {
            logDebug('🎥 Video: Using dataset date for media fetch', { datasetId, date: dateStr });
            return d;
          }
        }
      } catch (e) {
        logWarn('🎥 Video: Could not get dataset date for media fetch', e);
      }
    }
    return getDateForMediaFetch();
  };

  // Fetch media files using the cached service. When mediaDateYmd is set (e.g. from VideoSync), use it so we request the same day as the timeline and avoid UTC/local date mismatch.
  const fetchMediaFiles = async (mediaSource, targetDate = null) => {
    if (!mediaHealthy()) {
      logDebug('🎥 Video: Skipping media fetch - media server unhealthy');
      return [];
    }
    let dateToUse = targetDate ?? getDateForMediaFetch();
    const isEpoch =
      dateToUse.getUTCFullYear() === 1970 && dateToUse.getUTCMonth() === 0 && dateToUse.getUTCDate() === 1;
    if (isEpoch) dateToUse = getDateForMediaFetch();
    const datasetTz = getCurrentDatasetTimezone();
    const overrideDateYmd = props.mediaDateYmd != null && String(props.mediaDateYmd).trim() ? String(props.mediaDateYmd).trim().replace(/-/g, "").slice(0, 8) : null;
    try {
      logDebug('🎥 Video: Fetching media files for source', {
        mediaSource,
        targetDate: dateToUse?.toISOString(),
        timezone: datasetTz ?? 'UTC',
        overrideDateYmd: overrideDateYmd ?? undefined
      });

      const files = await mediaFilesService.getMediaFiles(mediaSource, dateToUse, datasetTz, overrideDateYmd || undefined);

      logDebug('🎥 Video: Retrieved media files', {
        filesCount: files.length,
        isCached: mediaFilesService.isCached(mediaSource, targetDate, datasetTz),
        cacheInfo: mediaFilesService.getCacheInfo()
      });
      
      return files;
    } catch (error: any) {
      logError('🎥 Video: Error fetching media files', error);
      return [];
    }
  };

  // When parent increments this (e.g. after video sync), refetch media files so we show updated start/end times.
  createEffect(() => {
    const trigger = props.mediaRefreshTrigger;
    if (trigger == null || typeof trigger !== 'number' || trigger <= 0 || !props.media_source) return;
    (async () => {
      try {
        const dateForFetch =
          props.fixedStartTime != null
            ? (typeof props.fixedStartTime === 'string' ? new Date(props.fixedStartTime) : new Date(props.fixedStartTime as unknown as string))
            : await getDateForMediaFetchAsync();
        const files = await fetchMediaFiles(props.media_source, dateForFetch);
        setMediaFiles(files);
        const currentTime = timeForThisTile();
        if (currentTime && files.length > 0) {
          const fileForTime = findFileForTime(currentTime, files) ?? files[0] ?? null;
          if (fileForTime) {
            setCurrentFile(fileForTime);
            setHasVideo(true);
            loadCurrentVideoFile(false, fileForTime);
            logDebug('🎥 Video: Refreshed media files after sync', { count: files.length, currentFile: fileForTime?.fileName });
          }
        }
      } catch (e) {
        logWarn('🎥 Video: Refresh after sync failed', e);
      }
    })();
  });

  // Media server health check
  const checkMediaHealth = async () => {
    try {
      const url = `${config.MEDIA_BASE_URL}/health`;
      const res = await fetch(url, { credentials: 'include' });
      const ok = res.ok;
      let healthy = false;
      if (ok) {
        try {
          const json = await res.json();
          healthy = json?.status === 'ok' || json?.status === 'ready';
        } catch (_e) {
          healthy = true; // 200 without JSON still treat as healthy
        }
      }
      setMediaHealthy(healthy);
      logDebug('🎥 Video: Media health check', { healthy, status: res.status });
      return healthy;
    } catch (e) {
      setMediaHealthy(false);
      logDebug('🎥 Video: Media health check failed');
      return false;
    }
  };

  // Test media server accessibility using network config
  const testMediaServerAccess = async () => {
    try {
      logDebug('🎥 Video: Testing media server accessibility using network config');
      const result = await testMediaServerConnectivity();
      
      logDebug('🎥 Video: Media server test result', {
        success: result.success,
        host: result.host,
        error: result.error,
        networkConfig: getNetworkConfigString()
      });
      
      return result.success;
    } catch (error: any) {
      logError('🎥 Video: Media server test failed', {
        error: error.message,
        networkConfig: getNetworkConfigString()
      });
      return false;
    }
  };

  // Test video URL accessibility with detailed debugging
  const testVideoUrlAccess = async (videoUrl) => {
    try {
      logDebug('🎥 Video: Testing video URL accessibility', { videoUrl });
      
      const response = await fetch(videoUrl, {
        method: 'HEAD',
        credentials: 'include',
        headers: {
          'Accept': 'video/mp4,video/*,*/*'
        }
      });
      
      logDebug('🎥 Video: Video URL test response', {
        url: videoUrl,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries())
      });
      
      return response.ok;
    } catch (error: any) {
      logError('🎥 Video: Video URL test failed', {
        url: videoUrl,
        error: error.message
      });
      return false;
    }
  };

  // Find the appropriate file for the current selectedTime. Compare using UTC millis to avoid UTC/local conversion issues.
  const findFileForTime = (selectedTime, files) => {
    VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Finding file for time', {
      selectedTime: selectedTime?.toISOString(),
      filesCount: files?.length,
      files: files
    });
    
    if (!selectedTime || !files || files.length === 0) {
      logDebug('🎥 Video: No files or selectedTime available');
      return null;
    }
    
    const t = selectedTime instanceof Date ? selectedTime.getTime() : new Date(selectedTime).getTime();
    
    // Find the file that contains the selectedTime (compare UTC millis)
    const matchingFile = files.find(file => {
      const startMs = file.start instanceof Date ? file.start.getTime() : new Date(file.start).getTime();
      const endMs = file.end instanceof Date ? file.end.getTime() : new Date(file.end).getTime();
      return t >= startMs && t <= endMs;
    });
    
    if (matchingFile) {
      logDebug('🎥 Video: Found matching file for time', {
        selectedTime: selectedTime.toISOString(),
        file: matchingFile.fileName,
        fileStart: toISO(matchingFile.start),
        fileEnd: toISO(matchingFile.end)
      });
      return matchingFile;
    }
    
    // If no file contains the time, find the next file
    const nextFile = files.find(file => {
      const startMs = file.start instanceof Date ? file.start.getTime() : new Date(file.start).getTime();
      return t < startMs;
    });
    if (nextFile) {
      logDebug('🎥 Video: Found next file for time', {
        selectedTime: selectedTime.toISOString(),
        nextFile: nextFile.fileName,
        nextFileStart: toISO(nextFile.start)
      });
      return nextFile;
    }
    
    VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: No file found for time', selectedTime.toISOString());
    return null;
  };

  const findNextVideo = (selectedTime, files) => {
    if (!selectedTime || !files || files.length === 0) {
      return null;
    }
    
    const t = selectedTime instanceof Date ? selectedTime.getTime() : new Date(selectedTime).getTime();
    // Find the next video that starts after the current time (compare UTC millis)
    const nextVideos = files
      .filter(file => (file.start instanceof Date ? file.start.getTime() : new Date(file.start).getTime()) > t)
      .sort((a, b) => (a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime()) - (b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime()));
    
    return nextVideos.length > 0 ? nextVideos[0] : null;
  };

  const calculateTimeToNextVideo = (selectedTime, nextVideo) => {
    if (!selectedTime || !nextVideo) {
      return null;
    }
    
    const timeToNext = (toTime(nextVideo.start) - (selectedTime instanceof Date ? selectedTime.getTime() : new Date(selectedTime).getTime())) / 1000; // Return seconds
    logDebug('🎥 Video: Calculated time to next video', {
      selectedTime: selectedTime instanceof Date ? selectedTime.toISOString() : new Date(selectedTime).toISOString(),
      nextVideoStart: toISO(nextVideo.start),
      timeToNext: timeToNext
    });
    return timeToNext;
  };

  // Smart video preloading system
  const preloadVideo = (file, quality = 'high_res') => {
    if (!mediaHealthy()) return null;
    if (!file || !file.fileName) return null;
    
    const videoUrl = getVideoUrl(file.fileName, quality);
    if (!videoUrl) return null;
    
    // Check if already preloaded
    const existing = preloadedVideos().get(file.fileName);
    if (existing) {
      logDebug('🎥 Video: Video already preloaded', { fileName: file.fileName });
      return existing;
    }
    
    // Create new video element for preloading
    const preloadVideo = document.createElement('video');
    preloadVideo.src = videoUrl;
    preloadVideo.preload = 'metadata';
    preloadVideo.crossOrigin = 'use-credentials';
    preloadVideo.style.display = 'none';
    preloadVideo.muted = true; // Muted for preloading
    
    // Add to DOM for preloading
    document.body.appendChild(preloadVideo);
    
    // Store in preloaded videos map
    const newPreloaded = new Map(preloadedVideos());
    newPreloaded.set(file.fileName, preloadVideo);
    setPreloadedVideos(newPreloaded);
    
    logDebug('🎥 Video: Preloading video', { 
      fileName: file.fileName, 
      url: videoUrl,
      preloadedCount: newPreloaded.size 
    });
    
    return preloadVideo;
  };

  const cleanupPreloadedVideo = (fileName: string) => {
    const preloaded = preloadedVideos().get(fileName);
    if (preloaded) {
      preloaded.pause();
      preloaded.removeAttribute('src');
      preloaded.load();
      preloaded.remove();
      const newPreloaded = new Map(preloadedVideos());
      newPreloaded.delete(fileName);
      setPreloadedVideos(newPreloaded);
      logDebug('🎥 Video: Cleaned up preloaded video', { fileName });
    }
  };

  const managePreloadMemory = () => {
    const preloaded = preloadedVideos();
    if (preloaded.size > MAX_PRELOADED_VIDEOS) {
      // Remove oldest preloaded video (simple FIFO for now)
      const firstKey = preloaded.keys().next().value;
      if (firstKey) {
        cleanupPreloadedVideo(firstKey);
      }
    }
  };

  const getPreloadedVideo = (fileName) => {
    return preloadedVideos().get(fileName);
  };

  // Request immediate load for manual changes (effect will set src and load)
  const loadVideoImmediately = (file) => {
    if (!file || !file.fileName) {
      logDebug('🎥 Video: Cannot load video immediately - missing file');
      return;
    }
    try {
      const key = `${file.fileName}|${currentQuality()}`;
      if (lastLoadedKey === key) {
        logDebug('🎥 Video: Skipping immediate load - same file and quality already loaded');
        return;
      }
      lastLoadedKey = key;
    } catch {}
    if (videoLoadTimeout) {
      clearTimeout(videoLoadTimeout);
      videoLoadTimeout = null;
    }
    if (!mediaHealthy()) {
      logDebug('🎥 Video: Skipping immediate load - media server unhealthy');
      setIsVideoLoading(false);
      return;
    }
    logDebug('🎥 Video: Requesting immediate load', { fileName: file.fileName });
    setHasEnded(false);
    setIsVideoLoading(true);
    setVideoError(null);
    isVideoInitialized = false;
    videoDuration = null;
    const preloaded = preloadedVideos();
    preloaded.forEach((video, fileName) => {
      if (fileName !== file.fileName) cleanupPreloadedVideo(fileName);
    });
  };

  // Cache for video URLs to prevent repeated generation
  const urlCache = new Map();
  // Track last loaded file and quality to avoid redundant loads
  let lastLoadedKey = "";
  
  // Generate video URL with quality resolution using bulletproof network config
  const getVideoUrl = (fileName, quality = 'high_res') => {
    if (!mediaHealthy()) return null;
    if (!fileName) {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: No fileName provided for getVideoUrl');
      return null;
    }
    
    // Create cache key
    const cacheKey = `${fileName}_${quality}`;
    
    // Check cache first
    if (urlCache.has(cacheKey)) {
      return urlCache.get(cacheKey);
    }
    
    // Use the bulletproof network configuration
    const fullUrl = getMediaUrl(fileName, quality);
    
    if (!fullUrl) {
      logWarn('🎥 Video: Failed to generate media URL', { fileName, quality });
      return null;
    }
    
    logDebug('🎥 Video: Generated URL using network config', {
      originalFileName: fileName,
      quality,
      fullUrl,
      networkConfig: getNetworkConfigString()
    });
    
    // Cache the URL
    urlCache.set(cacheKey, fullUrl);
    
    return fullUrl;
  };

  // Stable video src: only update when file or quality actually changes (prevents once-per-second reloads when selectedTime ticks)
  const videoSrc = createMemo((prev) => {
    const file = currentFile();
    const hasVid = hasVideo();
    const quality = currentQuality();
    
    if (!props.media_source || !hasVid || !file?.fileName) {
      if (prev !== null) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: videoSrc memo clearing src', { 
          media_source: props.media_source, 
          hasVideo: hasVid, 
          hasFile: !!file?.fileName 
        });
      }
      return null;
    }
    
    const newSrc = getVideoUrl(file.fileName, quality) ?? null;
    if (newSrc !== prev) {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: videoSrc memo computed new URL', {
        fileName: file.fileName,
        quality,
        newSrc,
        prevSrc: prev
      });
    }
    return newSrc;
  });

  // Generate alternative video URLs for fallback using network config
  const getAlternativeVideoUrls = (fileName, quality = 'high_res') => {
    if (!fileName) return [];
    
    // Use the bulletproof network configuration for alternatives
    const alternatives = getAlternativeMediaUrls(fileName, quality);
    
    logDebug('🎥 Video: Generated alternative URLs', {
      fileName,
      quality,
      alternatives,
      networkConfig: getNetworkConfigString()
    });
    
    return alternatives;
  };

  // Monitor playback performance and adjust quality if needed
  const monitorPlaybackPerformance = () => {
    if (!videoRef || !isVideoInitialized) return;
    
    const now = Date.now();
    const perf = playbackPerformance();
    
    // Check every 2 seconds
    if (now - perf.lastCheck < 2000) return;
    
    // Only check for buffering if video is actually playing (not during initial load)
    // readyState < 3 during initial load is normal, not buffering
    const isActuallyPlaying = !videoRef.paused && !videoRef.ended && videoRef.currentTime > 0;
    const isBuffering = isActuallyPlaying && videoRef.readyState < 3; // HAVE_FUTURE_DATA - only check if playing
    const isStalling = videoRef.paused && isPlaying() && videoRef.currentTime > 0; // Stalled during playback
    
    if (isBuffering || isStalling) {
      logDebug('🎥 Video: Playback performance issues detected', {
        readyState: videoRef.readyState,
        isBuffering,
        isStalling,
        isActuallyPlaying,
        currentTime: videoRef.currentTime,
        currentQuality: currentQuality()
      });
      
      // When med_res only (e.g. upload bypass), do not switch quality
      if (!config.MEDIA_MED_RES_ONLY) {
        if (!qualityGracePeriod()) {
          setQualityGracePeriod(now);
          logDebug('🎥 Video: Starting quality grace period');
        } else {
          const graceTime = now - qualityGracePeriod();
          if (graceTime > 5000) {
            const currentQ = currentQuality();
            let nextQuality;
            if (currentQ === 'high_res') {
              nextQuality = 'med_res';
            } else if (currentQ === 'med_res') {
              nextQuality = 'low_res';
            } else {
              nextQuality = 'low_res';
            }
            if (nextQuality !== currentQ) {
              logDebug('🎥 Video: Downgrading quality due to performance issues', { from: currentQ, to: nextQuality });
              setCurrentQuality(nextQuality);
              setQualityGracePeriod(null);
              loadCurrentVideoFile();
            }
          }
        }
      }
    } else {
      // Performance is good, reset grace period
      if (qualityGracePeriod()) {
        logDebug('🎥 Video: Performance improved, resetting grace period');
        setQualityGracePeriod(null);
      }
    }
    
    setPlaybackPerformance({ lastCheck: now, frameCount: perf.frameCount, isSlow: isBuffering || isStalling });
  };

  // One-off preload elements (from preloadNextVideo) - tracked so we can release on unmount
  const oneOffPreloadElements = new Set<HTMLVideoElement>();

  // Preload next video for smooth transitions
  const preloadNextVideo = (currentFileData: MediaFile) => {
    if (!mediaHealthy()) return;
    if (!currentFileData || !mediaFiles().length) return;
    
    const currentIndex = mediaFiles().findIndex(f => f.id === currentFileData.id);
    const nextFile = mediaFiles()[currentIndex + 1];
    
    if (nextFile) {
      const nextVideoUrl = getVideoUrl(nextFile.fileName, currentQuality());
      if (nextVideoUrl) {
        // Create a hidden video element to preload
        const preloadVideo = document.createElement('video');
        preloadVideo.src = nextVideoUrl;
        preloadVideo.preload = 'metadata';
        preloadVideo.style.display = 'none';
        document.body.appendChild(preloadVideo);
        oneOffPreloadElements.add(preloadVideo);
        
        const releaseOneOffPreload = () => {
          preloadVideo.src = '';
          preloadVideo.load();
          oneOffPreloadElements.delete(preloadVideo);
          if (preloadVideo.parentNode === document.body) {
            document.body.removeChild(preloadVideo);
          }
        };
        
        preloadVideo.addEventListener('loadedmetadata', () => {
          logDebug('🎥 Video: Next video preloaded', nextFile.fileName);
          releaseOneOffPreload();
        });
        
        preloadVideo.addEventListener('error', () => {
          logWarn('🎥 Video: Failed to preload next video', nextFile.fileName);
          releaseOneOffPreload();
        });
      }
    }
  };

  // Request load of current video file (effect will set src and load)
  const loadCurrentVideoFile = (smoothTransition = false, fileToLoad = null) => {
    const file = fileToLoad || currentFile();
    try {
      const key = `${file?.fileName || ''}|${currentQuality()}`;
      if (lastLoadedKey === key) {
        logDebug('🎥 Video: Skipping load - same file and quality already loaded');
        return;
      }
      lastLoadedKey = key;
    } catch {}
    if (videoLoadTimeout) {
      clearTimeout(videoLoadTimeout);
      videoLoadTimeout = null;
    }
    if (!mediaHealthy()) {
      logDebug('🎥 Video: Skipping load - media server unhealthy');
      setIsVideoLoading(false);
      return;
    }
    setHasEnded(false);
    const quality = currentQuality();
    
    if (!file || !file.fileName) {
      logDebug('🎥 Video: No current file to load');
      return;
    }
    
    // For manual changes, clear any existing preloads to ensure immediate loading
    if (!smoothTransition) {
      logDebug('🎥 Video: Manual change detected, clearing preloads for immediate loading');
      // Clear all preloaded videos to free up resources
      const preloaded = preloadedVideos();
      preloaded.forEach((video, fileName) => {
        if (fileName !== file.fileName) {
          cleanupPreloadedVideo(fileName);
        }
      });
    }
    
    // Set loading state when actually loading a video
    setIsVideoLoading(true);
    setVideoError(null);
    
    // Reset video initialization state for new video
    isVideoInitialized = false;
    videoDuration = null;
    
    // Don't set src directly here - let the effect handle it to avoid double loads
    // Just log what we're about to load
    logDebug('🎥 Video: Preparing to load video file', {
      fileName: file.fileName,
      quality,
      fileStart: toISO(file.start),
      fileEnd: toISO(file.end),
      smoothTransition
    });
    
    if (smoothTransition) {
      setIsTransitioning(true);
      if (transitionClearTimeout) clearTimeout(transitionClearTimeout);
      transitionClearTimeout = setTimeout(() => {
        transitionClearTimeout = null;
        setIsTransitioning(false);
        logDebug('🎥 Video: Cleared isTransitioning after timeout (loadedmetadata may not have fired)');
      }, 15000);
    }
    
    // Preload next video for future smooth transitions
    preloadNextVideo(file);
  };

  // For video streaming, we need to use a different approach
  // Since HTML video elements don't support custom headers, we'll use a proxy approach
  // The video element will make requests directly to the server with cookies
  const setupVideoStreaming = () => {
    logDebug('🎥 Video: Setting up video streaming with authentication');
    setVideoError(null);
    
    // The video element will handle the streaming directly
    // We just need to ensure it can access the authenticated endpoint
  };

  // Convert selectedTime to video time using the current media file's time range
  const selectedTimeToVideoTime = (selectedTime) => {
    const currentFileData = currentFile();
    if (!currentFileData || !videoDuration) return 0;

    // Use the actual media file's start and end times (may be Date or string after cache)
    const fileStart = toTime(currentFileData.start);
    const fileEnd = toTime(currentFileData.end);
    const fileDuration = fileEnd - fileStart;
    
    if (fileDuration <= 0) return 0;

    // Calculate the offset within this specific file
    const timeOffset = selectedTime.getTime() - fileStart;
    const ratio = timeOffset / fileDuration;
    
    // Map to video time (0 to videoDuration)
    const videoTime = ratio * videoDuration;
    
    VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Converting selectedTime to video time', {
      selectedTime: selectedTime.toISOString(),
      fileStart: toISO(currentFileData.start),
      fileEnd: toISO(currentFileData.end),
      fileDuration: fileDuration,
      timeOffset: timeOffset,
      ratio: ratio,
      videoTime: videoTime,
      videoDuration: videoDuration,
      videoDurationMinutes: videoDuration / 60,
      fileDurationMinutes: fileDuration / 60000
    });
    
    return Math.max(0, Math.min(videoDuration, videoTime));
  };

  // Same conversion given an explicit file (so we can seek when currentFile() not set yet, e.g. after timeline click)
  const selectedTimeToVideoTimeWithFile = (time: Date, file: MediaFile | null): number => {
    if (!file || !videoDuration) return 0;
    const fileStart = file.start instanceof Date ? file.start.getTime() : new Date(file.start).getTime();
    const fileEnd = file.end instanceof Date ? file.end.getTime() : new Date(file.end).getTime();
    const fileDuration = fileEnd - fileStart;
    if (fileDuration <= 0) return 0;
    const timeOffset = time.getTime() - fileStart;
    const ratio = timeOffset / fileDuration;
    return Math.max(0, Math.min(videoDuration, ratio * videoDuration));
  };

  // Convert video time to selectedTime (data time) using the current media file's time range
  const videoTimeToSelectedTime = (videoTimeSeconds) => {
    const currentFileData = currentFile();
    if (!currentFileData || !videoDuration) return new Date();

    // Use the actual media file's start and end times (may be Date or string after cache)
    const fileStart = toTime(currentFileData.start);
    const fileEnd = toTime(currentFileData.end);
    const fileDuration = fileEnd - fileStart;
    
    if (fileDuration <= 0) return new Date();

    const ratio = videoTimeSeconds / videoDuration;
    const timeOffset = ratio * fileDuration;
    
    const selectedTime = new Date(fileStart + timeOffset);
    
    logDebug('🎥 Video: Converting video time to selectedTime', {
      videoTimeSeconds: videoTimeSeconds,
      fileStart: toISO(currentFileData.start),
      fileEnd: toISO(currentFileData.end),
      fileDuration: fileDuration,
      ratio: ratio,
      timeOffset: timeOffset,
      selectedTime: selectedTime.toISOString()
    });
    
    return selectedTime;
  };

  // Video start handler - called when video metadata loads
  const handleVideoStart = (file) => {
    logDebug('🎥 Video: Video started', { file: file?.fileName });
    setHasVideo(true);
    setIsVideoLoading(false);
    setVideoError(null);
    setHasEnded(false);
    
    // Reset manual change flag when video successfully starts
    if (isManualTimeChange()) {
      logDebug('🎥 Video: Resetting manual change flag - video started', {
        mediaSource: props.media_source,
        fileName: file?.fileName
      });
      setIsManualTimeChange(false);
      
      // Clear the reset timeout since video loaded successfully
      if (manualChangeResetTimeout) {
        clearTimeout(manualChangeResetTimeout);
        manualChangeResetTimeout = null;
      }
    }
    
    // Update next video and time to next video
    if (file && mediaFiles().length > 0) {
      const files = mediaFiles();
      const nextFile = findNextVideo(effectiveTime(), files);
      setNextVideo(nextFile || null);
      
      // Calculate time to next video for transition messages
      if (nextFile) {
        const timeToNext = calculateTimeToNextVideo(effectiveTime(), nextFile);
        setTimeToNextVideo(timeToNext);
      } else {
        setTimeToNextVideo(null);
      }
      
      logDebug('🎥 Video: Next video updated', {
        currentFile: file.fileName,
        nextFile: nextFile?.fileName || 'none',
        timeToNext: timeToNextVideo(),
        totalFiles: files.length
      });
    } else {
      setNextVideo(null);
      setTimeToNextVideo(null);
    }
    
    // Play the video if isPlaying is true
    if (isPlaying() && videoRef && videoRef.paused) {
      logDebug('🎥 Video: Auto-playing video on start', {
        isPlaying: isPlaying(),
        videoPaused: videoRef.paused,
        fileName: file?.fileName
      });
      try {
        videoRef.play().catch(error => {
          logWarn('🎥 Video: Failed to auto-play video on start', error);
        });
      } catch (error: any) {
        logWarn('🎥 Video: Error during auto-play on start', error);
      }
    }
  };

  // Video end handler - called when video ends
  const handleVideoEnd = () => {
    // Guard: some platforms (e.g. macOS/Safari) can fire 'ended' prematurely when buffering or with gaps; only treat as ended when we're actually at the end.
    if (videoRef && typeof videoRef.duration === 'number' && videoRef.duration > 0) {
      const nearEnd = videoRef.currentTime >= videoRef.duration - 0.5;
      if (!nearEnd) {
        logDebug('🎥 Video: Ignoring premature ended event', { currentTime: videoRef.currentTime, duration: videoRef.duration });
        return;
      }
    }
    logDebug('🎥 Video: Video ended');
    setHasVideo(false); // Keep hasVideo false until next video starts
    setHasEnded(true);
    setIsVideoLoading(false);
    
    // Check if there's a next video to load
    const currentFileData = currentFile();
    if (currentFileData && mediaFiles().length > 0) {
      const files = mediaFiles();
      const nextFile = findNextVideo(effectiveTime(), files);
      
      if (nextFile) {
        logDebug('🎥 Video: Loading next video after current ended', {
          currentFile: currentFileData.fileName,
          nextFile: nextFile.fileName,
          isPlaying: isPlaying()
        });
        
        // Set next video info
        setNextVideo(nextFile);
        const timeToNext = calculateTimeToNextVideo(effectiveTime(), nextFile);
        setTimeToNextVideo(timeToNext);
        
        // Load next video (autoplay disabled - will be handled by handleVideoStart)
        // Note: hasVideo remains false until handleVideoStart is called
        setCurrentFile(nextFile);
        setIsVideoLoading(true);
        setVideoError(null);
        setHasEnded(false);
        
        // Load the next video
        if (isPlaying()) {
          // During animation - use smooth transition
          loadCurrentVideoFile(true, nextFile);
        } else {
          // Manual change - load immediately
          loadVideoImmediately(nextFile);
        }
      } else {
        logDebug('🎥 Video: No next video available');
        setNextVideo(null);
        setTimeToNextVideo(null);
      }
    } else {
      setNextVideo(null);
      setTimeToNextVideo(null);
    }
  };

  // Handle manual timeline clicks - check video arrays and set hasVideo accordingly
  const handleManualClick = async (currentTime) => {
    if (!mediaHealthy() || !props.media_source) {
      setHasVideo(false);
      setNextVideo(null);
      setTimeToNextVideo(null);
      return;
    }
    
    // Check if we need to fetch new media files for the current date (use same date logic as API: dataset TZ or UTC)
    const currentFiles = mediaFiles();
    const datasetTz = getCurrentDatasetTimezone();
    const currentDate = mediaFilesService.getDateYmdForMedia(currentTime, datasetTz);
    let hasFilesForCurrentDate = false;
    if (currentFiles && currentFiles.length > 0) {
      const firstFileDate = mediaFilesService.getDateYmdForMedia(currentFiles[0].start, datasetTz);
      hasFilesForCurrentDate = firstFileDate === currentDate;
    }
    
    // If we have no files or the date changed, fetch new media files
    if (!currentFiles || currentFiles.length === 0 || !hasFilesForCurrentDate) {
      logDebug('🎥 Video: Manual click - fetching new media files for date', {
        currentDate,
        hasFilesForCurrentDate,
        hasCurrentFiles: !!currentFiles,
        filesCount: currentFiles?.length || 0
      });
      
      try {
        const newFiles = await fetchMediaFiles(props.media_source, currentTime);
        setMediaFiles(newFiles);
        logDebug('🎥 Video: Manual click - fetched new media files', newFiles.length);
        
        // Now try to find video with the new files
        const videoFile = findFileForTime(currentTime, newFiles);
        if (videoFile) {
          logDebug('🎥 Video: Manual click - video found in new files', {
            file: videoFile.fileName,
            time: currentTime.toISOString()
          });
          setCurrentFile(videoFile);
          setHasVideo(true); // Set hasVideo immediately for manual changes
          setIsVideoLoading(true);
          setVideoError(null);
          setHasEnded(false);
          
          // Update next video and time to next video for transition messages
          const nextFile = findNextVideo(currentTime, newFiles);
          setNextVideo(nextFile || null);
          
          if (nextFile) {
            const timeToNext = calculateTimeToNextVideo(effectiveTime(), nextFile);
            setTimeToNextVideo(timeToNext);
          } else {
            setTimeToNextVideo(null);
          }
          
          logDebug('🎥 Video: Manual click - next video info updated', {
            currentFile: videoFile.fileName,
            nextFile: nextFile?.fileName || 'none',
            timeToNext: timeToNextVideo()
          });
          
          // Load video immediately for manual changes
          loadVideoImmediately(videoFile);
        } else {
          // No file for this time in new files: keep current video visible (consistent with map)
          VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Manual click - no video for time in new files, keeping current frame', {
            time: currentTime.toISOString(),
            newFilesCount: newFiles.length
          });
          if (newFiles.length === 0) {
            setHasVideo(false);
            setCurrentFile(null);
          }
          setIsVideoLoading(false);
          setNextVideo(null);
          setTimeToNextVideo(null);
        }
      } catch (error: any) {
        logError('🎥 Video: Failed to fetch media files for manual click', error);
        // Don't clear video if current time is still within current file's range (e.g. network blip)
        const currentFileForRange = currentFile();
        const stillInRange = currentFileForRange && currentTime instanceof Date && (
          currentTime.getTime() >= (currentFileForRange.start instanceof Date ? currentFileForRange.start.getTime() : new Date(currentFileForRange.start).getTime()) &&
          currentTime.getTime() <= (currentFileForRange.end instanceof Date ? currentFileForRange.end.getTime() : new Date(currentFileForRange.end).getTime())
        );
        if (!stillInRange) {
          setHasVideo(false);
          setCurrentFile(null);
        }
        setIsVideoLoading(false);
        setNextVideo(null);
        setTimeToNextVideo(null);
      }
      return;
    }
    
    // Use existing files if date hasn't changed
    const videoFile = findFileForTime(currentTime, currentFiles);
    if (videoFile) {
      const loaded = currentFile();
      const isSameFile = loaded && loaded.fileName === videoFile.fileName && toTime(loaded.start) === toTime(videoFile.start);
      if (isSameFile) {
        // Time still within current file: just update next-video info; sync effect will seek, no reload
        logDebug('🎥 Video: Manual click - same file, seeking only', { file: videoFile.fileName, time: currentTime.toISOString() });
        const nextFile = findNextVideo(currentTime, currentFiles);
        setNextVideo(nextFile || null);
        if (nextFile) {
          const timeToNext = calculateTimeToNextVideo(effectiveTime(), nextFile);
          setTimeToNextVideo(timeToNext);
        } else {
          setTimeToNextVideo(null);
        }
        setIsVideoLoading(false);
      } else {
        logDebug('🎥 Video: Manual click - video found in existing files', {
          file: videoFile.fileName,
          time: currentTime.toISOString()
        });
        setCurrentFile(videoFile);
        setHasVideo(true); // Set hasVideo immediately for manual changes
        setIsVideoLoading(true);
        setVideoError(null);
        setHasEnded(false);
        
        // Update next video and time to next video for transition messages
        const nextFile = findNextVideo(currentTime, currentFiles);
        setNextVideo(nextFile || null);
        
        if (nextFile) {
          const timeToNext = calculateTimeToNextVideo(effectiveTime(), nextFile);
          setTimeToNextVideo(timeToNext);
        } else {
          setTimeToNextVideo(null);
        }
        
        logDebug('🎥 Video: Manual click - next video info updated', {
          currentFile: videoFile.fileName,
          nextFile: nextFile?.fileName || 'none',
          timeToNext: timeToNextVideo()
        });
        
        // Load video immediately for manual changes (different file)
        loadVideoImmediately(videoFile);
      }
    } else {
      // Selected time outside all existing file ranges: keep current video visible (consistent with map - don't go blank)
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Manual click - time outside file ranges, keeping current frame visible', {
        time: currentTime.toISOString()
      });
      // Do not set hasVideo(false) or clear currentFile - leave video showing current frame
      setNextVideo(null);
      setTimeToNextVideo(null);
    }
  };

  // Lightweight start/stop listeners based on media file windows
  // Keeps playback simple: play when selectedTime is inside the current file window, pause otherwise
  let fileWindows = [];
  createEffect(() => {
    const files = mediaFiles();
    if (!files || files.length === 0) {
      fileWindows = [];
      return;
    }
    // Normalize into simple windows for quick checks
    fileWindows = files.map((f) => ({ id: f.id, start: f.start, end: f.end }));
  });

  // Start/stop watcher: manage hasVideo based on whether we're inside any video's time range
  createEffect(() => {
    const time = effectiveTime();
    if (!(time instanceof Date) || !videoRef) return;

    // Don't interfere during manual changes - let handleManualClick handle it
    if (isManualTimeChange()) {
      logDebug('🎥 Video: Skipping start/stop watcher - manual change in progress');
      return;
    }

    // Maneuver tiles: avoid re-running every second when selectedTime ticks. Only react when we need to (e.g. user hits play and video is paused).
    if (isManeuverTile() && hasVideo() && currentFile()) {
      // Skip this effect entirely for maneuver tiles when video is loaded and playing normally
      if (isPlaying() && !videoRef.paused) return;
      // Also skip when not playing and video is already paused (no state change needed)
      if (!isPlaying() && videoRef.paused) return;
    }

    const files = mediaFiles();
    let isInsideAnyVideo = false;
    let currentVideoFile = null;
    
    if (files && files.length > 0) {
      const tMs = time.getTime();
      currentVideoFile = files.find(file => {
        const startMs = file.start instanceof Date ? file.start.getTime() : new Date(file.start).getTime();
        const endMs = file.end instanceof Date ? file.end.getTime() : new Date(file.end).getTime();
        return tMs >= startMs && tMs <= endMs;
      });
      isInsideAnyVideo = currentVideoFile !== undefined;
    }

    if (isInsideAnyVideo) {
      const currentFileId = currentFile()?.id;
      const newFileId = currentVideoFile?.id;
      const sameFile = newFileId && currentFileId === newFileId;

      // Non-maneuver, same file: only resume if paused; no state updates to avoid reactive churn
      if (!isManeuverTile() && sameFile) {
        if (isPlaying() && videoRef.paused && !isVideoLoading()) {
          try { videoRef.play().catch(() => {}); } catch {}
        }
        return;
      }

      // Inside a video's time range: hasVideo should be true (only set when actually changing)
      const currentHasVideo = hasVideo();
      if (!currentHasVideo) {
        logDebug('🎥 Video: Entered video time range', {
          selectedTime: time.toISOString(),
          videoFile: currentVideoFile?.fileName
        });
        setHasVideo(true);
      }
      
      // Check if we need to load a new video file (skip for maneuver tiles)
      if (!isManeuverTile()) {
        if (newFileId && newFileId !== currentFileId) {
          logDebug('🎥 Video: Switching to new video file', {
            fromFile: currentFile()?.fileName,
            toFile: currentVideoFile?.fileName,
            isPlaying: isPlaying()
          });
          
          // Set the new current file
          setCurrentFile(currentVideoFile);
          setIsVideoLoading(true);
          setVideoError(null);
          setHasEnded(false);
          
          // Update next video info
          const files = mediaFiles();
          const nextFile = findNextVideo(effectiveTime(), files);
          setNextVideo(nextFile || null);
          
          if (nextFile) {
            const timeToNext = calculateTimeToNextVideo(effectiveTime(), nextFile);
            setTimeToNextVideo(timeToNext);
          } else {
            setTimeToNextVideo(null);
          }
          
          // Load the new video file (autoplay disabled - will be handled by handleVideoStart)
          if (isPlaying()) {
            // If playing, load with smooth transition for animation
            loadCurrentVideoFile(true, currentVideoFile);
          } else {
            // If paused, load immediately for manual changes
            loadVideoImmediately(currentVideoFile);
          }
        }
      }
      
      // Same file (or maneuver tile): resume playback if playing and paused
      if (isPlaying() && videoRef.paused && !isVideoLoading()) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Resuming playback - inside video time range', {
          isPlaying: isPlaying(),
          videoPaused: videoRef.paused,
          isVideoLoading: isVideoLoading(),
          currentFile: currentVideoFile?.fileName
        });
        try { videoRef.play().catch(() => {}); } catch {}
      }
    } else {
      // Outside all video time ranges: keep video visible (like map - don't go blank when scrubbing timeline)
      // Only pause playback; do not set hasVideo(false) so the current frame stays visible
      if (hasVideo()) {
        logDebug('🎥 Video: Selected time outside video range - keeping current frame visible (consistent with map)', {
          selectedTime: time.toISOString()
        });
      }
      // Pause video if playing when time is outside range
      if (!videoRef.paused) {
        try { videoRef.pause(); } catch {}
      }
    }
  });

  // Manual time change handling is now done in the dedicated watcher above

  // Debounce manual changes to prevent rapid processing
  let manualChangeTimeout = null;
  let manualChangeResetTimeout = null;
  
  // Watch for selectedTime changes and detect manual changes (skip when maneuver tile — no link to selectedTime)
  let lastSelectedTime: Date | null = null;
  createEffect(() => {
    const currentSelectedTime = effectiveTime();
    if (isManeuverTile()) {
      lastSelectedTime = currentSelectedTime instanceof Date ? currentSelectedTime : null;
      return;
    }

    // Detect if this is a manual change by checking if selectedTime changed significantly
    // and we're not currently in a manual change state
    if (currentSelectedTime instanceof Date && lastSelectedTime instanceof Date) {
      const timeDiff = Math.abs(currentSelectedTime.getTime() - lastSelectedTime.getTime());

      // If time changed by more than 5 seconds and we're not already in manual change mode,
      // it's likely a manual change
      if (timeDiff > 5000 && !isManualTimeChange()) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Detected potential manual time change', {
          mediaSource: props.media_source,
          timeDiff: timeDiff,
          from: lastSelectedTime.toISOString(),
          to: currentSelectedTime.toISOString()
        });
        setIsManualTimeChange(true);
      }
    }

    lastSelectedTime = currentSelectedTime instanceof Date ? currentSelectedTime : null;
  });

  // Watch for manual selectedTime changes and re-evaluate video selection
  createEffect(() => {
    // Only react to manual time changes, not animation changes
    if (isManualTimeChange()) {
      const currentSelectedTime = effectiveTime();
      
      if (currentSelectedTime instanceof Date) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Manual selectedTime change detected, re-evaluating video selection', {
          selectedTime: currentSelectedTime.toISOString(),
          mediaFilesCount: mediaFiles().length,
          hasMediaSource: !!props.media_source,
          mediaSource: props.media_source
        });
        
        // Clear any pending manual change
        if (manualChangeTimeout) {
          clearTimeout(manualChangeTimeout);
        }
        
        // Debounce manual changes to prevent rapid processing
        manualChangeTimeout = setTimeout(async () => {
          if (props.media_source) {
            try {
              await handleManualClick(currentSelectedTime);
              // Only reset manual change flag if this component successfully handled it
              // Don't reset it here - let handleVideoStart reset it when video actually loads
              VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Manual change processing completed', {
                mediaSource: props.media_source,
                hasVideo: hasVideo(),
                currentFile: currentFile()?.fileName
              });
              
              // Set a timeout to reset the manual change flag if no video loads within 3 seconds
              if (manualChangeResetTimeout) {
                clearTimeout(manualChangeResetTimeout);
              }
              manualChangeResetTimeout = setTimeout(() => {
                if (isManualTimeChange()) {
                  VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Manual change flag timeout - resetting', {
                    mediaSource: props.media_source,
                    hasVideo: hasVideo(),
                    currentFile: currentFile()?.fileName
                  });
                  setIsManualTimeChange(false);
                }
                manualChangeResetTimeout = null;
              }, 3000); // 3 second timeout
            } catch (error: any) {
              logError('🎥 Video: Error in manual selectedTime change handler', error);
              // Reset flag on error
              setIsManualTimeChange(false);
            }
          } else {
            // Reset flag if no media source
            setIsManualTimeChange(false);
          }
          manualChangeTimeout = null;
        }, 100); // 100ms debounce
      } else {
        // Reset flag even if selectedTime is invalid
        setIsManualTimeChange(false);
      }
    }
  });

  // Watch for manual time range changes and re-evaluate video selection
  let lastTimeRange = null;
  createEffect(() => {
    // Watch for changes in the global time range that might affect video selection
    const timeRange = getDataTimeRange();
    if (timeRange && mediaFiles().length > 0) {
      // Check if time range actually changed (use toTime for cache/serialized dates)
      const timeRangeChanged = !lastTimeRange ||
        toTime(lastTimeRange.start) !== toTime(timeRange.start) ||
        toTime(lastTimeRange.end) !== toTime(timeRange.end);
      
      if (timeRangeChanged) {
        lastTimeRange = { start: timeRange.start, end: timeRange.end };
        
        const currentSelectedTime = effectiveTime();
        if (currentSelectedTime) {
          logDebug('🎥 Video: Time range changed, re-evaluating video selection', {
          timeRange: {
            start: toISO(timeRange.start),
            end: toISO(timeRange.end)
          },
            selectedTime: currentSelectedTime.toISOString(),
            mediaFilesCount: mediaFiles().length
          });
          
          // Re-evaluate which video should be active for current selectedTime
          handleManualClick(currentSelectedTime).catch(error => {
            logError('🎥 Video: Error in time range change handler', error);
          });
        }
      }
    }
  });

  // Sync video currentTime with selectedTime - video is now passive (throttled)
  // Only seek when the selected time is within the currently loaded file's range (value check, not reference);
  // otherwise handleManualClick will load the correct file and the loadedmetadata callback will seek.
  // Maneuver tiles: never seek from this effect — selectedTime is a logical timeline we increment; each tile has its own time ref.
  // Only seekToStartTrigger (reset button) should move the video. This prevents pause from resetting the video to start.
  let lastSyncTime = 0;
  createEffect(() => {
    if (isManeuverTile()) return;

    const currentSelectedTime = effectiveTime();
    const files = mediaFiles();
    const currentLoaded = currentFile();
    const t = currentSelectedTime instanceof Date ? currentSelectedTime.getTime() : 0;
    const inCurrentFile = currentLoaded && t >= toTime(currentLoaded.start) && t <= toTime(currentLoaded.end);
    const fileForSync = inCurrentFile ? currentLoaded : null;

    const forceSeek = isManualTimeChange();
    const now = Date.now();
    const throttleOk = (now - lastSyncTime) > 500 || forceSeek;
    
    if (videoRef && currentSelectedTime instanceof Date && videoDuration && fileForSync && throttleOk) {
      lastSyncTime = now;
      const videoTimeSeconds = selectedTimeToVideoTimeWithFile(currentSelectedTime, fileForSync);
      const currentVideoTime = videoRef.currentTime;
      
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Calculating video sync', {
        selectedTime: currentSelectedTime.toISOString(),
        currentFile: fileForSync?.fileName,
        fileStart: toISO(fileForSync?.start),
        fileEnd: toISO(fileForSync?.end),
          calculatedVideoTime: videoTimeSeconds,
          currentVideoTime: currentVideoTime,
          timeDifference: Math.abs(currentVideoTime - videoTimeSeconds)
        });
        
      // Sync video to selectedTime when user explicitly moved time (step / timeline), not on simple pause.
      // Maneuver tiles: only seek when manual change or large diff (step). Never seek on plain pause.
      const isPaused = videoRef.paused;
      const isPlayingAt1x = isPlaying() && playbackSpeed() === 1;
      const diff = Math.abs(currentVideoTime - videoTimeSeconds);
      const isManeuver = isManeuverTile();
      const shouldSync = isManeuver
        ? forceSeek || diff > 1
        : isPaused || (!isPlayingAt1x && (forceSeek || diff > 2.0));
      
      if (shouldSync) {
          VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Syncing to selectedTime', {
            selectedTime: currentSelectedTime.toISOString(),
            videoTime: videoTimeSeconds,
            currentVideoTime: currentVideoTime,
          currentFile: fileForSync?.fileName,
          isPlayingAt1x: isPlayingAt1x,
          forceSeek: forceSeek,
          isPaused: isPaused,
          diff: diff,
          shouldSync: shouldSync
          });
          
          try {
          const beforeTime = videoRef.currentTime;
          
          // Ensure video is ready for seeking
          if (videoRef.readyState < 2) {
            VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Video not ready for seeking, waiting for loadedmetadata');
            videoRef.addEventListener('loadedmetadata', () => {
            videoRef.currentTime = videoTimeSeconds;
              VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Synced video after metadata loaded', {
                targetTime: videoTimeSeconds,
                actualTime: videoRef.currentTime
              });
            }, { once: true });
            return;
          }
          
          videoRef.currentTime = videoTimeSeconds;
          const afterTime = videoRef.currentTime;
          VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Successfully synced video to', {
            targetTime: videoTimeSeconds,
            beforeTime: beforeTime,
            afterTime: afterTime,
            videoDuration: videoRef.duration,
            videoReadyState: videoRef.readyState
          });
          } catch (error: any) {
            logWarn('🎥 Video: Failed to sync video time', error);
            // Try again after a short delay if video isn't ready
            if (!isVideoInitialized) {
              setTimeout(() => {
                try {
                  videoRef.currentTime = videoTimeSeconds;
                  VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Delayed sync successful', videoTimeSeconds);
                } catch (retryError) {
                  logWarn('🎥 Video: Delayed sync also failed', retryError);
                }
              }, 100);
            }
          }
        } else {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Skipping sync - video playing naturally at 1x speed', {
          isPlayingAt1x: isPlayingAt1x,
          forceSeek: forceSeek,
          isPaused: isPaused,
          diff: diff,
          playbackSpeed: playbackSpeed(),
          shouldSync: shouldSync
        });
      }
    } else {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Cannot sync - missing requirements', {
        videoRef: !!videoRef,
        selectedTime: currentSelectedTime,
        videoDuration,
        fileForSync: !!fileForSync,
        filesCount: files?.length ?? 0
      });
    }
  });

  // When seekToStartTrigger increments (e.g. maneuver video reset), seek this instance. Maneuver tiles: seek to this tile's fixedStartTime so each tile shows its own init frame (mirroring correct). Others: seek to effectiveTime().
  createEffect(() => {
    const trigger = props.seekToStartTrigger;
    if (trigger == null || typeof trigger !== "number") return;
    untrack(() => {
      const files = mediaFiles();
      const fixedStart = props.fixedStartTime;
      const targetTime: Date | null =
        fixedStart != null
          ? typeof fixedStart === "string"
            ? new Date(fixedStart)
            : (fixedStart instanceof Date ? fixedStart : new Date(fixedStart as unknown as string))
          : effectiveTime();
      if (!(targetTime instanceof Date) || Number.isNaN(targetTime.getTime())) return;
      const file = currentFile() || (files?.length ? findFileForTime(targetTime, files) : null);
      if (videoRef && videoDuration && file) {
        try {
          const videoTimeSeconds = selectedTimeToVideoTimeWithFile(targetTime, file);
          if (videoRef.readyState >= 2) {
            videoRef.currentTime = videoTimeSeconds;
            logDebug("🎥 Video: Seek to start (reset trigger)", { trigger, videoTime: videoTimeSeconds });
          } else {
            videoRef.addEventListener("loadedmetadata", () => {
              try {
                videoRef.currentTime = videoTimeSeconds;
              } catch (_) {}
            }, { once: true });
          }
        } catch (e) {
          logWarn("🎥 Video: Seek to start failed", e);
        }
      }
    });
  });

  // Video speed monitoring removed - video is now passive and doesn't control time

  // Video no longer controls selectedTime - it's a passive child component
  // The video will only respond to selectedTime changes and isPlaying state

  // Clear video error when video source changes
  createEffect(() => {
    const currentSrc = props.media_source ? getVideoUrl(currentFile()?.fileName, currentQuality()) : props.src;
    if (currentSrc && videoError()) {
      logDebug('🎥 Video: Video source changed, clearing previous error', {
        newSrc: currentSrc,
        previousError: videoError()
      });
      setVideoError(null);
    }
  });

  // Stop all video intervals
  const stopVideoIntervals = () => {
    if (videoUpdateInterval) {
      clearInterval(videoUpdateInterval);
      videoUpdateInterval = null;
    }
  };

  // When drivesPlaybackTime is true (e.g. first fleet video tile), push video currentTime into store
  // so the play/pause time display stays in sync on platforms that throttle setInterval (e.g. Chrome on macOS).
  let lastPlaybackTimePushMs = 0;
  const PLAYBACK_TIME_PUSH_THROTTLE_MS = 100;

  // Handle time updates - video now plays at native speed with playbackRate
  const handleTimeUpdate = () => {
    // Video plays at native speed with playbackRate, no manual frame skipping needed
    if (videoRef && isVideoInitialized && isPlaying() && currentFile()) {
      // Only log every 2 seconds to reduce noise
      if (Math.floor(videoRef.currentTime) % 2 === 0) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Video playing at native speed', {
          videoTime: videoRef.currentTime,
          playbackSpeed: playbackSpeed(),
          playbackRate: videoRef.playbackRate
        });
      }
      // Drive play/pause time display from this video when requested (e.g. fleet video first tile).
      // Keeps time updating when the store's setInterval is throttled (e.g. Chrome macOS background throttling).
      if (props.drivesPlaybackTime && !isManeuverTile() && videoDuration) {
        const now = Date.now();
        if (now - lastPlaybackTimePushMs >= PLAYBACK_TIME_PUSH_THROTTLE_MS) {
          lastPlaybackTimePushMs = now;
          try {
            const dataTime = videoTimeToSelectedTime(videoRef.currentTime);
            if (dataTime && !isNaN(dataTime.getTime())) {
              setSelectedTime(dataTime, 'playback');
            }
          } catch (_) {
            // ignore conversion errors
          }
        }
      }
    }
  };

  const handleVideoLoaded = () => {
    // Prevent multiple calls to this function
    if (isVideoInitialized) {
      logDebug('🎥 Video: handleVideoLoaded called but already initialized');
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
    logDebug('🎥 Video: Video loaded successfully', {
      duration: videoDuration,
      src: props.src,
      videoElement: videoRef
    });

    
    // Force sync to get latest selectedTime from other components
    syncSelectedTimeManual();
    
    // Start playback if animation is active
    if (isPlaying() && videoRef.paused) {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Starting playback from handleVideoLoaded', {
        isPlaying: isPlaying(),
        videoPaused: videoRef.paused,
        videoReadyState: videoRef.readyState
      });
      videoRef.play().catch(error => {
        logWarn('🎥 Video: Failed to start playback from handleVideoLoaded', error);
      });
    }
    
    // Initialize previousPlayState to current state (don't force opposite)
    previousPlayState = isPlaying();
    
    // Sync video position when loaded: maneuver tiles use fixedStartTime; others use selectedTime
    if (videoRef && videoDuration) {
      if (isManeuverTile()) {
        if (props.fixedStartTime != null) {
          try {
            const fixedDate = typeof props.fixedStartTime === 'string' ? new Date(props.fixedStartTime) : new Date(props.fixedStartTime as any);
            const videoTimeSeconds = selectedTimeToVideoTimeWithFile(fixedDate, currentFile());
            videoRef.currentTime = videoTimeSeconds;
            logDebug('🎥 Video: Video loaded, set to fixedStartTime (maneuver)', { fixedStartTime: String(props.fixedStartTime), videoTime: videoTimeSeconds });
          } catch {}
        } else {
          videoRef.currentTime = 0;
        }
      } else {
        const currentSelectedTime = effectiveTime();
        logDebug('🎥 Video: Video loaded, syncing to current selectedTime', {
          selectedTime: currentSelectedTime.toISOString(),
          videoDuration: videoDuration
        });
        const videoTimeSeconds = selectedTimeToVideoTime(currentSelectedTime);
        logDebug('🎥 Video: Setting initial video time', {
          selectedTime: currentSelectedTime.toISOString(),
          videoTime: videoTimeSeconds
        });
        videoRef.currentTime = videoTimeSeconds;
      }
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
      logDebug('🎥 Video: Can play event fired');
      handleVideoLoaded();
    }
  };

  const handleVideoError = (e) => {
    // Don't show error if we intentionally cleared the video source (no current file)
    if (!currentFile()) {
      logDebug('🎥 Video: Video error ignored - no current file (intentionally cleared)');
      return;
    }
    // If the video src is empty or there is no upcoming video, do not surface an error
    if (!videoRef?.src || (!hasVideo() && !nextVideo())) {
      logDebug('🎥 Video: Video error suppressed (empty src or no next video)');
      return;
    }
    // Suppress code 4 when it's our intentional abort (src = '' + load()) — message may not include "empty src"
    const isCode4 = videoRef?.error?.code === 4;
    const emptySrcAbort = isCode4 && (
      videoRef?.error?.message?.toLowerCase().includes('empty src') ||
      !videoRef?.currentSrc ||
      !videoRef.currentSrc.includes('/api/media/video')
    );
    if (emptySrcAbort) {
      logDebug('🎥 Video: Video error ignored - empty src / abort (intentional)');
      return;
    }
    
    const logSrc = videoRef?.currentSrc ?? videoRef?.src ?? (currentFile() ? getVideoUrl(currentFile()?.fileName, currentQuality()) : undefined) ?? props.src;
    logError('🎥 Video: Error occurred', {
      error: e,
      src: logSrc,
      networkState: videoRef?.networkState,
      readyState: videoRef?.readyState,
      videoError: videoRef?.error,
      errorCode: videoRef?.error?.code,
      errorMessage: videoRef?.error?.message,
      currentFile: currentFile()?.fileName,
      currentQuality: currentQuality()
    });
    
    setIsVideoLoading(false);
    
    // Only reset video initialization if we're actually changing to a new video
    // Don't reset on every error as it causes sync issues
    if (videoRef?.src !== currentFile()?.fileName) {
      isVideoInitialized = false;
      videoDuration = null;
    }
    
    // Try to get more specific error information
    if (videoRef?.error) {
      const error = videoRef.error;
      let errorMessage = 'Unknown error';
      switch (error.code) {
        case 1:
          errorMessage = 'Video loading was aborted';
          logError('🎥 Video: MEDIA_ERR_ABORTED - Video loading was aborted');
          break;
        case 2:
          errorMessage = 'Network error occurred';
          logError('🎥 Video: MEDIA_ERR_NETWORK - Network error occurred');
          
          // Check if this might be a CORS or network access issue
          const currentHost = window.location.hostname;
          if (currentHost !== 'localhost' && currentHost !== '127.0.0.1') {
            logError('🎥 Video: Network error on non-localhost - this might be a CORS or network access issue', {
              currentHost,
              videoSrc: videoRef?.src,
              mediaPort: config.MEDIA_PORT
            });
            errorMessage = `Network error on ${currentHost} - check if media server is accessible and CORS is configured`;
          }
          
          // Try alternative URLs for network errors
          if (currentFile()) {
            const alternatives = getAlternativeVideoUrls(currentFile().fileName, currentQuality());
            const currentSrc = videoRef?.src;
            const nextAlternative = alternatives.find(url => url !== currentSrc);
            
            if (nextAlternative) {
              logDebug('🎥 Video: Trying alternative URL for network error', {
                currentSrc,
                nextAlternative,
                alternatives
              });
              videoRef.src = nextAlternative;
              videoRef.load();
              return; // Don't set error, try the alternative URL
            }
          }
          break;
        case 3:
          errorMessage = 'Video decode error';
          logError('🎥 Video: MEDIA_ERR_DECODE - Video decode error');
          break;
        case 4:
          errorMessage = 'Video format not supported';
          logError('🎥 Video: MEDIA_ERR_SRC_NOT_SUPPORTED - Video format not supported');
          
          // Debug: Test if the video URL is accessible
          const currentSrcForTest = videoRef?.currentSrc ?? videoRef?.src;
          if (currentSrcForTest && currentSrcForTest.includes('/api/media/video')) {
            logDebug('🎥 Video: Testing video URL accessibility', { currentSrc: currentSrcForTest });
            testVideoUrlAccess(currentSrcForTest);
          }
          
          // Also test media server accessibility
          testMediaServerAccess();
          
          // Don't automatically downgrade quality for format errors - these are usually
          // configuration issues, not network/performance issues. Quality downgrade
          // should only happen for actual buffering/performance problems.
          break;
        default:
          errorMessage = `Unknown error code: ${error.code}`;
          logError('🎥 Video: Unknown error code:', error.code);
      }
      setVideoError(errorMessage);
    }
  };

  // True only when the current video src is a real video URL (not empty-src resolved to document/dashboard)
  const isRealVideoSrc = (src: string | undefined): boolean => {
    if (!src || typeof src !== 'string') return false;
    if (src.includes('window?')) return false;
    return src.includes('/api/media/video');
  };

  const handleLoadStart = () => {
    const src = videoRef?.src;
    logDebug('🎥 Video: Load started', { src });
    
    // Only treat as a real load when src is a video URL. When we clear src with '',
    // the browser can resolve it to the document URL (e.g. /dashboard), which triggers
    // loadstart but is not a video load - skip timeout and URL test to avoid spam.
    if (!isRealVideoSrc(src)) {
      if (videoLoadTimeout) {
        clearTimeout(videoLoadTimeout);
        videoLoadTimeout = null;
      }
      return;
    }
    
    setIsVideoLoading(true);
    setVideoError(null);
    testVideoUrlAccess(src);
    
    if (videoLoadTimeout) {
      clearTimeout(videoLoadTimeout);
    }
    
    videoLoadTimeout = setTimeout(() => {
      if (!isVideoInitialized) {
        if (
          !hasWarnedLoadTimeout &&
          isRealVideoSrc(videoRef?.src) &&
          props.media_source
        ) {
          hasWarnedLoadTimeout = true;
          logWarn('🎥 Video: Load timeout - video taking too long to load', {
            src: videoRef?.src,
            networkState: videoRef?.networkState,
            readyState: videoRef?.readyState
          });
        }
        setIsVideoLoading(false);
        if (isRealVideoSrc(videoRef?.src) && props.media_source && (currentFile() || nextVideo())) {
          setVideoError('Video loading timeout - try waiting longer or use a lower resolution');
        }
      }
    }, VIDEO_LOAD_TIMEOUT_MS);
  };

  const handleLoadedData = () => {
    logDebug('🎥 Video: Data loaded', { 
      duration: videoRef?.duration,
      readyState: videoRef?.readyState 
    });
  };

  onMount(async () => {
    logDebug('🎥 Video: onMount called', {
      mediaSource: props.media_source,
      allProps: props
    });
    
    // Video component is passive - no need to sync or control selectedTime
    // Setup video streaming
    setupVideoStreaming();
    
    // Check media server health before any work
    const healthy = await checkMediaHealth();
    if (!healthy) {
      setIsVideoLoading(false);
      setVideoError(null);
      // Retry health check periodically in background
      const retry = setInterval(async () => {
        const ok = await checkMediaHealth();
        if (ok) {
          clearInterval(retry);
          // Trigger initial load now that server is healthy
          if (props.media_source) {
            const dateForFetch =
              props.fixedStartTime != null
                ? (typeof props.fixedStartTime === 'string' ? new Date(props.fixedStartTime) : new Date(props.fixedStartTime as unknown as string))
                : await getDateForMediaFetchAsync();
            const files = await fetchMediaFiles(props.media_source, dateForFetch);
            setMediaFiles(files);
            let currentTime = timeForThisTile();
            const isEpoch =
              currentTime.getUTCFullYear() === 1970 && currentTime.getUTCMonth() === 0 && currentTime.getUTCDate() === 1;
            if (isEpoch && files.length > 0) currentTime = getDateForMediaFetch();
            if (currentTime && files.length > 0) {
              const initialFile = findFileForTime(currentTime, files) ?? files[0] ?? null;
              if (initialFile) {
                setIsVideoLoading(true);
                setVideoError(null);
                setHasVideo(true); // Video found
                setCurrentFile(initialFile);
                loadCurrentVideoFile(false, initialFile);
              }
            }
          }
        }
      }, 5000);
      // Do not proceed with initial fetch until healthy
      return;
    }

    // Load media files if media_source prop is provided
    if (props.media_source) {
      logDebug('🎥 Video: Loading media files for source', props.media_source);
      try {
        const dateForFetch =
          props.fixedStartTime != null
            ? (typeof props.fixedStartTime === 'string' ? new Date(props.fixedStartTime) : new Date(props.fixedStartTime as unknown as string))
            : await getDateForMediaFetchAsync();
        const files = await fetchMediaFiles(props.media_source, dateForFetch);
        logDebug('🎥 Video: fetchMediaFiles returned', files);
        setMediaFiles(files);
        logDebug('🎥 Video: Loaded media files', files.length);
        
        // Find initial file: use timeForThisTile (per-tile fixedStartTime when maneuver), or selected date when epoch
        let currentTime = timeForThisTile();
        const isEpoch =
          currentTime.getUTCFullYear() === 1970 && currentTime.getUTCMonth() === 0 && currentTime.getUTCDate() === 1;
        if (isEpoch && files.length > 0) currentTime = getDateForMediaFetch();
        logDebug('🎥 Video: Current selectedTime for initial file', currentTime);
        if (currentTime && files.length > 0) {
          const initialFile = findFileForTime(currentTime, files) ?? files[0] ?? null;
          logDebug('🎥 Video: Initial file found', initialFile);
          if (initialFile) {
            // Set loading state immediately to hide black screen
            setIsVideoLoading(true);
            setVideoError(null);
            setHasVideo(true); // Video found
            setCurrentFile(initialFile);
            // Initial load - no smooth transition needed
            loadCurrentVideoFile(false, initialFile);
          }
        } else {
          logDebug('🎥 Video: No currentTime or files available', {
            currentTime,
            filesLength: files.length
          });
          setHasVideo(false); // No video available
        }
      } catch (error: any) {
        logError('🎥 Video: Failed to load media files', error);
      }
    } else {
      logDebug('🎥 Video: No media_source prop provided, using fallback behavior');
    }
    
    // Add global sync function for debugging
    //@ts-ignore
    window.syncVideoToSelectedTime = () => {
      const currentTime = effectiveTime();
      if (videoRef && currentTime instanceof Date && videoDuration) {
        const videoTimeSeconds = selectedTimeToVideoTime(currentTime);
      logDebug('🎥 Video: Manual sync called', {
          selectedTime: currentTime.toISOString(),
          videoTime: videoTimeSeconds,
          videoDuration: videoDuration
        });
        try {
          videoRef.currentTime = videoTimeSeconds;
          logDebug('🎥 Video: Manual sync successful');
        } catch (error: any) {
          logWarn('🎥 Video: Manual sync failed', error);
        }
      } else {
        logWarn('🎥 Video: Manual sync failed - missing requirements', {
          videoRef: !!videoRef,
          currentTime: currentTime?.toISOString(),
          videoDuration: videoDuration
        });
      }
    };

    // Add global function to set time range manually
    //@ts-ignore
    window.setVideoTimeRange = (startTime, endTime) => {
      logDebug('🎥 Video: Setting manual time range', {
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
      logDebug('🎥 Video: Testing video sync...');
      const currentTime = effectiveTime();
      const timeRange = getDataTimeRange();
      const videoTime = selectedTimeToVideoTime(currentTime);
      
      logDebug('🎥 Video: Test results', {
        selectedTime: currentTime?.toISOString(),
        timeRange: timeRange ? {
          start: toISO(timeRange.start),
          end: toISO(timeRange.end)
        } : null,
        videoDuration: videoDuration,
        calculatedVideoTime: videoTime,
        videoRef: !!videoRef,
        videoCurrentTime: videoRef?.currentTime
      });
      
      if (videoRef && videoTime > 0) {
        try {
          videoRef.currentTime = videoTime;
          logDebug('🎥 Video: Test sync successful - set to', videoTime);
        } catch (error: any) {
          logWarn('🎥 Video: Test sync failed', error);
        }
      }
    };
  });

  // Handle play/pause state - video is now passive
  createEffect(() => {
    const currentPlayState = isPlaying();
    const speed = playbackSpeed();

    VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Play/pause effect triggered', {
      currentPlayState,
      speed,
      videoRef: !!videoRef,
      isVideoInitialized,
      videoPaused: videoRef?.paused,
      videoReadyState: videoRef?.readyState,
      previousPlayState
    });

    if (videoRef) {
      if (currentPlayState && (currentPlayState !== previousPlayState || videoRef.paused)) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Starting playback', { 
          speed, 
          videoPaused: videoRef.paused,
          videoReadyState: videoRef.readyState,
          isVideoInitialized 
        });
        
        // If video hasn't started loading yet, trigger it now
        if (videoRef.readyState === 0) {
          VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Triggering video load for playback');
          videoRef.load();
        }

        // Apply current playback speed so every tile gets the same rate (avoids one tile stuck at 1x when speed changes)
        videoRef.playbackRate = speed;

        // Force play regardless of initialization state
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Attempting to play video', {
          src: videoRef.src,
          currentSrc: videoRef.currentSrc,
          networkState: videoRef.networkState,
          readyState: videoRef.readyState,
          duration: videoRef.duration,
          paused: videoRef.paused
        });
        
        // Wait for video to be ready before playing
        if (videoRef.readyState < 3) {
          VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Video not ready, waiting for canplay event');
          const handleCanPlay = () => {
            if (videoRef && isPlaying() && videoRef.paused) {
              VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Video ready, attempting to play');
              videoRef.play().then(() => {
                VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Delayed play succeeded');
              }).catch(error => {
                logError('🎥 Video: Delayed play failed', error);
              });
            }
            videoRef.removeEventListener('canplay', handleCanPlay);
          };
          videoRef.addEventListener('canplay', handleCanPlay);
        } else {
          // Video is ready, play immediately
          videoRef.play().then(() => {
            VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Play succeeded');
          }).catch(error => {
          logError('🎥 Video: Play failed', error);
        });
        }
        
      } else if (!currentPlayState && currentPlayState !== previousPlayState) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Pausing playback');
        // Add a small delay to prevent race condition with play()
        setTimeout(() => {
          if (videoRef && !isPlaying()) {
        videoRef.pause();
          }
        }, 50);
      }
      previousPlayState = currentPlayState;
    } else {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: No videoRef available for play/pause control');
    }
  });

  // Aggressive video playback - watch for video readiness and force play
  createEffect(() => {
    const playing = isPlaying();
    const currentFileData = currentFile();
    
    if (videoRef && playing && currentFileData) {
      VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Aggressive playback effect triggered', {
        playing,
        hasCurrentFile: !!currentFileData,
        videoSrc: videoRef.src,
        videoReadyState: videoRef.readyState,
        videoPaused: videoRef.paused,
        videoDuration: videoRef.duration
      });
      
      // Only try to play if the main effect hasn't already handled it
      if (videoRef.readyState >= 3 && videoRef.paused) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Video is fully ready and paused, forcing play');
        videoRef.play().then(() => {
          VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Aggressive play succeeded');
        }).catch(error => {
          logError('🎥 Video: Aggressive play failed', error);
        });
      }
    }
  });

  // Handle playback speed changes - use HTML5 playbackRate for smooth playback (apply to all tiles whenever speed changes)
  createEffect(() => {
    const speed = playbackSpeed();
    const playing = isPlaying();
    
    VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Speed/Play state changed', { speed, playing, videoInitialized: isVideoInitialized });
    
    if (videoRef) {
      videoRef.playbackRate = speed;
    }
    if (videoRef && isVideoInitialized) {
      if (playing) {
        VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Setting playback rate', { speed });
        stopVideoIntervals();
        
        // Make sure video is playing
        if (videoRef.paused) {
          videoRef.play().catch(error => {
            logError('🎥 Video: Play failed', error);
          });
        }
        
        // Monitor performance during playback
        if (!videoUpdateInterval) {
        videoUpdateInterval = setInterval(() => {
            if (!isPlaying()) {
            clearInterval(videoUpdateInterval);
            videoUpdateInterval = null;
            return;
          }
            monitorPlaybackPerformance();
          }, 2000); // Check every 2 seconds
        }
        
      } else {
        logDebug('🎥 Video: Stopping playback');
        // Not playing - stop everything
        stopVideoIntervals();
        if (videoRef && !videoRef.paused) {
          videoRef.pause();
        }
      }
    }
  });


  // Handle cleanup when component unmounts
  onCleanup(() => {
    VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Cleaning up component');
    // Abort main video so closing the view stops the stream immediately
    if (videoRef) {
      videoRef.pause();
      videoRef.src = '';
      videoRef.load();
    }
    stopVideoIntervals();
    
    // Clear video load timeout
    if (videoLoadTimeout) {
      clearTimeout(videoLoadTimeout);
      videoLoadTimeout = null;
    }
    if (transitionClearTimeout) {
      clearTimeout(transitionClearTimeout);
      transitionClearTimeout = null;
    }
    
    // Clear manual change timeouts
    if (manualChangeTimeout) {
      clearTimeout(manualChangeTimeout);
      manualChangeTimeout = null;
    }
    if (manualChangeResetTimeout) {
      clearTimeout(manualChangeResetTimeout);
      manualChangeResetTimeout = null;
    }
    
    // Release one-off preload elements from preloadNextVideo
    oneOffPreloadElements.forEach((el) => {
      el.pause();
      el.src = '';
      el.load();
      if (el.parentNode === document.body) {
        document.body.removeChild(el);
      }
    });
    oneOffPreloadElements.clear();
    
    // Clean up all preloaded videos
    const preloaded = preloadedVideos();
    preloaded.forEach((_video, fileName) => {
      cleanupPreloadedVideo(fileName);
    });
    
    // Clear URL cache
    urlCache.clear();
    
    // Reset all flags and clean up global reference
    isVideoInitialized = false;
    videoDuration = null;
    previousPlayState = false;
    //@ts-ignore
    window.videoComponent = null;
  });

  return (
    <div 
      class="video-container" 
      style={{ position: 'relative', height: '100%', 'padding-bottom': '0px' }}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      {/* Removed debug toggle button */}
      
      {/* Placeholder when no video, video failed, media server unhealthy, or video ended */}
        <Show when={!hasVideo() || !mediaHealthy() || hasEnded()}>
        <div 
          class={`video-placeholder-overlay${videoError() ? ' video-placeholder-overlay--error' : ''}`}
        >
          {(() => {
            if (hasEnded()) {
              return '';
            }
            if (!mediaHealthy()) {
              return 'Unable to connect to media server';
            }
            if (videoError()) {
              return 'Video failed to load';
            }
            
            // Show appropriate message when no video (between files)
            if (!hasVideo()) {
              const isAnimating = isPlaying() && !isManualTimeChange();
              
              VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Animation state check', {
                isPlaying: isPlaying(),
                isManualTimeChange: isManualTimeChange(),
                isAnimating: isAnimating
              });
              const nextVideoData = nextVideo();
              
              VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Between files - showing transition screen', {
                hasVideo: hasVideo(),
                hasNextVideo: !!nextVideoData,
                nextVideo: nextVideoData,
                nextVideoType: typeof nextVideoData,
                nextVideoKeys: nextVideoData ? Object.keys(nextVideoData) : 'null',
                isAnimating
              });
              
              if (isAnimating && nextVideoData) {
                logDebug('🎥 Video: Calling getTransitionMessage with nextVideoData', {
                  nextVideoData: nextVideoData,
                  startTime: toISO(nextVideoData.start)
                });
                return getTransitionMessage(nextVideoData.start);
              } else if (isAnimating && !nextVideoData) {
                VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: No next video data, showing black screen');
                return getTransitionMessage(null);
              } else {
                // Not animating - check if there's actually a next video
                if (nextVideoData) {
                  logDebug('🎥 Video: Not animating but has next video, showing countdown');
                  return getTransitionMessage(nextVideoData.start);
                } else {
                  VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Not animating and no next video, showing black screen');
                  return 'No video available';
                }
              }
            } else if (isVideoLoading() && !isManualTimeChange()) {
              // Loading during animation - show transitioning message
              const nextVideoData = nextVideo();
              const isAnimating = isPlaying();
              
              if (isAnimating && nextVideoData) {
                logDebug('🎥 Video: Loading state - calling getTransitionMessage', {
                  nextVideoData: nextVideoData,
                  startTime: toISO(nextVideoData.start)
                });
                return getTransitionMessage(nextVideoData.start);
              } else if (isAnimating && !nextVideoData) {
                logDebug('🎥 Video: Loading state - no next video data, showing black screen');
                return getTransitionMessage(null);
              } else {
                // Loading state - not animating, check if there's a next video
                if (nextVideoData) {
                  logDebug('🎥 Video: Loading state - not animating but has next video');
                  return getTransitionMessage(nextVideoData.start);
                } else {
                VIDEO_DEBUG_ENABLED && logDebug('🎥 Video: Loading state - not animating and no next video');
                  return 'No video available';
                }
              }
            } else {
              // Other cases - show black screen
              return 'No video available';
            }
          })()}
        </div>
      </Show>
      
      {/* Loading overlay - show whenever video is loading so window is never blank */}
      <Show when={isVideoLoading()}>
        <div class="video-loading-overlay">
          {isTransitioning() ? 'Loading next video...' : 'Loading...'}
        </div>
      </Show>
      
      <div
        class="video-mirror-wrapper"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'center'
        }}
      >
        <video
          class={`video-window${props.mirrorHorizontal ? ' video-mirror-horizontal' : ''}`}
          ref={(el) => (videoRef = el)}
          width={props.width || undefined}
          height={props.height || undefined}
          controls={false}
          playsinline
          preload="metadata"
          crossOrigin="use-credentials"
          muted={isMuted()}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleDurationChange}
          onCanPlay={handleCanPlay}
          onError={handleVideoError}
          onLoadStart={handleLoadStart}
          onLoadedData={handleLoadedData}
          onEnded={handleVideoEnd}
          style={{ 
            width: '100%', 
            height: '100%', 
            'object-fit': 'contain',
            opacity: currentFile() ? 1 : 0.3
          }}
        >
          Your browser does not support the video tag.
        </video>
      </div>
      
      {/* Mute/Unmute button - only show when hovering */}
      <Show when={isHovering()}>
        <button
          onClick={toggleMute}
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '50px',
            height: '50px',
            'border-radius': '50%',
            border: 'none',
            'background-color': 'rgba(0, 0, 0, 0.7)',
            color: 'white',
            cursor: 'pointer',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'font-size': '20px',
            'z-index': 15,
            transition: 'background-color 0.2s ease'
          }}
          onMouseEnter={(e) => {
            const target = e.currentTarget;
            target.style.setProperty('background-color', 'rgba(0, 0, 0, 0.9)');
          }}
          onMouseLeave={(e) => {
            const target = e.currentTarget;
            target.style.setProperty('background-color', 'rgba(0, 0, 0, 0.7)');
          }}
          title={isMuted() ? 'Unmute video' : 'Mute video'}
        >
          {isMuted() ? '🔇' : '🔊'}
        </button>
      </Show>
      
      {/* Resolution label - only show when hovering and not in med_res-only mode (no quality switching) */}
      <Show when={isHovering() && currentFile() && !config.MEDIA_MED_RES_ONLY}>
        <div
          style={{
            position: 'absolute',
            bottom: '8px',
            right: '8px',
            color: 'white',
            'font-size': '11px',
            'font-weight': '500',
            'z-index': 15,
            'pointer-events': 'none',
            'text-shadow': '1px 1px 2px rgba(0, 0, 0, 0.8)'
          }}
        >
          {(() => {
            const quality = currentQuality();
            if (quality === 'high_res') return 'High';
            if (quality === 'med_res') return 'Med';
            if (quality === 'low_res') return 'Low';
            return quality;
          })()}
        </div>
      </Show>
      
    </div>
  );
};

export default VideoPlayer;
