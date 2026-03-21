import { apiEndpoints, config } from '@config/env';
import { debug, warn, error as logError } from '../utils/console';
import { authManager } from '../utils/authManager';
import { sourcesStore } from '../store/sourcesStore';

export interface StreamingDataPoint {
  source_id: number;
  source_name?: string;
  timestamp: number;
  data: Record<string, any>;
}

export interface StreamingMessage {
  type: 'connected' | 'subscribed' | 'unsubscribed' | 'data' | 'data_batch' | 'error' | 'pong';
  clientId?: number;
  source_id?: number;
  source_name?: string; // Server sends source_name, frontend maps to source_id
  timestamp?: number;
  data?: Record<string, any>;
  sources?: Array<{ // For batched updates
    source_name: string;
    source_id?: number;
    timestamp: number;
    data: Record<string, any>;
  }>;
  message?: string;
}

type DataCallback = (data: StreamingDataPoint) => void;
type ConnectionCallback = (connected: boolean) => void;

/**
 * WebSocket Client Service for Streaming Data
 * Manages connection to /api/stream/ws, subscriptions, and reconnection
 */
class StreamingService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseReconnectDelay = 1000; // 1 second
  private maxReconnectDelay = 60000; // 60 seconds
  private reconnectTimer: number | null = null;
  private shouldReconnect = true;
  private subscriptions = new Set<string>(); // source_names we're subscribed to
  private subscriptionChannels = new Map<string, string[]>(); // source_name -> channels (for re-subscription on reconnect)
  private dataCallbacks = new Set<DataCallback>();
  private connectionCallbacks = new Set<ConnectionCallback>();
  private pingInterval: number | null = null;
  private isConnecting = false;

  private lastConnectionError: string | null = null;

  /**
   * Get the last connection error message
   */
  getLastError(): string | null {
    return this.lastConnectionError;
  }

  /**
   * Connect to streaming WebSocket server
   */
  async connect(): Promise<boolean> {
    // Check if WebSockets are enabled
    debug('[StreamingService] connect() called', {
      ENABLE_WEBSOCKETS: config.ENABLE_WEBSOCKETS,
      currentState: this.ws ? this.ws.readyState : 'no websocket'
    });
    
    if (!config.ENABLE_WEBSOCKETS) {
      const errorMsg = 'WebSockets are disabled (VITE_ENABLE_WEBSOCKETS=false)';
      this.lastConnectionError = errorMsg;
      warn('[StreamingService] ❌', errorMsg);
      debug('[StreamingService]', errorMsg);
      return false;
    }
    
    debug('[StreamingService] connect() called');
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      debug('[StreamingService] Already connected');
      this.lastConnectionError = null;
      return true;
    }

    // If connection is in progress, wait for it to complete
    if (this.isConnecting) {
      debug('[StreamingService] Connection already in progress, waiting...');
      // Wait for connection to complete (poll every 100ms, max 10 seconds)
      const maxWait = 10000; // 10 seconds
      const pollInterval = 100; // 100ms
      const startTime = Date.now();
      
      while (this.isConnecting && (Date.now() - startTime) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        // Check if connection completed successfully
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          debug('[StreamingService] Connection completed while waiting');
          this.lastConnectionError = null;
          return true;
        }
      }
      
      // If still connecting after timeout, return false
      if (this.isConnecting) {
        debug('[StreamingService] Connection wait timeout');
        this.lastConnectionError = 'Connection timeout while waiting for in-progress connection';
        return false;
      }
      
      // Connection attempt completed, check result
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        debug('[StreamingService] Connection completed successfully');
        this.lastConnectionError = null;
        return true;
      } else {
        debug('[StreamingService] Connection attempt failed');
        return false;
      }
    }

    debug('[StreamingService] Starting new connection...');
    this.isConnecting = true;
    this.lastConnectionError = null;

    try {
      // Get JWT token (refresh if needed)
      debug('[StreamingService] Getting authentication token...');
      const token = await authManager.getValidToken();
      if (!token) {
        const errorMsg = 'No authentication token available';
        this.lastConnectionError = errorMsg;
        error('[StreamingService]', errorMsg);
        this.isConnecting = false;
        return false;
      }
      debug('[StreamingService] Token obtained (length:', token.length, ')');

      // Build WebSocket URL (use relative path, nginx handles routing)
      const wsUrl = `${apiEndpoints.stream.websocket}?token=${encodeURIComponent(token)}`;
      
      // Determine protocol based on current page protocol
      // For HTTPS pages, use wss:// (secure WebSocket)
      // For HTTP pages, use ws://
      const currentProtocol = window.location.protocol.toLowerCase();
      const currentPort = window.location.port;
      const currentHostname = window.location.hostname;
      
      // Check if we're on HTTPS - check protocol first, then port
      // Also check if we're behind a proxy that might report HTTP but we're actually HTTPS
      const isSecure = currentProtocol === 'https:' || 
                       currentPort === '443' ||
                       // If port is empty and not localhost, assume HTTPS (common with nginx)
                       (!currentPort && currentHostname !== 'localhost' && currentHostname !== '127.0.0.1' && !currentHostname.startsWith('192.168.'));
      
      // Always use wss:// if page is HTTPS, otherwise ws://
      const protocol = isSecure ? 'wss:' : 'ws:';
      
      // Use current hostname/port from the page (nginx will handle routing)
      // This ensures we use the same host/port as the page, which is important for HTTPS
      const host = window.location.host;
      let fullUrl = `${protocol}//${host}${wsUrl}`;

      // Safety check: if page is HTTPS but we somehow got ws://, force wss://
      if (isSecure && fullUrl.startsWith('ws://')) {
        warn('[StreamingService] WARNING: Detected secure connection but using ws:// protocol - forcing wss://');
        fullUrl = fullUrl.replace(/^ws:\/\//, 'wss://');
      }

      debug('[StreamingService] Connecting to', fullUrl.replace(/token=[^&]+/, 'token=***'));
      debug('[StreamingService] Protocol detection:', {
        currentProtocol,
        currentPort,
        currentHostname,
        isSecure,
        protocol,
        host,
        path: wsUrl,
        finalUrl: fullUrl.replace(/token=[^&]+/, 'token=***')
      });
      
      // Log warning if we detect potential HTTPS but protocol is http:
      if (currentProtocol === 'http:' && (currentPort === '443' || (!currentPort && currentHostname !== 'localhost' && currentHostname !== '127.0.0.1'))) {
        warn('[StreamingService] Page protocol is http: but port/hostname suggests HTTPS - using wss:// for WebSocket');
      }

      // Wait for connection to actually open or fail
      return new Promise<boolean>((resolve) => {
        let resolved = false;
        
        const connectionTimeout = window.setTimeout(() => {
          if (resolved) return;
          resolved = true;
          const errorMsg = 'WebSocket connection timeout';
          this.lastConnectionError = errorMsg;
          error('[StreamingService]', errorMsg);
          if (this.ws) {
            this.ws.close();
            this.ws = null;
          }
          this.isConnecting = false;
          this.notifyConnectionCallbacks(false);
          resolve(false);
        }, 10000); // 10 second timeout

        try {
          this.ws = new WebSocket(fullUrl);
          debug('[StreamingService] WebSocket instance created, readyState:', this.ws.readyState);
        } catch (err) {
          if (resolved) return;
          resolved = true;
          clearTimeout(connectionTimeout);
          const errorMsg = `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`;
          this.lastConnectionError = errorMsg;
          error('[StreamingService]', errorMsg);
          this.isConnecting = false;
          this.notifyConnectionCallbacks(false);
          resolve(false);
          return;
        }

        this.ws.onopen = () => {
          debug('[StreamingService] WebSocket onopen', {
            readyState: this.ws?.readyState,
            url: fullUrl.replace(/token=[^&]+/, 'token=***')
          });
          
          if (resolved) {
            debug('[StreamingService] onopen called but promise already resolved');
            return;
          }
          resolved = true;
          clearTimeout(connectionTimeout);
          debug('[StreamingService] WebSocket connected, readyState:', this.ws?.readyState);
          debug('[StreamingService] ✅ WebSocket connected successfully');
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.lastConnectionError = null;
          this.notifyConnectionCallbacks(true);
          this.startPingInterval();
          resolve(true);
        };

        this.ws.onmessage = (event) => {
          debug('[StreamingService] WebSocket message received', {
            dataLength: event.data?.length || 0,
            dataPreview: typeof event.data === 'string' ? event.data.substring(0, 200) : 'binary'
          });
          this.handleMessage(event);
        };

        this.ws.onerror = (err) => {
          logError('[StreamingService] WebSocket onerror fired', { 
            resolved, 
            readyState: this.ws?.readyState,
            readyStateText: this.ws?.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                           this.ws?.readyState === WebSocket.OPEN ? 'OPEN' :
                           this.ws?.readyState === WebSocket.CLOSING ? 'CLOSING' :
                           this.ws?.readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN',
            error: err,
            errorType: err.type,
            url: fullUrl.replace(/token=[^&]+/, 'token=***')
          });
          debug('[StreamingService] WebSocket onerror fired', { 
            resolved, 
            readyState: this.ws?.readyState,
            error: err 
          });
          if (resolved) return;
          resolved = true;
          clearTimeout(connectionTimeout);
          const errorMsg = `WebSocket connection error: ${err.type || 'Unknown error'}`;
          this.lastConnectionError = errorMsg;
          logError('[StreamingService] WebSocket error:', err);
          logError('[StreamingService] WebSocket state:', this.ws?.readyState);
          logError('[StreamingService] WebSocket URL:', fullUrl.replace(/token=[^&]+/, 'token=***'));
          this.isConnecting = false;
          this.notifyConnectionCallbacks(false);
          resolve(false);
        };

        this.ws.onclose = (event) => {
          const isNormalClose = event.code === 1000 && event.wasClean;
          if (!isNormalClose) {
            logError('[StreamingService] WebSocket closed unexpectedly', {
              code: event.code,
              reason: event.reason,
              wasClean: event.wasClean,
              url: fullUrl.replace(/token=[^&]+/, 'token=***')
            });
          } else {
            debug('[StreamingService] WebSocket closed (normal)', { code: event.code, reason: event.reason });
          }
          debug('[StreamingService] WebSocket onclose fired', { 
            resolved, 
            code: event.code, 
            reason: event.reason, 
            wasClean: event.wasClean,
            readyState: this.ws?.readyState
          });
          clearTimeout(connectionTimeout);
          this.isConnecting = false;
          this.ws = null;
          this.stopPingInterval();
          this.notifyConnectionCallbacks(false);

          // Only resolve if we haven't already (connection failed before opening)
          if (!resolved) {
            resolved = true;
            const errorMsg = event.reason || `WebSocket closed with code ${event.code}${event.wasClean ? ' (clean)' : ' (unclean)'}`;
            this.lastConnectionError = errorMsg;
            logError('[StreamingService] Connection closed before opening:', errorMsg);
            logError('[StreamingService] WebSocket URL was:', fullUrl.replace(/token=[^&]+/, 'token=***'));
            resolve(false);
          }

          // Reconnect if not a normal close and we should reconnect
          if (event.code !== 1000 && this.shouldReconnect) {
            debug('[StreamingService] Scheduling reconnect', {
              code: event.code,
              reason: event.reason,
              shouldReconnect: this.shouldReconnect
            });
            this.scheduleReconnect();
          }
        };
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.lastConnectionError = errorMsg;
      logError('[StreamingService] Failed to connect:', err);
      this.isConnecting = false;
      this.notifyConnectionCallbacks(false);
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
      return false;
    }
  }

  /**
   * Disconnect from WebSocket
   * Only disconnects if there are no active callbacks (other components might still be using it)
   */
  disconnect() {
    debug('[StreamingService] disconnect() called', {
      hasWebSocket: !!this.ws,
      readyState: this.ws?.readyState,
      subscriptionCount: this.subscriptions.size,
      callbackCount: this.dataCallbacks.size,
      connectionCallbackCount: this.connectionCallbacks.size
    });
    
    // Check if other components are still using the connection
    const hasActiveCallbacks = this.dataCallbacks.size > 0 || this.connectionCallbacks.size > 0;
    
    if (hasActiveCallbacks) {
      debug('[StreamingService] disconnect() called but other components still have callbacks; clearing subscriptions only', {
        dataCallbacks: this.dataCallbacks.size,
        connectionCallbacks: this.connectionCallbacks.size,
        subscriptions: this.subscriptions.size,
        note: 'Not disconnecting - other components are still using the connection'
      });
      // Don't disconnect if other components are using it
      // Just clear our subscriptions but keep the connection open
      this.subscriptions.clear();
      return;
    }
    
    this.shouldReconnect = false;
    this.stopPingInterval();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        debug('[StreamingService] Closing WebSocket connection', {
          readyState: this.ws.readyState,
          subscriptionCount: this.subscriptions.size,
          callbackCount: this.dataCallbacks.size
        });
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }

    this.subscriptions.clear();
    this.notifyConnectionCallbacks(false);
    debug('[StreamingService] Disconnect complete');
  }

  /**
   * Subscribe to a source
   * @param source_name - Source name to subscribe to (e.g., "GBR", "ITA", "NZL")
   * @param channels - Optional array of channels to subscribe to (for future backend support)
   */
  subscribe(source_name: string, channels?: string[]): boolean {
    debug('[StreamingService] subscribe() called', {
      source_name,
      channels,
      hasWebSocket: !!this.ws,
      readyState: this.ws?.readyState
    });
    
    if (!this.ws) {
      logError('[StreamingService] Cannot subscribe: WebSocket instance does not exist', {
        source_name,
        readyState: null
      });
      warn('[StreamingService] Cannot subscribe: WebSocket instance does not exist', {
        source_name,
        readyState: null
      });
      return false;
    }
    
    if (this.ws.readyState !== WebSocket.OPEN) {
      logError('[StreamingService] Cannot subscribe: WebSocket not connected', {
        source_name,
        readyState: this.ws.readyState,
        readyStateText: this.ws.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                       this.ws.readyState === WebSocket.CLOSING ? 'CLOSING' :
                       this.ws.readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN'
      });
      warn('[StreamingService] Cannot subscribe: WebSocket not connected', {
        source_name,
        readyState: this.ws.readyState,
        readyStateText: this.ws.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                       this.ws.readyState === WebSocket.CLOSING ? 'CLOSING' :
                       this.ws.readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN'
      });
      return false;
    }

    if (this.subscriptions.has(source_name)) {
      debug(`[StreamingService] Already subscribed to source "${source_name}"`, { channels });
      return true;
    }

    try {
      // Persist channels for re-subscription on reconnect
      if (channels && channels.length > 0) {
        this.subscriptionChannels.set(source_name, [...channels]);
      }

      // Send channels in subscription payload for backend filtering
      // Backend expects source_name, not source_id
      const subscribeMessage = {
        type: 'subscribe',
        payload: { 
          source_name,
          ...(channels && channels.length > 0 ? { channels } : {})
        }
      };
      
      debug('[StreamingService] Sending subscribe message', subscribeMessage);
      this.send(subscribeMessage);

      this.subscriptions.add(source_name);
      debug(`[StreamingService] Subscribed to source "${source_name}"`, { 
        channels,
        subscriptions: Array.from(this.subscriptions),
        readyState: this.ws?.readyState 
      });
      debug(`[StreamingService] Subscribed to source "${source_name}"`, { channels });
      debug(`[StreamingService] 📡 Subscribed to source "${source_name}"`, { 
        subscriptions: Array.from(this.subscriptions),
        readyState: this.ws?.readyState 
      });
      return true;
    } catch (err) {
      logError(`[StreamingService] Failed to subscribe to source "${source_name}":`, err);
      // Remove from subscriptions if send failed
      this.subscriptions.delete(source_name);
      return false;
    }
  }

  /**
   * Unsubscribe from a source
   */
  unsubscribe(source_name: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (!this.subscriptions.has(source_name)) {
      return true;
    }

    try {
      this.send({
        type: 'unsubscribe',
        payload: { source_name }
      });

      this.subscriptions.delete(source_name);
      this.subscriptionChannels.delete(source_name);
      debug(`[StreamingService] Unsubscribed from source "${source_name}"`);
      return true;
    } catch (err) {
      error(`[StreamingService] Failed to unsubscribe from source "${source_name}":`, err);
      return false;
    }
  }

  /**
   * Unsubscribe from all sources
   */
  unsubscribeAll(): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      this.send({
        type: 'unsubscribe',
        payload: {}
      });

      this.subscriptions.clear();
      debug('[StreamingService] Unsubscribed from all sources');
      return true;
    } catch (err) {
      error('[StreamingService] Failed to unsubscribe from all sources:', err);
      return false;
    }
  }

  /**
   * Register callback for data events
   */
  onData(callback: DataCallback): () => void {
    const callbackId = `callback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    debug('[StreamingService] onData() callback registered', {
      callbackId,
      totalCallbacks: this.dataCallbacks.size + 1
    });
    
    const wrappedCallback = (data: StreamingDataPoint) => {
      debug(`[StreamingService] Calling callback ${callbackId}`, {
        source_name: data.source_name,
        source_id: data.source_id,
        hasData: !!data.data,
        dataKeys: data.data ? Object.keys(data.data).length : 0
      });
      try {
        callback(data);
        debug(`[StreamingService] Callback ${callbackId} completed`);
      } catch (err) {
        error('[StreamingService] Callback threw error:', err);
        throw err;
      }
    };
    
    this.dataCallbacks.add(wrappedCallback);
    return () => {
      debug('[StreamingService] onData() callback unregistered', {
        callbackId,
        remainingCallbacks: this.dataCallbacks.size - 1
      });
      this.dataCallbacks.delete(wrappedCallback);
    };
  }

  /**
   * Register callback for connection state changes
   */
  onConnection(callback: ConnectionCallback): () => void {
    this.connectionCallbacks.add(callback);
    return () => {
      this.connectionCallbacks.delete(callback);
    };
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    const connected = this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    if (!connected && this.ws) {
      debug('[StreamingService] WebSocket exists but not OPEN', {
        readyState: this.ws.readyState,
        readyStateText: this.ws.readyState === WebSocket.CONNECTING ? 'CONNECTING' :
                       this.ws.readyState === WebSocket.OPEN ? 'OPEN' :
                       this.ws.readyState === WebSocket.CLOSING ? 'CLOSING' :
                       this.ws.readyState === WebSocket.CLOSED ? 'CLOSED' : 'UNKNOWN',
        isConnecting: this.isConnecting
      });
    } else if (!connected && !this.ws) {
      debug('[StreamingService] WebSocket is null', {
        isConnecting: this.isConnecting,
        subscriptions: Array.from(this.subscriptions)
      });
    }
    return connected;
  }

  /**
   * Get current subscriptions
   */
  getSubscriptions(): Set<string> {
    return new Set(this.subscriptions);
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(event: MessageEvent) {
    try {
      const message: StreamingMessage = JSON.parse(event.data);
      
      debug('[StreamingService] Handling WebSocket message', {
        type: message.type,
        hasSourceId: message.source_id !== undefined,
        hasSourceName: !!message.source_name,
        hasData: !!message.data,
        hasSources: !!message.sources
      });

      switch (message.type) {
        case 'connected':
          debug('[StreamingService] Connection confirmed', { clientId: message.clientId });
          // Re-subscribe to all previous subscriptions with stored channels
          const sourcesToResubscribe = Array.from(this.subscriptions);
          this.subscriptions.clear(); // Clear so subscribe() will actually send
          for (const source_name of sourcesToResubscribe) {
            const channels = this.subscriptionChannels.get(source_name);
            this.subscribe(source_name, channels);
          }
          break;

        case 'subscribed':
          debug('[StreamingService] Subscription confirmed', { 
            source_id: message.source_id,
            source_name: message.source_name 
          });
          break;

        case 'unsubscribed':
          debug('[StreamingService] Unsubscription confirmed', { source_id: message.source_id });
          break;

        case 'data_batch':
          // Handle batched updates - all sources together for synchronized timing
          debug('[StreamingService] Received "data_batch" message', {
            sourceCount: message.sources?.length || 0,
            sources: message.sources?.map(s => ({
              source_name: s.source_name,
              source_id: s.source_id,
              hasData: !!s.data,
              dataKeys: s.data ? Object.keys(s.data).slice(0, 5) : []
            }))
          });
          
          if (message.sources && Array.isArray(message.sources)) {
            // Process each source in the batch
            for (const sourceData of message.sources) {
              let source_id = sourceData.source_id;
              const source_name = sourceData.source_name || sourceData.data?.source_name;
              
              if (source_id === undefined && source_name) {
                source_id = sourcesStore.getSourceId(source_name) || undefined;
                
                if (source_id === undefined) {
                  warn('[StreamingService] Could not map source_name to source_id in batch', {
                    source_name,
                    availableSources: sourcesStore.sources().map(s => s.source_name)
                  });
                  continue;
                }
              }
              
              // Try to extract timestamp from sourceData or data object
              let timestamp = sourceData.timestamp;
              if (timestamp === undefined && sourceData.data) {
                // Try to get timestamp from data object
                timestamp = sourceData.data.timestamp;
                if (timestamp === undefined) {
                  // Use current time as fallback if no timestamp available
                  timestamp = Date.now();
                  debug('[StreamingService] No timestamp in batch sourceData, using current time as fallback', {
                    source_name,
                    source_id
                  });
                }
              }
              
              // Validate timestamp is a valid number
              if (timestamp !== undefined) {
                // Convert to number if it's a string
                const timestampNum = typeof timestamp === 'string' ? parseFloat(timestamp) : timestamp;
                // Check if it's a valid number and reasonable (not NaN, not too old, not too far in future)
                if (isNaN(timestampNum) || timestampNum <= 0 || timestampNum > Date.now() + 86400000) {
                  // Invalid timestamp, use current time
                  warn('[StreamingService] Invalid timestamp in batch, using current time', {
                    originalTimestamp: timestamp,
                    source_name,
                    source_id
                  });
                  timestamp = Date.now();
                } else {
                  timestamp = timestampNum;
                }
              }
              
              if (source_id !== undefined && timestamp !== undefined && sourceData.data) {
                const dataPoint: StreamingDataPoint = {
                  source_id: source_id,
                  source_name: source_name || undefined,
                  timestamp: timestamp,
                  data: sourceData.data
                };
                
                this.notifyDataCallbacks(dataPoint);
              } else {
                debug('[StreamingService] Skipping batch sourceData - missing required fields', {
                  hasSourceId: source_id !== undefined,
                  hasSourceName: !!source_name,
                  hasTimestamp: timestamp !== undefined,
                  hasData: !!sourceData.data,
                  sourceDataKeys: Object.keys(sourceData),
                  dataKeys: sourceData.data ? Object.keys(sourceData.data) : []
                });
              }
            }
          } else {
            warn('[StreamingService] Received data_batch message with invalid sources array');
          }
          break;

        case 'data':
          // Handle single-source update (legacy, for backward compatibility)
          // Map source_name to source_id if source_id is not provided
          debug('[StreamingService] Received "data" message', {
            source_id: message.source_id,
            source_name: message.source_name,
            hasData: !!message.data,
            dataKeys: message.data ? Object.keys(message.data).slice(0, 10) : []
          });
          
          let source_id = message.source_id;
          const source_name = message.source_name || message.data?.source_name || message.data?.source;
          
          if (source_id === undefined && source_name) {
            // Map source_name to source_id using sourcesStore
            source_id = sourcesStore.getSourceId(source_name) || undefined;
            
            if (source_id === undefined) {
              warn('[StreamingService] Could not map source_name to source_id', {
                source_name,
                availableSources: sourcesStore.sources().map(s => s.source_name)
              });
            } else {
              debug('[StreamingService] Mapped source_name to source_id', { source_name, source_id });
            }
          }
          
          // Try to extract timestamp from message or data object
          let timestamp = message.timestamp;
          if (timestamp === undefined && message.data) {
            // Try to get timestamp from data object
            timestamp = message.data.timestamp;
            if (timestamp === undefined) {
              // Use current time as fallback if no timestamp available
              timestamp = Date.now();
              debug('[StreamingService] No timestamp in message, using current time as fallback', {
                source_name,
                source_id
              });
            }
          }
          
          // Validate timestamp is a valid number
          if (timestamp !== undefined) {
            // Convert to number if it's a string
            const timestampNum = typeof timestamp === 'string' ? parseFloat(timestamp) : timestamp;
            // Check if it's a valid number and reasonable (not NaN, not too old, not too far in future)
            if (isNaN(timestampNum) || timestampNum <= 0 || timestampNum > Date.now() + 86400000) {
              // Invalid timestamp, use current time
              warn('[StreamingService] Invalid timestamp value, using current time', {
                originalTimestamp: timestamp,
                source_name,
                source_id
              });
              timestamp = Date.now();
            } else {
              timestamp = timestampNum;
            }
          }
          
          if (source_id !== undefined && timestamp !== undefined && message.data) {
            const dataPoint: StreamingDataPoint = {
              source_id: source_id,
              source_name: source_name || undefined,
              timestamp: timestamp,
              data: message.data
            };
            
            // Log WebSocket data reception (use validated timestamp)
            debug('[StreamingService] WebSocket data received', {
              source_id: dataPoint.source_id,
              source_name: dataPoint.source_name,
              timestamp: timestamp,
              datetime: new Date(timestamp).toISOString(),
              channels: Object.keys(message.data || {})
            });
            debug('[StreamingService] 📡 WebSocket data received:', {
              source_id: dataPoint.source_id,
              source_name: dataPoint.source_name,
              timestamp: new Date(timestamp).toISOString(),
              lat: message.data?.Lat || message.data?.lat,
              lng: message.data?.Lng || message.data?.lng,
              bsp: message.data?.Bsp || message.data?.bsp,
              hdg: message.data?.Hdg || message.data?.hdg,
              allChannels: Object.keys(message.data || {}).sort()
            });
            
            this.notifyDataCallbacks(dataPoint);
          } else {
            warn('[StreamingService] Received data message with missing fields', {
              hasSourceId: source_id !== undefined,
              hasSourceName: !!source_name,
              hasTimestamp: timestamp !== undefined,
              hasData: !!message.data,
              messageKeys: Object.keys(message),
              dataKeys: message.data ? Object.keys(message.data) : []
            });
          }
          break;

        case 'error':
          warn('[StreamingService] Server error:', message.message);
          break;

        case 'pong':
          // Ping/pong keepalive
          break;

        default:
          warn('[StreamingService] Unknown message type:', message.type);
      }
    } catch (err) {
      error('[StreamingService] Error parsing message:', err);
    }
  }

  /**
   * Send message to WebSocket
   */
  private send(message: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      error('[StreamingService] Max reconnection attempts reached');
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );

    this.reconnectAttempts++;
    debug(`[StreamingService] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval() {
    this.stopPingInterval();
    this.pingInterval = window.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.send({ type: 'ping' });
        } catch (err) {
          error('[StreamingService] Error sending ping:', err);
        }
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Notify all data callbacks
   */
  private notifyDataCallbacks(data: StreamingDataPoint) {
    debug('[StreamingService] Notifying data callbacks', {
      callbackCount: this.dataCallbacks.size,
      source_id: data.source_id,
      source_name: data.source_name,
      timestamp: new Date(data.timestamp).toISOString(),
      dataKeys: Object.keys(data.data || {}).slice(0, 10)
    });
    
    if (this.dataCallbacks.size === 0) {
      warn('[StreamingService] Received data but no callbacks registered', {
        source_name: data.source_name,
        timestamp: data.timestamp
      });
    }
    for (const callback of this.dataCallbacks) {
      try {
        callback(data);
      } catch (err) {
        error('[StreamingService] Error in data callback:', err);
      }
    }
  }

  /**
   * Notify all connection callbacks
   */
  private notifyConnectionCallbacks(connected: boolean) {
    for (const callback of this.connectionCallbacks) {
      try {
        callback(connected);
      } catch (err) {
        error('[StreamingService] Error in connection callback:', err);
      }
    }
  }
}

// Singleton instance
export const streamingService = new StreamingService();

