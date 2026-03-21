import { onMount, createSignal, Show, For, createMemo } from "solid-js";
import { FiCopy, FiCheck, FiX, FiTrash2, FiUser } from "solid-icons/fi";
import { getData } from "../../utils/global";
import { apiEndpoints } from "@config/env";
import { logPageLoad } from "../../utils/logging";
import { error as logError, log, info } from "../../utils/console";

interface User {
  user_id: number;
  email: string;
  is_active: boolean;
  subscription_type: string;
  billing_status?: string;
  [key: string]: any;
}

// Function to fetch all users
async function fetchAllUsers(): Promise<User[]> {
  const controller = new AbortController();
  
  // Set a timeout for the request (30 seconds)
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 30000);
  
  try {
    info('[AdminUsers] Starting to fetch all users...');
    const startTime = Date.now();
    
    const response = await getData(`${apiEndpoints.app.users}/all`, controller.signal);
    
    clearTimeout(timeoutId);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    
    if (response.success) {
      info(`[AdminUsers] Successfully fetched ${response.data?.length || 0} users in ${elapsed}s`);
      return response.data;
    } else {
      logError(`[AdminUsers] Failed to fetch users: ${response.message || 'Unknown error'}`);
      return [];
    }
  } catch (error: any) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      logError('[AdminUsers] Request timed out after 30 seconds. The server may be slow or unresponsive.');
    } else {
      logError('[AdminUsers] Error fetching users:', error);
    }
    return [];
  }
}

