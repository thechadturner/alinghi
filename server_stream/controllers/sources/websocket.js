const WebSocket = require('ws');
const { log, error, warn, debug } = require('../../../shared');
const connectionManager = require('../connections');
const EventEmitter = require('events');

/**
 * WebSocket Data Source Connector
 * Connects to external WebSocket endpoints, parses JSON data, and emits to processor
 */

class WebSocketSource extends EventEmitter {
  constructor(source_id, config) {
    super();
    this.source_id = source_id;
    this.config = config;
    this.ws = null;
    this.isConnecting = false;
    this.shouldReconnect = true;
  }

  /**
   * Connect to WebSocket endpoint
   */
  async connect() {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      warn(`[WebSocketSource] Source ${this.source_id} already connected or connecting`);
      return;
    }

    this.isConnecting = true;
    connectionManager.updateState(this.source_id, 'connecting');

    try {
      const url = this.config.url;
      if (!url) {
        throw new Error('WebSocket URL not provided in config');
      }

      log(`[WebSocketSource] Connecting source ${this.source_id} to ${url}`);

      // Create WebSocket connection
      this.ws = new WebSocket(url, {
        headers: this.config.headers || {},
        handshakeTimeout: this.config.handshakeTimeout || 10000,
        perMessageDeflate: this.config.perMessageDeflate !== false
      });

      // Connection opened
      this.ws.on('open', () => {
        this.isConnecting = false;
        connectionManager.updateState(this.source_id, 'connected');
        log(`[WebSocketSource] Source ${this.source_id} connected`);
        this.emit('connected');
      });

      // Receive message
      this.ws.on('message', (data) => {
        try {
          // Parse JSON data
          let message;
          if (Buffer.isBuffer(data)) {
            message = JSON.parse(data.toString('utf8'));
          } else if (typeof data === 'string') {
            message = JSON.parse(data);
          } else {
            message = data;
          }

          // Extract source_id from message if present, otherwise use configured source_id
          const messageSourceId = message.source_id || message.sourceId || this.source_id;

          // Validate source_id matches (if provided in message)
          if (message.source_id !== undefined && message.source_id !== this.source_id) {
            warn(`[WebSocketSource] Source ID mismatch: expected ${this.source_id}, got ${message.source_id}`);
          }

          // Emit data event to processor
          this.emit('data', {
            source_id: this.source_id,
            timestamp: message.timestamp || Date.now(),
            data: message
          });

        } catch (err) {
          error(`[WebSocketSource] Error parsing message from source ${this.source_id}:`, err.message);
          this.emit('error', err);
        }
      });

      // Connection error
      this.ws.on('error', (err) => {
        this.isConnecting = false;
        error(`[WebSocketSource] Error for source ${this.source_id}:`, err.message);
        connectionManager.updateState(this.source_id, 'error', err);
        this.emit('error', err);

        // Schedule reconnection if should reconnect
        if (this.shouldReconnect) {
          connectionManager.scheduleReconnect(this.source_id, () => {
            this.connect();
          });
        }
      });

      // Connection closed
      this.ws.on('close', (code, reason) => {
        this.isConnecting = false;
        log(`[WebSocketSource] Source ${this.source_id} disconnected (code: ${code}, reason: ${reason || 'none'})`);
        connectionManager.updateState(this.source_id, 'disconnected');

        // Schedule reconnection if should reconnect
        if (this.shouldReconnect && code !== 1000) { // Don't reconnect on normal close
          connectionManager.scheduleReconnect(this.source_id, () => {
            this.connect();
          });
        }
      });

      // Ping/pong for keepalive
      if (this.config.pingInterval) {
        const pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
          } else {
            clearInterval(pingInterval);
          }
        }, this.config.pingInterval);
      }

    } catch (err) {
      this.isConnecting = false;
      error(`[WebSocketSource] Failed to connect source ${this.source_id}:`, err.message);
      connectionManager.updateState(this.source_id, 'error', err);
      this.emit('error', err);

      // Schedule reconnection
      if (this.shouldReconnect) {
        connectionManager.scheduleReconnect(this.source_id, () => {
          this.connect();
        });
      }
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    this.shouldReconnect = false;
    
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Client disconnect');
      }
      this.ws = null;
    }

    connectionManager.updateState(this.source_id, 'disconnected');
    log(`[WebSocketSource] Source ${this.source_id} disconnected`);
  }

  /**
   * Send message to WebSocket (if bidirectional)
   */
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const message = typeof data === 'string' ? data : JSON.stringify(data);
        this.ws.send(message);
        return true;
      } catch (err) {
        error(`[WebSocketSource] Error sending message for source ${this.source_id}:`, err.message);
        return false;
      }
    }
    return false;
  }

  /**
   * Get connection state
   */
  getState() {
    if (!this.ws) {
      return 'disconnected';
    }
    
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING:
        return 'connecting';
      case WebSocket.OPEN:
        return 'connected';
      case WebSocket.CLOSING:
        return 'closing';
      case WebSocket.CLOSED:
        return 'disconnected';
      default:
        return 'unknown';
    }
  }
}

/**
 * Create and manage WebSocket source connection
 * @param {number} source_id - Source identifier
 * @param {Object} config - WebSocket configuration
 * @returns {WebSocketSource} - WebSocket source instance
 */
function createWebSocketSource(source_id, config) {
  const connectionInfo = connectionManager.getConnection(source_id);
  if (!connectionInfo) {
    throw new Error(`Connection for source_id ${source_id} not found in connection manager`);
  }

  const wsSource = new WebSocketSource(source_id, config);
  
  // Forward events to connection manager
  wsSource.on('connected', () => {
    connectionManager.updateState(source_id, 'connected');
  });

  wsSource.on('error', (err) => {
    connectionManager.updateState(source_id, 'error', err);
  });

  wsSource.on('data', (data) => {
    // Emit to global event for processor
    connectionManager.emit('data', data);
  });

  return wsSource;
}

module.exports = {
  WebSocketSource,
  createWebSocketSource
};

