import { createSignal } from 'solid-js';
import { streamingService, StreamingDataPoint } from '../services/streamingService';
import { streamingDataService } from '../services/streamingDataService';
import { sourcesStore } from './sourcesStore';
import { selectedTime, timeWindow, getDisplayWindowReferenceTime } from './playbackStore';
import { selectedRange, selectedRanges } from './selectionStore';
import { LIVE_STREAM_CHANNELS } from '../constants/liveChannels';
import { debug, warn, error as logError } from '../utils/console';
import { config } from '../config/env';

/**
 * Streaming Store
 * WebSocket-only store for managing streaming data connections
 * Emits updates immediately as websocket data arrives (no batching for maximum responsiveness)
 */
class StreamingStore {
  private _isInitialized = false;
  private _isInitializing = false;
  private unsubscribeCallbacks: Array<() => void> = [];
  // Track sources we've already warned about to avoid spam
  private sourceIdMismatchWarned = new Set<string>();
  // Counter to reduce logging frequency
  private dataPointCount = 0;

  // Reactive signals
  private loadingSignal = createSignal<boolean>(false);
  private errorSignal = createSignal<string | null>(null);
  
  // Reactive signal for immediate data updates (components can watch this)
  // This stores only the latest point per source for immediate updates
  private newDataSignal = createSignal<Map<number, any[]>>(new Map());
  
  // Signal bumped when historical data is loaded from Redis - triggers timeline re-render
  private historicalDataVersionSignal = createSignal(0);
  // Signal bumped on every WebSocket append to historicalData - ensures chart/map re-run when getNewData() is cleared
  private liveDataAppendVersionSignal = createSignal(0);

  // Historical data storage - accumulates all data points per source
  // This is used for time window filtering and track rendering
  private historicalData = new Map<number, any[]>();

  // Source IDs we are currently subscribed to (avoids cleanup when table/map both call initialize with same ids)
  private currentSourceIds = new Set<number>();

