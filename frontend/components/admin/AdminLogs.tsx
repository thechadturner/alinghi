import { onMount, createSignal, Show, For, createMemo } from "solid-js";
import { getData, deleteData } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import { LOG_LEVELS, logPageLoad } from "../../utils/logging";
import { error as logError, info as logInfo } from "../../utils/console";
import PaginationControls from "../utilities/PaginationControls";

interface Log {
  type?: string;
  message_type?: string;
  datetime?: string;
  [key: string]: any;
}

interface PaginationData {
  data: Log[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalRecords: number;
    limit: number;
  };
}

// Function to fetch recent activity (used as system logs for now)
async function fetchRecentActivity(page = 1, limit = 50, searchTerm = "", logType = "all", serverSource = "all"): Promise<PaginationData> {
  const controller = new AbortController();
  
  try {
    // Build query parameters
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString()
    });
    
    if (searchTerm) {
      params.append('search', searchTerm);
    }
    if (logType !== "all") {
      params.append('log_type', logType);
    }
    if (serverSource !== "all") {
      params.append('log_level', serverSource);
    }
    
    const url = `${apiEndpoints.app.admin.log_activity}?${params.toString()}`;
    const response = await getData(url, controller.signal);

    if (response.success) {
      return response.data;
    }

    return { data: [], pagination: { currentPage: 1, totalPages: 1, totalRecords: 0, limit: 50 } };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return { data: [], pagination: { currentPage: 1, totalPages: 1, totalRecords: 0, limit: 50 } };
    }
    logError('Error fetching recent activity:', error);
    return { data: [], pagination: { currentPage: 1, totalPages: 1, totalRecords: 0, limit: 50 } };
  }
}

