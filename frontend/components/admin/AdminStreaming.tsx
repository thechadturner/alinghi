import { onMount, onCleanup, createSignal, Show, For } from "solid-js";
import { FiRefreshCw, FiTrash2, FiDatabase, FiActivity, FiWifi, FiCheckCircle, FiXCircle, FiToggleLeft, FiToggleRight } from "solid-icons/fi";
import { getData, postData } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import { logPageLoad } from "../../utils/logging";
import { error as logError, log } from "../../utils/console";

interface RedisSource {
  source_name: string;
  [key: string]: any;
}

interface RedisStatus {
  connected: boolean;
  sources: RedisSource[];
}

// Function to fetch Redis status
async function fetchRedisStatus(): Promise<RedisStatus> {
  const controller = new AbortController();
  
  try {
    const response = await getData(apiEndpoints.stream.redisStatus, controller.signal);
    
    if (response.success) {
      return response.data;
    }
    
    return { connected: false, sources: [] };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return { connected: false, sources: [] };
    }
    logError('Error fetching Redis status:', error);
    return { connected: false, sources: [] };
  }
}

// Function to flush Redis database
async function flushRedisDatabase(): Promise<boolean> {
  try {
    const response = await postData(apiEndpoints.stream.redisFlush, {});
    
    if (response.success) {
      return true;
    }
    
    return false;
  } catch (error: any) {
    logError('Error flushing Redis database:', error);
    return false;
  }
}

// Function to fetch monitoring status
async function fetchMonitoringStatus(): Promise<any> {
  const controller = new AbortController();
  
  try {
    const response = await getData(apiEndpoints.stream.monitoringStatus, controller.signal);
    
    if (response.success) {
      return response.data;
    }
    
    return null;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return null;
    }
    logError('Error fetching monitoring status:', error);
    return null;
  }
}

// Function to set InfluxDB streaming enabled/disabled
async function setInfluxDBStreaming(enabled) {
  try {
    const response = await postData(apiEndpoints.stream.influxdbEnable, { enabled });
    
    if (response.success) {
      return { success: true };
    }
    
    // Return error details for better debugging
    const errorMessage = response.message || response.error || 'Unknown error';
    logError('Failed to set InfluxDB streaming:', {
      enabled,
      response,
      errorMessage
    });
    return { success: false, error: errorMessage };
  } catch (error: any) {
    const errorMessage = error?.message || 'Network error';
    logError('Error setting InfluxDB streaming:', error);
    return { success: false, error: errorMessage };
  }
}

// Function to start streaming
async function startStreaming() {
  try {
    const response = await postData(apiEndpoints.stream.start, {});
    
    if (response.success) {
      return { success: true };
    }
    
    const errorMessage = response.message || response.error || 'Unknown error';
    logError('Failed to start streaming:', {
      response,
      errorMessage
    });
    return { success: false, error: errorMessage };
  } catch (error: any) {
    const errorMessage = error?.message || 'Network error';
    logError('Error starting streaming:', error);
    return { success: false, error: errorMessage };
  }
}

// Function to stop streaming
async function stopStreaming() {
  try {
    const response = await postData(apiEndpoints.stream.stop, {});
    
    if (response.success) {
      return { success: true };
    }
    
    const errorMessage = response.message || response.error || 'Unknown error';
    logError('Failed to stop streaming:', {
      response,
      errorMessage
    });
    return { success: false, error: errorMessage };
  } catch (error: any) {
    const errorMessage = error?.message || 'Network error';
    logError('Error stopping streaming:', error);
    return { success: false, error: errorMessage };
  }
}

// Helper function to format websocket frequency display
function formatWebSocketFrequency(intervalMs) {
  if (!intervalMs || intervalMs <= 0) return null;
  
  const frequencyHz = 1000 / intervalMs;
  const formatInterval = (ms) => {
    if (ms >= 1000) {
      return `${(ms / 1000).toFixed(0)}s`;
    } else {
      return `${ms}ms`;
    }
  };
  const formatFrequency = (hz) => {
    if (hz >= 1) {
      return `${hz.toFixed(0)}Hz`;
    } else {
      return `${hz.toFixed(2)}Hz`;
    }
  };
  
  return `${formatFrequency(frequencyHz)} / ${formatInterval(intervalMs)}`;
}