  private static setsEqual(a: Set<number>, b: Set<number>): boolean {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  get isInitialized() {
    return this._isInitialized;
  }

  /**
   * Initialize WebSocket connection and set up data callbacks
   */
  async initialize(selectedSourceIds: Set<number>): Promise<void> {
    debug('[StreamingStore] 🚀 initialize() called', {
      sourceIds: Array.from(selectedSourceIds),
      sourceCount: selectedSourceIds.size,
      ENABLE_WEBSOCKETS: config.ENABLE_WEBSOCKETS
    });
    
    // Check if WebSockets are enabled
    if (!config.ENABLE_WEBSOCKETS) {
      const msg = '[StreamingStore] WebSockets are disabled (VITE_ENABLE_WEBSOCKETS=false), skipping initialization';
      debug(msg);
      warn('[StreamingStore] ⚠️', msg);
      this.loadingSignal[1](false);
      this.errorSignal[1]('WebSockets are disabled');
      this._isInitialized = false;
      this._isInitializing = false;
      return;
    }
    
    // Prevent multiple simultaneous initializations
    if (this._isInitializing) {
      debug('[StreamingStore] Initialization already in progress, waiting...');
      const maxWait = 15000;
      const pollInterval = 100;
      const startTime = Date.now();
      
      while (this._isInitializing && (Date.now() - startTime) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
      
      if (this._isInitializing) {
        logError('[StreamingStore] Initialization wait timeout');
        throw new Error('Initialization timeout');
      }
      
      if (this._isInitialized) {
        debug('[StreamingStore] Initialization completed while waiting');
        return;
      }
    }
    
    if (this._isInitialized) {
      if (StreamingStore.setsEqual(selectedSourceIds, this.currentSourceIds)) {
        debug('[StreamingStore] Already initialized with same source IDs, skipping');
        return;
      }
      debug('[StreamingStore] Already initialized, updating subscriptions (keeping live data)');
      await this.updateSelectedSources(selectedSourceIds, this.currentSourceIds);
      this.currentSourceIds = new Set(selectedSourceIds);
      return;
    }

    this._isInitializing = true;
    this.loadingSignal[1](true);
    this.errorSignal[1](null);

    try {
      // Connect to WebSocket
      debug('[StreamingStore] Attempting to connect to streaming service...');
      debug('[StreamingStore] 🔌 Attempting to connect to WebSocket...');
      const connected = await streamingService.connect();
      debug('[StreamingStore] 🔌 Connection result:', connected);
      debug('[StreamingStore] Connection result:', connected);
      if (!connected) {
        const errorMsg = streamingService.getLastError();
        debug('[StreamingStore] getLastError() returned:', errorMsg);
        const finalErrorMsg = errorMsg || 'Failed to connect to streaming service (no error details available)';
        logError('[StreamingStore] Connection failed:', finalErrorMsg);
        throw new Error(finalErrorMsg);
      }
      debug('[StreamingStore] Successfully connected to streaming service');
      debug('[StreamingStore] ✅ Successfully connected to streaming service');

      // Subscribe to data updates - feed into unifiedDataStore
      const unsubscribeData = streamingService.onData((dataPoint: StreamingDataPoint) => {
        // Handle asynchronously to avoid blocking
        this.handleWebSocketData(dataPoint).catch(err => {
          logError('[StreamingStore] Error in handleWebSocketData:', err);
        });
      });

      // Subscribe to connection changes
      const unsubscribeConnection = streamingService.onConnection((connected) => {
        if (!connected) {
          this.errorSignal[1]('Disconnected from streaming service');
        } else {
          this.errorSignal[1](null);
          // Re-subscribe to all sources with a small delay to ensure WebSocket is ready
          // Use queueMicrotask to ensure this happens after the connection is fully established
          queueMicrotask(async () => {
            // Retry subscription with exponential backoff if WebSocket not ready
            const retrySubscribe = async (source_name: string, maxRetries = 10, initialDelay = 100) => {
              let retries = maxRetries;
              let delay = initialDelay;
              
              while (retries > 0) {
                // Check if WebSocket is connected
                if (streamingService.isConnected()) {
                  if (streamingService.subscribe(source_name)) {
                    debug(`[StreamingStore] ✅ Re-subscribed to source "${source_name}" after reconnection`);
                    return true;
                  } else {
                    // Subscribe returned false - might be already subscribed
                    const subscriptions = streamingService.getSubscriptions();
                    if (subscriptions.has(source_name)) {
                      debug(`[StreamingStore] Already subscribed to source "${source_name}" after reconnection`);
                      return true;
                    }
                    // Not subscribed and subscribe failed - retry
                    debug(`[StreamingStore] ⚠️ Re-subscribe returned false for "${source_name}", retrying in ${delay}ms (${retries} retries left)`);
                  }
                } else {
                  // WebSocket not connected yet
                  debug(`[StreamingStore] ⏳ WebSocket not connected for re-subscription "${source_name}", waiting ${delay}ms (${retries} retries left)`);
                }
                
                retries--;
                if (retries > 0) {
                  await new Promise(resolve => setTimeout(resolve, delay));
                  delay = Math.min(delay * 1.5, 2000); // Exponential backoff, max 2 seconds
                }
              }
              
              warn(`[StreamingStore] Failed to re-subscribe to source "${source_name}" after ${maxRetries} retries`);
              return false;
            };
            
            // Convert source_ids to source_names before subscribing
            // Subscribe without channels = get all data (processor-mapped names); filter client-side
            const subscriptionPromises = [];
            for (const source_id of selectedSourceIds) {
              const source_name = sourcesStore.getSourceName(source_id);
              if (source_name) {
                subscriptionPromises.push(retrySubscribe(source_name));
              } else {
                warn(`[StreamingStore] Could not get source_name for source_id ${source_id}, skipping subscription`);
              }
            }
            
            // Wait for all re-subscriptions to complete
            await Promise.all(subscriptionPromises);
            debug('[StreamingStore] ✅ All re-subscription attempts completed');
          });
        }
      });

      this.unsubscribeCallbacks.push(unsubscribeData, unsubscribeConnection);

      // Subscribe to selected sources with retry logic
      // Wait for WebSocket to be ready before attempting subscriptions
      debug('[StreamingStore] 📡 Setting up subscriptions for', selectedSourceIds.size, 'sources');
      
      const subscribeWithRetry = async (source_name: string, maxRetries = 10, initialDelay = 100) => {
        let retries = maxRetries;
        let delay = initialDelay;
        
        while (retries > 0) {
          // Check if WebSocket is connected
          if (streamingService.isConnected()) {
            if (streamingService.subscribe(source_name)) {
              debug(`[StreamingStore] ✅ Subscribed to source "${source_name}" (all channels)`);
              return true;
            } else {
              // Subscribe returned false - might be already subscribed or other issue
              // Check if already subscribed
              const subscriptions = streamingService.getSubscriptions();
              if (subscriptions.has(source_name)) {
                debug(`[StreamingStore] Already subscribed to source "${source_name}"`);
                return true;
              }
              // Not subscribed and subscribe failed - log and retry
              debug(`[StreamingStore] ⚠️ Subscribe returned false for "${source_name}", retrying in ${delay}ms (${retries} retries left)`, {
                isConnected: streamingService.isConnected(),
                readyState: (streamingService as any).ws?.readyState
              });
            }
          } else {
            // WebSocket not connected yet
            debug(`[StreamingStore] ⏳ WebSocket not connected for "${source_name}", waiting ${delay}ms (${retries} retries left)`, {
              readyState: (streamingService as any).ws?.readyState
            });
          }
          
          retries--;
          if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 1.5, 2000); // Exponential backoff, max 2 seconds
          }
        }
        
        const msg = `[StreamingStore] Failed to subscribe to source "${source_name}" after ${maxRetries} retries`;
        warn(msg, {
          source_name,
          isConnected: streamingService.isConnected(),
          readyState: (streamingService as any).ws?.readyState
        });
        logError('[StreamingStore] ❌', msg);
        return false;
      };
      
      // Convert source_ids to source_names before subscribing
      // Subscribe without channels = get all data (processor-mapped names from Redis/WebSocket)
      // Use queueMicrotask to ensure WebSocket connection is established
      queueMicrotask(async () => {
        const subscriptionPromises = [];
        const availableSources = sourcesStore.sources();
        debug('[StreamingStore] Available sources for subscription:', {
          sourceCount: availableSources.length,
          sources: availableSources.map(s => ({ source_id: s.source_id, source_name: s.source_name })),
          selectedSourceIds: Array.from(selectedSourceIds),
          sourcesStoreReady: sourcesStore.isReady()
        });
        
        for (const source_id of selectedSourceIds) {
          const source_name = sourcesStore.getSourceName(source_id);
          if (source_name) {
            debug(`[StreamingStore] 📡 Attempting to subscribe to source_id ${source_id} (source_name: "${source_name}")`);
            subscriptionPromises.push(subscribeWithRetry(source_name));
          } else {
            const msg = `[StreamingStore] Could not get source_name for source_id ${source_id}, skipping subscription`;
            warn(msg, {
              source_id,
              sourcesStoreReady: sourcesStore.isReady(),
              availableSourceIds: availableSources.map(s => s.source_id),
              availableSourceNames: availableSources.map(s => s.source_name)
            });
            warn('[StreamingStore] ⚠️', msg);
          }
        }
        
        // Wait for all subscriptions to complete (or fail)
        await Promise.all(subscriptionPromises);
        debug('[StreamingStore] ✅ All subscription attempts completed');
      });

      this.loadingSignal[1](false);
      this._isInitialized = true;
      this._isInitializing = false;
      this.currentSourceIds = new Set(selectedSourceIds);
      debug('[StreamingStore] Initialized successfully');
      debug('[StreamingStore] ✅ Initialized successfully');
    } catch (err) {
      logError('[StreamingStore] Initialization failed:', err);
      this.errorSignal[1](err instanceof Error ? err.message : 'Initialization failed');
      this.loadingSignal[1](false);
      this._isInitializing = false;
      this._isInitialized = false;
    }
  }

