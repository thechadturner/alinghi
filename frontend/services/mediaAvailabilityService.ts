/**
 * Media availability service: fast sync lookups for "does this (sourceName, datetime) have video?"
 * and batch preloading for multiple sources/dates. Used by maneuver VIDEO filter and can be
 * reused across the app (e.g. MapTimeSeries, Video component).
 */
import { persistantStore } from "../store/persistantStore";
import { mediaFilesService } from "./mediaFilesService";
import { getData } from "../utils/global";
import { MANEUVER_VIDEO_START_OFFSET_SECONDS } from "../store/playbackStore";
import { debug as logDebug } from "../utils/console";

export interface MediaWindow {
  start: Date;
  end: Date;
}

const CACHE_KEY_PREFIX = "media_availability";

function normalizeSource(sourceName: string): string {
  return String(sourceName ?? "").trim().toLowerCase();
}

/** Normalize date to YYYYMMDD (8 chars) for cache key. */
function normalizeDateYmd(dateYmd: string): string {
  const s = String(dateYmd ?? "").trim();
  if (s.length >= 8 && /^\d{8}$/.test(s)) return s;
  const m = s.match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return s;
}

class MediaAvailabilityService {
  /** In-memory cache: key = className|projectId|normalizedSource|dateYmd, value = windows[] */
  private cache = new Map<string, MediaWindow[]>();
  private inFlight = new Map<string, Promise<void>>();

  private cacheKey(sourceName: string, dateYmd: string): string {
    const className = persistantStore.selectedClassName() ?? "";
    const projectId = persistantStore.selectedProjectId() ?? "";
    const normSource = normalizeSource(sourceName);
    const normDate = normalizeDateYmd(dateYmd);
    return `${CACHE_KEY_PREFIX}_${className}_${projectId}_${normSource}_${normDate}`;
  }

  /** Derive dateYmd from a Date using optional timezone (matches mediaFilesService convention). */
  getDateYmdFromDatetime(datetime: Date, timezone?: string | null): string {
    return mediaFilesService.getDateYmdForMedia(datetime, timezone ?? undefined);
  }

  /**
   * Sync. Returns true if cache has windows for (source, dateYmd) and at least one window
   * contains datetime + clipOffsetSeconds. On cache miss returns false (callers should preload).
   */
  hasVideo(
    sourceName: string,
    datetime: Date,
    options?: { timezone?: string | null; clipOffsetSeconds?: number }
  ): boolean {
    const dateYmd = this.getDateYmdFromDatetime(datetime, options?.timezone);
    const windows = this.getWindows(sourceName, dateYmd);
    if (windows.length === 0) return false;
    const offsetSec = options?.clipOffsetSeconds ?? MANEUVER_VIDEO_START_OFFSET_SECONDS;
    const checkTime = datetime.getTime() + offsetSec * 1000;
    return windows.some(
      (w) => w.start.getTime() <= checkTime && checkTime <= w.end.getTime()
    );
  }

  /**
   * Sync. Returns cached windows for (sourceName, dateYmd) or empty array.
   */
  getWindows(sourceName: string, dateYmd: string): MediaWindow[] {
    const key = this.cacheKey(sourceName, dateYmd);
    const cached = this.cache.get(key);
    if (!cached) return [];
    return cached.map((w) => ({
      start: w.start instanceof Date ? w.start : new Date(w.start),
      end: w.end instanceof Date ? w.end : new Date(w.end),
    }));
  }

  /**
   * Preload: fetch sources for date, then for each source fetch windows and store in cache.
   */
  async preloadForDate(dateYmd: string, timezone?: string | null): Promise<void> {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    if (!className || !projectId) return;

    const normDate = normalizeDateYmd(dateYmd);
    const key = `${CACHE_KEY_PREFIX}_${className}_${projectId}_sources_${normDate}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      await existing;
      return;
    }

    const promise = this.preloadForDateInternal(className, projectId, normDate, timezone);
    this.inFlight.set(key, promise);
    try {
      await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async preloadForDateInternal(
    className: string,
    projectId: string,
    dateYmd: string,
    timezone?: string | null
  ): Promise<void> {
    try {
      const url = `/api/media/sources?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateYmd)}`;
      logDebug("MediaAvailabilityService: Fetching media sources", { dateYmd });
      const response = await getData(url);
      if (!response?.success || !response?.data) return;
      const list = Array.isArray(response.data) ? response.data : [];
      const sources = list.map((r: { id?: string; media_source?: string; name?: string }, i: number) => ({
        id: r.id ?? r.media_source ?? r.name ?? `src_${i}`,
        name: r.name ?? r.media_source ?? r.id ?? `Source ${i + 1}`,
      }));

      for (const source of sources) {
        const files = await mediaFilesService.getMediaFiles(
          source.id,
          undefined,
          timezone ?? undefined,
          dateYmd
        );
        const windows: MediaWindow[] = files.map((f) => ({ start: f.start, end: f.end }));
        const cacheKey = this.cacheKey(source.id, dateYmd);
        this.cache.set(cacheKey, windows);
        logDebug("MediaAvailabilityService: Cached windows", {
          source: source.id,
          dateYmd,
          count: windows.length,
        });
      }
    } catch (e) {
      logDebug("MediaAvailabilityService: preloadForDate failed", e);
    }
  }

  /**
   * Preload: for each unique (sourceName, dateYmd) fetch windows and store in cache. Dedupes by key and in-flight.
   */
  async preloadForSourcesAndDates(
    entries: Array<{ sourceName: string; dateYmd: string }>,
    timezone?: string | null
  ): Promise<void> {
    const seen = new Set<string>();
    const promises: Promise<void>[] = [];
    for (const { sourceName, dateYmd } of entries) {
      const normSource = normalizeSource(sourceName);
      const normDate = normalizeDateYmd(dateYmd);
      const key = this.cacheKey(sourceName, normDate);
      if (seen.has(key)) continue;
      seen.add(key);

      const inFlightKey = `preload_${key}`;
      let p = this.inFlight.get(inFlightKey);
      if (!p) {
        p = this.preloadOneSourceAndDate(sourceName, normDate, timezone).finally(() => {
          this.inFlight.delete(inFlightKey);
        });
        this.inFlight.set(inFlightKey, p);
      }
      promises.push(p);
    }
    await Promise.all(promises);
  }

  private async preloadOneSourceAndDate(
    sourceName: string,
    dateYmd: string,
    timezone?: string | null
  ): Promise<void> {
    try {
      const files = await mediaFilesService.getMediaFiles(
        sourceName,
        undefined,
        timezone ?? undefined,
        dateYmd
      );
      const windows: MediaWindow[] = files.map((f) => ({ start: f.start, end: f.end }));
      const key = this.cacheKey(sourceName, dateYmd);
      this.cache.set(key, windows);
      logDebug("MediaAvailabilityService: Cached windows for source/date", {
        sourceName,
        dateYmd,
        count: windows.length,
      });
    } catch (e) {
      logDebug("MediaAvailabilityService: preloadOneSourceAndDate failed", {
        sourceName,
        dateYmd,
        error: e,
      });
    }
  }

  /**
   * Clear in-memory cache. If className/projectId provided, clear only entries for that scope.
   */
  clearCache(className?: string, projectId?: string): void {
    if (className != null && projectId != null) {
      const prefix = `${CACHE_KEY_PREFIX}_${className}_${projectId}_`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) this.cache.delete(key);
      }
    } else {
      this.cache.clear();
    }
    logDebug("MediaAvailabilityService: clearCache", { className, projectId });
  }
}

export const mediaAvailabilityService = new MediaAvailabilityService();
export default mediaAvailabilityService;
