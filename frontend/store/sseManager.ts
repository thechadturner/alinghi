import { processStore, ProcessMessage } from "./processStore";
import { warn, debug } from "../utils/console";
import { originalFetch } from "../utils/fetchInterceptor";

interface ServerConnection {
  port: number;
  sse: EventSource | null;
  pollTimer: NodeJS.Timeout | null;
  isConnected: boolean;
  lastTimestamp: number;
  pollFailures: number;
}

class SSEManager {
  private connections = new Map<number, ServerConnection>();
  private cleanupTimers = new Map<number, number>();
  private messageListeners = new Set<(message: ProcessMessage) => void>();
  private activeProcesses = new Set<string>();
  private processTypeToPort = new Map<string, number>();

  constructor() {
    // Initialize connection objects for both servers
    this.connections.set(8059, {
      port: 8059,
      sse: null,
      pollTimer: null,
      isConnected: false,
      lastTimestamp: 0,
      pollFailures: 0
    });
    this.connections.set(8049, {
      port: 8049,
      sse: null,
      pollTimer: null,
      isConnected: false,
      lastTimestamp: 0,
      pollFailures: 0
    });
    
    // Map process types to their respective server ports
    this.processTypeToPort.set('video_upload', 8059);
    this.processTypeToPort.set('script_execution', 8049);
    
    // Set up periodic cleanup of old processes
    setInterval(() => {
      processStore.cleanupOldProcesses();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  // Handle process start - connect to appropriate server if needed
  onProcessStart(processId: string, processType: 'video_upload' | 'script_execution') {
    debug(`[SSEManager] Process started: ${processId} (${processType})`);
    this.activeProcesses.add(processId);
    
    const port = this.processTypeToPort.get(processType);
    if (port) {
      debug(`[SSEManager] Process type ${processType} maps to port ${port}`);
      // Only connect if not already connected
      if (!this.isConnected(port)) {
        debug(`[SSEManager] Not connected to port ${port}, establishing connection...`);
        this.ensureConnection(port);
      } else {
        debug(`[SSEManager] Already connected to port ${port}`);
      }
    } else {
      warn(`[SSEManager] No port mapping found for process type: ${processType}`);
    }
  }

  // Handle process completion - check if we should disconnect
  onProcessComplete(processId: string, processType: 'video_upload' | 'script_execution') {
    this.activeProcesses.delete(processId);
    
    const port = this.processTypeToPort.get(processType);
    if (port) {
      this.checkAndDisconnectIfNoActiveProcesses(port);
    }
  }

  // Ensure connection to a server (connect if not already connected)
  private async ensureConnection(port: number): Promise<boolean> {
    const connection = this.connections.get(port);
    if (!connection) {
      warn(`[SSEManager] Unknown port: ${port}`);
      return false;
    }

    if (connection.isConnected) {
      debug(`[SSEManager] Already connected to port ${port}`);
      return true;
    }

    debug(`[SSEManager] Attempting to connect to port ${port}...`);
    return this.connectToServer(port);
  }

  // Check if we should disconnect from a server (when no active processes of that type)
  private checkAndDisconnectIfNoActiveProcesses(port: number) {
    const processType = port === 8059 ? 'video_upload' : 'script_execution';
    const hasActiveProcessesOfType = Array.from(this.activeProcesses).some(processId => {
      const process = processStore.getProcess(processId);
      return process && process.type === processType && process.status === 'running';
    });

    if (!hasActiveProcessesOfType) {
      this.disconnectFromServer(port);
    }
  }

  // Connect to a specific server
  connectToServer(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const connection = this.connections.get(port);
      if (!connection) {
        warn(`[SSEManager] Unknown port: ${port}`);
        resolve(false);
        return;
      }

      if (connection.isConnected) {
        debug(`[SSEManager] Already connected to port ${port}`);
        resolve(true);
        return;
      }
      
      debug(`[SSEManager] Starting connection process for port ${port}...`);
      // Try SSE first
      this.connectSSE(port).then(sseSuccess => {
        if (sseSuccess) {
          debug(`[SSEManager] SSE connection successful for port ${port}`);
          connection.isConnected = true;
          resolve(true);
        } else {
          debug(`[SSEManager] SSE connection failed for port ${port}, falling back to polling`);
          // Fall back to polling
          this.startPolling(port);
          connection.isConnected = true;
          resolve(true);
        }
      });
    });
  }

  // Disconnect from a specific server
  disconnectFromServer(port: number) {
    const connection = this.connections.get(port);
    if (!connection) return;

    // Close SSE connection
    if (connection.sse) {
      try {
        connection.sse.close();
      } catch (e) {
        warn(`[SSEManager] Error closing SSE for port ${port}:`, e);
      }
      connection.sse = null;
    }

    // Clear polling timer
    if (connection.pollTimer) {
      clearInterval(connection.pollTimer);
      connection.pollTimer = null;
    }

    connection.isConnected = false;
  }

  // Check if connected to a server
  isConnected(port: number): boolean {
    const connection = this.connections.get(port);
    return connection?.isConnected || false;
  }


  // Connect via SSE
  private async connectSSE(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        // For both servers, include auth token as query parameter (EventSource can't send headers)
        const token = localStorage.getItem('access_token');
        
        // Always use relative URLs (nginx handles routing)
        let sseUrl: string;
        if (port === 8059) {
          // Admin server: /api/admin/events/upload-progress
          sseUrl = token 
            ? `/api/admin/events/upload-progress?token=${encodeURIComponent(token)}`
            : `/api/admin/events/upload-progress`;
        } else {
          // Python server: /api/python/sse
          sseUrl = token 
            ? `/api/python/sse?token=${encodeURIComponent(token)}`
            : `/api/python/sse`;
        }
        
        debug(`[SSEManager] Attempting SSE connection to: ${sseUrl}`);
        const sse = new EventSource(sseUrl, { withCredentials: port === 8059 });
        const connection = this.connections.get(port)!;
        connection.sse = sse;

        sse.onopen = () => {
          debug(`[SSEManager] SSE connection opened for port ${port}`);
          resolve(true);
        };

        sse.onmessage = (event) => {
          debug(`[SSEManager] SSE message received from port ${port}:`, event.data);
          try {
            const data = JSON.parse(event.data);
            
            // Handle per-port formats
            if (port === 8049) {
              // Python server may stream nested items
              if (data?.success && data?.data?.items) {
                const items = data.data.items || [];
                for (const item of items) {
                  this.processMessage(port, { type: 'script_progress', ...item });
                }
                return;
              }
              
            }
            // Default path (unified or legacy pass-through)
            this.processMessage(port, data);
          } catch (e) {
            warn(`[SSEManager] Error parsing SSE message from port ${port}:`, e);
          }
        };

        sse.onerror = (error) => {
          // Silence noisy EventSource error object for 8059; fall back to polling quietly
          if (port !== 8059) {
            warn(`[SSEManager] SSE error for port ${port}:`, error);
          } else {
            debug(`[SSEManager] SSE error for port ${port} (silenced for 8059)`);
          }
          try {
            sse.close();
          } catch {}
          connection.sse = null;
          resolve(false);
        };

        // Timeout after 5 seconds
        setTimeout(() => {
          if (!connection.isConnected) {
            try {
              sse.close();
            } catch {}
            connection.sse = null;
            resolve(false);
          }
        }, 5000);

      } catch (e) {
        warn(`[SSEManager] Error creating SSE connection for port ${port}:`, e);
        resolve(false);
      }
    });
  }

  // Start polling fallback
  private startPolling(port: number) {
    const connection = this.connections.get(port)!;
    
    if (connection.pollTimer) {
      clearInterval(connection.pollTimer);
    }

    // Always use relative URLs (nginx handles routing)
    let urlBase: string;
    if (port === 8059) {
      // Admin server: /api/admin/api/upload/progress
      urlBase = `/api/admin/api/upload/progress`;
    } else {
      // Python server: /api/python/sse
      urlBase = `/api/python/sse`;
    }

    debug(`[SSEManager] Starting polling fallback for port ${port} at: ${urlBase}`);
    
    // Reset failure count when starting polling
    connection.pollFailures = 0;

    connection.pollTimer = setInterval(async () => {
      try {
        const url = `${urlBase}?since=${connection.lastTimestamp}`;
        // Add authentication for Python server (8049)
        const headers: HeadersInit = {};
        if (port === 8049) {
          const token = localStorage.getItem('access_token');
          if (token) {
            headers['Authorization'] = `Bearer ${token}`;
          }
        }
        
        const resp = await originalFetch(url, { 
          credentials: 'omit',
          mode: 'cors',
          headers
        });
        
        if (!resp.ok) {
          connection.pollFailures++;
          if (connection.pollFailures >= 5) {
            warn(`[SSEManager] Polling failed ${connection.pollFailures} times for port ${port}, stopping polling`);
            clearInterval(connection.pollTimer!);
            connection.pollTimer = null;
            return;
          }
          return;
        }
        
        // Reset failure count on success
        connection.pollFailures = 0;

        const json = await resp.json();

        // Handle different response formats
        if (port === 8059) {
          // Admin server format
          const items = json?.data?.items || [];
          const now = json?.data?.now || Date.now();
          connection.lastTimestamp = now;
          
          for (const item of items) {
            this.processMessage(port, { type: 'upload_progress', ...item });
          }
        } else {
          // Python server format
          if (json?.success && json?.data?.items) {
            const items = json.data.items;
            const now = json.data.now || Date.now();
            connection.lastTimestamp = now;
            
            for (const item of items) {
              this.processMessage(port, { type: 'script_progress', ...item });
            }
          }
        }
      } catch (e) {
        connection.pollFailures++;
        if (connection.pollFailures >= 5) {
          warn(`[SSEManager] Polling error ${connection.pollFailures} times for port ${port}, stopping polling:`, e);
          clearInterval(connection.pollTimer!);
          connection.pollTimer = null;
          return;
        }
        
      }
    }, 3000);
  }

  // Process incoming messages
  private processMessage(port: number, data: any) {
    debug(`[SSEManager] Processing message from port ${port}:`, data);
    try {
      // Handle direct/unwrapped event format (common from Python server items)
      if (data && data.event && data.process_id && data.type) {
        const message: ProcessMessage = {
          process_id: data.process_id,
          type: data.type,
          event: data.event,
          text: data.text,
          now: data.now || Date.now(),
          data: data.data,
          toast: data.toast // Extract explicit toast flag from SSE message
        };

        debug(`[SSEManager] Parsed direct/unwrapped message:`, message);

        // Filter out old messages (older than 5 minutes) to prevent replay issues
        const messageAge = Date.now() - message.now;
        if (messageAge > 5 * 60 * 1000) {
          debug(`[SSEManager] Ignoring old direct message (age: ${messageAge}ms)`);
          return;
        }

        processStore.addMessage(message.process_id, message);
        this.messageListeners.forEach(listener => {
          try {
            listener(message);
          } catch (e) {
            warn(`[SSEManager] Error in message listener:`, e);
          }
        });

        // Treat a broader set of events as completion indicators
        const completionEvents = new Set<string>([
          'process_complete',
          'process_timeout',
          'process_error',
          'script_complete',
          'complete',
          'error'
        ]);
        if (completionEvents.has(message.event)) {
          // Determine status based on event type and completion data
          let status: 'complete' | 'timeout' | 'error' = 'complete';
          
          if (message.event === 'process_timeout') {
            status = 'timeout';
          } else if (message.event === 'process_error' || message.event === 'error') {
            status = 'error';
          } else if (message.event === 'process_complete' || message.event === 'script_complete' || message.event === 'complete') {
            // Check completion data to see if script actually succeeded.
            // Server sets script_succeeded from script's sys.exit(code) via proc.wait() return_code.
            if (message.data && message.data.script_succeeded === false) {
              status = 'error';
            } else if (message.data && typeof message.data.return_code === 'number' && message.data.return_code !== 0) {
              // Fallback: treat non-zero return_code as error if script_succeeded is missing
              status = 'error';
            } else {
              status = 'complete';
            }
          }
          
          debug(`[SSEManager] Direct message completion: ${message.process_id} -> ${status}`, {
            event: message.event,
            scriptSucceeded: message.data?.script_succeeded,
            returnCode: message.data?.return_code,
            hasErrorLines: message.data?.error_lines?.length > 0
          });
          processStore.completeProcess(message.process_id, status as any, message.data);
        }

        return;
      }

      // Handle wrapped unified format (both Python and Admin servers use this)
      if (data.success && data.event) {
        const message: ProcessMessage = {
          process_id: data.event.process_id,
          type: data.event.type,
          event: data.event.event,
          text: data.event.text,
          now: data.event.now,
          data: data.data,
          toast: data.event.toast // Extract toast flag from event if present
        };

        debug(`[SSEManager] Parsed message:`, message);

            // Filter out old messages (older than 5 minutes) to prevent replay issues
            const messageAge = Date.now() - message.now;
            if (messageAge > 5 * 60 * 1000) { // 5 minutes
              // Silently ignore old messages to prevent console spam
              debug(`[SSEManager] Ignoring old message (age: ${messageAge}ms)`);
              return;
            }

        debug(`[SSEManager] Adding message to process store for process: ${message.process_id}`);
        // Add message to process store
        processStore.addMessage(message.process_id, message);

        debug(`[SSEManager] Notifying ${this.messageListeners.size} message listeners`);
        // Notify message listeners (for modal components)
        this.messageListeners.forEach(listener => {
          try {
            listener(message);
          } catch (e) {
            warn(`[SSEManager] Error in message listener:`, e);
          }
        });

        // Check for completion events (broader set)
        const completionEvents = new Set<string>([
          'process_complete',
          'process_timeout',
          'process_error',
          'script_complete',
          'complete',
          'error'
        ]);
        if (completionEvents.has(message.event)) {
          // Determine status based on event type and completion data
          let status: 'complete' | 'timeout' | 'error' = 'complete';
          
          if (message.event === 'process_timeout') {
            status = 'timeout';
          } else if (message.event === 'process_error' || message.event === 'error') {
            status = 'error';
          } else if (message.event === 'process_complete' || message.event === 'script_complete' || message.event === 'complete') {
            // Check completion data to see if script actually succeeded (from sys.exit code via proc.wait())
            if (message.data && message.data.script_succeeded === false) {
              status = 'error';
            } else if (message.data && typeof message.data.return_code === 'number' && message.data.return_code !== 0) {
              status = 'error';
            } else {
              status = 'complete';
            }
          }
          
          processStore.completeProcess(message.process_id, status as any, message.data);
        }

        return;
      }

      // Handle legacy formats for backward compatibility
      if (port === 8059) {
        // Legacy admin server format
        if (data.type === 'upload_progress') {
          // Convert legacy format to new format
          const process_id = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const message: ProcessMessage = {
            process_id,
            type: 'video_upload',
            event: data.event === 'video_ready' ? 'process_complete' : 'upload_progress',
            text: data.text || `${data.event}: ${data.file || ''}`,
            now: Date.now(),
            data: data
          };

          processStore.addMessage(message.process_id, message);

          if (data.event === 'video_ready') {
            processStore.completeProcess(message.process_id, 'complete', data);
          }
        }
      } else {
        // No other formats to handle
      }
    } catch (e) {
      warn(`[SSEManager] Error processing message from port ${port}:`, e);
    }
  }

  // Schedule cleanup for a server (disconnect after delay if no processes running)
  // DISABLED: Keep connections persistent for global listening
  scheduleCleanup(_port: number, _delayMs: number = 10000) {
    // Don't auto-disconnect - keep connections alive for global listening
  }

  // Force disconnect all servers
  disconnectAll() {
    this.connections.forEach((_, port) => {
      this.disconnectFromServer(port);
    });
    
    // Clear all cleanup timers
    this.cleanupTimers.forEach(timer => clearTimeout(timer));
    this.cleanupTimers.clear();
  }

  // Get connection status
  getStatus() {
    const status: Record<number, boolean> = {};
    this.connections.forEach((conn, port) => {
      status[port] = conn.isConnected;
    });
    return status;
  }

  // Subscribe to SSE messages (for modal components)
  subscribe(callback: (message: ProcessMessage) => void) {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }
}

export const sseManager = new SSEManager();
