const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { log, error, warn, debug } = require('../../shared');
const config = require('../middleware/config');
const connectionManager = require('./connections');
const processor = require('./processor');
const redisStorage = require('./redis');

/**
 * WebSocket Server for Clients
 * Handles client connections, authentication, subscriptions, and data broadcasting
 */

class ClientWebSocketServer {
  constructor(wss) {
    this.wss = wss;
    this.clients = new Map(); // client_id -> { ws, userId, subscriptions: Set<source_name>, channels: Set<channel> }
    this.subscriptions = new Map(); // source_name -> Set<client_id>
    this.clientChannels = new Map(); // client_id -> Set<channel> (channels this client wants)
    this.clientCounter = 0;
    
    // OPTIMIZED: Buffer for throttled WebSocket broadcasts
    // Key: normalized source_name, Value: latest processedPoint (only keep latest per source)
    this.broadcastBuffer = new Map(); // source_name -> processedPoint
    this.broadcastInterval = null; // interval timer
    this.broadcastIntervalMs = parseInt(config.STREAM_LIVE_POLL_INTERVAL_MS || process.env.STREAM_LIVE_POLL_INTERVAL_MS || '5000', 10);
    this.broadcastCount = 0; // Track broadcast count for reduced logging
    
    this.setupServer();
  }

  /**
   * Setup WebSocket server
   */
  setupServer() {
    this.wss.on('connection', (ws, req) => {
      debug('[ClientWebSocketServer] WebSocket connection event received');
      this.handleConnection(ws, req);
    });

    // Add error handler for the WebSocket server itself
    this.wss.on('error', (err) => {
      error('[ClientWebSocketServer] WebSocket server error:', err.message);
      error('[ClientWebSocketServer] WebSocket server error stack:', err.stack);
    });

    // Listen for processed data from processor
    processor.on('processed', (processedPoint) => {
      // OPTIMIZED: Buffer data instead of immediately broadcasting
      // This allows us to send at regular 0.5-second intervals instead of bursts
      this.bufferForBroadcast(processedPoint);
    });

    // OPTIMIZED: Start 0.5-second interval for regular WebSocket broadcasts
    this.startBroadcastInterval();

    log('[ClientWebSocketServer] WebSocket server initialized');
  }

  /**
   * Handle new client connection
   */
  async handleConnection(ws, req) {
    const clientId = ++this.clientCounter;
    log(`[ClientWebSocketServer] New client connection attempt: ${clientId}`);
    debug(`[ClientWebSocketServer] Connection from: ${req.socket?.remoteAddress || 'unknown'}`);
    debug(`[ClientWebSocketServer] Request URL: ${req.url}`);
    debug(`[ClientWebSocketServer] Request headers:`, Object.keys(req.headers || {}));

    // Track WebSocket connection attempt (if stats available from stream controller)
    // Note: We can't directly access stream controller stats here, but the connection
    // will be tracked when the source is added via addSource endpoint

    // Authenticate client
    const authResult = await this.authenticate(ws, req);
    if (!authResult.success) {
      warn(`[ClientWebSocketServer] Authentication failed for client ${clientId}: ${authResult.message}`);
      try {
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
          ws.close(1008, authResult.message || 'Authentication failed');
        }
      } catch (closeErr) {
        error(`[ClientWebSocketServer] Error closing connection after auth failure:`, closeErr.message);
      }
      return;
    }

    const userId = authResult.userId;
    log(`[ClientWebSocketServer] Client ${clientId} authenticated successfully (user: ${userId})`);

    // Store client info
    const clientInfo = {
      ws,
      userId,
      subscriptions: new Set(),
      channels: new Set(), // Track which channels this client wants
      connectedAt: Date.now()
    };
    this.clients.set(clientId, clientInfo);

    // Send connection confirmation
    this.send(ws, {
      type: 'connected',
      clientId,
      message: 'WebSocket connection established'
    });

    // Handle messages
    ws.on('message', (message) => {
      this.handleMessage(clientId, message);
    });

    // Handle close
    ws.on('close', () => {
      this.handleDisconnect(clientId);
    });

    // Handle error
    ws.on('error', (err) => {
      error(`[ClientWebSocketServer] Client ${clientId} WebSocket error:`, err.message);
      error(`[ClientWebSocketServer] Client ${clientId} error stack:`, err.stack);
      debug(`[ClientWebSocketServer] Client ${clientId} readyState:`, ws.readyState);
    });

