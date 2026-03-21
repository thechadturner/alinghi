import { createSignal, onMount, onCleanup, Show, createMemo } from "solid-js";
import { FiUsers, FiActivity, FiFileText, FiArrowLeft, FiMenu, FiX, FiDatabase, FiPlay, FiCast, FiServer } from "solid-icons/fi";
import { useNavigate } from "@solidjs/router";
import { user } from "../../store/userStore";

interface AdminSidebarProps {
  [key: string]: any;
}

const AdminSidebar = (props: AdminSidebarProps) => {
  const navigate = useNavigate();
  
  const [selectedMenu, setSelectedMenu] = createSignal("users");
  const [isCollapsed, setIsCollapsed] = createSignal(false);
  const [isMobile, setIsMobile] = createSignal(false);
  const [showMobileMenu, setShowMobileMenu] = createSignal(false);

  // Function to detect screen size and set responsive state
  const checkScreenSize = (): void => {
    const width = window.innerWidth;
    const mobile = width <= 1000;
    setIsMobile(mobile);
    
    // Auto-collapse on mobile, restore desktop state on larger screens
    if (mobile) {
      setIsCollapsed(true);
      setShowMobileMenu(false);
    } else {
      // Restore collapsed state from localStorage for desktop
      const savedCollapsed = localStorage.getItem('adminSidebarCollapsed') === 'true';
      setIsCollapsed(savedCollapsed);
    }
  };

  // Function to toggle sidebar collapse
  const toggleSidebar = (): void => {
    if (isMobile()) {
      setShowMobileMenu(!showMobileMenu());
    } else {
      const newCollapsed = !isCollapsed();
      setIsCollapsed(newCollapsed);
      localStorage.setItem('adminSidebarCollapsed', newCollapsed.toString());
    }
  };

  // Function to handle double-click on sidebar
  const handleSidebarDoubleClick = (): void => {
    // Only handle double-click on desktop (not mobile)
    if (!isMobile()) {
      const newCollapsed = !isCollapsed();
      setIsCollapsed(newCollapsed);
      localStorage.setItem('adminSidebarCollapsed', newCollapsed.toString());
    }
  };

  // Function to handle menu selection
  const handleMenuClick = (menuName) => {
    setSelectedMenu(menuName);
    if (props.onMenuChange) {
      props.onMenuChange(menuName);
    }
  };

  // Function to handle back navigation
  const handleBackClick = () => {
    navigate("/dashboard");
  };

  // Resize handler function
  const handleResize = () => {
    checkScreenSize();
  };

  onMount(() => {
    // Initialize responsive state
    checkScreenSize();
    
    // Add resize listener
    window.addEventListener('resize', handleResize);
  });

  onCleanup(() => {
    window.removeEventListener('resize', handleResize);
  });

  // Check if user is super user
  const isSuperUser = createMemo(() => {
    const currentUser = user();
    return currentUser?.is_super_user === true;
  });

  // Base menu items (always visible)
  const baseMenuItems = [
    {
      id: "users",
      label: "USERS",
      icon: FiUsers,
      description: "Manage users and permissions"
    },
    {
      id: "activity",
      label: "ACTIVITY",
      icon: FiActivity,
      description: "View user activity logs"
    },
    {
      id: "logs",
      label: "LOGS",
      icon: FiFileText,
      description: "View system logs"
    },
    {
      id: "hunidb",
      label: "HUNIDB",
      icon: FiDatabase,
      description: "Manage client-side HuniDB storage"
    },
    {
      id: "streaming",
      label: "STREAMING",
      icon: FiCast,
      description: "Monitor Redis database and streaming status"
    },
    {
      id: "script-execution",
      label: "SCRIPT EXECUTION",
      icon: FiPlay,
      description: "Execute scripts on datasets"
    }
  ];

  // Database menu item (super user only)
  const databaseMenuItem = {
    id: "database",
    label: "DATABASE",
    icon: FiServer,
    description: "Database administration and maintenance"
  };

  // Filtered menu items based on user permissions
  const menuItems = createMemo(() => {
    const items = [...baseMenuItems];
    // Insert database menu item after logs if user is super user
    if (isSuperUser()) {
      items.splice(3, 0, databaseMenuItem);
    }
    return items;
  });

  return (
    <>
      {/* Mobile Menu Button */}
      <Show when={isMobile()}>
        <button 
          class="mobile-menu-button"
          onClick={toggleSidebar}
        >
          <Show when={showMobileMenu()} fallback={<FiMenu size={24} />}>
            <FiX size={24} />
          </Show>
        </button>
      </Show>

      {/* Mobile Overlay */}
      <Show when={isMobile() && showMobileMenu()}>
        <div 
          class="mobile-overlay show"
          onClick={() => setShowMobileMenu(false)}
        />
      </Show>

      <div 
        class={`admin-sidebar ${isCollapsed() && !isMobile() ? 'collapsed' : ''} ${isMobile() ? 'mobile' : ''} ${isMobile() && showMobileMenu() ? 'show' : ''}`} 
        onContextMenu={(e) => e.preventDefault()}
        onDblClick={handleSidebarDoubleClick}
      >
        {/* Main Content Area */}
        <div class="admin-sidebar-main-content">
          <div class="admin-menu">
            {menuItems().map((item) => {
              const IconComponent = item.icon;
              return (
                <button
                  class={`admin-menu-item ${selectedMenu() === item.id ? "active" : ""}`}
                  onClick={() => handleMenuClick(item.id)}
                  title={isCollapsed() && !isMobile() ? item.label : ""}
                >
                  <div class="flex items-center">
                    <IconComponent size={20} />
                    <Show when={!isCollapsed() || isMobile()}>
                      <span class="ml-2">{item.label}</span>
                    </Show>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Bottom Section - Always visible */}
        <div class="admin-sidebar-bottom" style="position: absolute; bottom: 20px; left: 0; right: 0;">
          {/* Back Button */}
          <button 
            class="admin-menu-item" 
            onClick={handleBackClick}
            title={isCollapsed() && !isMobile() ? "Back to Dashboard" : ""}
          >
            <div class="flex items-center">
              <FiArrowLeft size={20} />
              <Show when={!isCollapsed() || isMobile()}>
                <span class="ml-2">Back to Dashboard</span>
              </Show>
            </div>
          </button>

        </div>
      </div>
    </>
  );
};

export default AdminSidebar;
