import { createSignal, Show, onMount, onCleanup } from "solid-js";
import { FiSettings, FiChevronDown } from "solid-icons/fi";
import { useNavigate } from "@solidjs/router";

interface MenuItem {
  label: string;
  route: string | (() => void);
}

interface SidebarSettingsProps {
  isCollapsed: () => boolean;
  toggleSidebar?: () => void;
  isMobile: () => boolean;
  menuItems?: MenuItem[] | (() => MenuItem[]);
}

const SidebarSettings = (props: SidebarSettingsProps) => {
  const navigate = useNavigate();
  const [isExpanded, setIsExpanded] = createSignal(false);
  const { isCollapsed, toggleSidebar, isMobile } = props;
  
  // Keep menuItems reactive by accessing it directly from props
  const menuItems = (): MenuItem[] => {
    const items = typeof props.menuItems === 'function' ? props.menuItems() : (props.menuItems || []);
    return items;
  };

  const toggleSettings = (event: MouseEvent): void => {
    event.stopPropagation();
    setIsExpanded(!isExpanded());
  };

  const handleMenuItemClick = (route: string | (() => void)): void => {
    if (typeof route === 'function') {
      route(); // Call the function
    } else {
      navigate(route); // Navigate to the string route
    }
    setIsExpanded(false); // Close the dropdown after navigation
  };

  // Handle click outside to close dropdown
  const handleClickOutside = (event: MouseEvent): void => {
    const container = document.querySelector('.sidebar-settings-container');
    if (container && !container.contains(event.target as Node)) {
      setIsExpanded(false);
    }
  };

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
  });

  onCleanup(() => {
    document.removeEventListener('click', handleClickOutside);
  });

  return (
    <div class="sidebar-settings-container">
      {/* Settings Button */}
      <button 
        class="menu-item" 
        onClick={toggleSettings}
        title={isCollapsed() ? "Settings" : ""}
      >
        <FiSettings size={20} />
        <Show when={!isCollapsed() || isMobile()}>
          <span>Settings</span>
        </Show>
      </button>

      {/* Settings Dropdown */}
      <Show when={isExpanded()}>
        <div class="settings-dropdown">
          {menuItems().map((item, index) => (
            <button
              key={index}
              class="settings-menu-item"
              onClick={() => handleMenuItemClick(item.route)}
            >
              <span>{item.label}</span>
            </button>
          ))}
          
        </div>
      </Show>
    </div>
  );
};

export default SidebarSettings;