export default function AdminStreaming() {
  const [status, setStatus] = createSignal({ connected: false, sources: [] });
  const [monitoring, setMonitoring] = createSignal(null);
  const [loading, setLoading] = createSignal(true);
  const [flushing, setFlushing] = createSignal(false);
  const [togglingInflux, setTogglingInflux] = createSignal(false);
  const [startingStreaming, setStartingStreaming] = createSignal(false);
  const [stoppingStreaming, setStoppingStreaming] = createSignal(false);
  const [lastRefresh, setLastRefresh] = createSignal(new Date());

  // Auto-refresh timer (5 seconds fixed interval)
  let refreshTimer = null;

  const refreshStatus = async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    const [redisData, monitoringData] = await Promise.all([
      fetchRedisStatus(),
      fetchMonitoringStatus()
    ]);
    setStatus(redisData);
    setMonitoring(monitoringData);
    setLastRefresh(new Date());
    if (!silent) {
      setLoading(false);
    }
  };

  // Setup auto-refresh (5 seconds fixed)
  const setupAutoRefresh = () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
    refreshTimer = setInterval(() => {
      refreshStatus(true); // Silent refresh - don't show loading state
    }, 5000); // 5 seconds
  };

  const handleToggleInfluxDB = async () => {
    if (!monitoring()) return;
    
    const currentEnabled = monitoring().influxdb.enabled;
    const newEnabled = !currentEnabled;
    const currentlyStarted = monitoring().streamingStarted;
    
    // If disabling and streaming is active, ask for confirmation
    if (!newEnabled && currentlyStarted) {
      if (!confirm('Are you sure you want to disable InfluxDB streaming? This will stop streaming and disconnect all active data sources.')) {
        return;
      }
    }
    
    setTogglingInflux(true);
    setStartingStreaming(newEnabled && !currentlyStarted);
    setStoppingStreaming(!newEnabled && currentlyStarted);
    
    try {
      // First, enable/disable InfluxDB streaming
      const enableResult = await setInfluxDBStreaming(newEnabled);
      
      if (!enableResult.success) {
        const errorMsg = enableResult.error || 'Unknown error';
        logError('Failed to toggle InfluxDB streaming:', errorMsg);
        alert(`Failed to toggle InfluxDB streaming: ${errorMsg}\n\nPlease check the server logs for more details.`);
        setTogglingInflux(false);
        setStartingStreaming(false);
        setStoppingStreaming(false);
        return;
      }
      
      // If enabling and streaming not started, start streaming
      if (newEnabled && !currentlyStarted) {
        const startResult = await startStreaming();
        if (!startResult.success) {
          const errorMsg = startResult.error || 'Unknown error';
          logError('Failed to start streaming:', errorMsg);
          alert(`Failed to start streaming: ${errorMsg}\n\nPlease check the server logs for more details.`);
          setTogglingInflux(false);
          setStartingStreaming(false);
          setStoppingStreaming(false);
          return;
        }
        log('InfluxDB streaming enabled and streaming started');
      }
      
      // If disabling and streaming is started, stop streaming
      if (!newEnabled && currentlyStarted) {
        const stopResult = await stopStreaming();
        if (!stopResult.success) {
          const errorMsg = stopResult.error || 'Unknown error';
          logError('Failed to stop streaming:', errorMsg);
          alert(`Failed to stop streaming: ${errorMsg}\n\nPlease check the server logs for more details.`);
          setTogglingInflux(false);
          setStartingStreaming(false);
          setStoppingStreaming(false);
          return;
        }
        log('InfluxDB streaming disabled and streaming stopped');
      }
      
      // Refresh status after toggle
      await refreshStatus();
    } catch (error: any) {
      const errorMsg = error?.message || 'Unexpected error';
      logError('Error toggling InfluxDB streaming:', error);
      alert(`Error toggling InfluxDB streaming: ${errorMsg}\n\nPlease check the server logs for more details.`);
    } finally {
      setTogglingInflux(false);
      setStartingStreaming(false);
      setStoppingStreaming(false);
    }
  };


  const handleFlush = async () => {
    if (!confirm('Are you sure you want to flush the Redis database? This will delete ALL streaming data and cannot be undone.')) {
      return;
    }

    setFlushing(true);
    const success = await flushRedisDatabase();
    setFlushing(false);

    if (success) {
      log('Redis database flushed successfully');
      // Refresh status after flush
      await refreshStatus();
    } else {
      logError('Failed to flush Redis database');
      alert('Failed to flush Redis database. Please check the server logs.');
    }
  };

  onMount(async () => {
    await logPageLoad('AdminStreaming.jsx', 'Admin Streaming Page');
    await refreshStatus();
    setupAutoRefresh(); // Start auto-refresh every 5 seconds
  });

  onCleanup(() => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
  });

  const getStatusBadge = (source) => {
    const badges = [];
    
    if (source.has_active_data_inserts) {
      badges.push(
        <button class="px-2 py-1 rounded-full text-xs font-semibold bg-green-500 dark:bg-green-600 text-white hover:opacity-80 transition-opacity flex items-center gap-1 cursor-default">
          <FiActivity size={12} />
          Active Data
        </button>
      );
    } else if (source.time_since_latest_data_minutes) {
      // Show time since last data if available
      const minutesAgo = parseFloat(source.time_since_latest_data_minutes);
      if (minutesAgo < 10) {
        badges.push(
          <button class="px-2 py-1 rounded-full text-xs font-semibold bg-orange-500 dark:bg-orange-600 text-white hover:opacity-80 transition-opacity cursor-default">
            {minutesAgo.toFixed(1)}m ago
          </button>
        );
      } else {
        badges.push(
          <button class="px-2 py-1 rounded-full text-xs font-semibold bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300 hover:opacity-80 transition-opacity cursor-default">
            {minutesAgo.toFixed(1)}m ago
          </button>
        );
      }
    }
    
    if (source.has_websocket_connections) {
      badges.push(
        <button class="px-2 py-1 rounded-full text-xs font-semibold bg-blue-500 dark:bg-blue-600 text-white hover:opacity-80 transition-opacity flex items-center gap-1 cursor-default">
          <FiWifi size={12} />
          {source.websocket_client_count} WS Client{source.websocket_client_count !== 1 ? 's' : ''}
        </button>
      );
    }
    
    if (badges.length === 0) {
      badges.push(
        <button class="px-2 py-1 rounded-full text-xs font-semibold bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300 hover:opacity-80 transition-opacity cursor-default">
          Inactive
        </button>
      );
    }
    
    return badges;
  };

  return (
    <div class="admin-streaming">
      {/* Page Title */}
      <div class="admin-page-header">
        <h1>Streaming Status</h1>
        <p>Monitor Redis database status and active streaming sources</p>
      </div>

      {/* Controls */}
      <div class="filter-controls mt-2" style={{ "background-color": "var(--color-bg-secondary)", "transition": "background-color 0.3s ease", "width": "98%" }}>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-4">
            <div class="flex items-center gap-2">
              <FiDatabase size={20} class={status().connected ? "text-green-500 dark:text-green-400" : "text-red-500 dark:text-red-400"} />
              <span class={`font-semibold ${status().connected ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                Redis: {status().connected ? "Connected" : "Disconnected"}
              </span>
            </div>
            <div class="text-sm text-gray-600 dark:text-gray-400">
              Last refreshed: {lastRefresh().toLocaleTimeString()}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="px-4 py-2 bg-blue-500 dark:bg-blue-600 text-white rounded hover:bg-blue-600 dark:hover:bg-blue-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={() => refreshStatus()}
              disabled={loading()}
            >
              <FiRefreshCw size={16} class={loading() ? "animate-spin" : ""} />
              Refresh
            </button>
            <button
              class="px-4 py-2 bg-red-500 dark:bg-red-600 text-white rounded hover:bg-red-600 dark:hover:bg-red-700 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              onClick={handleFlush}
              disabled={flushing() || !status().connected}
            >
              <FiTrash2 size={16} />
              {flushing() ? 'Flushing...' : 'Clear Database'}
            </button>
          </div>
        </div>
      </div>

      {/* Monitoring Status */}
      <div 
        class="mt-4 p-4 rounded-lg streaming-monitoring-section" 
        style={{
          "width": "98%", 
          "margin-left": "15px",
          "background-color": "var(--color-bg-secondary)",
          "transition": "background-color 0.3s ease"
        }}
      >
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-semibold" style={{ "color": "var(--color-text-secondary)" }}>Streaming Monitoring</h3>
        </div>
        <Show when={monitoring()} fallback={
          <div class="text-center py-8" style={{ "color": "var(--color-text-tertiary)" }}>
            Loading monitoring data...
          </div>
        }>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {/* InfluxDB Status */}
            <div 
              class="p-3 rounded border"
              style={{
                "background-color": "var(--color-bg-card)",
                "border-color": "var(--color-border-primary)",
                "transition": "background-color 0.3s ease, border-color 0.3s ease"
              }}
            >
              <div class="flex items-center justify-between mb-2">
                <div class="text-sm font-medium" style={{ "color": "var(--color-text-secondary)" }}>InfluxDB Streaming</div>
                <button
                  onClick={handleToggleInfluxDB}
                  disabled={togglingInflux() || startingStreaming() || stoppingStreaming()}
                  class="disabled:opacity-50 disabled:cursor-not-allowed"
                  title={
                    togglingInflux() || startingStreaming() || stoppingStreaming()
                      ? (startingStreaming() ? 'Starting...' : stoppingStreaming() ? 'Stopping...' : 'Processing...')
                      : (monitoring()?.influxdb?.enabled && monitoring()?.streamingStarted
                          ? 'Click to disable and stop streaming'
                          : 'Click to enable and start streaming')
                  }
                >
                  <Show when={monitoring()?.influxdb?.enabled && monitoring()?.streamingStarted} fallback={
                    <FiToggleLeft size={24} class={togglingInflux() || startingStreaming() || stoppingStreaming() ? "text-gray-300" : "text-gray-400"} />
                  }>
                    <FiToggleRight size={24} class={togglingInflux() || startingStreaming() || stoppingStreaming() ? "text-gray-300 animate-pulse" : "text-green-500 dark:text-green-400"} />
                  </Show>
                </button>
              </div>
              <div class="flex items-center gap-2">
                <Show when={monitoring()?.influxdb?.streaming} fallback={
                  <Show when={!monitoring()?.streamingStarted} fallback={<FiXCircle size={16} class="text-red-500 dark:text-red-400" />}>
                    <FiXCircle size={16} class="text-orange-500 dark:text-orange-400" />
                  </Show>
                }>
                  <FiCheckCircle size={16} class="text-green-500 dark:text-green-400" />
                </Show>
                <span class={`text-sm ${
                  monitoring()?.influxdb?.streaming 
                    ? 'text-green-600 dark:text-green-400' 
                    : !monitoring()?.streamingStarted 
                      ? 'text-orange-500 dark:text-orange-400' 
                      : 'text-red-600 dark:text-red-400'
                }`}>
                  {monitoring()?.influxdb?.streaming 
                    ? 'Active' 
                    : !monitoring()?.streamingStarted 
                      ? 'Hibernating' 
                      : 'Inactive'}
                </span>
              </div>
              <div class="text-xs mt-1" style={{ "color": "var(--color-text-tertiary)" }}>
                {monitoring()?.streamingStarted && monitoring()?.influxdb?.active_connections !== undefined && (
                  <>{monitoring()?.influxdb?.active_connections || 0} connection{monitoring()?.influxdb?.active_connections !== 1 ? 's' : ''}</>
                )}
              </div>
              <Show when={monitoring()?.influxdb?.query_stats}>
                <div 
                  class="text-xs mt-1 border-t pt-1"
                  style={{
                    "color": "var(--color-text-tertiary)",
                    "border-color": "var(--color-border-primary)"
                  }}
                >
                  <div>Queries: {monitoring()?.influxdb?.query_stats?.successful_queries || 0} success, {monitoring()?.influxdb?.query_stats?.failed_queries || 0} failed</div>
                  {monitoring()?.influxdb?.query_stats?.last_query_error && (
                    <div class="text-red-500 dark:text-red-400 mt-1 truncate" title={monitoring()?.influxdb?.query_stats?.last_query_error}>
                      Error: {monitoring()?.influxdb?.query_stats?.last_query_error}
                    </div>
                  )}
                </div>
              </Show>
            </div>

            {/* Data Processing Status */}
            <div 
              class="p-3 rounded border"
              style={{
                "background-color": "var(--color-bg-card)",
                "border-color": "var(--color-border-primary)",
                "transition": "background-color 0.3s ease, border-color 0.3s ease"
              }}
            >
              <div class="text-sm font-medium mb-2" style={{ "color": "var(--color-text-secondary)" }}>Data Processing</div>
              <div class="flex items-center gap-2">
                <Show when={!monitoring()?.data_processing?.active} fallback={
                  <Show when={monitoring()?.data_processing?.healthy} fallback={<FiXCircle size={16} class="text-red-500 dark:text-red-400" />}>
                    <FiCheckCircle size={16} class="text-green-500 dark:text-green-400" />
                  </Show>
                }>
                  <FiXCircle size={16} class="text-gray-400" />
                </Show>
                <span 
                  class="text-sm"
                  style={{
                    "color": !monitoring()?.data_processing?.active 
                      ? "var(--color-text-secondary)" 
                      : monitoring()?.data_processing?.healthy 
                        ? "var(--color-text-primary)" 
                        : "#dc2626"
                  }}
                >
                  {!monitoring()?.data_processing?.active ? 'Inactive' : (monitoring()?.data_processing?.healthy ? 'Healthy' : 'Errors')}
                </span>
              </div>
              <div class="text-xs mt-1" style={{ "color": "var(--color-text-tertiary)" }}>
                {monitoring()?.data_processing?.active ? (
                  <>
                    {monitoring()?.data_processing?.success_rate || '100%'} success
                    {monitoring()?.data_processing?.error_count > 0 && (
                      <span class="text-red-500 dark:text-red-400 ml-1">
                        ({monitoring()?.data_processing?.error_count} errors)
                      </span>
                    )}
                    {monitoring()?.data_processing?.avg_trip_time_ms && (
                      <div class="mt-1">
                        <span>Avg trip time: {monitoring()?.data_processing?.avg_trip_time_ms}ms</span>
                      </div>
                    )}
                  </>
                ) : (
                  'No data processed yet'
                )}
              </div>
            </div>

            {/* Redis Status */}
            <div 
              class="p-3 rounded border"
              style={{
                "background-color": "var(--color-bg-card)",
                "border-color": "var(--color-border-primary)",
                "transition": "background-color 0.3s ease, border-color 0.3s ease"
              }}
            >
              <div class="text-sm font-medium mb-2" style={{ "color": "var(--color-text-secondary)" }}>Redis Inserts</div>
              <div class="flex items-center gap-2">
                <Show when={!monitoring()?.redis?.active} fallback={
                  <Show when={monitoring()?.redis?.healthy} fallback={<FiXCircle size={16} class="text-red-500 dark:text-red-400" />}>
                    <FiCheckCircle size={16} class="text-green-500 dark:text-green-400" />
                  </Show>
                }>
                  <FiXCircle size={16} class="text-gray-400" />
                </Show>
                <span 
                  class="text-sm"
                  style={{
                    "color": !monitoring()?.redis?.active 
                      ? "var(--color-text-secondary)" 
                      : monitoring()?.redis?.healthy 
                        ? "var(--color-text-primary)" 
                        : "#dc2626"
                  }}
                >
                  {!monitoring()?.redis?.active ? 'Inactive' : (monitoring()?.redis?.healthy ? 'Healthy' : 'Errors')}
                </span>
              </div>
              <div class="text-xs mt-1" style={{ "color": "var(--color-text-tertiary)" }}>
                {monitoring()?.redis?.active ? (
                  <>
                    {monitoring()?.redis?.success_rate || '100%'} success
                    {monitoring()?.redis?.error_count > 0 && (
                      <span class="text-red-500 dark:text-red-400 ml-1">
                        ({monitoring()?.redis?.error_count} errors)
                      </span>
                    )}
                  </>
                ) : (
                  'No inserts attempted yet'
                )}
              </div>
            </div>

            {/* WebSocket Status */}
            <div 
              class="p-3 rounded border"
              style={{
                "background-color": "var(--color-bg-card)",
                "border-color": "var(--color-border-primary)",
                "transition": "background-color 0.3s ease, border-color 0.3s ease"
              }}
            >
              <div class="text-sm font-medium mb-2" style={{ "color": "var(--color-text-secondary)" }}>WebSocket</div>
              <div class="flex items-center gap-2">
                <FiWifi size={16} class={monitoring()?.websocket?.active_connections > 0 ? "text-green-500" : "text-gray-400"} />
                <span class="text-sm" style={{ "color": "var(--color-text-primary)" }}>
                  {monitoring()?.websocket?.active_connections || 0} active
                </span>
              </div>
              <div class="text-xs mt-1" style={{ "color": "var(--color-text-tertiary)" }}>
                {monitoring()?.websocket?.attempt_count || 0} attempts
                {monitoring()?.websocket?.error_count > 0 && (
                  <span class="text-red-500 dark:text-red-400 ml-1">
                    ({monitoring()?.websocket?.error_count} errors)
                  </span>
                )}
              </div>
              {monitoring()?.websocket?.broadcast_interval_ms && (
                <div class="text-xs mt-1 font-medium" style={{ "color": "var(--color-text-tertiary)" }}>
                  {formatWebSocketFrequency(monitoring().websocket.broadcast_interval_ms)}
                </div>
              )}
            </div>

            {/* Real-Time Sync Status */}
            <div 
              class="p-3 rounded border"
              style={{
                "background-color": "var(--color-bg-card)",
                "border-color": "var(--color-border-primary)",
                "transition": "background-color 0.3s ease, border-color 0.3s ease"
              }}
            >
              <div class="text-sm font-medium mb-2" style={{ "color": "var(--color-text-secondary)" }}>Real-Time Sync</div>
              <div class="flex items-center gap-2">
                <Show when={monitoring()?.realtime_sync?.in_sync} fallback={<FiXCircle size={16} class="text-orange-500 dark:text-orange-400" />}>
                  <FiCheckCircle size={16} class="text-green-500 dark:text-green-400" />
                </Show>
                <span 
                  class="text-sm"
                  style={{
                    "color": monitoring()?.realtime_sync?.sync_status === 'in_sync' 
                      ? "#16a34a" 
                      : monitoring()?.realtime_sync?.sync_status === 'slightly_delayed' 
                        ? "#ea580c" 
                        : monitoring()?.realtime_sync?.sync_status === 'delayed' 
                          ? "#dc2626" 
                          : "var(--color-text-secondary)"
                  }}
                >
                  {monitoring()?.realtime_sync?.sync_status === 'in_sync' ? 'In Sync' :
                   monitoring()?.realtime_sync?.sync_status === 'slightly_delayed' ? 'Slightly Delayed' :
                   monitoring()?.realtime_sync?.sync_status === 'delayed' ? 'Delayed' : 'No Data'}
                </span>
              </div>
              <div class="text-xs mt-1" style={{ "color": "var(--color-text-tertiary)" }}>
                {monitoring()?.realtime_sync?.time_since_last_data_seconds !== null ? (
                  <div>Last data: {monitoring()?.realtime_sync?.time_since_last_data_seconds}s ago</div>
                ) : monitoring()?.realtime_sync?.time_since_last_query_seconds !== null ? (
                  <div>Last query: {monitoring()?.realtime_sync?.time_since_last_query_seconds}s ago</div>
                ) : null}
                {monitoring()?.realtime_sync?.avg_trip_time_ms && (
                  <div>Avg trip: {monitoring()?.realtime_sync?.avg_trip_time_ms}ms</div>
                )}
              </div>
            </div>
          </div>
        </Show>
      </div>

      {/* Sources Table */}
      <div class="admin-table-container mt-4">
        <div class="admin-table">
          <Show when={!loading()} fallback={
            <div class="flex justify-center items-center h-64">
              <div class="text-gray-500 dark:text-gray-400">Loading Redis status...</div>
            </div>
          }>
            <div class="overflow-auto h-full">
              <Show when={status().sources.length > 0} fallback={
                <div class="flex justify-center items-center h-64">
                  <div class="text-gray-500 dark:text-gray-400">No sources found in Redis database</div>
                </div>
              }>
                <table class="w-full border-collapse border border-gray-200 text-left">
                  <thead class="bg-gray-200 sticky top-0 z-20">
                    <tr>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Source Name</th>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Hours of Data</th>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Status</th>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Earliest Timestamp</th>
                      <th class="border border-gray-300 px-4 py-2 font-semibold">Latest Timestamp</th>
                    </tr>
                  </thead>
                  <tbody class="bg-white" style={{ "background-color": "var(--color-bg-card)" }}>
                    <For each={status().sources}>
                      {(source) => (
                        <tr class="border border-gray-200 hover:bg-gray-50" style={{ "background-color": "var(--color-bg-card)" }}>
                          <td class="px-4 py-2 text-sm text-gray-600">{source.source_name}</td>
                          <td class="px-4 py-2 text-sm text-gray-600">
                            {parseFloat(source.hours_of_data).toFixed(2)} hours
                          </td>
                          <td class="px-4 py-2 text-center">
                            <div class="flex flex-wrap gap-2 justify-center">
                              {getStatusBadge(source)}
                            </div>
                          </td>
                          <td class="px-4 py-2 text-sm text-gray-600">
                            {new Date(source.earliest_timestamp).toLocaleString()}
                          </td>
                          <td class="px-4 py-2 text-sm text-gray-600">
                            {new Date(source.latest_timestamp).toLocaleString()}
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      {/* Summary Stats */}
      <Show when={!loading() && status().sources.length > 0}>
        <div 
          class="mt-4 p-4 rounded-lg streaming-monitoring-section" 
          style={{
            "width": "98%", 
            "margin-left": "15px",
            "background-color": "var(--color-bg-secondary)",
            "transition": "background-color 0.3s ease"
          }}
        >
          <h3 class="font-semibold mb-2" style={{ "color": "var(--color-text-secondary)" }}>Summary</h3>
          <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div 
              class="p-3 rounded border"
              style={{
                "background-color": "var(--color-bg-card)",
                "border-color": "var(--color-border-primary)",
                "transition": "background-color 0.3s ease, border-color 0.3s ease"
              }}
            >
              <div class="text-sm" style={{ "color": "var(--color-text-secondary)" }}>Total Sources</div>
              <div class="text-2xl font-bold" style={{ "color": "var(--color-text-primary)" }}>{status().sources.length}</div>
            </div>
            <div 
              class="p-3 rounded border"
              style={{
                "background-color": "var(--color-bg-card)",
                "border-color": "var(--color-border-primary)",
                "transition": "background-color 0.3s ease, border-color 0.3s ease"
              }}
            >
              <div class="text-sm" style={{ "color": "var(--color-text-secondary)" }}>Active Data Sources</div>
              <div class="text-2xl font-bold text-green-600">
                {status().sources.filter(s => s.has_active_data_inserts).length}
              </div>
            </div>
            <div 
              class="p-3 rounded border"
              style={{
                "background-color": "var(--color-bg-card)",
                "border-color": "var(--color-border-primary)",
                "transition": "background-color 0.3s ease, border-color 0.3s ease"
              }}
            >
              <div class="text-sm" style={{ "color": "var(--color-text-secondary)" }}>WebSocket Connections</div>
              <div class="text-2xl font-bold text-blue-600">
                {status().sources.reduce((sum, s) => sum + (s.websocket_client_count || 0), 0)}
              </div>
            </div>
            <div 
              class="p-3 rounded border"
              style={{
                "background-color": "var(--color-bg-card)",
                "border-color": "var(--color-border-primary)",
                "transition": "background-color 0.3s ease, border-color 0.3s ease"
              }}
            >
              <div class="text-sm" style={{ "color": "var(--color-text-secondary)" }}>Total Hours of Data</div>
              <div class="text-2xl font-bold" style={{ "color": "var(--color-text-primary)" }}>
                {status().sources.reduce((sum, s) => sum + parseFloat(s.hours_of_data || 0), 0).toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

