// Media files service with IndexedDB caching
import { unifiedDataStore } from '../store/unifiedDataStore';
import { persistantStore } from '../store/persistantStore';
import { selectedTime } from '../store/playbackStore';
import { config } from '../config/env';
import { debug as logDebug, warn as logWarn, error as logError } from '../utils/console';
import { getData } from '../utils/global';

export interface MediaFile {
  start: Date;
  end: Date;
  fileName: string;
  id: string;
}

export interface MediaFilesCache {
  className: string;
  projectId: string;
  mediaSource: string;
  date: string; // YYYYMMDD format
  files: MediaFile[];
  timestamp: number;
  lastChecked: number;
}

class MediaFilesService {
  private cache = new Map<string, MediaFilesCache>();
  private inFlight = new Map<string, Promise<MediaFile[]>>(); // dedupe concurrent getMediaFiles for same key
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private readonly STORAGE_KEY_PREFIX = 'media_files';

  // Helper: YYYYMMDD in local time (for callers that need calendar date in browser TZ)
  private toYyyyMmDd = (d: Date): string => {
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

  // UTC calendar date for media API when no dataset timezone. Backend media.date can be stored in dataset TZ.
  private toYyyyMmDdUtc = (d: Date): string => {
    try {
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return `${yyyy}${mm}${dd}`;
    } catch (e) {
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(now.getUTCDate()).padStart(2, "0");
      return `${yyyy}${mm}${dd}`;
    }
  };

  // Calendar date in a given timezone (YYYYMMDD). Backend stores media.date in dataset timezone; use this when timezone is known.
  private toYyyyMmDdInTimezone = (d: Date, timezone: string): string => {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
      const parts = formatter.formatToParts(d);
      const yyyy = parts.find((p) => p.type === "year")?.value ?? "";
      const mm = parts.find((p) => p.type === "month")?.value ?? "";
      const dd = parts.find((p) => p.type === "day")?.value ?? "";
      return `${yyyy}${mm}${dd}`;
    } catch (e) {
      logWarn("🎥 MediaFilesService: toYyyyMmDdInTimezone failed, falling back to UTC", { timezone, error: e });
      return this.toYyyyMmDdUtc(d);
    }
  };

  /** Same YYYYMMDD as getMediaFiles (dataset TZ or UTC). Use for "same calendar day?" so refetch decision matches API. */
  public getDateYmdForMedia(d: Date, timezone?: string | null): string {
    if (timezone && timezone.trim()) return this.toYyyyMmDdInTimezone(d, timezone.trim());
    return this.toYyyyMmDdUtc(d);
  }

  // Create cache key for media files
  private createCacheKey(className: string, projectId: string, mediaSource: string, date: string): string {
    return `${this.STORAGE_KEY_PREFIX}_${className}_${projectId}_${mediaSource}_${date}`;
  }

  // Check if cache entry is still valid
  private isCacheValid(cacheEntry: MediaFilesCache): boolean {
    const now = Date.now();
    return (now - cacheEntry.timestamp) < this.CACHE_TTL;
  }

  // Store media files in IndexedDB
  private async storeInIndexedDB(cacheKey: string, cacheEntry: MediaFilesCache): Promise<void> {
    try {
      await unifiedDataStore.storeObject(cacheKey, cacheEntry);
      logDebug('🎥 MediaFilesService: Stored in IndexedDB', { cacheKey, filesCount: cacheEntry.files.length });
    } catch (error) {
      logError('🎥 MediaFilesService: Failed to store in IndexedDB', error);
    }
  }

  /** Normalize file start/end to Date. After IndexedDB (de)serialization they can be strings. */
  private normalizeMediaFileDates(files: Array<{ start: Date | string; end: Date | string; fileName: string; id?: string | number }>): MediaFile[] {
    return files.map((f) => ({
      start: f.start instanceof Date ? f.start : new Date(f.start),
      end: f.end instanceof Date ? f.end : new Date(f.end),
      fileName: f.fileName,
      id: f.id != null ? String(f.id) : ''
    }));
  }