    // Send ping to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Authenticate client
   */
  async authenticate(ws, req) {
    try {
      let token = null;
      
      // Try to get token from query string first
      if (req.url) {
        try {
          // Parse query string manually to avoid URL constructor issues with proxy headers
          const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
          const params = new URLSearchParams(queryString);
          token = params.get('token');
        } catch (urlErr) {
          // Fallback: try URL constructor with fallback host
          try {
            const host = req.headers.host || 'localhost';
            const url = new URL(req.url, `http://${host}`);
            token = url.searchParams.get('token');
          } catch (urlErr2) {
            warn('[ClientWebSocketServer] Failed to parse URL for token extraction:', urlErr2.message);
            debug('[ClientWebSocketServer] Request URL:', req.url);
            debug('[ClientWebSocketServer] Request headers:', Object.keys(req.headers));
          }
        }
      }

      if (!token) {
        // Try to get from Authorization header
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
          token = authHeader.substring(7);
          debug('[ClientWebSocketServer] Found token in Authorization header');
        } else {
          warn('[ClientWebSocketServer] No authentication token found in query string or Authorization header');
          debug('[ClientWebSocketServer] Request URL:', req.url);
          debug('[ClientWebSocketServer] Has Authorization header:', !!authHeader);
          return { success: false, message: 'No authentication token provided' };
        }
      } else {
        debug('[ClientWebSocketServer] Found token in query string');
      }

      // Validate the token
      const validationResult = this.validateToken(token);
      if (!validationResult.success) {
        warn('[ClientWebSocketServer] Token validation failed:', validationResult.message);
      } else {
        debug('[ClientWebSocketServer] Token validated successfully for user:', validationResult.userId);
      }
      return validationResult;

    } catch (err) {
      error('[ClientWebSocketServer] Authentication error:', err.message);
      error('[ClientWebSocketServer] Authentication error stack:', err.stack);
      debug('[ClientWebSocketServer] Request URL:', req.url);
      debug('[ClientWebSocketServer] Request headers:', req.headers);
      return { success: false, message: 'Authentication error' };
    }
  }

  /**
   * Validate JWT token
   */
  validateToken(token) {
    try {
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        warn('[ClientWebSocketServer] Token is empty or invalid type');
        return { success: false, message: 'Invalid token format' };
      }

      const secret = config.JWT_SECRET || process.env.JWT_SECRET;
      if (!secret) {
        error('[ClientWebSocketServer] JWT_SECRET not configured');
        return { success: false, message: 'Server configuration error' };
      }

      const decoded = jwt.verify(token, secret);
      const userId = decoded.user_id || decoded.id;
      if (!userId) {
        warn('[ClientWebSocketServer] Token decoded but missing user_id or id field');
        debug('[ClientWebSocketServer] Decoded token:', Object.keys(decoded));
        return { success: false, message: 'Token missing user identifier' };
      }
      
      return { success: true, userId: userId };
    } catch (err) {
      // Provide more specific error messages
      if (err.name === 'JsonWebTokenError') {
        warn('[ClientWebSocketServer] JWT verification failed:', err.message);
        return { success: false, message: 'Invalid token signature' };
      } else if (err.name === 'TokenExpiredError') {
        warn('[ClientWebSocketServer] Token expired:', err.expiredAt);
        return { success: false, message: 'Token expired' };
      } else if (err.name === 'NotBeforeError') {
        warn('[ClientWebSocketServer] Token not active yet:', err.date);
        return { success: false, message: 'Token not yet valid' };
      } else {
        error('[ClientWebSocketServer] Token validation error:', err.message);
        return { success: false, message: 'Invalid token' };
      }
    }
  }

  /**
   * Handle client message
   */
  handleMessage(clientId, message) {
    try {
      const clientInfo = this.clients.get(clientId);
      if (!clientInfo) {
        return;
      }

      const data = JSON.parse(message.toString());
      const { type, payload } = data;

      switch (type) {
        case 'subscribe':
          this.handleSubscribe(clientId, payload);
          break;
        case 'unsubscribe':
          this.handleUnsubscribe(clientId, payload);
          break;
        case 'ping':
          this.send(clientInfo.ws, { type: 'pong' });
          break;
        default:
          warn(`[ClientWebSocketServer] Unknown message type: ${type}`);
      }
    } catch (err) {
      error(`[ClientWebSocketServer] Error handling message from client ${clientId}:`, err.message);
    }
  }

  /**
   * Handle subscribe request
   * Accepts either source_name (preferred) or source_id (legacy)
   */
  async handleSubscribe(clientId, payload) {
    const clientInfo = this.clients.get(clientId);
    if (!clientInfo) {
      return;
    }

    const { source_name, source_id, channels } = payload;
    
    // Prefer source_name over source_id
    let sourceName = source_name;
    let sourceId = source_id;
    
    // If only source_id provided, try to find source_name from Redis or connections
    if (!sourceName && sourceId) {
      // Try to find source_name by checking Redis for available sources
      // This is a fallback for legacy clients
      const allConnections = connectionManager.getAllConnections();
      const connection = connectionManager.getConnection(sourceId);
      if (connection && connection.source_name) {
        sourceName = connection.source_name;
      } else {
        // Can't determine source_name, reject subscription
        this.send(clientInfo.ws, {
          type: 'error',
          message: `Cannot subscribe: source_name required (source_id ${sourceId} provided but source_name not found)`
        });
        return;
      }
    }
    
    if (!sourceName) {
      this.send(clientInfo.ws, {
        type: 'error',
        message: 'source_name required for subscription'
      });
      return;
    }

    // Normalize source_name (uppercase, trimmed)
    const normalizedSourceName = String(sourceName).toUpperCase().trim();
    
    // If only source_name provided, try to find source_id from connections
    if (!sourceId) {
      const allConnections = connectionManager.getAllConnections();
      for (const connection of allConnections) {
        // Check if connection's source_name matches (from config.source for InfluxDB sources)
        const connectionSourceName = connection.config?.source || connection.config?.boat || connection.source_name;
        if (connectionSourceName && String(connectionSourceName).toUpperCase().trim() === normalizedSourceName) {
          sourceId = connection.source_id;
          debug(`[ClientWebSocketServer] Resolved source_id ${sourceId} from source_name "${normalizedSourceName}"`);
          break;
        }
      }
    }

    // Check if source has data in Redis (this is what we're subscribing to)
    // Allow subscription even if no data exists yet - client may be waiting for data to arrive
    try {
      const availableChannels = await redisStorage.getChannels(normalizedSourceName);
      if (!availableChannels || availableChannels.length === 0) {
        // Log warning but allow subscription - data may arrive later
        warn(`[ClientWebSocketServer] Client ${clientId} subscribing to source "${normalizedSourceName}" with no data in Redis yet (subscription allowed, will receive data when available)`);
      } else {
        debug(`[ClientWebSocketServer] Source "${normalizedSourceName}" has ${availableChannels.length} channels in Redis`);
      }
    } catch (err) {
      warn(`[ClientWebSocketServer] Error checking Redis for source "${normalizedSourceName}":`, err.message);
      // Continue anyway - data might exist but channels query failed
    }

    // Update client's channel subscriptions if provided
    if (channels && Array.isArray(channels)) {
      for (const channel of channels) {
        clientInfo.channels.add(channel);
      }
      this.clientChannels.set(clientId, new Set(clientInfo.channels));
      debug(`[ClientWebSocketServer] Client ${clientId} subscribed to channels:`, Array.from(channels));
    }

    // Add subscription (use source_name as key)
    clientInfo.subscriptions.add(normalizedSourceName);

    // Add to subscriptions map (keyed by source_name)
    if (!this.subscriptions.has(normalizedSourceName)) {
      this.subscriptions.set(normalizedSourceName, new Set());
    }
    this.subscriptions.get(normalizedSourceName).add(clientId);

    log(`[ClientWebSocketServer] Client ${clientId} subscribed to source "${normalizedSourceName}"${channels ? ` with channels: ${channels.join(', ')}` : ''}`);
    
    // Debug: Log subscription details
    debug(`[ClientWebSocketServer] Subscription details:`, {
      clientId,
      source_name: normalizedSourceName,
      source_id: sourceId,
      channels: channels || null,
      totalSubscriptions: this.subscriptions.size,
      allSubscribedSources: Array.from(this.subscriptions.keys()),
      subscriberCount: this.subscriptions.get(normalizedSourceName)?.size || 0
    });

    this.send(clientInfo.ws, {
      type: 'subscribed',
      source_name: normalizedSourceName,
      source_id: sourceId || null,
      channels: channels || null
    });

    // Send initial snapshot immediately for fastest possible initial load
    // This provides O(1) hash lookup vs waiting for next broadcast
    try {
      const latestSnapshot = await redisStorage.getLatestSnapshot(normalizedSourceName);
      if (latestSnapshot) {
        // Filter channels if client specified specific channels
        let snapshotData = latestSnapshot;
        if (channels && Array.isArray(channels) && channels.length > 0) {
          const filteredData = { timestamp: latestSnapshot.timestamp };
          for (const channel of channels) {
            if (latestSnapshot[channel] !== undefined) {
              filteredData[channel] = latestSnapshot[channel];
            }
          }
          snapshotData = filteredData;
        }

        this.send(clientInfo.ws, {
          type: 'data',
          source_name: normalizedSourceName,
          source_id: sourceId || null,
          data: snapshotData,
          is_initial_snapshot: true
        });
        debug(`[ClientWebSocketServer] Sent initial snapshot to client ${clientId} for source "${normalizedSourceName}"`);
      } else {
        debug(`[ClientWebSocketServer] No snapshot available for source "${normalizedSourceName}" - client will receive data from next broadcast`);
      }
    } catch (err) {
      warn(`[ClientWebSocketServer] Error sending initial snapshot to client ${clientId} for source "${normalizedSourceName}":`, err.message);
      // Continue - client will get data from next broadcast
    }
  }

  /**
   * Handle unsubscribe request
   * Accepts either source_name (preferred) or source_id (legacy)
   */
  handleUnsubscribe(clientId, payload) {
    const clientInfo = this.clients.get(clientId);
    if (!clientInfo) {
      return;
    }

    const { source_name, source_id } = payload;
    
    // Prefer source_name over source_id
    let sourceName = source_name;
    
    // If only source_id provided, try to find it in subscriptions (legacy support)
    if (!sourceName && source_id) {
      // Check if source_id exists in subscriptions (for backward compatibility)
      // Note: This won't work if subscriptions are keyed by source_name
      // But we'll try to find it anyway
      for (const sub of clientInfo.subscriptions) {
        // If subscription is a number (legacy source_id), match it
        if (typeof sub === 'number' && sub === source_id) {
          sourceName = sub; // Use the subscription key directly
          break;
        }
      }
    }
    
    if (sourceName) {
      // Normalize if it's a string
      const normalizedSourceName = typeof sourceName === 'string' 
        ? String(sourceName).toUpperCase().trim() 
        : sourceName;
        
      clientInfo.subscriptions.delete(normalizedSourceName);
      const sourceSubs = this.subscriptions.get(normalizedSourceName);
      if (sourceSubs) {
        sourceSubs.delete(clientId);
        if (sourceSubs.size === 0) {
          this.subscriptions.delete(normalizedSourceName);
        }
      }

      this.send(clientInfo.ws, {
        type: 'unsubscribed',
        source_name: typeof normalizedSourceName === 'string' ? normalizedSourceName : null,
        source_id: typeof normalizedSourceName === 'number' ? normalizedSourceName : null
      });
    } else {
      // Unsubscribe from all
      for (const sourceName of clientInfo.subscriptions) {
        const sourceSubs = this.subscriptions.get(sourceName);
        if (sourceSubs) {
          sourceSubs.delete(clientId);
          if (sourceSubs.size === 0) {
            this.subscriptions.delete(sourceName);
          }
        }
      }
      clientInfo.subscriptions.clear();

      this.send(clientInfo.ws, {
        type: 'unsubscribed',
        source_id: null
      });
    }
  }

  /**
   * Handle client disconnect
   */
  handleDisconnect(clientId) {
    const clientInfo = this.clients.get(clientId);
    if (!clientInfo) {
      return;
    }

    // Remove from all subscriptions
    for (const sourceId of clientInfo.subscriptions) {
      const sourceSubs = this.subscriptions.get(sourceId);
      if (sourceSubs) {
        sourceSubs.delete(clientId);
        if (sourceSubs.size === 0) {
          this.subscriptions.delete(sourceId);
        }
      }
    }

    // Clean up channel subscriptions
    this.clientChannels.delete(clientId);
    this.clients.delete(clientId);
    log(`[ClientWebSocketServer] Client ${clientId} disconnected`);
  }

  /**
   * Buffer processed data for throttled broadcast
   * Stores the latest data point per source (overwrites if multiple arrive)
   * Actual broadcast happens at regular 0.5-second intervals
   */
  bufferForBroadcast(processedPoint) {
    const { source_id, timestamp, data } = processedPoint;
    
    // Extract source_name from data (required for Redis operations and subscriptions)
    const source_name = data?.source_name || null;
    
    if (!source_name) {
      warn(`[ClientWebSocketServer] Cannot buffer: processedPoint missing source_name`, {
        source_id,
        availableKeys: Object.keys(data || {})
      });
      return;
    }

    // Normalize source_name (uppercase, trimmed) to match subscription keys
    const normalizedSourceName = String(source_name).toUpperCase().trim();
    
    // Debug: Log when data is buffered (reduced frequency)
    const bufferCount = (this.bufferCount = (this.bufferCount || 0) + 1);
    if (bufferCount % 20 === 0) {
      debug(`[ClientWebSocketServer] Buffering data for "${normalizedSourceName}"`, {
        source_name: normalizedSourceName,
        source_id,
        timestamp,
        hasSubscribers: this.subscriptions.has(normalizedSourceName),
        subscriberCount: this.subscriptions.get(normalizedSourceName)?.size || 0,
        dataChannels: Object.keys(data || {}).slice(0, 10)
      });
    }

    // Store latest data point per source (overwrites if multiple arrive in same interval)
    // This ensures we send the most recent data at each 0.5-second interval
    // If data arrives faster than 2 Hz, we keep only the latest point per interval
    // This provides consistent 2 Hz updates even if source sends at higher rates
    this.broadcastBuffer.set(normalizedSourceName, processedPoint);
  }

  /**
   * Start 0.5-second interval for regular WebSocket broadcasts
   * Sends buffered data at consistent intervals instead of bursts
   */
  startBroadcastInterval() {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
    }

    this.broadcastInterval = setInterval(() => {
      // Handle async function - catch errors to prevent unhandled rejections
      this.flushBroadcastBuffer().catch(err => {
        error(`[ClientWebSocketServer] Error in flushBroadcastBuffer:`, err.message);
      });
    }, this.broadcastIntervalMs);

    log(`[ClientWebSocketServer] Started 1-second broadcast interval`);
  }

  /**
   * Flush broadcast buffer and send to all subscribed clients
   * Called every 0.5 seconds to provide smooth, regular updates
   * BATCHED: Sends all sources together in one message for synchronized updates
   * OPTIMIZED: Uses hash for latest data when available for fastest real-time updates
   */
  async flushBroadcastBuffer() {
    if (this.broadcastBuffer.size === 0) {
      return; // No data to send
    }

    // Collect all buffered data points for batch send
    // OPTIMIZED: Use hash to get absolute latest data when available (O(1) lookup)
    const batchData = [];
    const hashCheckPromises = [];
    
    for (const [normalizedSourceName, processedPoint] of this.broadcastBuffer.entries()) {
      const { source_id, timestamp, data } = processedPoint;
      const source_name = data?.source_name || null;
      
      if (!source_name) {
        continue; // Skip invalid points
      }

      // Check if any client is subscribed to this source
      const subscribers = this.subscriptions.get(normalizedSourceName);
      if (!subscribers || subscribers.size === 0) {
        // Log when we have data but no subscribers (helps debug subscription issues)
        if (this.broadcastCount % 20 === 0) {
          debug(`[ClientWebSocketServer] Data available for "${normalizedSourceName}" but no subscribers`, {
            source_name: normalizedSourceName,
            availableSubscriptions: Array.from(this.subscriptions.keys()),
            totalClients: this.clients.size
          });
        }
        continue; // Skip sources with no subscribers
      }
      
      // Log successful match (reduced frequency)
      if (this.broadcastCount % 20 === 0) {
        debug(`[ClientWebSocketServer] Broadcasting "${normalizedSourceName}" to ${subscribers.size} subscriber(s)`, {
          source_name: normalizedSourceName,
          subscriberCount: subscribers.size,
          subscriberIds: Array.from(subscribers)
        });
      }

      // OPTIMIZED: Check hash for absolute latest data (non-blocking, async)
      // This ensures we send the most recent data even if buffer is slightly stale
      hashCheckPromises.push(
        redisStorage.getLatestSnapshot(normalizedSourceName)
          .then(latestSnapshot => {
            if (latestSnapshot && latestSnapshot.timestamp && latestSnapshot.timestamp > timestamp) {
              // Hash has newer data, use it instead of buffered data
              return {
                source_name: source_name,
                source_id: source_id,
                timestamp: latestSnapshot.timestamp,
                data: latestSnapshot
              };
            }
            // Use buffered data (it's already latest or hash doesn't have newer)
            return {
              source_name: source_name,
              source_id: source_id,
              timestamp: timestamp,
              data: data
            };
          })
          .catch(err => {
            // If hash check fails, use buffered data (backward compatibility)
            debug(`[ClientWebSocketServer] Hash check failed for ${normalizedSourceName}, using buffer:`, err.message);
            return {
              source_name: source_name,
              source_id: source_id,
              timestamp: timestamp,
              data: data
            };
          })
      );
    }

    // Wait for all hash checks to complete (parallel, non-blocking)
    const resolvedData = await Promise.all(hashCheckPromises);
    batchData.push(...resolvedData);

    if (batchData.length === 0) {
      this.broadcastBuffer.clear();
      return; // No data to send after filtering
    }

    // Send batched update to all clients
    this.broadcastBatchToSubscribers(batchData);

    // Clear buffer after sending
    this.broadcastBuffer.clear();
  }

  /**
   * Broadcast batched data to all subscribed clients
   * Sends all sources together in one message for synchronized updates
   * Filters data by each client's requested channels
   */
  broadcastBatchToSubscribers(batchData) {
    if (batchData.length === 0) {
      return;
    }

    // Get all unique client IDs that are subscribed to any source in the batch
    const subscribedClients = new Set();
    for (const item of batchData) {
      const normalizedSourceName = String(item.source_name).toUpperCase().trim();
      const subscribers = this.subscriptions.get(normalizedSourceName);
      if (subscribers) {
        for (const clientId of subscribers) {
          subscribedClients.add(clientId);
        }
      }
    }

    if (subscribedClients.size === 0) {
      return; // No subscribers
    }

    // Send batched message to each client (filtered by their channel subscriptions)
    for (const clientId of subscribedClients) {
      const clientInfo = this.clients.get(clientId);
      if (!clientInfo || clientInfo.ws.readyState !== clientInfo.ws.OPEN) {
        continue;
      }

      // Filter batch data by client's channel subscriptions
      const clientChannels = this.clientChannels.get(clientId);
      const filteredBatch = [];

      for (const item of batchData) {
        const normalizedSourceName = String(item.source_name).toUpperCase().trim();
        const subscribers = this.subscriptions.get(normalizedSourceName);
        
        // Check if this client is subscribed to this source
        if (!subscribers || !subscribers.has(clientId)) {
          continue; // Client not subscribed to this source
        }

        // Debug: Log data keys before filtering (only for first client to avoid spam)
        if (clientId === 1 && this.broadcastCount % 10 === 0) {
          debug(`[ClientWebSocketServer] Source "${normalizedSourceName}" data keys before filtering:`, Object.keys(item.data || {}));
        }

        // Default channel names to always include (if available in data)
        // Processor now outputs default channel names directly (Lat_dd, Bsp_kph, etc.)
        // These are the channels needed for map rendering and charts
        const defaultChannels = [
          'Lat_dd', 'Lng_dd',           // Coordinates
          'Bsp_kph', 'Bsp_kts',         // Boat speed (both units for compatibility)
          'Hdg_deg',                    // Heading
          'Tws_kph', 'Tws_kts',         // True wind speed (both units)
          'Twd_deg',                    // True wind direction
          'Twa_deg',                    // True wind angle
          'Sog_kph', 'Sog_kts',         // Speed over ground (both units)
          'Cog_deg',                    // Course over ground
          'Vmg_kph', 'Vmg_kts',         // Velocity made good (both units)
          'Aws_kph', 'Aws_kts',         // Apparent wind speed (both units)
          'Awa_deg',                    // Apparent wind angle
          'Lwy_deg',                    // Leeway
          'Race_number', 'Leg_number'   // Race metadata
        ];
        
        // Filter data by client's requested channels
        // Map client-requested channel names to actual processor output channel names
        // Frontend may request 'Lat', 'Lng', 'Bsp' but processor outputs 'Lat_dd', 'Lng_dd', 'Bsp_kph'
        const channelNameMapping = {
          'lat': ['lat_dd', 'latitude', 'lat'],
          'lng': ['lng_dd', 'longitude', 'lng'],
          'bsp': ['bsp_kph', 'bsp_kts', 'boat_speed', 'bsp'],
          'hdg': ['hdg_deg', 'heading', 'hdg'],
          'tws': ['tws_kph', 'tws_kts', 'true_wind_speed', 'tws'],
          'twd': ['twd_deg', 'true_wind_direction', 'twd'],
          'twa': ['twa_deg', 'true_wind_angle', 'twa'],
          'sog': ['sog_kph', 'sog_kts', 'speed_over_ground', 'sog'],
          'cog': ['cog_deg', 'course_over_ground', 'cog'],
          'vmg': ['vmg_kph', 'vmg_kts', 'velocity_made_good', 'vmg'],
          'aws': ['aws_kph', 'aws_kts', 'apparent_wind_speed', 'aws'],
          'awa': ['awa_deg', 'apparent_wind_angle', 'awa'],
          'lwy': ['lwy_deg', 'leeway', 'lwy'],
          'datetime': ['datetime', 'timestamp']
        };
        
        // Build a plain object for payload so we never assign onto item.data (it may have getter-only Datetime from processor)
        let filteredData;
        
        if (clientChannels && clientChannels.size > 0) {
          filteredData = {};
          
          // First, try to match client-requested channels to actual data channels
          for (const channel of clientChannels) {
            const channelLower = channel.toLowerCase();
            
            // Check if there's a mapping for this channel
            const possibleNames = channelNameMapping[channelLower] || [channelLower];
            
            // Try exact match first (case-insensitive)
            let found = false;
            for (const key in item.data) {
              if (item.data.hasOwnProperty(key)) {
                const keyLower = key.toLowerCase();
                
                // Check if key matches any of the possible names
                for (const possibleName of possibleNames) {
                  if (keyLower === possibleName || keyLower.startsWith(possibleName + '_') || keyLower.endsWith('_' + possibleName)) {
                    filteredData[key] = item.data[key]; // Use actual key name from data
                    found = true;
                    break;
                  }
                }
                
                if (found) break;
              }
            }
            
            // If not found, try case-insensitive partial match
            if (!found) {
              for (const key in item.data) {
                if (item.data.hasOwnProperty(key) && key.toLowerCase().includes(channelLower)) {
                  filteredData[key] = item.data[key];
                  break;
                }
              }
            }
          }
          
          // CRITICAL: Always include default channels if available (even if not requested)
          // Processor now outputs default channel names directly, so we just check for them
          for (const defaultChannel of defaultChannels) {
            // Check if already included from client request
            if (filteredData[defaultChannel] !== undefined) {
              continue; // Already included
            }
            
            // Check for default channel name directly (processor outputs these now)
            if (item.data[defaultChannel] !== undefined && item.data[defaultChannel] !== null) {
              filteredData[defaultChannel] = item.data[defaultChannel];
              continue;
            }
            
            // Also check case-insensitive match for any variation
            const defaultChannelLower = defaultChannel.toLowerCase();
            for (const key in item.data) {
              if (key.toLowerCase() === defaultChannelLower && item.data[key] !== undefined && item.data[key] !== null) {
                filteredData[defaultChannel] = item.data[key];
                break;
              }
            }
          }
          
          // Always include source_name if available (needed for display)
          if (item.data.source_name !== undefined) {
            filteredData.source_name = item.data.source_name;
          }
          
          // Always include Datetime if available (read getter once into variable to avoid assigning onto getter-only object)
          let datetimeVal;
          try {
            if ('Datetime' in item.data) datetimeVal = item.data.Datetime;
            else if ('datetime' in item.data) datetimeVal = item.data.datetime;
            else if (item.timestamp) datetimeVal = new Date(item.timestamp).toISOString();
          } catch (_) {
            if (item.timestamp) datetimeVal = new Date(item.timestamp).toISOString();
          }
          if (datetimeVal !== undefined) filteredData.Datetime = datetimeVal;
        } else {
          // No channel filtering - copy by value into a plain object (item.data may have getter-only Datetime from processor)
          const src = item.data || {};
          filteredData = {};
          for (const k of Object.keys(src)) {
            try {
              filteredData[k] = src[k];
            } catch (_) {
              // skip getter-only or throwing accessors
            }
          }
          let datetimeVal;
          try {
            if ('Datetime' in src) datetimeVal = src.Datetime;
            else if ('datetime' in src) datetimeVal = src.datetime;
            else if (item.timestamp) datetimeVal = new Date(item.timestamp).toISOString();
          } catch (_) {
            if (item.timestamp) datetimeVal = new Date(item.timestamp).toISOString();
          }
          if (datetimeVal !== undefined) filteredData.Datetime = datetimeVal;
        }

        filteredBatch.push({
          source_name: item.source_name,
          source_id: item.source_id,
          timestamp: item.timestamp,
          data: filteredData
        });
      }

      if (filteredBatch.length > 0) {
        const message = {
          type: 'data_batch',
          sources: filteredBatch
        };

        this.send(clientInfo.ws, message);
      }
    }

    // OPTIMIZED: Reduce logging
    if (!this.broadcastCount || this.broadcastCount % 10 === 0) {
      debug(`[ClientWebSocketServer] Broadcasted batch of ${batchData.length} sources to ${subscribedClients.size} clients`);
    }
    this.broadcastCount = (this.broadcastCount || 0) + 1;
  }

  /**
   * Broadcast processed data to subscribed clients (legacy single-source method)
   * Filters data by client's requested channels for efficiency
   * Note: Subscriptions still use source_id for connection management,
   * but broadcast messages use source_name from the data
   * @deprecated Use broadcastBatchToSubscribers for synchronized updates
   */
  broadcastToSubscribers(processedPoint) {
    const { source_id, timestamp, data } = processedPoint;
    
    // Extract source_name from data (required for Redis operations and subscriptions)
    const source_name = data?.source_name || null;
    
    if (!source_name) {
      warn(`[ClientWebSocketServer] Cannot broadcast: processedPoint missing source_name`, {
        source_id,
        availableKeys: Object.keys(data || {})
      });
      return;
    }

    // Normalize source_name (uppercase, trimmed) to match subscription keys
    const normalizedSourceName = String(source_name).toUpperCase().trim();

    const subscribers = this.subscriptions.get(normalizedSourceName);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    let sentCount = 0;
    for (const clientId of subscribers) {
      const clientInfo = this.clients.get(clientId);
      if (!clientInfo || clientInfo.ws.readyState !== clientInfo.ws.OPEN) {
        // Remove dead client
        subscribers.delete(clientId);
        continue;
      }

      // Filter data by client's requested channels
      const clientChannels = this.clientChannels.get(clientId);
      let filteredData = data;
      
      if (clientChannels && clientChannels.size > 0) {
        // Client has specific channel requirements - filter data
        // CRITICAL: Preserve normalized channel names from processed data
        filteredData = {};
        for (const channel of clientChannels) {
          // Find the actual key in processed data (case-insensitive search)
          // This preserves the normalized channel names from the processor
          let foundKey = null;
          let foundValue = undefined;
          
          // Check exact match first
          if (data.hasOwnProperty(channel)) {
            foundKey = channel;
            foundValue = data[channel];
          } else {
            // Case-insensitive search to find normalized name
            const channelLower = channel.toLowerCase();
            for (const key in data) {
              if (data.hasOwnProperty(key) && key.toLowerCase() === channelLower) {
                foundKey = key; // Use the actual normalized key from processed data
                foundValue = data[key];
                break;
              }
            }
          }
          
          // Use the normalized channel name from processed data, not the client's requested name
          if (foundKey !== null && foundValue !== undefined) {
            filteredData[foundKey] = foundValue;
          }
        }
        
        // Always include source_name if available (needed for display)
        if (data.source_name !== undefined) {
          filteredData.source_name = data.source_name;
        }
        
        // Log what channels were requested vs what was found
        if (sentCount === 0) { // Only log for first client to avoid spam
          const requestedChannels = Array.from(clientChannels);
          const foundChannels = Object.keys(filteredData).filter(k => k !== 'source_name');
          const missingChannels = requestedChannels.filter(c => !foundChannels.includes(c));
          if (missingChannels.length > 0) {
            debug(`[ClientWebSocketServer] Requested channels not found in data for "${normalizedSourceName}":`, {
              requested: requestedChannels,
              found: foundChannels,
              missing: missingChannels,
              availableInData: Object.keys(data).filter(k => !['source_name', 'timestamp'].includes(k))
            });
          }
        }
      }
      // If no channel filter, send all data (backward compatibility)

      // Debug: Log channel names being sent to verify normalization
      if (sentCount === 0) { // Only log for first client to avoid spam
        const channelNames = Object.keys(filteredData).filter(k => k !== 'source_name' && k !== 'timestamp');
        const dataChannels = Object.keys(data).filter(k => k !== 'source_name' && k !== 'timestamp');
        // Use warn so it shows up even without verbose logging
        warn(`[ClientWebSocketServer] Source "${normalizedSourceName}": Data channels: [${dataChannels.join(', ')}] -> Sending to client: [${channelNames.join(', ')}]`);
      }

      const message = {
        type: 'data',
        source_name: source_name, // Use source_name from data, not source_id
        timestamp,
        data: filteredData
      };

      this.send(clientInfo.ws, message);
      sentCount++;
    }

    // OPTIMIZED: Reduce logging - only log every 10th broadcast or when no clients
    if (sentCount === 0) {
      debug(`[ClientWebSocketServer] No subscribers for source_name "${source_name}"`);
    } else if (!this.broadcastCount || this.broadcastCount % 10 === 0) {
      debug(`[ClientWebSocketServer] Broadcasted data for source_name "${source_name}" to ${sentCount} clients`);
    }
    this.broadcastCount = (this.broadcastCount || 0) + 1;
  }

  /**
   * Send message to client
   */
  send(ws, message) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        error('[ClientWebSocketServer] Error sending message:', err.message);
      }
    }
  }

  /**
   * Get client count
   */
  getClientCount() {
    const count = this.clients.size;
    // Debug: Log if count is 0 but we expect connections
    if (count === 0 && this.clientCounter > 0) {
      debug(`[ClientWebSocketServer] getClientCount() returned 0 but clientCounter is ${this.clientCounter}`, {
        totalClients: this.clients.size,
        clientCounter: this.clientCounter,
        subscriptionCount: this.subscriptions.size,
        allSubscriptions: Array.from(this.subscriptions.keys())
      });
    }
    return count;
  }
  
  /**
   * Get detailed connection info for debugging
   */
  getConnectionInfo() {
    const clients = [];
    for (const [clientId, clientInfo] of this.clients.entries()) {
      clients.push({
        clientId,
        userId: clientInfo.userId,
        connectedAt: clientInfo.connectedAt,
        readyState: clientInfo.ws.readyState,
        subscriptionCount: clientInfo.subscriptions.size,
        subscriptions: Array.from(clientInfo.subscriptions),
        channelCount: clientInfo.channels.size,
        channels: Array.from(clientInfo.channels)
      });
    }
    return {
      totalClients: this.clients.size,
      clientCounter: this.clientCounter,
      clients,
      totalSubscriptions: this.subscriptions.size,
      allSubscribedSources: Array.from(this.subscriptions.keys()),
      subscriptionDetails: Array.from(this.subscriptions.entries()).map(([source, clientIds]) => ({
        source,
        clientCount: clientIds.size,
        clientIds: Array.from(clientIds)
      }))
    };
  }

  /**
   * Get subscription count for a source
   */
  getSubscriptionCount(source_id) {
    const subscribers = this.subscriptions.get(source_id);
    return subscribers ? subscribers.size : 0;
  }

  /**
   * Get diagnostic information about the WebSocket server
   */
  getDiagnostics() {
    const clientDetails = [];
    for (const [clientId, clientInfo] of this.clients.entries()) {
      clientDetails.push({
        clientId,
        userId: clientInfo.userId,
        connectedAt: clientInfo.connectedAt,
        readyState: clientInfo.ws.readyState,
        subscriptionCount: clientInfo.subscriptions.size,
        channelCount: clientInfo.channels.size,
        subscriptions: Array.from(clientInfo.subscriptions),
        channels: Array.from(clientInfo.channels)
      });
    }

    const subscriptionDetails = {};
    for (const [sourceName, clientIds] of this.subscriptions.entries()) {
      subscriptionDetails[sourceName] = {
        clientCount: clientIds.size,
        clientIds: Array.from(clientIds)
      };
    }

    return {
      serverInitialized: !!this.wss,
      clientCount: this.clients.size,
      subscriptionCount: this.subscriptions.size,
      broadcastIntervalMs: this.broadcastIntervalMs,
      broadcastIntervalActive: !!this.broadcastInterval,
      bufferedSources: this.broadcastBuffer.size,
      clients: clientDetails,
      subscriptions: subscriptionDetails,
      jwtSecretConfigured: !!(require('../middleware/config').JWT_SECRET || process.env.JWT_SECRET)
    };
  }

  /**
   * Disconnect all WebSocket clients
   * Used when streaming is stopped to clean up all connections
   */
  disconnectAllClients(reason = 'Streaming stopped') {
    const clientCount = this.clients.size;
    log(`[ClientWebSocketServer] Disconnecting all ${clientCount} WebSocket clients: ${reason}`);
    
    // Disconnect each client
    for (const [clientId, clientInfo] of this.clients.entries()) {
      try {
        if (clientInfo.ws && clientInfo.ws.readyState === clientInfo.ws.OPEN) {
          // Send notification before closing
          this.send(clientInfo.ws, {
            type: 'disconnected',
            reason: reason,
            message: 'WebSocket connection closed: ' + reason
          });
          clientInfo.ws.close(1000, reason);
        }
      } catch (err) {
        error(`[ClientWebSocketServer] Error disconnecting client ${clientId}:`, err.message);
      }
    }
    
    // Clear all subscriptions and clients
    this.subscriptions.clear();
    this.clients.clear();
    this.clientChannels.clear();
    
    log(`[ClientWebSocketServer] All ${clientCount} WebSocket clients disconnected`);
  }

  /**
   * Cleanup: Stop broadcast interval and clear buffers
   */
  cleanup() {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
    this.broadcastBuffer.clear();
    log('[ClientWebSocketServer] Cleaned up broadcast interval and buffers');
  }
}

module.exports = ClientWebSocketServer;