export default function AdminUsers() {
  const [users, setUsers] = createSignal<User[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [searchTerm, setSearchTerm] = createSignal("");
  const [sortBy, setSortBy] = createSignal("email");
  const [sortOrder, setSortOrder] = createSignal<"asc" | "desc">("asc");
  const [filterBy, setFilterBy] = createSignal("all");

  // Enhanced color coding for user status
  const getUserStatusClass = (user: User): string => {
    if (user.is_active === false) {
      return "bg-red-50 border-l-0 border-red-500";
    }
    if (user.subscription_type === "enterprise") {
      return "bg-blue-50 border-l-0 border-blue-500";
    }
    if (user.subscription_type === "pro") {
      return "bg-purple-50 border-l-0 border-purple-500";
    }
    return "bg-gray-50 border-l-0 border-gray-300";
  };

  const getStatusBadge = (user: User): string => {
    const baseClasses = "px-2 py-1 rounded-full text-xs font-semibold";
    
    if (user.is_active === false) {
      return `${baseClasses} bg-red-100 text-red-800`;
    }
    if (user.subscription_type === "enterprise") {
      return `${baseClasses} bg-blue-100 text-blue-800`;
    }
    if (user.subscription_type === "pro") {
      return `${baseClasses} bg-purple-100 text-purple-800`;
    }
    return `${baseClasses} bg-gray-100 text-gray-800`;
  };

  const getSubscriptionBadge = (subscriptionType: string): string => {
    const baseClasses = "px-2 py-1 rounded-full text-xs font-semibold";
    
    switch (subscriptionType) {
      case "enterprise":
        return `${baseClasses} bg-blue-100 text-blue-800`;
      case "pro":
        return `${baseClasses} bg-purple-100 text-purple-800`;
      case "standard":
        return `${baseClasses} bg-green-100 text-green-800`;
      default:
        return `${baseClasses} bg-gray-100 text-gray-800`;
    }
  };

  const copyUserId = (userId: number): void => {
    navigator.clipboard.writeText(userId.toString());
    // You could add a toast notification here
    log('User ID copied:', userId);
  };

  const rejectPAT = (userId: number): void => {
    // TODO: Implement PAT rejection functionality
    log('Reject PAT for user:', userId);
  };

  const getBillingStatusBadge = (status: string | undefined): string => {
    if (!status) return "px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800";
    
    switch (status.toLowerCase()) {
      case 'active':
        return "px-2 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800";
      case 'pending':
        return "px-2 py-1 text-xs font-semibold rounded-full bg-yellow-100 text-yellow-800";
      case 'failed':
        return "px-2 py-1 text-xs font-semibold rounded-full bg-red-100 text-red-800";
      default:
        return "px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-800";
    }
  };

  // Filter users
  const filteredUsers = createMemo(() => {
    let filtered = users();
    
    // Filter by search term
    if (searchTerm()) {
      const term = searchTerm().toLowerCase();
      filtered = filtered.filter(user => 
        user.email?.toLowerCase().includes(term) ||
        user.user?.toLowerCase().includes(term) ||
        user.subscription_type?.toLowerCase().includes(term)
      );
    }
    
    // Filter by subscription type
    if (filterBy() !== "all") {
      filtered = filtered.filter(user => user.subscription_type === filterBy());
    }
    
    return filtered;
  });

  // Sort users separately
  const sortedUsers = createMemo(() => {
    const filtered = filteredUsers();
    const sortColumn = sortBy();
    const order = sortOrder();
    
    log('Sorting users - Column:', sortColumn, 'Order:', order, 'Count:', filtered.length);
    
    const sorted = [...filtered].sort((a, b) => {
      let aValue = a[sortColumn];
      let bValue = b[sortColumn];
      
      // Handle null/undefined values
      if (aValue == null) aValue = "";
      if (bValue == null) bValue = "";
      
      // Special handling for date fields
      if (sortColumn === "created_at" || sortColumn === "last_login") {
        const aDate = new Date(aValue);
        const bDate = new Date(bValue);
        
        if (order === "asc") {
          return aDate - bDate;
        } else {
          return bDate - aDate;
        }
      }
      
      // Special handling for numeric fields
      if (sortColumn === "PAT") {
        const aNum = parseFloat(aValue) || 0;
        const bNum = parseFloat(bValue) || 0;
        
        if (order === "asc") {
          return aNum - bNum;
        } else {
          return bNum - aNum;
        }
      }
      
      // String comparison for other fields
      aValue = String(aValue).toLowerCase();
      bValue = String(bValue).toLowerCase();
      
      if (order === "asc") {
        return aValue > bValue ? 1 : -1;
      } else {
        return aValue < bValue ? 1 : -1;
      }
    });
    
    log('Sorted users:', sorted.slice(0, 3).map(u => ({ [sortColumn]: u[sortColumn] })));
    return sorted;
  });

  const handleSort = (column) => {
    log('Sorting by:', column, 'Current sortBy:', sortBy(), 'Current order:', sortOrder());
    if (sortBy() === column) {
      setSortOrder(sortOrder() === "asc" ? "desc" : "asc");
    } else {
      setSortBy(column);
      setSortOrder("asc");
    }
  };

  const getSortIcon = (column) => {
    if (sortBy() !== column) return "";
    return sortOrder() === "asc" ? "↑" : "↓";
  };

  onMount(async () => {
    await logPageLoad('AdminUsers.jsx', 'Admin Users Page');
    info('[AdminUsers] Component mounted, starting user fetch...');
    setLoading(true);
    
    try {
      const userData = await fetchAllUsers();
      setUsers(userData);
      info(`[AdminUsers] Loaded ${userData.length} user(s) into state`);
    } catch (error: any) {
      logError('[AdminUsers] Error in onMount:', error);
    } finally {
      setLoading(false);
      info('[AdminUsers] Loading complete');
    }
  });

  return (
    <div class="admin-users">
      {/* Page Title */}
      <div class="admin-page-header">
        <h1>User Management</h1>
        <p>Manage users, permissions, and subscriptions</p>
      </div>

      {/* Enhanced Filter Controls */}
      <div class="filter-controls mt-2 p-4 bg-gray-50 rounded-lg" style="width: 98%;">
        <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Search */}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Search</label>
            <input
              type="text"
              placeholder="Search users by name, email..."
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={searchTerm()}
              onInput={(e) => setSearchTerm(e.target.value)}
            />
          </div>

          {/* Subscription Filter */}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Subscription</label>
            <select
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={filterBy()}
              onChange={(e) => setFilterBy(e.target.value)}
            >
              <option value="all">All Subscriptions</option>
              <option value="enterprise">Enterprise</option>
              <option value="pro">Pro</option>
              <option value="standard">Standard</option>
              <option value="none">None</option>
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
              <option value="email">Email</option>
              <option value="user">Name</option>
              <option value="subscription_type">Subscription</option>
              <option value="created_at">Created Date</option>
              <option value="last_login">Last Login</option>
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
              <option value="asc">A-Z</option>
              <option value="desc">Z-A</option>
            </select>
          </div>
        </div>

        {/* Results Count */}
        <div class="mt-3 text-sm text-gray-600">
          Showing {sortedUsers().length} of {users().length} users
        </div>
      </div>

      {/* Users Table */}
      <div class="admin-table-container">
        <div class="admin-table">
          <Show when={loading()} fallback={
            <div class="overflow-auto h-full">
              <table class="w-full border-collapse border border-gray-200 text-left">
                <thead class="bg-gray-200 sticky top-0 z-20">
                  <tr>
                    <th class="border border-gray-300 px-4 py-2 font-semibold w-12">ID</th>
                    <th 
                      class="border border-gray-300 px-4 py-2 font-semibold cursor-pointer hover:bg-gray-300 w-48"
                      onClick={() => handleSort("user")}
                    >
                      Name {getSortIcon("user")}
                    </th>
                    <th 
                      class="border border-gray-300 px-4 py-2 font-semibold cursor-pointer hover:bg-gray-300"
                      onClick={() => handleSort("email")}
                    >
                      Email {getSortIcon("email")}
                    </th>
                    <th 
                      class="border border-gray-300 px-4 py-2 font-semibold cursor-pointer hover:bg-gray-300 w-20"
                      onClick={() => handleSort("created_at")}
                    >
                      Created {getSortIcon("created_at")}
                    </th>
                    <th 
                      class="border border-gray-300 px-4 py-2 font-semibold cursor-pointer hover:bg-gray-300 w-20"
                      onClick={() => handleSort("last_login")}
                    >
                      Last Login {getSortIcon("last_login")}
                    </th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold w-16">Active</th>
                    <th 
                      class="border border-gray-300 px-4 py-2 font-semibold cursor-pointer hover:bg-gray-300"
                      onClick={() => handleSort("subscription_type")}
                    >
                      Subscription {getSortIcon("subscription_type")}
                    </th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">PAT</th>
                    <th class="border border-gray-300 px-4 py-2 font-semibold">Billing</th>
                  </tr>
                </thead>
                <tbody class="bg-white">
                  <For each={sortedUsers()}>
                    {(user) => (
                      <tr class={`${getUserStatusClass(user)} border border-gray-200 hover:bg-gray-50`}>
                        {/* User ID with copy icon */}
                        <td class="px-2 py-2 text-center">
                          <button
                            class="p-1 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
                            onClick={() => copyUserId(user.user_id)}
                            title={`Copy User ID: ${user.user_id}`}
                          >
                            <FiCopy size={16} />
                          </button>
                        </td>
                        
                        {/* Name (from concatenated user field) */}
                        <td class="px-4 py-2 text-sm text-gray-600 w-48">
                          {user.user || 'N/A'}
                        </td>
                        
                        {/* Email */}
                        <td class="px-4 py-2 text-sm font-medium">{user.email}</td>
                        
                        {/* Created Date */}
                        <td class="px-4 py-2 text-sm text-gray-600 w-20">
                          {user.created_at ? new Date(user.created_at).toLocaleDateString() : '-'}
                        </td>
                        
                        {/* Last Login */}
                        <td class="px-4 py-2 text-sm text-gray-600 w-20">
                          {user.last_login ? new Date(user.last_login).toLocaleDateString() : 'Never'}
                        </td>
                        
                        {/* Active Status - Check/Cross */}
                        <td class="px-4 py-2 text-center w-16">
                          {user.is_active ? (
                            <FiCheck class="text-green-500 mx-auto" size={20} />
                          ) : (
                            <FiX class="text-red-500 mx-auto" size={20} />
                          )}
                        </td>
                        
                        {/* Subscription Type - Button */}
                        <td class="px-4 py-2">
                          <button class={getSubscriptionBadge(user.subscription_type)}>
                            {user.subscription_type?.toUpperCase() || 'NONE'}
                          </button>
                        </td>
                        
                        {/* PAT - Reject button if not zero */}
                        <td class="px-4 py-2 text-center">
                          <Show when={user.PAT && user.PAT > 0} fallback={<span class="text-gray-400">-</span>}>
                            <button
                              class="px-2 py-1 bg-red-500 text-white text-xs rounded hover:bg-red-600 flex items-center gap-1"
                              onClick={() => rejectPAT(user.user_id)}
                              title="Reject PAT"
                            >
                              <FiTrash2 size={12} />
                              Reject
                            </button>
                          </Show>
                        </td>
                        
                        {/* Billing Status - Button */}
                        <td class="px-4 py-2">
                          <button class={getBillingStatusBadge(user.billing_status)}>
                            {user.billing_status?.toUpperCase() || 'N/A'}
                          </button>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          }>
            <div class="flex justify-center items-center h-64">
              <div class="text-gray-500">Loading users...</div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