  /**
   * Handle WebSocket data updates - emit immediately (no batching)
   */
  private async handleWebSocketData(dataPoint: StreamingDataPoint): Promise<void> {
    try {
      // Extract source_name from data
      const sourceName = dataPoint.source_name || dataPoint.data?.source_name;
      if (!sourceName) {
        debug('[StreamingStore] WebSocket data point missing source_name, skipping');
        return;
      }

      // Convert WebSocket data point to format expected by unifiedDataStore
      // The data object contains all channel values
      const channels = Object.keys(dataPoint.data || {});
      if (channels.length === 0) {
        debug('[StreamingStore] WebSocket data point has no channels, skipping');
        return;
      }

      // Get source_id for signal emission
      // Prefer sourcesStore lookup (most reliable), but fallback to server's source_id if sourcesStore isn't ready
      let sourceId: number | null = null;
      
      // Try to get correct source_id from sourcesStore first
      if (sourcesStore.isReady()) {
        const correctSourceId = sourcesStore.getSourceId(sourceName);
        if (correctSourceId !== null) {
          sourceId = correctSourceId;
          
          // Validate that server's source_id matches the correct one (if provided)
          // Only warn once per source to avoid log spam
          const serverSourceId = dataPoint.source_id ?? null;
          if (serverSourceId !== null && serverSourceId !== correctSourceId) {
            if (!this.sourceIdMismatchWarned.has(sourceName)) {
              debug('[StreamingStore] Server source_id mismatch - using correct source_id from sourcesStore', {
                source_name: sourceName,
                server_source_id: serverSourceId,
                correct_source_id: correctSourceId,
                note: 'Server sent incorrect source_id; using correct mapping from sourcesStore. Logged once per source.'
              });
              this.sourceIdMismatchWarned.add(sourceName);
            }
          }
        }
      }
      
      // Fallback: use server's source_id if sourcesStore lookup failed or isn't ready
      if (sourceId === null) {
        const serverSourceId = dataPoint.source_id ?? null;
        if (serverSourceId !== null) {
          sourceId = serverSourceId;
          if (!sourcesStore.isReady()) {
            debug('[StreamingStore] sourcesStore not ready, using server source_id temporarily', {
              source_name: sourceName,
              server_source_id: serverSourceId
            });
          } else {
            warn('[StreamingStore] Could not find source in sourcesStore, using server source_id', {
              source_name: sourceName,
              server_source_id: serverSourceId,
              availableSources: sourcesStore.sources().map(s => ({ source_id: s.source_id, source_name: s.source_name }))
            });
          }
        }
      }
      
      // Final check - if we still don't have a source_id, we can't process this data
      if (sourceId === null) {
        warn('[StreamingStore] Cannot determine source_id for data point', {
          source_name: sourceName,
          dataPoint_source_id: dataPoint.source_id,
          sourcesStoreReady: sourcesStore.isReady(),
          availableSources: sourcesStore.sources().map(s => ({ source_id: s.source_id, source_name: s.source_name }))
        });
        // Cannot process without source_id - return early
        return;
      }
      
      // Get previous point for this source so we can carry forward missing channels (no flashing)
      const currentData = this.newDataSignal[0]();
      const previousPoints = currentData.get(sourceId);
      const previousPoint = previousPoints?.[0] && typeof previousPoints[0] === 'object' ? previousPoints[0] as Record<string, unknown> : null;
      const metaKeys = new Set(['timestamp', 'source_name', 'source_id', 'Datetime', 'datetime']);

      // Create a merged data point: new values override, missing channels keep previous value
      const mergedPoint: any = {
        timestamp: dataPoint.timestamp,
        source_name: sourceName,
        source_id: sourceId
      };

      // Copy from incoming data where value is present
      for (const [channel, value] of Object.entries(dataPoint.data || {})) {
        if (!metaKeys.has(channel) && value !== undefined && value !== null) {
          mergedPoint[channel] = value;
        }
      }
      // Carry forward from previous point for channels not in this update (smooth display, no empty flash)
      if (previousPoint) {
        for (const [channel, value] of Object.entries(previousPoint)) {
          if (!metaKeys.has(channel) && mergedPoint[channel] === undefined && value !== undefined && value !== null) {
            mergedPoint[channel] = value;
          }
        }
      }

      // Ensure Datetime exists for bad air overlay (use from data if available, otherwise from timestamp)
      // Bad air checks: d.Datetime ?? d.datetime
      // The server sends Datetime as an ISO string (getter property), so we need to handle it
      if (!mergedPoint.Datetime && !mergedPoint.datetime) {
        // Create Datetime from timestamp if not provided in data
        mergedPoint.Datetime = new Date(dataPoint.timestamp);
      } else if (mergedPoint.datetime && !mergedPoint.Datetime) {
        // If only lowercase datetime exists, also set uppercase Datetime
        mergedPoint.Datetime = mergedPoint.datetime instanceof Date 
          ? mergedPoint.datetime 
          : new Date(mergedPoint.datetime);
      } else if (mergedPoint.Datetime) {
        // Datetime exists - ensure it's a Date object (server sends as ISO string)
        if (typeof mergedPoint.Datetime === 'string') {
          mergedPoint.Datetime = new Date(mergedPoint.Datetime);
        } else if (!(mergedPoint.Datetime instanceof Date)) {
          // Convert to Date if it's not already
          mergedPoint.Datetime = new Date(mergedPoint.Datetime);
        }
        // Also set lowercase datetime for compatibility (bad air checks both)
        if (!mergedPoint.datetime) {
          mergedPoint.datetime = mergedPoint.Datetime;
        }
      }

      // Normalize coordinates: ensure both Lat/Lng and Lat_dd/Lng_dd are available
      // This ensures components can use either naming convention
      if (mergedPoint.Lat_dd !== undefined && mergedPoint.Lat === undefined) {
        mergedPoint.Lat = mergedPoint.Lat_dd;
      }
      if (mergedPoint.Lng_dd !== undefined && mergedPoint.Lng === undefined) {
        mergedPoint.Lng = mergedPoint.Lng_dd;
      }
      // Also ensure lowercase variants for compatibility
      if (mergedPoint.lat_dd !== undefined && mergedPoint.lat === undefined) {
        mergedPoint.lat = mergedPoint.lat_dd;
      }
      if (mergedPoint.lng_dd !== undefined && mergedPoint.lng === undefined) {
        mergedPoint.lng = mergedPoint.lng_dd;
      }

      // Emit update signal immediately - ALWAYS create new Map to trigger SolidJS reactivity
      // Since server sends 1 point per source per second, we only keep the latest point
      // This ensures boats update at least once per second
      // Use source_id from data point if available, otherwise skip (can't store without source_id)
      if (sourceId !== null && sourceId !== undefined) {
        const currentData = this.newDataSignal[0]();
        
        // ALWAYS create a new Map (not just modify existing) to ensure SolidJS detects the change
        const updatedData = new Map(currentData);
        
        // Store only the latest point per source (server sends 1 per second)
        updatedData.set(sourceId, [mergedPoint]);
        
        // Only log every 20th data point to reduce console spam
        this.dataPointCount++;
        if (this.dataPointCount % 20 === 0) {
          debug('[StreamingStore] Storing WebSocket data point', {
            sourceId,
            source_name: sourceName,
            timestamp: mergedPoint.timestamp,
            hasLat: !!(mergedPoint.Lat_dd || mergedPoint.lat_dd),
            hasLng: !!(mergedPoint.Lng_dd || mergedPoint.lng_dd),
            channels: Object.keys(mergedPoint).filter(k => !['timestamp', 'source_name', 'source_id', 'Datetime', 'datetime'].includes(k)),
            totalPointsStored: this.dataPointCount
          });
        }
        
        // Update signal with new Map reference - this triggers all watching effects
        this.newDataSignal[1](updatedData);
        
        // Also accumulate in historical data storage
        if (!this.historicalData.has(sourceId)) {
          this.historicalData.set(sourceId, []);
        }
        const historicalPoints = this.historicalData.get(sourceId)!;
        
        // Append new point (avoid duplicates by checking timestamp)
        const getTimestamp = (d: any): number => {
          if (!d) return 0;
          const ts = d.timestamp || (d.Datetime instanceof Date ? d.Datetime.getTime() : new Date(d.Datetime).getTime());
          return Number.isFinite(ts) ? ts : 0;
        };
        
        const newTimestamp = getTimestamp(mergedPoint);
        const isDuplicate = historicalPoints.some(p => getTimestamp(p) === newTimestamp);
        
        if (!isDuplicate) {
          historicalPoints.push(mergedPoint);
          // Sort by timestamp to maintain chronological order
          historicalPoints.sort((a, b) => getTimestamp(a) - getTimestamp(b));
          // Bump so chart/map memos re-run even after getNewData() is cleared by LiveMultiBoatLayer
          this.liveDataAppendVersionSignal[1](v => v + 1);
        } else {
          debug('[StreamingStore] Skipped duplicate data point', {
            sourceId,
            timestamp: newTimestamp
          });
        }
      }
    } catch (err) {
      logError('[StreamingStore] Error handling WebSocket data:', err);
    }
  }