export default function AdminLogs() {
  const [logs, setLogs] = createSignal<Log[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [searchTerm, setSearchTerm] = createSignal("");
  const [selectedLevel, setSelectedLevel] = createSignal("all");
  const [sortBy, setSortBy] = createSignal("datetime");
  const [sortOrder, setSortOrder] = createSignal("desc");
  const [copyStatus, setCopyStatus] = createSignal({});
  const [logType, setLogType] = createSignal("all");
  
  // Pagination state
  const [currentPage, setCurrentPage] = createSignal(1);
  const [totalPages, setTotalPages] = createSignal(1);
  const [totalRecords, setTotalRecords] = createSignal(0);
  const [limit, setLimit] = createSignal(100);
  
  // Clear logs state
  const [clearing, setClearing] = createSignal(false);

  // Function to copy row data as JSON to clipboard
  const copyRowAsJson = async (log, index) => {
    try {
      const jsonData = JSON.stringify(log, null, 2);
      
      // Check if modern Clipboard API is available
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(jsonData);
      } else {
        // Fallback to legacy method for non-secure contexts
        const textArea = document.createElement('textarea');
        textArea.value = jsonData;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        
        if (!successful) {
          throw new Error('Legacy copy command failed');
        }
      }
      
      // Show success status
      setCopyStatus(prev => ({ ...prev, [index]: 'copied' }));
      
      // Reset status after 2 seconds
      setTimeout(() => {
        setCopyStatus(prev => ({ ...prev, [index]: null }));
      }, 2000);
    } catch (error: any) {
      logError('Failed to copy to clipboard:', error);
      
      // Show error status
      setCopyStatus(prev => ({ ...prev, [index]: 'error' }));
      
      // Reset status after 2 seconds
      setTimeout(() => {
        setCopyStatus(prev => ({ ...prev, [index]: null }));
      }, 2000);
    }
  };

  // Enhanced color coding for log levels
  const getLogRowClass = (log) => {
    const type = log.type || log.message_type || log.level;
    switch (type) {
      case LOG_LEVELS.ERROR:
      case "error":
        return "bg-red-50 border-l-0 border-red-500";
      case LOG_LEVELS.WARN:
      case "warn":
      case "warning":
        return "bg-yellow-50 border-l-0 border-yellow-500";
      case LOG_LEVELS.INFO:
      case "info":
        return "bg-blue-50 border-l-0 border-blue-500";
      case LOG_LEVELS.DEBUG:
      case "debug":
        return "bg-gray-50 border-l-0 border-gray-500";
      case "success":
        return "bg-green-50 border-l-0 border-green-500";
      default:
        return "bg-gray-50 border-l-0 border-gray-300";
    }
  };

  const getLogLevelBadge = (log) => {
    const type = log.log_type || log.type || log.message_type || log.level;
    const baseClasses = "px-2 py-1 rounded-full text-xs font-semibold";
    switch (type?.toLowerCase()) {
      case LOG_LEVELS.ERROR:
      case "error":
        return `${baseClasses} bg-red-500 text-white`;
      case LOG_LEVELS.WARN:
      case "warn":
      case "warning":
        return `${baseClasses} bg-orange-500 text-white`;
      case LOG_LEVELS.INFO:
      case "info":
        return `${baseClasses} bg-blue-100 text-blue-800`;
      case LOG_LEVELS.DEBUG:
      case "debug":
        return `${baseClasses} bg-gray-100 text-gray-800`;
      case "success":
        return `${baseClasses} bg-green-100 text-green-800`;
      default:
        return `${baseClasses} bg-gray-100 text-gray-800`;
    }
  };

  // Since filtering is now done server-side, just return the logs directly
  const filteredLogs = createMemo(() => {
    return logs();
  });

  // Function to load data with pagination
  const loadData = async (page = 1) => {
    setLoading(true);
    try {
      const result = await fetchRecentActivity(page, 100, searchTerm(), selectedLevel(), logType());
      setLogs(result.data || []);
      setCurrentPage(Number(result.pagination?.currentPage) || 1);
      setTotalPages(Number(result.pagination?.totalPages) || 1);
      setTotalRecords(Number(result.pagination?.totalRecords) || 0);
      setLimit(Number(result.pagination?.limit) || 100);
    } catch (error: any) {
      logError('Error loading logs:', error);
    } finally {
      setLoading(false);
    }
  };

  // Handle page change
  const handlePageChange = (page) => {
    setCurrentPage(page);
    loadData(page);
  };

  // Handle search term change
  const handleSearchChange = (term) => {
    setSearchTerm(term);
    setCurrentPage(1); // Reset to first page when searching
    loadData(1);
  };

  // Handle log type filter change
  const handleLogTypeChange = (type) => {
    setSelectedLevel(type);
    setCurrentPage(1); // Reset to first page when filtering
    loadData(1);
  };

  // Handle server source filter change
  const handleServerSourceChange = (source) => {
    setLogType(source);
    setCurrentPage(1); // Reset to first page when filtering
    loadData(1);
  };

  // Handle clear logs
  const handleClearLogs = async () => {
    if (!confirm('Are you sure you want to clear all logs? This action cannot be undone.')) {
      return;
    }

    setClearing(true);
    try {
      const url = `/api/admin/logs`;
      const response = await deleteData(url, {});

      if (response.success) {
        logInfo('Logs cleared successfully');
        // Reload data to show empty table
        await loadData(1);
      } else {
        logError('Failed to clear logs:', response.error || response.message);
        alert('Failed to clear logs. Please try again.');
      }
    } catch (error: any) {
      logError('Error clearing logs:', error);
      alert('An error occurred while clearing logs. Please try again.');
    } finally {
      setClearing(false);
    }
  };

  onMount(async () => {
    await logPageLoad('AdminLogs.jsx', 'Admin Logs Page');
    await loadData();
  });

  return (
    <div class="admin-logs">
      {/* Page Title */}
      <div class="admin-page-header">
        <h1>System Logs</h1>
        <p>View system logs and recent activity</p>
      </div>

      {/* Enhanced Filter Controls */}
      <div class="filter-controls mt-2 rounded-lg" style={{ "background-color": "var(--color-bg-secondary)", "transition": "background-color 0.3s ease", "width": "98%" }}>
        <div class="grid grid-cols-1 md:grid-cols-5 gap-4">
          {/* Search */}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Search</label>
            <input
              type="text"
              placeholder="Search logs by message, file, location, server source..."
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={searchTerm()}
              onInput={(e) => handleSearchChange(e.target.value)}
            />
          </div>

          {/* Log Type Filter */}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Log Type</label>
            <select
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={selectedLevel()}
              onChange={(e) => handleLogTypeChange(e.target.value)}
            >
              <option value="all">All Types</option>
              <option value={LOG_LEVELS.ERROR}>Error</option>
              <option value={LOG_LEVELS.WARN}>Warning</option>
              <option value={LOG_LEVELS.INFO}>Info</option>
              <option value={LOG_LEVELS.DEBUG}>Debug</option>
            </select>
          </div>

          {/* Log Type Filter */}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Server Source</label>
            <select
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={logType()}
              onChange={(e) => handleServerSourceChange(e.target.value)}
            >
              <option value="all">All Sources</option>
              <option value="client">Client Application</option>
              <option value="server_app">Server App</option>
              <option value="server_admin">Server Admin</option>
              <option value="server_file">Server File</option>
              <option value="server_media">Server Media</option>
              <option value="server_stream">Server Streaming</option>
              <option value="shared">Shared</option>
              <option value="Script">Script</option>
            </select>
          </div>

          {/* Sort By */}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Sort By</label>
            <select
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={sortBy()}
              onChange={(e) => setSortBy(e.target.value)}
            >
              <option value="datetime">Date/Time</option>
              <option value="type">Log Level</option>
              <option value="email">User</option>
              <option value="message">Message</option>
              <option value="file_name">File</option>
            </select>
          </div>

          {/* Sort Order */}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Order</label>
            <select
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={sortOrder()}
              onChange={(e) => setSortOrder(e.target.value)}
            >
              <option value="desc">Newest First</option>
              <option value="asc">Oldest First</option>
            </select>
          </div>
        </div>

        {/* Results Count */}
        <div class="mt-3 text-sm text-gray-600">
          Showing {filteredLogs().length} of {logs().length} log entries
        </div>
      </div>

      {/* Logs Table */}
      <div class="admin-table-container">
        <div class="admin-table">
          <Show when={loading()} fallback={
            <div class="overflow-auto h-full">
              <table class="w-full border-collapse border border-gray-200 text-left">
                <thead class="bg-gray-200 sticky top-0 z-20">
                  <tr>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Timestamp</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Type</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Source</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">User</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">File</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Message</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Location</th>
                  </tr>
                </thead>
                <tbody class="bg-white">
                  <For each={filteredLogs()}>
                    {(log, index) => {
                      const logLevel = log.log_type;
                      const serverSource = log.log_level || 'client'; // Default to 'client' instead of 'unknown'
                      const copyState = copyStatus()[index()];
                      return (
                        <tr class={`${getLogRowClass(log)} border border-gray-200 hover:bg-gray-50`}>
                          <td class="px-4 py-2 text-sm text-gray-600">{log.datetime}</td>
                          <td class="px-4 py-2">
                            <button 
                              onClick={() => copyRowAsJson(log, index())}
                              class={`${getLogLevelBadge(log)} cursor-pointer hover:opacity-80 transition-opacity relative`}
                              title="Click to copy row data as JSON"
                            >
                              {logLevel?.toUpperCase() || 'UNKNOWN'}
                              {copyState === 'copied' && (
                                <span class="absolute -top-1 -right-1 text-green-600 text-xs">✓</span>
                              )}
                              {copyState === 'error' && (
                                <span class="absolute -top-1 -right-1 text-red-600 text-xs">✗</span>
                              )}
                            </button>
                          </td>
                          <td class="px-4 py-2 text-sm text-gray-600 font-mono text-xs">
                            <span class={`px-2 py-1 rounded text-xs font-semibold ${
                              serverSource === 'server_app' ? 'bg-blue-100 text-blue-800' :
                              serverSource === 'server_admin' ? 'bg-purple-100 text-purple-800' :
                              serverSource === 'server_file' ? 'bg-green-100 text-green-800' :
                              serverSource === 'server_media' ? 'bg-orange-100 text-orange-800' :
                              serverSource === 'server_stream' ? 'bg-teal-100 text-teal-800' :
                              serverSource === 'shared' ? 'bg-indigo-100 text-indigo-800' :
                              serverSource === 'Script' ? 'bg-yellow-100 text-yellow-800' :
                              'bg-gray-100 text-gray-800'
                            }`}>
                              {serverSource}
                            </span>
                          </td>
                          <td class="px-4 py-2 text-sm font-medium">{log.email || '-'}</td>
                          <td class="px-4 py-2 text-sm text-gray-600 font-mono text-xs">
                            {log.file_name || '-'}
                          </td>
                          <td class="px-4 py-2 text-sm max-w-xs truncate" title={log.message}>
                            {log.message}
                          </td>
                          <td class="px-4 py-2 text-sm text-gray-600">
                            {(() => {
                              try {
                                const context = typeof log.context === 'string' ? JSON.parse(log.context) : log.context;
                                return context?.lineNumber ? `Line ${context.lineNumber}` : (log.location || '-');
                              } catch {
                                return log.location || '-';
                              }
                            })()}
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          }>
            <div class="flex justify-center items-center h-64">
              <div class="text-gray-500">Loading logs...</div>
            </div>
          </Show>
        </div>
      </div>

      {/* Pagination Controls */}
      <PaginationControls
        currentPage={currentPage()}
        totalPages={totalPages()}
        totalRecords={totalRecords()}
        limit={limit()}
        onPageChange={handlePageChange}
      />

      {/* Clear Logs Button */}
      <div class="mt-4 flex justify-end">
        <button
          onClick={handleClearLogs}
          disabled={clearing()}
          class={`px-4 py-2 rounded-md font-medium transition-colors ${
            clearing()
              ? 'bg-gray-400 text-gray-200 cursor-not-allowed'
              : 'bg-red-600 text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2'
          }`}
        >
          {clearing() ? 'Clearing...' : 'Clear All Logs'}
        </button>
      </div>

    </div>
  );
}