  // Retrieve media files from IndexedDB
  private async getFromIndexedDB(cacheKey: string): Promise<MediaFilesCache | null> {
    try {
      const cached = await unifiedDataStore.getObject(cacheKey);
      if (cached && this.isCacheValid(cached)) {
        const files = this.normalizeMediaFileDates(cached.files ?? []);
        logDebug('🎥 MediaFilesService: Retrieved from IndexedDB', { cacheKey, filesCount: files.length });
        return { ...cached, files };
      }
      return null;
    } catch (error) {
      logWarn('🎥 MediaFilesService: Failed to retrieve from IndexedDB', error);
      return null;
    }
  }

  // Fetch media files from API
  private async fetchFromAPI(className: string, projectId: string, mediaSource: string, date: string): Promise<MediaFile[]> {
    try {
      logDebug('🎥 MediaFilesService: Fetching from API', { className, projectId, mediaSource, date });
      
      const url = `/api/media?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(date)}&media_source=${encodeURIComponent(mediaSource)}`;
      
      const response = await getData(url);
      
      if (!response.success) {
        if (response.status === 204) {
          logDebug('🎥 MediaFilesService: No media files found (204)');
          return [];
        }
        
        logError('🎥 MediaFilesService: API fetch failed', {
          status: response.status,
          message: response.message,
          url
        });
        throw new Error(`Media fetch failed: ${response.status} - ${response.message}`);
      }
      
      const json = response.data;
      if (!json) {
        logDebug('🎥 MediaFilesService: Empty response');
        return [];
      }
      
      const list = Array.isArray(json?.data || json) ? (json.data || json) : [];
      
      const files = list
        .map((r) => {
          const start = r.start_time || r.start || r.begin || r.ts_start;
          const end = r.end_time || r.end || r.finish || r.ts_end;
          const startDate = start ? new Date(start) : null;
          const endDate = end ? new Date(end) : null;
          if (!startDate || !endDate || isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return null;
          const fileName = r.file_name || r.file || r.filename || '';
          const id = r.media_id || r.id || undefined;
          return { start: startDate, end: endDate, fileName, id };
        })
        .filter(Boolean)
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      
      logDebug('🎥 MediaFilesService: Fetched from API', { filesCount: files.length });
      return files;
    } catch (error) {
      logError('🎥 MediaFilesService: Error fetching from API', error);
      throw error;
    }
  }

  // Get media files with caching. Date for API: when overrideDateYmd is set use it (same day as timeline); else when timezone is provided use calendar date in that TZ (matches backend media.date); otherwise UTC.
  // In-flight requests for the same cache key are deduped so multiple callers (e.g. 3–4 maneuver video tiles) share one fetch.
  public async getMediaFiles(mediaSource: string, targetDate?: Date, timezone?: string | null, overrideDateYmd?: string | null): Promise<MediaFile[]> {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    const resolved = targetDate || selectedTime() || new Date();
    const date =
      overrideDateYmd && String(overrideDateYmd).trim().length >= 8
        ? String(overrideDateYmd).trim().replace(/-/g, "").slice(0, 8)
        : timezone && timezone.trim()
          ? this.toYyyyMmDdInTimezone(resolved, timezone.trim())
          : this.toYyyyMmDdUtc(resolved);
    logDebug("🎥 MediaFilesService: getMediaFiles date for API", {
      date,
      overrideDateYmd: overrideDateYmd ?? undefined,
      timezone: timezone ?? "UTC",
      targetDate: targetDate?.toISOString(),
      selectedTime: selectedTime()?.toISOString()
    });

    if (!className || !projectId || !mediaSource) {
      logWarn('🎥 MediaFilesService: Missing required parameters', { className, projectId, mediaSource });
      return [];
    }

    const cacheKey = this.createCacheKey(className, projectId, mediaSource, date);

    // Check memory cache first (sync, no need to dedupe)
    const memoryCached = this.cache.get(cacheKey);
    if (memoryCached && this.isCacheValid(memoryCached)) {
      logDebug('🎥 MediaFilesService: Retrieved from memory cache', { cacheKey, filesCount: memoryCached.files.length });
      return memoryCached.files;
    }

    // Dedupe in-flight: if another caller is already fetching this key, wait for that promise
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      logDebug('🎥 MediaFilesService: Joining in-flight request', { cacheKey });
      return existing;
    }

    const promise = this.getMediaFilesInternal(className, projectId, mediaSource, date, cacheKey);
    this.inFlight.set(cacheKey, promise);
    try {
      const result = await promise;
      return result;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async getMediaFilesInternal(className: string, projectId: string, mediaSource: string, date: string, cacheKey: string): Promise<MediaFile[]> {
    // Check IndexedDB cache
    const indexedDBCached = await this.getFromIndexedDB(cacheKey);
    if (indexedDBCached) {
      // Store in memory cache for faster access
      this.cache.set(cacheKey, indexedDBCached);
      return indexedDBCached.files;
    }

    // Fetch from API
    try {
      const files = await this.fetchFromAPI(className, projectId, mediaSource, date);

      // Create cache entry
      const cacheEntry: MediaFilesCache = {
        className,
        projectId,
        mediaSource,
        date,
        files,
        timestamp: Date.now(),
        lastChecked: Date.now()
      };

      // Store in both memory and IndexedDB
      this.cache.set(cacheKey, cacheEntry);
      await this.storeInIndexedDB(cacheKey, cacheEntry);

      return files;
    } catch (error) {
      logError('🎥 MediaFilesService: Failed to fetch media files', error);
      return [];
    }
  }

  // Clear cache for specific parameters
  public async clearCache(className?: string, projectId?: string, mediaSource?: string, date?: string): Promise<void> {
    if (className && projectId && mediaSource && date) {
      // Clear specific cache entry
      const cacheKey = this.createCacheKey(className, projectId, mediaSource, date);
      this.cache.delete(cacheKey);
      await unifiedDataStore.deleteObject(cacheKey);
      logDebug('🎥 MediaFilesService: Cleared specific cache entry', { cacheKey });
    } else {
      // Clear all media files cache
      const keysToDelete: string[] = [];
      
      // Clear memory cache
      for (const key of this.cache.keys()) {
        if (key.startsWith(this.STORAGE_KEY_PREFIX)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => this.cache.delete(key));
      
      // Clear IndexedDB cache
      try {
        const allObjects = await unifiedDataStore.listObjects();
        const mediaObjects = allObjects.filter(obj => obj.startsWith(this.STORAGE_KEY_PREFIX));
        await Promise.all(mediaObjects.map(obj => unifiedDataStore.deleteObject(obj)));
      } catch (error) {
        logWarn('🎥 MediaFilesService: Error clearing IndexedDB cache', error);
      }
      
      logDebug('🎥 MediaFilesService: Cleared all media files cache', { clearedCount: keysToDelete.length });
    }
  }

  // Get cache info
  public getCacheInfo(): { memoryEntries: number; memoryKeys: string[] } {
    const memoryKeys = Array.from(this.cache.keys()).filter(key => key.startsWith(this.STORAGE_KEY_PREFIX));
    return {
      memoryEntries: memoryKeys.length,
      memoryKeys
    };
  }

  // Check if data is cached (use same date logic as getMediaFiles for cache key)
  public isCached(mediaSource: string, targetDate?: Date, timezone?: string | null): boolean {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    const resolved = targetDate || selectedTime() || new Date();
    const date =
      timezone && timezone.trim()
        ? this.toYyyyMmDdInTimezone(resolved, timezone.trim())
        : this.toYyyyMmDdUtc(resolved);
    
    if (!className || !projectId || !mediaSource) return false;
    
    const cacheKey = this.createCacheKey(className, projectId, mediaSource, date);
    const cached = this.cache.get(cacheKey);
    return cached ? this.isCacheValid(cached) : false;
  }

  // Force refresh cache for specific parameters (use same date logic as getMediaFiles)
  public async refreshCache(mediaSource: string, targetDate?: Date, timezone?: string | null): Promise<MediaFile[]> {
    const className = persistantStore.selectedClassName();
    const projectId = persistantStore.selectedProjectId();
    const resolved = targetDate || selectedTime() || new Date();
    const date =
      timezone && timezone.trim()
        ? this.toYyyyMmDdInTimezone(resolved, timezone.trim())
        : this.toYyyyMmDdUtc(resolved);
    
    if (!className || !projectId || !mediaSource) {
      logWarn('🎥 MediaFilesService: Missing required parameters for refresh', { className, projectId, mediaSource });
      return [];
    }

    // Clear existing cache
    await this.clearCache(className, projectId, mediaSource, date);

    // Fetch fresh data (pass timezone so same date is used)
    return await this.getMediaFiles(mediaSource, targetDate, timezone);
  }
}

// Export singleton instance
export const mediaFilesService = new MediaFilesService();
export default mediaFilesService;