  /**
   * Get reactive signal for new data updates (immediate, no batching)
   * Components can watch this to receive updates as soon as websocket data arrives
   */
  getNewData() {
    return this.newDataSignal[0];
  }

  /**
   * Reactive signal for when historical data is loaded from Redis.
   * Components (e.g. LiveMapTimeSeries) can watch this to re-render when Redis data arrives.
   */
  getHistoricalDataVersion() {
    return this.historicalDataVersionSignal[0];
  }

  /**
   * Reactive signal bumped on every WebSocket append to historicalData.
   * Use this so chart/map re-run when new points arrive even after getNewData() is cleared.
   */
  getLiveDataAppendVersion() {
    return this.liveDataAppendVersionSignal[0];
  }

  /**
   * Clear processed data from the signal for specified sources
   * Optionally clear only points up to a certain timestamp to preserve newer data
   */
  clearProcessedData(sourceIds: Set<number>, upToTimestamp?: Map<number, number>): void {
    const currentData = this.newDataSignal[0]();
    const updatedData = new Map(currentData);
    
    let hasChanges = false;
    for (const sourceId of sourceIds) {
      const points = updatedData.get(sourceId);
      if (!points || points.length === 0) {
        continue;
      }

      if (upToTimestamp && upToTimestamp.has(sourceId)) {
        // Clear only points up to the specified timestamp, keep newer ones
        const maxTimestamp = upToTimestamp.get(sourceId)!;
        const getTimestamp = (d: any): number => {
          if (!d) return 0;
          const ts = d.timestamp || (d.Datetime instanceof Date ? d.Datetime.getTime() : new Date(d.Datetime).getTime());
          return Number.isFinite(ts) ? ts : 0;
        };
        
        const remainingPoints = points.filter(p => getTimestamp(p) > maxTimestamp);
        
        if (remainingPoints.length === 0) {
          // All points were processed, remove the entry
          updatedData.delete(sourceId);
        } else {
          // Keep newer points
          updatedData.set(sourceId, remainingPoints);
        }
        hasChanges = true;
      } else {
        // No timestamp specified, clear all data for this source
        updatedData.delete(sourceId);
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      this.newDataSignal[1](updatedData);
      debug('[StreamingStore] Cleared processed data for sources', {
        sourceIds: Array.from(sourceIds),
        remainingSources: Array.from(updatedData.keys()),
        usedTimestampFilter: !!upToTimestamp
      });
    }
  }

  /**
   * Update selected sources (subscribe/unsubscribe from WebSocket)
   */
  async updateSelectedSources(selectedSourceIds: Set<number>, previousSourceIds: Set<number>): Promise<void> {
    if (!this._isInitialized) {
      debug('[StreamingStore] Not initialized, cannot update sources');
      return;
    }

    // Unsubscribe from removed sources
    for (const source_id of previousSourceIds) {
      if (!selectedSourceIds.has(source_id)) {
        const source_name = sourcesStore.getSourceName(source_id);
        if (source_name) {
          streamingService.unsubscribe(source_name);
          debug(`[StreamingStore] Unsubscribed from source "${source_name}" (source_id: ${source_id})`);
        } else {
          warn(`[StreamingStore] Could not get source_name for source_id ${source_id} to unsubscribe`);
        }
      }
    }

    // Subscribe to new sources (no channel filter = get all processor-mapped data)
    for (const source_id of selectedSourceIds) {
      if (!previousSourceIds.has(source_id)) {
        const source_name = sourcesStore.getSourceName(source_id);
        if (source_name) {
          streamingService.subscribe(source_name);
          debug(`[StreamingStore] Subscribed to source "${source_name}" (source_id: ${source_id})`);
        } else {
          warn(`[StreamingStore] Could not get source_name for source_id ${source_id} to subscribe`);
        }
      }
    }
  }

  /**
   * Get reactive loading signal
   */
  loading() {
    return this.loadingSignal[0];
  }

  /**
   * Get reactive error signal
   */
  error() {
    return this.errorSignal[0];
  }

  /**
   * Load initial historical data from Redis for specified sources
   * @param sourceIds Set of source IDs to load data for
   * @param minutes Number of minutes of historical data to load
   * @param endTime Optional end time in milliseconds (defaults to Date.now())
   */
  async loadInitialDataFromRedis(sourceIds: Set<number>, minutes: number, endTime?: number): Promise<void> {
    if (sourceIds.size === 0) {
      debug('[StreamingStore] ⚠️ No sources to load, skipping loadInitialDataFromRedis');
      return;
    }

    try {
      // Use provided endTime or fallback to current time
      const effectiveEndTime = endTime ?? Date.now();
      
      debug('[StreamingStore] 🔄 Loading initial data from Redis', {
        sourceCount: sourceIds.size,
        minutes,
        endTime: effectiveEndTime,
        endTimeProvided: endTime !== undefined,
        sourceIds: Array.from(sourceIds),
        sourceNames: Array.from(sourceIds).map(id => sourcesStore.getSourceName(id))
      });

      // For live map, load ALL available history from Redis (up to 24 hours)
      // This ensures the timeseries shows complete history, then fills gaps to latest
      // Use a large window (24 hours) to get complete history, or use minutes if specified
      const windowMinutes = minutes > 0 ? minutes : 24 * 60; // Default to 24 hours if minutes is 0
      const startTime = effectiveEndTime - (windowMinutes * 60 * 1000);

      // Processor now outputs default channel names directly (Lat_dd, Bsp_kph, etc.)
      // Use LIVE_STREAM_CHANNELS + Bsp_kts/Tws_kts for unit compatibility + Datetime for merge
      const channels = [
        ...LIVE_STREAM_CHANNELS,
        'Bsp_kts', 'Tws_kts',        // Boat/wind speed in kts for compatibility
        'Datetime'                    // Timestamp
      ];
      
      debug('[StreamingStore] Requesting default channel names from Redis', {
        channels,
        note: 'Processor now stores default channel names with units in Redis'
      });

      // Fetch data for all sources in parallel
      const sourceNames = Array.from(sourceIds).map(id => {
        const name = sourcesStore.getSourceName(id);
        if (!name) {
          warn(`[StreamingStore] Could not get source_name for source_id ${id}`);
        }
        return { sourceId: id, sourceName: name };
      }).filter(s => s.sourceName);

      const fetchPromises = sourceNames.map(async ({ sourceId, sourceName }) => {
        try {
          const mergedData = await streamingDataService.fetchMergedData(
            sourceName!,
            channels,
            startTime,
            effectiveEndTime
          );

          // Store in historical data
          if (mergedData.length > 0) {
            // Normalize coordinates: ensure both Lat/Lng and Lat_dd/Lng_dd are available
            // This ensures components can use either naming convention
            const normalizedData = mergedData.map(point => {
              const normalized = { ...point };
              
              // If we have Lat_dd/Lng_dd but not Lat/Lng, add normalized names
              if (normalized.Lat_dd !== undefined && normalized.Lat === undefined) {
                normalized.Lat = normalized.Lat_dd;
              }
              if (normalized.Lng_dd !== undefined && normalized.Lng === undefined) {
                normalized.Lng = normalized.Lng_dd;
              }
              
              // Also ensure lowercase variants for compatibility
              if (normalized.lat_dd !== undefined && normalized.lat === undefined) {
                normalized.lat = normalized.lat_dd;
              }
              if (normalized.lng_dd !== undefined && normalized.lng === undefined) {
                normalized.lng = normalized.lng_dd;
              }
              
              return normalized;
            });
            
            this.historicalData.set(sourceId, normalizedData);
            // Debug: Check if first point has coordinates (using default channel names)
            const firstPoint = normalizedData[0];
            const hasLat = !!(firstPoint.Lat ?? firstPoint.Lat_dd ?? firstPoint.lat ?? firstPoint.lat_dd);
            const hasLng = !!(firstPoint.Lng ?? firstPoint.Lng_dd ?? firstPoint.lng ?? firstPoint.lng_dd);
            debug(`[StreamingStore] ✅ Loaded ${normalizedData.length} points for source ${sourceId} (${sourceName})`, {
              firstPointKeys: Object.keys(firstPoint).slice(0, 15),
              hasLat,
              hasLng,
              latValue: firstPoint.Lat ?? firstPoint.Lat_dd ?? firstPoint.lat ?? firstPoint.lat_dd,
              lngValue: firstPoint.Lng ?? firstPoint.Lng_dd ?? firstPoint.lng ?? firstPoint.lng_dd,
              allChannels: Object.keys(firstPoint)
            });
          } else {
            // Do NOT overwrite with [] - WebSocket may have already pushed data; leave existing data intact
            if (!this.historicalData.has(sourceId)) {
              this.historicalData.set(sourceId, []);
            }
            debug(`[StreamingStore] ⚠️ No data found for source ${sourceId} (${sourceName})`, {
              requestedChannels: channels,
              note: 'Check if channels exist in Redis with default channel names'
            });
          }
        } catch (err) {
          // Network errors for Redis are expected - log as warning, not error
          warn(`[StreamingStore] Network error loading data for source ${sourceId} (expected when Redis unavailable)`);
          // Do NOT overwrite existing data (e.g. from WebSocket) - only set empty if source had no key
          if (!this.historicalData.has(sourceId)) {
            this.historicalData.set(sourceId, []);
          }
        }
      });

      await Promise.all(fetchPromises);

      const totalPoints = Array.from(this.historicalData.values()).reduce((sum, arr) => sum + arr.length, 0);
      debug('[StreamingStore] ✅ Initial data loaded from Redis', {
        sourceCount: sourceIds.size,
        totalPoints,
        pointsPerSource: Array.from(this.historicalData.entries()).map(([id, data]) => ({
          sourceId: id,
          sourceName: sourcesStore.getSourceName(id),
          pointCount: data.length
        }))
      });

      // Bump signal so timeline (groupedData) re-renders with loaded data
      if (totalPoints > 0) {
        this.historicalDataVersionSignal[1](v => v + 1);
      }
    } catch (err) {
      // Network errors for Redis are expected - log as warning, not error
      warn('[StreamingStore] Network error loading initial data from Redis (expected when Redis unavailable)');
    }
  }

  /**
   * Pull a time window from Redis around the current playback position and merge into historical data.
   * Fills gaps when WebSocket pushes are missed so playback stays smooth.
   * @param sourceIds Selected source IDs to fetch
   * @param centerTimeMs Playback position (e.g. selectedTime) in ms
   * @param beforeMs Window before center (default 10000 = 10s)
   * @param afterMs Window after center (default 2000 = 2s)
   */
  async pullPlaybackWindowFromRedis(
    sourceIds: Set<number>,
    centerTimeMs: number,
    beforeMs: number = 10000,
    afterMs: number = 2000
  ): Promise<void> {
    if (sourceIds.size === 0) return;

    const startTime = centerTimeMs - beforeMs;
    const endTime = centerTimeMs + afterMs;
    const channels = [
      ...LIVE_STREAM_CHANNELS,
      'Bsp_kts', 'Tws_kts',
      'Datetime'
    ];

    const getTimestamp = (d: any): number => {
      if (!d) return 0;
      const ts = d.timestamp || (d.Datetime instanceof Date ? d.Datetime.getTime() : new Date(d.Datetime).getTime());
      return Number.isFinite(ts) ? ts : 0;
    };

    try {
      const sourceNames = Array.from(sourceIds)
        .map(id => ({ sourceId: id, sourceName: sourcesStore.getSourceName(id) }))
        .filter((s): s is { sourceId: number; sourceName: string } => !!s.sourceName);

      let addedCount = 0;
      for (const { sourceId, sourceName } of sourceNames) {
        try {
          const mergedData = await streamingDataService.fetchMergedData(
            sourceName,
            channels,
            startTime,
            endTime
          );
          if (mergedData.length === 0) continue;

          const normalizedData = mergedData.map(point => {
            const normalized = { ...point };
            if (normalized.Lat_dd !== undefined && normalized.Lat === undefined) normalized.Lat = normalized.Lat_dd;
            if (normalized.Lng_dd !== undefined && normalized.Lng === undefined) normalized.Lng = normalized.Lng_dd;
            if (normalized.lat_dd !== undefined && normalized.lat === undefined) normalized.lat = normalized.lat_dd;
            if (normalized.lng_dd !== undefined && normalized.lng === undefined) normalized.lng = normalized.lng_dd;
            return normalized;
          });

          const existing = this.historicalData.get(sourceId) || [];
          const existingTs = new Set(existing.map(getTimestamp));
          const newPoints = normalizedData.filter(p => !existingTs.has(getTimestamp(p)));
          if (newPoints.length === 0) continue;

          const combined = [...existing];
          for (const p of newPoints) {
            combined.push(p);
            existingTs.add(getTimestamp(p));
            addedCount++;
          }
          combined.sort((a, b) => getTimestamp(a) - getTimestamp(b));
          this.historicalData.set(sourceId, combined);
        } catch (err) {
          warn(`[StreamingStore] Pull playback window failed for source ${sourceId}`, err);
        }
      }

      // Merge newest Redis point into "latest" per source so live table sees all Redis channels (WebSocket may only send 3)
      const metaKeys = new Set(['timestamp', 'Datetime', 'datetime', 'source_name', 'source_id']);
      const currentData = this.newDataSignal[0]();
      let latestMerged = false;
      const updatedData = new Map(currentData);
      for (const { sourceId } of sourceNames) {
        const hist = this.historicalData.get(sourceId);
        if (!hist || hist.length === 0) continue;
        const newestFromRedis = hist[hist.length - 1];
        if (!newestFromRedis || typeof newestFromRedis !== 'object') continue;
        const currentLatest = currentData.get(sourceId);
        const currentPoint = currentLatest?.[0];
        const merged: Record<string, unknown> = currentPoint && typeof currentPoint === 'object'
          ? { ...currentPoint }
          : {
              timestamp: getTimestamp(newestFromRedis),
              source_name: newestFromRedis.source_name,
              source_id: sourceId
            };
        for (const [key, val] of Object.entries(newestFromRedis)) {
          if (metaKeys.has(key)) continue;
          if ((merged[key] === undefined || merged[key] === null) && val !== undefined && val !== null) {
            merged[key] = val;
            latestMerged = true;
          }
        }
        updatedData.set(sourceId, [merged]);
      }
      if (latestMerged) {
        this.newDataSignal[1](updatedData);
      }

      if (addedCount > 0) {
        this.historicalDataVersionSignal[1](v => v + 1);
        debug('[StreamingStore] Pulled playback window from Redis', { sourceCount: sourceNames.length, addedPoints: addedCount });
      }
    } catch (err) {
      warn('[StreamingStore] Error pulling playback window from Redis', err);
    }
  }

  /**
   * Get raw unfiltered data for chart display (bypasses all filtering)
   * @param sourceIds Set of source IDs to get data for
   * @returns Map of sourceId -> raw data array
   */
  getRawData(sourceIds: Set<number>): Map<number, any[]> {
    const result = new Map<number, any[]>();
    
    if (sourceIds.size === 0) {
      return result;
    }
    
    for (const sourceId of sourceIds) {
      const sourceData = this.historicalData.get(sourceId) || [];
      if (sourceData.length > 0) {
        // Create a new array reference to ensure reactivity
        result.set(sourceId, sourceData.map(p => ({ ...p })));
      }
    }
    
    return result;
  }

  /**
   * Get filtered data based on selected sources, time window, and brush selection
   * @param sourceIds Set of source IDs to filter by
   * @param options Optional filtering options (selectedRange, selectedRanges)
   * @returns Map of sourceId -> filtered data array
   */
  getFilteredData(
    sourceIds: Set<number>,
    options?: { selectedRange?: any[]; selectedRanges?: any[]; effectivePlaybackTime?: Date | null }
  ): Map<number, any[]> {
    const result = new Map<number, any[]>();

    if (sourceIds.size === 0) {
      return result;
    }

    // Use same reference time as chart (getDisplayWindowReferenceTime) when no override, so chart and map stay in sync
    const currentTime = options?.effectivePlaybackTime ?? getDisplayWindowReferenceTime() ?? selectedTime();
    const currentTimeWindow = Number(timeWindow()); // Minutes; coerce so string from sync doesn't truncate window

    // Check for brush selection
    const ranges = options?.selectedRanges || selectedRanges();
    const singleRange = options?.selectedRange || selectedRange();
    const hasBrushSelection = (Array.isArray(ranges) && ranges.length > 0) ||
                              (Array.isArray(singleRange) && singleRange.length > 0);

    // Helper to get timestamp from data point
    const getTimestamp = (d: any): number => {
      if (!d) return 0;
      const ts = d.timestamp || (d.Datetime instanceof Date ? d.Datetime.getTime() : new Date(d.Datetime).getTime());
      return Number.isFinite(ts) ? ts : 0;
    };

    for (const sourceId of sourceIds) {
      const sourceData = this.historicalData.get(sourceId) || [];
      if (sourceData.length === 0) {
        continue;
      }

      // Always create a new array reference to ensure reactivity
      // This ensures components detect changes even if the underlying data array reference is the same
      let filtered = sourceData.map(p => ({ ...p })); // Deep copy to ensure new references

      // Apply brush selection filtering first (if active)
      if (hasBrushSelection) {
        const activeRanges: Array<{ start_time: Date | string; end_time: Date | string }> = [];
        
        if (Array.isArray(ranges) && ranges.length > 0) {
          activeRanges.push(...ranges);
        }
        
        if (activeRanges.length === 0 && Array.isArray(singleRange) && singleRange.length > 0) {
          activeRanges.push(...singleRange);
        }

        if (activeRanges.length > 0) {
          filtered = filtered.filter(d => {
            const timestampMs = getTimestamp(d);
            return activeRanges.some(range => {
              const startTime = range.start_time instanceof Date
                ? range.start_time.getTime()
                : new Date(range.start_time).getTime();
              const endTime = range.end_time instanceof Date
                ? range.end_time.getTime()
                : new Date(range.end_time).getTime();
              return timestampMs >= startTime && timestampMs <= endTime;
            });
          });
        }
      }

      // Apply time window filtering (only if no brush selection)
      if (!hasBrushSelection && currentTimeWindow > 0 && currentTime) {
        const windowMs = currentTimeWindow * 60 * 1000;
        const windowStart = new Date(currentTime.getTime() - windowMs);
        const windowEnd = currentTime;

        filtered = filtered.filter(d => {
          const timestamp = getTimestamp(d);
          // getTimestamp returns a number (milliseconds), so convert to Date
          const timestampDate = new Date(timestamp);
          return timestampDate >= windowStart && timestampDate <= windowEnd;
        });
      }

      if (filtered.length > 0) {
        result.set(sourceId, filtered);
      }
    }

    return result;
  }

  /**
   * Get the latest timestamp across all sources
   * @param sourceIds Set of source IDs to check
   * @returns Latest timestamp in milliseconds, or null if no data
   */
  getLatestTimestamp(sourceIds: Set<number>): number | null {
    let latestTimestamp: number | null = null;
    
    for (const sourceId of sourceIds) {
      const sourceData = this.historicalData.get(sourceId) || [];
      if (sourceData.length === 0) continue;
      
      // Get the last point (data should be sorted by timestamp)
      const lastPoint = sourceData[sourceData.length - 1];
      if (!lastPoint) continue;
      
      const getTimestamp = (d: any): number => {
        if (!d) return 0;
        const ts = d.timestamp || (d.Datetime instanceof Date ? d.Datetime.getTime() : new Date(d.Datetime).getTime());
        return Number.isFinite(ts) ? ts : 0;
      };
      
      const ts = getTimestamp(lastPoint);
      if (ts > 0 && (!latestTimestamp || ts > latestTimestamp)) {
        latestTimestamp = ts;
      }
    }
    
    return latestTimestamp;
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // Unsubscribe all callbacks
    for (const unsubscribe of this.unsubscribeCallbacks) {
      try {
        unsubscribe();
      } catch (err) {
        warn('[StreamingStore] Error unsubscribing callback:', err);
      }
    }
    this.unsubscribeCallbacks = [];

    // Disconnect WebSocket
    streamingService.disconnect();

    this._isInitialized = false;
    this._isInitializing = false;
    this.currentSourceIds = new Set();
    this.loadingSignal[1](false);
    this.errorSignal[1](null);
    this.newDataSignal[1](new Map()); // Clear data signal
    this.historicalData.clear(); // Clear historical data
    this.liveDataAppendVersionSignal[1](0);
  }
}

// Singleton instance
export const streamingStore = new StreamingStore();
