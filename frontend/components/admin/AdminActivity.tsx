import { onMount, createSignal, Show, For, createMemo, createEffect } from "solid-js";
import { getData } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import { LOG_LEVELS, logPageLoad } from "../../utils/logging";
import { error as logError } from "../../utils/console";
import PaginationControls from "../utilities/PaginationControls";

interface Activity {
  type?: string;
  message_type?: string;
  datetime?: string;
  [key: string]: any;
}

interface PaginationData {
  data: Activity[];
  pagination: {
    currentPage: number;
    totalPages: number;
    totalRecords: number;
    limit: number;
  };
}

// Function to fetch user activity
async function fetchUserActivity(page = 1, limit = 50): Promise<PaginationData> {
  const controller = new AbortController();
  
  try {
    const url = `${apiEndpoints.app.admin.user_activity}?page=${page}&limit=${limit}`;
    const response = await getData(url, controller.signal);

    if (response.success) {
      return response.data;
    }

    return { data: [], pagination: { currentPage: 1, totalPages: 1, totalRecords: 0, limit: 50 } };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return { data: [], pagination: { currentPage: 1, totalPages: 1, totalRecords: 0, limit: 50 } };
    }
    logError('Error fetching user activity:', error);
    return { data: [], pagination: { currentPage: 1, totalPages: 1, totalRecords: 0, limit: 50 } };
  }
}

