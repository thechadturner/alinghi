const { log, error, warn, debug } = require('../../shared');
const EventEmitter = require('events');

/**
 * Connection Manager
 * Manages up to 20 concurrent external data source connections
 * Tracks connections by source_id with state management and reconnection logic
 */

const MAX_CONNECTIONS = 20;

class ConnectionManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map(); // source_id -> connection info
    this.reconnectTimers = new Map(); // source_id -> reconnect timer
    this.reconnectAttempts = new Map(); // source_id -> attempt count
    this.maxReconnectAttempts = 10;
    this.baseReconnectDelay = 1000; // 1 second
    this.maxReconnectDelay = 60000; // 60 seconds
  }

  /**
   * Add a new connection
   * @param {Object} config - Connection configuration
   * @param {number} config.source_id - Unique source identifier
   * @param {string} config.type - Connection type ('websocket' or 'influxdb')
   * @param {Object} config.config - Type-specific configuration
   * @returns {boolean} - Success status
   */
  addConnection(config) {
    const { source_id, type, config: connectionConfig } = config;

    if (!source_id || !type) {
      error('[ConnectionManager] Missing required fields: source_id or type');
      return false;
    }

    if (this.connections.size >= MAX_CONNECTIONS) {
      error(`[ConnectionManager] Maximum connections (${MAX_CONNECTIONS}) reached`);
      return false;
    }

    if (this.connections.has(source_id)) {
      warn(`[ConnectionManager] Connection for source_id ${source_id} already exists`);
      return false;
    }

    const connectionInfo = {
      source_id,
      type,
      config: connectionConfig,
      state: 'disconnected',
      connectedAt: null,
      lastError: null,
      reconnectAttempts: 0
    };

    this.connections.set(source_id, connectionInfo);
    this.reconnectAttempts.set(source_id, 0);
    
    log(`[ConnectionManager] Added connection for source_id ${source_id}, type: ${type}`);
    
    this.emit('connection_added', { source_id, type });
    
    return true;
  }

  /**
   * Remove a connection
   * @param {number} source_id - Source identifier
   * @returns {boolean} - Success status
   */
  removeConnection(source_id) {
    if (!this.connections.has(source_id)) {
      warn(`[ConnectionManager] Connection for source_id ${source_id} not found`);
      return false;
    }

    // Clear reconnect timer
    const timer = this.reconnectTimers.get(source_id);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(source_id);
    }

    // Get connection info before removing
    const connectionInfo = this.connections.get(source_id);
    
    // Remove connection
    this.connections.delete(source_id);
    this.reconnectAttempts.delete(source_id);
    
    log(`[ConnectionManager] Removed connection for source_id ${source_id}`);
    
    this.emit('connection_removed', { source_id, type: connectionInfo.type });
    
    return true;
  }

  /**
   * Update connection state
   * @param {number} source_id - Source identifier
   * @param {string} state - New state ('connecting', 'connected', 'disconnected', 'error')
   * @param {Error} error - Optional error object
   */
  updateState(source_id, state, err = null) {
    if (!this.connections.has(source_id)) {
      warn(`[ConnectionManager] Cannot update state for unknown source_id ${source_id}`);
      return;
    }

    const connectionInfo = this.connections.get(source_id);
    const oldState = connectionInfo.state;
    connectionInfo.state = state;
    
    if (state === 'connected') {
      connectionInfo.connectedAt = new Date();
      connectionInfo.lastError = null;
      this.reconnectAttempts.set(source_id, 0);
      
      // Clear any reconnect timer
      const timer = this.reconnectTimers.get(source_id);
      if (timer) {
        clearTimeout(timer);
        this.reconnectTimers.delete(source_id);
      }
    } else if (state === 'error' || state === 'disconnected') {
      connectionInfo.lastError = err ? err.message : null;
    }

    log(`[ConnectionManager] Source ${source_id} state: ${oldState} -> ${state}`);
    
    this.emit('state_changed', { source_id, oldState, newState: state, error: err });
  }

  /**
   * Schedule reconnection attempt
   * @param {number} source_id - Source identifier
   * @param {Function} reconnectFn - Function to call for reconnection
   */
  scheduleReconnect(source_id, reconnectFn) {
    if (!this.connections.has(source_id)) {
      return;
    }

    const attempts = this.reconnectAttempts.get(source_id) || 0;
    
    if (attempts >= this.maxReconnectAttempts) {
      error(`[ConnectionManager] Max reconnection attempts reached for source_id ${source_id}`);
      this.updateState(source_id, 'error', new Error('Max reconnection attempts exceeded'));
      return;
    }

    // Exponential backoff: baseDelay * 2^attempts, capped at maxReconnectDelay
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, attempts),
      this.maxReconnectDelay
    );

    this.reconnectAttempts.set(source_id, attempts + 1);
    
    log(`[ConnectionManager] Scheduling reconnect for source_id ${source_id} in ${delay}ms (attempt ${attempts + 1})`);

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(source_id);
      reconnectFn();
    }, delay);

    this.reconnectTimers.set(source_id, timer);
  }

  /**
   * Get connection info
   * @param {number} source_id - Source identifier
   * @returns {Object|null} - Connection info or null
   */
  getConnection(source_id) {
    return this.connections.get(source_id) || null;
  }

  /**
   * Get all connections
   * @returns {Array} - Array of connection info objects
   */
  getAllConnections() {
    return Array.from(this.connections.values());
  }

  /**
   * Get connections by state
   * @param {string} state - State to filter by
   * @returns {Array} - Array of connection info objects
   */
  getConnectionsByState(state) {
    return Array.from(this.connections.values()).filter(conn => conn.state === state);
  }

  /**
   * Check if source_id exists
   * @param {number} source_id - Source identifier
   * @returns {boolean} - True if connection exists
   */
  hasConnection(source_id) {
    return this.connections.has(source_id);
  }

  /**
   * Get connection count
   * @returns {number} - Number of active connections
   */
  getConnectionCount() {
    return this.connections.size;
  }

  /**
   * Cleanup all connections
   */
  cleanup() {
    log('[ConnectionManager] Cleaning up all connections');
    
    // Clear all reconnect timers
    for (const [source_id, timer] of this.reconnectTimers.entries()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    
    // Emit disconnect events for all connections
    for (const [source_id, connectionInfo] of this.connections.entries()) {
      this.emit('connection_removed', { source_id, type: connectionInfo.type });
    }
    
    this.connections.clear();
    this.reconnectAttempts.clear();
  }
}

// Singleton instance
const connectionManager = new ConnectionManager();

module.exports = connectionManager;

