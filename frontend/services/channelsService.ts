import { apiEndpoints } from '@config/env';
import { getData } from '../utils/global';
import { debug, warn, error, log } from '../utils/console';
import { huniDBStore } from '../store/huniDBStore';

/**
 * Get channels from PostgreSQL API endpoint
 * @param className - Class name (e.g., 'gp50')
 * @param projectId - Project ID
 * @param date - Date in YYYYMMDD or YYYY-MM-DD format
 * @param dataSource - Optional data source filter ('FILE', 'INFLUX', or 'UNIFIED')
 * @returns Promise<string[]> Array of channel names
 */
export async function getChannels(
  className: string,
  projectId: number | string,
  date: string,
  dataSource?: 'FILE' | 'INFLUX' | 'UNIFIED'
): Promise<string[]> {
  try {
    // Normalize date format (remove dashes if present)
    const normalizedDate = date.replace(/[-/]/g, '');
    
    const url = new URL(apiEndpoints.app.channels, window.location.origin);
    url.searchParams.set('class_name', className);
    url.searchParams.set('project_id', String(projectId));
    url.searchParams.set('date', normalizedDate);
    
    if (dataSource) {
      url.searchParams.set('data_source', dataSource);
    }
    
    const response = await getData(url.toString());
    
    if (response.success && response.data && Array.isArray(response.data)) {
      debug(`[channelsService] Retrieved ${response.data.length} channels from PostgreSQL API for date ${normalizedDate}`);
      return response.data;
    }
    
    warn(`[channelsService] No channels returned from API for date ${normalizedDate}`);
    return [];
  } catch (err) {
    error(`[channelsService] Error fetching channels from API:`, err);
    return [];
  }
}

/**
 * Sync channels from PostgreSQL API to hunidb meta.channel_names table
 * This is a non-blocking background function that populates hunidb cache
 * @param className - Class name (e.g., 'gp50')
 * @param projectId - Project ID
 * @param date - Date in YYYYMMDD or YYYY-MM-DD format
 * @param sourceName - Optional source name (for logging)
 * @returns Promise<void> - Does not return values (fire-and-forget)
 */
export async function syncChannelsFromPostgreSQL(
  className: string,
  projectId: number | string,
  date: string,
  sourceName?: string
): Promise<void> {
  try {
    // Normalize date format (remove dashes if present)
    const normalizedDate = date.replace(/[-/]/g, '');
    
    debug(`[channelsService] Starting background sync of channels from PostgreSQL for date ${normalizedDate}${sourceName ? `, source ${sourceName}` : ''}`);
    
    // Get channels from PostgreSQL API
    const channels = await getChannels(className, projectId, normalizedDate);
    
    if (channels.length === 0) {
      debug(`[channelsService] No channels to sync for date ${normalizedDate}`);
      return;
    }
    
    // Get database instance
    const db = await huniDBStore.getDatabase(className);
    
    // Insert channels into hunidb meta.channel_names
    // We need to determine data_source for each channel
    // For now, we'll insert all channels with data_source='UNIFIED' since the API returns combined channels
    // If we need to track FILE vs INFLUX separately, we'd need to call the API twice with different data_source filters
    
    // Try to get FILE and INFLUX channels separately to preserve data_source
    const [fileChannels, influxChannels] = await Promise.all([
      getChannels(className, projectId, normalizedDate, 'FILE'),
      getChannels(className, projectId, normalizedDate, 'INFLUX')
    ]);
    
    // Insert FILE channels
    if (fileChannels.length > 0) {
      for (const channelName of fileChannels) {
        try {
          await db.exec(
            `INSERT OR IGNORE INTO "meta.channel_names" (channel_name, date, data_source, discovered_at) VALUES (?, ?, ?, ?)`,
            [channelName, normalizedDate, 'FILE', Date.now()]
          );
        } catch (err) {
          // Ignore individual channel errors, continue with others
          debug(`[channelsService] Error inserting FILE channel ${channelName}:`, err);
        }
      }
    }
    
    // Insert INFLUX channels
    if (influxChannels.length > 0) {
      for (const channelName of influxChannels) {
        try {
          await db.exec(
            `INSERT OR IGNORE INTO "meta.channel_names" (channel_name, date, data_source, discovered_at) VALUES (?, ?, ?, ?)`,
            [channelName, normalizedDate, 'INFLUX', Date.now()]
          );
        } catch (err) {
          // Ignore individual channel errors, continue with others
          debug(`[channelsService] Error inserting INFLUX channel ${channelName}:`, err);
        }
      }
    }
    
    log(`[channelsService] ✅ Background sync completed: ${fileChannels.length} FILE, ${influxChannels.length} INFLUX channels synced to hunidb for date ${normalizedDate}`);
  } catch (err) {
    // Log error but don't throw - this is a background sync
    warn(`[channelsService] Background sync failed for date ${date}:`, err);
  }
}

/**
 * Get channels from the file server (live discovery from parquet + Influx).
 * Use this to include channels that exist on disk (e.g. fusion_corrections_racesight.parquet)
 * but may not yet be in PostgreSQL (e.g. after running 3_corrections without re-populating channels).
 * @param className - Class name (e.g., 'gp50')
 * @param projectId - Project ID
 * @param date - Date in YYYYMMDD format
 * @param sourceName - Source name (e.g., 'GER')
 * @param dataSource - 'file' | 'influx' | 'unified' (default 'unified')
 * @returns Promise<string[]> Array of channel names, or [] on error
 */
export async function getChannelsFromFileServer(
  className: string,
  projectId: number | string,
  date: string,
  sourceName: string,
  dataSource: 'file' | 'influx' | 'unified' = 'unified'
): Promise<string[]> {
  try {
    const normalizedDate = date.replace(/[-/]/g, '');
    const url = new URL(apiEndpoints.file.channels, window.location.origin);
    url.searchParams.set('class_name', className);
    url.searchParams.set('project_id', String(projectId));
    url.searchParams.set('date', normalizedDate);
    url.searchParams.set('source_name', sourceName);
    url.searchParams.set('data_source', dataSource);

    const response = await getData(url.toString());
    if (response?.success && Array.isArray(response.data)) {
      debug(`[channelsService] File server returned ${response.data.length} channels (data_source=${dataSource})`);
      return response.data;
    }
    return [];
  } catch (err) {
    debug(`[channelsService] File server channel fetch failed (non-fatal):`, err);
    return [];
  }
}

/**
 * Merge two channel lists with case-insensitive deduplication; preserves first-seen casing.
 * Use to combine PostgreSQL/HuniDB channels with file-server channels (e.g. fusion).
 */
export function mergeChannelLists(primary: string[], secondary: string[]): string[] {
  const map = new Map<string, string>();
  [...primary, ...secondary].forEach((ch) => {
    if (!ch || typeof ch !== 'string') return;
    const lower = ch.toLowerCase();
    if (!map.has(lower)) map.set(lower, ch);
  });
  return Array.from(map.values()).sort();
}