export default function AdminActivity() {
  const [activities, setActivities] = createSignal<Activity[]>([]);
  const [allActivities, setAllActivities] = createSignal<Activity[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loadingAllForSearch, setLoadingAllForSearch] = createSignal(false);
  const [searchTerm, setSearchTerm] = createSignal("");
  const [sortBy, setSortBy] = createSignal("datetime");
  const [sortOrder, setSortOrder] = createSignal<"asc" | "desc">("desc");
  
  // Pagination state
  const [currentPage, setCurrentPage] = createSignal(1);
  const [totalPages, setTotalPages] = createSignal(1);
  const [totalRecords, setTotalRecords] = createSignal(0);
  const [limit, setLimit] = createSignal(100);

  // Enhanced color coding with better contrast
  const getRowClass = (activity: Activity): string => {
    const type = activity.type || activity.message_type;
    switch (type) {
      case LOG_LEVELS.ERROR:
        return "bg-red-50 border-l-0 border-red-500";
      case LOG_LEVELS.WARN:
        return "bg-yellow-50 border-l-0 border-yellow-500";
      case LOG_LEVELS.INFO:
        return "bg-blue-50 border-l-0 border-blue-500";
      case LOG_LEVELS.DEBUG:
        return "bg-gray-50 border-l-0 border-gray-500";
      case "success":
        return "bg-green-50 border-l-0 border-green-500";
      default:
        return "bg-gray-50 border-l-0 border-gray-300";
    }
  };

  const getTypeBadge = (activity) => {
    const type = activity.type || activity.message_type;
    const baseClasses = "px-2 py-1 rounded-full text-xs font-semibold";
    switch (type) {
      case LOG_LEVELS.ERROR:
        return `${baseClasses} bg-red-100 text-red-800`;
      case LOG_LEVELS.WARN:
        return `${baseClasses} bg-yellow-100 text-yellow-800`;
      case LOG_LEVELS.INFO:
        return `${baseClasses} bg-blue-100 text-blue-800`;
      case LOG_LEVELS.DEBUG:
        return `${baseClasses} bg-gray-100 text-gray-800`;
      case "success":
        return `${baseClasses} bg-green-100 text-green-800`;
      default:
        return `${baseClasses} bg-gray-100 text-gray-800`;
    }
  };

  // When search is active, use full dataset; otherwise use current page from server
  const dataSource = createMemo(() =>
    searchTerm().trim() ? allActivities() : activities()
  );

  // Filter and sort activities (filter then sort, so we can repaginate the filtered set)
  const filteredActivities = createMemo(() => {
    let filtered = [...dataSource()];

    // Filter by search term
    if (searchTerm().trim()) {
      const term = searchTerm().trim().toLowerCase();
      filtered = filtered.filter((activity) =>
        activity.message?.toLowerCase().includes(term) ||
        activity.email?.toLowerCase().includes(term) ||
        activity.location?.toLowerCase().includes(term) ||
        activity.context?.toLowerCase().includes(term)
      );
    }

    // Sort activities
    filtered.sort((a, b) => {
      const aValue = a[sortBy()];
      const bValue = b[sortBy()];
      if (sortOrder() === "asc") {
        return aValue > bValue ? 1 : -1;
      }
      return aValue < bValue ? 1 : -1;
    });

    return filtered;
  });

  // When search is active, paginate the filtered list so each page is full
  const isSearchMode = () => searchTerm().trim() !== "";
  const searchModeTotalPages = () =>
    Math.max(1, Math.ceil(filteredActivities().length / limit()));
  const paginatedDisplay = createMemo(() => {
    if (!isSearchMode()) return filteredActivities();
    const start = (currentPage() - 1) * limit();
    return filteredActivities().slice(start, start + limit());
  });

  // Function to load one page (server pagination, no search)
  const loadData = async (page = 1) => {
    setLoading(true);
    try {
      const result = await fetchUserActivity(page, 100);
      setActivities(result.data);
      setCurrentPage(result.pagination.currentPage);
      setTotalPages(result.pagination.totalPages);
      setTotalRecords(result.pagination.totalRecords);
      setLimit(result.pagination.limit);
    } catch (error: any) {
      logError('Error loading activities:', error);
    } finally {
      setLoading(false);
    }
  };

  // Load all pages so we can filter then repaginate when search is active
  const loadAllData = async () => {
    setLoadingAllForSearch(true);
    try {
      const first = await fetchUserActivity(1, limit());
      const totalP = first.pagination.totalPages;
      const merged = [...first.data];
      for (let p = 2; p <= totalP; p++) {
        const next = await fetchUserActivity(p, limit());
        merged.push(...next.data);
      }
      setAllActivities(merged);
      setCurrentPage(1);
    } catch (error: unknown) {
      logError('Error loading all activities for search:', error);
    } finally {
      setLoadingAllForSearch(false);
    }
  };

  // When user enters a search, load all data once so we can filter then repaginate
  createEffect(() => {
    const term = searchTerm().trim();
    if (term && allActivities().length === 0 && !loadingAllForSearch()) {
      loadAllData();
    }
    if (!term) {
      setAllActivities([]);
    }
  });

  // Keep current page in range when filtered result has fewer pages
  createEffect(() => {
    if (isSearchMode() && currentPage() > searchModeTotalPages()) {
      setCurrentPage(Math.max(1, searchModeTotalPages()));
    }
  });

  // Handle page change: in search mode just change page; otherwise fetch from server
  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    if (!isSearchMode()) {
      loadData(page);
    }
  };

  onMount(async () => {
    await logPageLoad('AdminActivity.jsx', 'Admin Activity Page');
    await loadData();
  });

  return (
    <div class="admin-activity">
      {/* Page Title */}
      <div class="admin-page-header">
        <h1>User Activity</h1>
        <p>Monitor user activities and system interactions</p>
      </div>

      {/* Enhanced Filter Controls */}
      <div class="filter-controls mt-2 bg-gray-50 rounded-lg" style="width: 98%;">
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Search */}
          <div class="lg:col-span-3">
            <label class="block text-sm font-medium text-gray-700 mb-1">Search</label>
            <input
              type="text"
              placeholder="Search messages, emails, locations..."
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={searchTerm()}
              onInput={(e) => setSearchTerm(e.target.value)}
            />
          </div>


          {/* Sort By */}
          <div class="lg:col-span-1">
            <label class="block text-sm font-medium text-gray-700 mb-1">Sort By</label>
            <select
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={sortBy()}
              onChange={(e) => setSortBy(e.target.value)}
            >
              <option value="datetime">Date/Time</option>
              <option value="email">Email</option>
              <option value="message">Message</option>
            </select>
          </div>

          {/* Sort Order */}
          <div class="lg:col-span-1">
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
          {isSearchMode()
            ? `Showing ${paginatedDisplay().length} of ${filteredActivities().length} filtered entries`
            : `Showing ${filteredActivities().length} of ${totalRecords()} entries`}
        </div>
      </div>

      {/* Activity Table */}
      <div class="admin-table-container">
        <div class="admin-table">
          <Show when={loading() || (isSearchMode() && loadingAllForSearch())} fallback={
            <div class="overflow-auto h-full">
              <table class="w-full border-collapse border border-gray-200 text-left">
                <thead class="bg-gray-200 sticky top-0 z-20">
                  <tr>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Datetime</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Email</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Client IP</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Location</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Message</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Context</th>
                  </tr>
                </thead>
                <tbody class="bg-white">
                  <For each={paginatedDisplay()}>
                    {(activity) => {
                      return (
                        <tr class={`${getRowClass(activity)} border border-gray-200 hover:bg-gray-50`}>
                          <td class="px-4 py-2 text-sm text-gray-600">{activity.datetime}</td>
                          <td class="px-4 py-2 text-sm font-medium">{activity.email}</td>
                          <td class="px-4 py-2 text-sm text-gray-600 font-mono">{activity.client_ip}</td>
                          <td class="px-4 py-2 text-sm text-gray-600">{activity.location}</td>
                          <td class="px-4 py-2 text-sm max-w-xs truncate" title={activity.message}>
                            {activity.message}
                          </td>
                          <td class="px-4 py-2 text-sm text-gray-600 max-w-xs truncate" title={activity.context}>
                            {activity.context}
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
              <div class="text-gray-500">
                {isSearchMode() && loadingAllForSearch() ? "Loading all data for search..." : "Loading activity..."}
              </div>
            </div>
          </Show>
        </div>
      </div>

      {/* Pagination Controls: when searching, use filtered count and repaginated pages */}
      <PaginationControls
        currentPage={currentPage()}
        totalPages={isSearchMode() ? searchModeTotalPages() : totalPages()}
        totalRecords={isSearchMode() ? filteredActivities().length : totalRecords()}
        limit={limit()}
        onPageChange={handlePageChange}
      />

    </div>
  );
}
