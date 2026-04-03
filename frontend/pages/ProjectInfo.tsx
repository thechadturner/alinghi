import { createSignal, onMount, onCleanup, Show, createEffect } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { logPageLoad } from "../utils/logging";
import { error as logError, log } from "../utils/console";
import Loading from "../components/utilities/Loading";
import BackButton from "../components/buttons/BackButton";
import ColorPicker from "../components/utilities/ColorPicker";
import { postData, putData, getData, deleteData } from "../utils/global";

import { user } from "../store/userStore";
import { persistantStore } from "../store/persistantStore";
import { normalizeSpeedDisplayUnit } from "../utils/speedUnits";
import { apiEndpoints } from "@config/env";
import { toastStore } from "../store/toastStore";
import UnitsToggle from "../components/utilities/UnitsToggle";
import { sourcesStore } from "../store/sourcesStore";
import { themeStore } from "../store/themeStore";
import { Source, getSourceFallbackColor } from "../utils/colorScale";
const { selectedProjectId, setSelectedProjectId, projects, setProjects, setProjectHeader: setProjectHeaderStore } = persistantStore;

interface PendingUser {
  email: string;
  permission: string;
  status: "active" | "inactive";
}

export default function ProjectInfo() {
  const navigate = useNavigate();
  const [projectHeader, setProjectHeader] = createSignal("RACESIGHT");
  const [projectName, setProjectName] = createSignal("");
  const [emailInput, setEmailInput] = createSignal("");
  const [pendingUsers, setPendingUsers] = createSignal<PendingUser[]>([]);
  const [sources, setSources] = createSignal<Source[]>([]);
  const [selectedClassId, setSelectedClassId] = createSignal(0);
  const [selectedClassName, setSelectedClassName] = createSignal("");

  const [showModal, setShowModal] = createSignal(false);
  const [selectedColor, setSelectedColor] = createSignal<string | null>(null);
  const [sourceId, setSourceId] = createSignal<number | null>(null);
  const [editingPermission, setEditingPermission] = createSignal<string | null>(null); // Track which user's permission is being edited
  const [newSourceName, setNewSourceName] = createSignal("");
  const [addingSource, setAddingSource] = createSignal(false);
  const [showAddSourceModal, setShowAddSourceModal] = createSignal(false);

  const openAddSourceModal = () => {
    setNewSourceName("");
    setShowAddSourceModal(true);
  };

  const closeAddSourceModal = () => {
    setShowAddSourceModal(false);
    setNewSourceName("");
  };

  createEffect(() => {
    if (!showAddSourceModal()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !addingSource()) {
        e.preventDefault();
        closeAddSourceModal();
      }
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  const colors = [
    "#FF0000", "#0000FF", "#008000", "#FFA500", "#800080",  // Red, Blue, Green, Orange, Purple
    "#808080", "#000000", "#FFFF00", "#00FFFF", "#FF00FF",  // Grey, Black, Yellow, Cyan, Magenta
    "#A52A2A", "#4682B4", "#32CD32", "#FF4500", "#9400D3",  // Brown, Steel Blue, Lime Green, Orange Red, Dark Violet
    "#C0C0C0", "#2F4F4F", "#FFD700", "#20B2AA", "#DC143C",  // Silver, Dark Slate, Gold, Light Sea Green, Crimson
    "#8B4513", "#1E90FF", "#228B22", "#FF6347", "#DA70D6",  // Saddle Brown, Dodger Blue, Forest Green, Tomato, Orchid
  ];

  const toggleColorPicker = (sourceId: number) => {
    setSourceId(sourceId);
    setShowModal(true);  // Show the color picker modal
  };

  const handleColorSelect = (color: string) => {
    setSelectedColor(color);
    setShowModal(false); // Close the modal after color selection

    if (sourceId() !== null && selectedColor() !== null) {
      handleUpdateSource(sourceId()!, "color", selectedColor()!);
    }
  };

  // Track abort controllers for cleanup using a signal so SolidJS can track them
  const [abortControllers, setAbortControllers] = createSignal<AbortController[]>([]);

  // Register cleanup at component level (not inside onMount)
  onCleanup(() => {
    // Abort all pending requests when component unmounts
    abortControllers().forEach(controller => {
      controller.abort();
    });
  });

  const fetchProjectData = async () => {
    if (!selectedProjectId()) return;

    const controller = new AbortController();
    setAbortControllers(prev => [...prev, controller]);
    
    try {
      const response = await getData(`${apiEndpoints.app.projects}/id?project_id=${selectedProjectId()}`, controller.signal);
      
      // Remove controller from tracking when request completes
      setAbortControllers(prev => prev.filter(c => c !== controller));

      if (!response.success) throw new Error("Failed to fetch project data");

      const data = response.data;

      setProjectName(() => data.project_name);
      setSelectedClassId(() => data.class_id);
      setSelectedClassName(() => data.class_name.toLowerCase());

      if (data.speed_units) {
        persistantStore.setDefaultUnits(normalizeSpeedDisplayUnit(data.speed_units));
      }

      // Retrieve project header from project_objects
      try {
        const today = '1970-01-01'; // YYYY-MM-DD format
        const headerResponse = await getData(
          `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(data.class_name.toLowerCase())}&project_id=${encodeURIComponent(selectedProjectId())}&date=${encodeURIComponent(today)}&object_name=header`,
          controller.signal
        );

        if (headerResponse.success && headerResponse.data) {
          const headerObj = typeof headerResponse.data === 'string' ? JSON.parse(headerResponse.data) : headerResponse.data;
          
          const header = headerObj?.header || data.project_name || "RACESIGHT";
          setProjectHeader(() => header);
          setProjectHeaderStore(header);
        } else {
          // If no header object found, use project name as default
          const defaultHeader = data.project_name || "RACESIGHT";
          setProjectHeader(() => defaultHeader);
          setProjectHeaderStore(defaultHeader);
        }
      } catch (headerError: any) {
        // If error retrieving header, use project name as default
        if (headerError.name !== 'AbortError') {
          logError("Error fetching project header:", headerError.message);
        }
        const defaultHeader = data.project_name || "RACESIGHT";
        setProjectHeader(() => defaultHeader);
        setProjectHeaderStore(defaultHeader);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Request was aborted, controller already removed or will be removed
      } else {
        logError("Error fetching project data:", error.message);
      }
    } finally {
      // Remove controller from tracking when request completes (success or error)
      setAbortControllers(prev => prev.filter(c => c !== controller));
    }
  };

  const fetchPendingUsers = async () => {
    if (!selectedProjectId()) return;

    const controller = new AbortController();
    setAbortControllers(prev => [...prev, controller]);
    
    try {
      const response = await getData(`${apiEndpoints.app.projects}/users?project_id=${encodeURIComponent(selectedProjectId())}`, controller.signal);

      if (!response.success) throw new Error("Failed to fetch project users");

      const data = response.data;

      setPendingUsers(() => data);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Request was aborted
      } else {
        logError("Error fetching project users:", error.message);
      }
    } finally {
      // Remove controller from tracking when request completes
      setAbortControllers(prev => prev.filter(c => c !== controller));
    }
  };

  const fetchProjects = async () => {
    const controller = new AbortController();
    setAbortControllers(prev => [...prev, controller]);
    
    try {
      const response = await getData(`${apiEndpoints.app.projects}/type?type=user`, controller.signal)

      if (response.success) {
        const data = response.data;
        setProjects(data);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
      } else {
        logError("Error fetching projects:", error);
      }
    }
  };

  const fetchSources = async () => {
    const controller = new AbortController();
    setAbortControllers(prev => [...prev, controller]);
    
    try {
      const response = await getData(`${apiEndpoints.app.sources}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}`, controller.signal);

      if (response.success) {
        const data = response.data;
        setSources(() => (Array.isArray(data) ? data : []));
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Request was aborted
      } else {
        logError("Error fetching sources:", error.message);
      }
    } finally {
      // Remove controller from tracking when request completes
      setAbortControllers(prev => prev.filter(c => c !== controller));
    }
  };

  const handleAddSource = async () => {
    const trimmed = newSourceName().trim();
    if (!trimmed) {
      toastStore.showToast("error", "Validation", "Please enter a source name");
      return;
    }
    const projectId = selectedProjectId();
    const className = selectedClassName();
    if (projectId == null || projectId === 0 || !className) {
      toastStore.showToast("error", "Error", "Project is not fully loaded yet");
      return;
    }

    const controller = new AbortController();
    setAbortControllers((prev) => [...prev, controller]);
    setAddingSource(true);
    try {
      const color = getSourceFallbackColor(trimmed);
      const response = await postData(
        `${apiEndpoints.app.sources}`,
        {
          class_name: className,
          project_id: typeof projectId === "number" ? projectId : Number(projectId),
          source_name: trimmed,
          color,
        },
        controller.signal
      );

      if (!response.success) {
        const msg = typeof response.message === "string" ? response.message : "Failed to add source";
        logError("[ProjectInfo] addSource failed:", msg);
        toastStore.showToast("error", "Could not add source", msg);
        return;
      }

      log("[ProjectInfo] Source added or matched:", response.data);
      closeAddSourceModal();
      await fetchSources();
      try {
        await sourcesStore.refresh(true);
      } catch (storeErr) {
        logError("[ProjectInfo] sourcesStore.refresh after add:", storeErr);
      }
      const alreadyExisted = response.message === "Source found";
      toastStore.showToast(
        "success",
        alreadyExisted ? "Source already registered" : "Source added",
        alreadyExisted
          ? `"${trimmed}" was already in this project.`
          : `"${trimmed}" is now available for this project.`
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      const message = error instanceof Error ? error.message : "Unexpected error";
      logError("[ProjectInfo] addSource error:", message);
      toastStore.showToast("error", "Could not add source", message);
    } finally {
      setAddingSource(false);
      setAbortControllers((prev) => prev.filter((c) => c !== controller));
    }
  };

  onMount(async () => {
    await fetchProjectData();
    await fetchPendingUsers();
    await fetchSources();

      await logPageLoad('ProjectInfo.tsx', 'Project Info Page')

    // Close permission dropdown when clicking outside
    const handleClickOutside = (event: MouseEvent) => {
      if (editingPermission() && !(event.target as HTMLElement).closest('[data-permission-dropdown]')) {
        setEditingPermission(null);
      }
    };

    document.addEventListener('click', handleClickOutside);

    // Register cleanup for event listener
    onCleanup(() => {
      document.removeEventListener('click', handleClickOutside);
    });
  });

  const handleRemoveProject = async () => {
    if (!selectedProjectId()) return;

    const isConfirmed1 = window.confirm("Are you sure you want to delete this project?");
    
    if (!isConfirmed1) return; 

    const isConfirmed2 = window.confirm("A reminder, data will not be recoverable?");
    
    if (!isConfirmed2) return; 

    const controller = new AbortController();

    try {
      const response = await deleteData(`${apiEndpoints.app.projects}`, {
          project_id: selectedProjectId()
      }, controller.signal);

      if (!response.success) throw new Error("Failed to delete project");

      await logPageLoad('ProjectInfo.tsx', 'Project Removed', 'Success')

      await fetchProjects();

      if (projects()) {
        let first_project = projects()[0]["project_id"]
        setSelectedProjectId(first_project)
      }

      setTimeout(() => navigate("/dashboard", { replace: true }), 100);
    } catch (error: any) {
      if (error.name === 'AbortError') {
      } else {
        // Let backend sendResponse handle error logging
        logError('Error removing project:', error.message);
      }
    }
  };

  const handleUpdateProject = async () => {
    if (!selectedProjectId()) return;

    const controller = new AbortController();

    try {
      // Update project basic info
      const response = await putData(`${apiEndpoints.app.projects}`, {
          project_id: selectedProjectId(),
          project_name: projectName(),
          class_id: selectedClassId(),
          speed_units: persistantStore.defaultUnits()
      }, controller.signal);

      if (!response.success) throw new Error("Failed to update project");

      // Save project header as a project_object
      try {
        const today = '1970-01-01'; // YYYY-MM-DD format
        const headerJson = JSON.stringify({ header: projectHeader() });
        const headerResponse = await postData(`${apiEndpoints.app.projects}/object`, {
          class_name: selectedClassName(),
          project_id: selectedProjectId(),
          date: today,
          object_name: 'header',
          json: headerJson
        }, controller.signal);

        if (!headerResponse.success) {
          logError("Failed to save project header:", headerResponse.message || "Unknown error");
        }
      } catch (headerError: any) {
        if (headerError.name !== 'AbortError') {
          logError("Error saving project header:", headerError.message);
        }
      }

      // Update store with new header for Header component
      setProjectHeaderStore(projectHeader());

      await logPageLoad('ProjectInfo.tsx', 'Project Updated', 'Success')
      setTimeout(() => navigate("/dashboard", { replace: true }), 100);
    } catch (error: any) {
      if (error.name === 'AbortError') {
      } else {
        logError("Error updating project:", error.message);
      }
    }
  };

  const handleAddUsers = async () => {
    if (!selectedProjectId()) return;

    const emails = emailInput().split(",").map((email) => email.trim());
    
    // Validate email formats before attempting to add
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalidEmails = emails.filter(email => !emailRegex.test(email));
    
    if (invalidEmails.length > 0) {
      alert(`Invalid email format(s): ${invalidEmails.join(', ')}\n\nPlease enter valid email addresses separated by commas.`);
      return;
    }
    
    // Check for empty emails
    const emptyEmails = emails.filter(email => email === '');
    if (emptyEmails.length > 0) {
      alert('Please enter at least one valid email address.');
      return;
    }

    for (const email of emails) {
      const controller = new AbortController();
      
      try {
        const response = await postData(`${apiEndpoints.app.usersPending}`, {
          project_id: selectedProjectId(),
          email: email,
          permission: "reader"
        }, controller.signal)

        if (!response.success) throw new Error(`Failed to add user: ${email}`);
        await logPageLoad('ProjectInfo.tsx', 'User Added', email)
      } catch (error: any) {
        if (error.name === 'AbortError') {
        } else {
          logError(`Error adding user ${email}:`, error.message);
        }
      }
    }

    setEmailInput(""); // Clear input after adding users
    await fetchPendingUsers(); // Refresh list after update
  };

  const handleUpdateSource = async (source_id: number, key: string, value: any) => {
    const sourceIndex = sources().findIndex((source) => source.source_id === source_id);
    if (sourceIndex === -1) {
      throw new Error("Source not found!");
    }

    const updatedSources = [...sources()]; 
    updatedSources[sourceIndex] = { ...updatedSources[sourceIndex], [key]: value };

    setSources(updatedSources);
  
    // Refetch the updated source using the updated sources state
    const updatedSource = updatedSources[sourceIndex];

    const controller = new AbortController();

    try {
      // Now proceed with the API call to update the backend
      const response = await putData(`${apiEndpoints.app.sources}`, {
        class_name: selectedClassName(),
        project_id: selectedProjectId(),
        source_id: updatedSource.source_id,
        source_name: updatedSource.source_name,
        color: updatedSource.color,
        fleet: updatedSource.fleet,
        visible: updatedSource.visible
      }, controller.signal);

      if (!response.success) {
        throw new Error("Update failed!");
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
      } else {
        throw error;
      }
    }
  };

  const handleRemoveSource = async (source_id: number) => {
    const isConfirmed1 = window.confirm("Are you sure you want to delete this source?");
    
    if (!isConfirmed1) return; 

    const isConfirmed2 = window.confirm("A reminder, related data will also be removed?");
    
    if (!isConfirmed2) return; 
  
    const controller = new AbortController();

    try {
      const response = await deleteData(`${apiEndpoints.app.sources}`, {
        class_name: selectedClassName(),
        project_id: selectedProjectId(),
        source_id: source_id
      }, controller.signal);
    
      if (!response.success) {
        const msg = typeof response.message === "string" ? response.message : "Delete failed";
        logError("[ProjectInfo] removeSource failed:", msg);
        toastStore.showToast("error", "Could not remove source", msg);
        return;
      }

      await fetchSources();
      try {
        await sourcesStore.refresh(true);
      } catch (storeErr) {
        logError("[ProjectInfo] sourcesStore.refresh after remove:", storeErr);
      }
      log("[ProjectInfo] Source removed:", source_id);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      const message = error instanceof Error ? error.message : "Unexpected error";
      logError("[ProjectInfo] removeSource error:", message);
      toastStore.showToast("error", "Could not remove source", message);
    }
  };

  const handleRemovePendingUser = async (email: string) => {
    const isConfirmed = window.confirm("Are you sure you want to remove this user from the project?");
    
    if (!isConfirmed) return; 
  
    const controller = new AbortController();
    setAbortControllers(prev => [...prev, controller]);

    try {
      const response = await deleteData(`${apiEndpoints.app.projects}/user`, {
        project_id: selectedProjectId(),
        email: email
      }, controller.signal);

      if (!response.success) {
        const errorMessage = response.message || "Failed to remove user from project";
        logError("Error removing user:", errorMessage);
        alert(`Failed to remove user: ${errorMessage}`);
        return;
      }

      await logPageLoad('ProjectInfo.tsx', 'User Removed', email);
      await fetchPendingUsers(); // Refresh list after update
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Request was aborted
      } else {
        logError("Error removing user from project:", error.message);
        alert(`Error removing user: ${error.message}`);
      }
    } finally {
      // Remove controller from tracking when request completes
      setAbortControllers(prev => prev.filter(c => c !== controller));
    }
  };

  const handleSendInvite = async (email: string, permission: string) => {
    if (!selectedProjectId()) return;

    const controller = new AbortController();

    try {
      const response = await postData(`${apiEndpoints.app.usersPending}/invite`, {
        project_id: selectedProjectId(),
        email: email,
        permission: permission
      }, controller.signal);

      if (!response.success) {
        throw new Error(response.message || "Failed to send invitation");
      }

      await logPageLoad('ProjectInfo.tsx', 'Invitation Sent', email);
      // Refresh the pending users list to show updated status
      await fetchPendingUsers();
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Request was aborted
      } else {
        logError("Error sending invitation:", error.message);
        alert(`Failed to send invitation: ${error.message}`);
      }
    }
  };

  const handleUpdateUserPermission = async (email: string, newPermission: string, status: string) => {
    if (!selectedProjectId()) return;

    const controller = new AbortController();

    try {
      let response;
      
      if (status === "active") {
        // Update active user permission via projects endpoint
        response = await putData(`${apiEndpoints.app.projects}/users/permission`, {
          project_id: selectedProjectId(),
          email: email,
          permission: newPermission
        }, controller.signal);
      } else {
        // Update pending user permission
        response = await putData(`${apiEndpoints.app.usersPending}`, {
          project_id: selectedProjectId(),
          email: email,
          permission: newPermission
        }, controller.signal);
      }

      if (!response.success) {
        throw new Error("Failed to update permission");
      }

      setEditingPermission(null); // Close dropdown
      await fetchPendingUsers(); // Refresh list after update
    } catch (error: any) {
      if (error.name === 'AbortError') {
      } else {
        logError("Error updating user permission:", error.message);
      }
    }
  };

  const permissionLevels: string[] = ["administrator", "publisher", "contributor", "reader"];
  
  // Check if user has access (enterprise subscription or super user)
  const hasAccess = () => {
    const userData = user();
    if (!userData) return false;
    
    if (userData.is_super_user) return true;
    
    // Handle permissions as object {1: 'administrator'} or string
    if (typeof userData.permissions === 'string') {
      return userData.permissions === "administrator";
    } else if (typeof userData.permissions === 'object' && userData.permissions !== null) {
      return Object.values(userData.permissions).includes("administrator");
    }
    
    return false;
  };

  return (
    <>
      <style>{`
        .profile-layout {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 32px;
          align-items: start;
          flex: 1;
          width: 100%;
          max-width: 100%;
        }
        /* Keep subscription + extras together in the right column */
        .right-column { 
          grid-column: 2; 
          display: flex; 
          flex-direction: column; 
          gap: 16px; 
          min-width: 0; /* Allow column to shrink */
        }
        
        @media (max-width: 1200px) {
          .profile-layout {
            grid-template-columns: 1fr;
            gap: 24px;
          }
          .right-column { 
            grid-column: 1; 
          }
        }
        
        @media (max-width: 768px) {
          .profile-layout {
            gap: 16px;
          }
        }
        
        @media (max-width: 480px) {
          .profile-layout {
            gap: 12px;
          }
        }
        
        /* Ensure proper spacing from header */
        .profile-container {
          padding-top: 80px;
          min-height: calc(100vh - 80px);
          height: auto;
          overflow: visible; /* Remove scroll from container, let parent handle it */
        }
        
        /* Ensure smooth scrolling and proper scroll container */
        .login-page {
          scroll-behavior: smooth;
          position: relative;
          height: auto !important;
          min-height: 100vh !important;
          overflow: visible !important;
          align-items: flex-start !important; /* Change from center to start */
          justify-content: flex-start !important; /* Change from center to start */
          padding-top: 0;
        }
        
        /* Remove the scroll-container wrapper - not needed */
        .login-page-scroll-container {
          width: 100%;
          height: auto;
          overflow: visible !important; /* Prevent this container from creating a scrollbar */
        }
        
        @media (max-width: 768px) {
          .profile-container {
            padding-top: 70px;
            min-height: calc(100vh - 70px);
          }
        }
        
        @media (max-width: 480px) {
          .profile-container {
            padding-top: 60px;
            min-height: calc(100vh - 60px);
            padding-left: 10px;
            padding-right: 10px;
          }
        }
      `}</style>
      <Show when={hasAccess()} fallback={
      <div class="login-page">
        <div class="login-container" style="max-width: 600px;">
          <div class="login-header">
            <div class="logo-section">
              <div class="logo-icon" style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                  <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2"/>
                  <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2"/>
                </svg>
              </div>
              <h1 class="login-title">Access Denied</h1>
              <p class="login-subtitle">This feature requires an Enterprise subscription</p>
            </div>
          </div>
          <BackButton />
        </div>
      </div>
    }>
    <div class="login-page" style="
      background: var(--color-bg-secondary);
      padding-bottom: 64px;
      box-sizing: border-box;
      transition: background-color 0.3s ease;
    ">
      <Show when={selectedClassId()} fallback={<Loading />}>
        <div class="login-page-scroll-container" style="overflow: visible !important;">
        <div class="profile-container" style="
          display: flex; 
          flex-direction: column; 
          min-height: 100%; 
          height: auto;
          padding: 20px;
          padding-top: 80px;
          max-width: 1400px;
          margin: 0 auto;
          box-sizing: border-box;
        ">
          <div class="login-header" style="margin-bottom: 24px;">
            <div class="logo-section">
              <div class="logo-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <polyline points="10,9 9,9 8,9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <h1 class="login-title">Project Settings</h1>
              <p class="login-subtitle">Manage your project configuration and data sources</p>
            </div>
          </div>
          
          <div class="profile-layout">
            {/* Left Column - Project Settings */}
            <div style="display: flex; flex-direction: column; gap: 16px;">
              <div style="
                background: var(--color-bg-card); 
                border-radius: 12px; 
                padding: 24px; 
                box-shadow: 0 2px 8px var(--color-shadow-sm);
                border: 1px solid var(--color-border-primary);
                transition: all 0.3s ease;
              ">
                <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--color-text-primary); transition: color 0.3s ease;">
                  Project Information
                </h3>
                <form onSubmit={(e) => { e.preventDefault(); handleUpdateProject(); }}>
                  <div class="form-group">
                    <label for="projectheader-input" class="form-label">Project Header</label>
                    <div class="input-container">
                      <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6C2 4.9 2.9 4 4 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M22 6L12 13L2 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      <input 
                        id="projectheader-input" 
                        type="text" 
                        value={projectHeader()} 
                        onInput={(e) => setProjectHeader((e.target as HTMLInputElement).value)} 
                        placeholder="Enter project header (e.g., RACESIGHT)"
                        class="form-input"
                      />
                    </div>
                    <p class="form-help-text">This text will appear in the header when this project is selected</p>
                  </div>
                  <div class="form-group">
                    <label for="projectname-input" class="form-label">Project Name</label>
                    <div class="input-container">
                      <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      <input 
                        id="projectname-input" 
                        type="text" 
                        value={projectName()} 
                        onInput={(e) => setProjectName((e.target as HTMLInputElement).value)} 
                        placeholder="Enter project name"
                        class="form-input"
                      />
                    </div>
                  </div>
                  <div class="form-group">
                    <label for="classname-input" class="form-label">Data Class</label>
                    <div class="input-container">
                      <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M9 11H15M9 15H15M17 21H7C5.89543 21 5 20.1046 5 19V5C5 3.89543 5.89543 3 7 3H12.5858C12.851 3 13.1054 3.10536 13.2929 3.29289L19.7071 9.70711C19.8946 9.89464 20 10.149 20 10.4142V19C20 20.1046 19.1046 21 18 21H17Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      <input 
                        type="text" 
                        id="classname-input" 
                        value={selectedClassName()} 
                        readOnly 
                        class="form-input"
                        style="background-color: var(--color-bg-tertiary); color: var(--color-text-secondary);"
                      />
                    </div>
                    <p class="form-help-text">Data class cannot be changed after project creation</p>
                    <div class="project-info-units-toggle-wrap">
                      <p class="form-help-text project-info-units-hint">Default wind and boat speed units for charts and tables</p>
                      <UnitsToggle />
                    </div>
                  </div>
                  
                  <div class="flex gap-3" style="margin-top: 16px;">
                    <button type="submit" class="builder-form-button-success px-6 py-3 font-semibold">
                      <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 6L9 17L4 12"></path>
                      </svg>
                      Update Project
                    </button>
                    <button class="builder-form-button-danger px-6 py-3 font-semibold" type="button" onClick={handleRemoveProject}>
                      <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 6H5H21M8 6V4C8 3.46957 8.21071 2.96086 8.58579 2.58579C8.96086 2.21071 9.46957 2 10 2H14C14.5304 2 15.0391 2.21071 15.4142 2.58579C15.7893 2.96086 16 3.46957 16 4V6M19 6V20C19 20.5304 18.7893 21.0391 18.4142 21.4142C18.0391 21.7893 17.5304 22 17 22H7C6.46957 22 5.96086 21.7893 5.58579 21.4142C5.21071 21.0391 5 20.5304 5 20V6H19Z"></path>
                      </svg>
                      Delete Project
                    </button>
                  </div>
                </form>
              </div>

              {/* Data Sources Section — always show card; table or empty-state add form */}
              <div style="
                  background: var(--color-bg-card); 
                  border-radius: 12px; 
                  padding: 24px; 
                  box-shadow: 0 2px 8px var(--color-shadow-sm);
                  border: 1px solid var(--color-border-primary);
                  transition: all 0.3s ease;
                ">
                <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--color-text-primary); transition: color 0.3s ease;">
                  Data Sources
                </h3>
                <Show
                  when={sources().length > 0}
                  fallback={
                    <div class="project-info-sources-empty">
                      <p class="project-info-sources-empty-text">
                        No data sources are defined for this project yet. Use the button below to register a source (for example matching a boat or unit name used in your data). You can set color, fleet grouping, and visibility once it appears in the table.
                      </p>
                      <div class="project-info-sources-add-actions">
                        <button
                          type="button"
                          class="builder-form-button-secondary project-info-sources-add-btn"
                          onClick={openAddSourceModal}
                        >
                          + Add Source
                        </button>
                      </div>
                    </div>
                  }
                >
                  <div style="overflow-x: auto;">
                    <table style="
                      width: 100%; 
                      border-collapse: collapse; 
                      font-size: 14px;
                      background: var(--color-bg-card);
                      border-radius: 8px;
                      overflow: hidden;
                      box-shadow: 0 1px 3px var(--color-shadow-sm);
                    ">
                      <thead>
                        <tr style="background: var(--color-bg-tertiary);">
                          <th style="
                            padding: 12px 16px; 
                            text-align: left; 
                            font-weight: 600; 
                            color: var(--color-text-primary);
                            border-bottom: 1px solid var(--color-border-primary);
                          ">Name</th>
                          <th style="
                            padding: 12px 16px; 
                            text-align: left; 
                            font-weight: 600; 
                            color: var(--color-text-primary);
                            border-bottom: 1px solid var(--color-border-primary);
                          ">Color</th>
                          <th style="
                            padding: 12px 16px; 
                            text-align: left; 
                            font-weight: 600; 
                            color: var(--color-text-primary);
                            border-bottom: 1px solid var(--color-border-primary);
                          ">Fleet</th>
                          <th style="
                            padding: 12px 16px; 
                            text-align: left; 
                            font-weight: 600; 
                            color: var(--color-text-primary);
                            border-bottom: 1px solid var(--color-border-primary);
                          ">Visible</th>
                          <th style="
                            padding: 12px 16px; 
                            text-align: left; 
                            font-weight: 600; 
                            color: var(--color-text-primary);
                            border-bottom: 1px solid var(--color-border-primary);
                          ">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sources().map((source, index) => (
                          <tr style={`
                            background: ${index % 2 === 0 ? 'var(--color-bg-card)' : 'var(--color-bg-secondary)'};
                            border-bottom: 1px solid var(--color-border-primary);
                          `}>
                            <td style="
                              padding: 12px 16px; 
                              color: var(--color-text-primary);
                              font-weight: 500;
                            ">{source.source_name}</td>
                            <td style="padding: 12px 16px;">
                              <div 
                                onClick={() => toggleColorPicker(source.source_id)}
                                style={`
                                  width: 24px; 
                                  height: 24px; 
                                  border-radius: 6px; 
                                  background-color: ${source.color}; 
                                  border: 2px solid var(--color-border-primary);
                                  cursor: pointer;
                                  transition: all 0.2s ease;
                                `}
                                onMouseEnter={(e: MouseEvent) => {
                                  (e.target as HTMLElement).style.transform = 'scale(1.1)';
                                  (e.target as HTMLElement).style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
                                }}
                                onMouseLeave={(e: MouseEvent) => {
                                  (e.target as HTMLElement).style.transform = 'scale(1)';
                                  (e.target as HTMLElement).style.boxShadow = 'none';
                                }}
                              />
                            </td>
                            <td style="padding: 12px 16px;">
                              <label style="
                                display: flex; 
                                align-items: center; 
                                cursor: pointer;
                                gap: 8px;
                              ">
                                <input
                                  type="checkbox"
                                  checked={source.fleet === 1}
                                  onChange={() =>
                                    handleUpdateSource(source.source_id, "fleet", source.fleet === 1 ? 0 : 1)
                                  }
                                  style="
                                    width: 16px; 
                                    height: 16px; 
                                    accent-color: var(--color-primary);
                                  "
                                />
                                <span style="color: var(--color-text-primary); font-size: 12px;">
                                  {source.fleet === 1 ? 'Yes' : 'No'}
                                </span>
                              </label>
                            </td>
                            <td style="padding: 12px 16px;">
                              <label style="
                                display: flex; 
                                align-items: center; 
                                cursor: pointer;
                                gap: 8px;
                              ">
                                <input
                                  type="checkbox"
                                  checked={source.visible === 1}
                                  onChange={() =>
                                    handleUpdateSource(source.source_id, "visible", source.visible === 1 ? 0 : 1)
                                  }
                                  style="
                                    width: 16px; 
                                    height: 16px; 
                                    accent-color: var(--color-primary);
                                  "
                                />
                                <span style="color: var(--color-text-primary); font-size: 12px;">
                                  {source.visible === 1 ? 'Yes' : 'No'}
                                </span>
                              </label>
                            </td>
                            <td style="padding: 12px 16px;">
                              <button 
                                onClick={() => handleRemoveSource(source.source_id)}
                                title="Remove source"
                                class="builder-form-icon-button-delete"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  <path d="M3 6H5H21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                  <path d="M8 6V4C8 3.46957 8.21071 2.96086 8.58579 2.58579C8.96086 2.21071 9.46957 2 10 2H14C14.5304 2 15.0391 2.21071 15.4142 2.58579C15.7893 2.96086 16 3.46957 16 4V6M19 6V20C19 20.5304 18.7893 21.0391 18.4142 21.4142C18.0391 21.7893 17.5304 22 17 22H7C6.46957 22 5.96086 21.7893 5.58579 21.4142C5.21071 21.0391 5 20.5304 5 20V6H19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style="
                    margin-top: 12px; 
                    padding: 12px; 
                    background: var(--color-bg-tertiary); 
                    border-radius: 6px;
                    font-size: 12px;
                    color: var(--color-text-secondary);
                  ">
                    <p style="margin: 0 0 4px 0;"><strong>Fleet:</strong> Will be grouped into fleet data summary reports and not shown individually.</p>
                    <p style="margin: 0;"><strong>Visible:</strong> Individual and fleet summaries will only include visible data sources.</p>
                  </div>
                  <div class="project-info-sources-add-more-wrap">
                    <button
                      type="button"
                      class="builder-form-button-secondary project-info-sources-add-btn"
                      onClick={openAddSourceModal}
                    >
                      + Add Source
                    </button>
                  </div>
                </Show>
              </div>
            </div>

            {/* Right Column - User Management */}
            <div class="right-column">
              <div style="
                background: var(--color-bg-card); 
                border-radius: 12px; 
                padding: 24px; 
                box-shadow: 0 2px 8px var(--color-shadow-sm);
                border: 1px solid var(--color-border-primary);
                transition: all 0.3s ease;
              ">
                <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: var(--color-text-primary); transition: color 0.3s ease;">
                  Team Management
                </h3>
                <div style="overflow-x: auto;">
                  <table style="
                    width: 100%; 
                    border-collapse: collapse; 
                    font-size: 14px;
                    background: var(--color-bg-card);
                    border-radius: 8px;
                    overflow: hidden;
                    box-shadow: 0 1px 3px var(--color-shadow-sm);
                  ">
                    <thead>
                      <tr style="background: var(--color-bg-tertiary);">
                        <th style="
                          padding: 12px 16px; 
                          text-align: left; 
                          font-weight: 600; 
                          color: var(--color-text-primary);
                          border-bottom: 1px solid var(--color-border-primary);
                        ">Email</th>
                        <th style="
                          padding: 12px 16px; 
                          text-align: left; 
                          font-weight: 600; 
                          color: var(--color-text-primary);
                          border-bottom: 1px solid var(--color-border-primary);
                        ">Permission</th>
                        <th style="
                          padding: 12px 16px; 
                          text-align: left; 
                          font-weight: 600; 
                          color: var(--color-text-primary);
                          border-bottom: 1px solid var(--color-border-primary);
                        ">Status</th>
                        <th style="
                          padding: 12px 16px; 
                          text-align: left; 
                          font-weight: 600; 
                          color: var(--color-text-primary);
                          border-bottom: 1px solid var(--color-border-primary);
                        ">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingUsers().map((user, index) => (
                        <tr style={`
                          background: ${index % 2 === 0 ? 'var(--color-bg-card)' : 'var(--color-bg-secondary)'};
                          border-bottom: 1px solid var(--color-border-primary);
                        `}>
                          <td style="
                            padding: 12px 16px; 
                            color: var(--color-text-primary);
                            font-weight: 500;
                          ">{user.email}</td>
                          <td style="padding: 12px 16px; position: relative;" data-permission-dropdown>
                            {editingPermission() === user.email ? (
                              <div style="
                                position: absolute;
                                top: 100%;
                                left: 0;
                                z-index: 1000;
                                background: var(--color-bg-card);
                                border: 1px solid var(--color-border-primary);
                                border-radius: 8px;
                                box-shadow: 0 4px 12px var(--color-shadow-md);
                                min-width: 160px;
                                margin-top: 4px;
                              ">
                                {permissionLevels.map((permission) => (
                                  <button
                                    onClick={() => handleUpdateUserPermission(user.email, permission, user.status)}
                                    style={`
                                      display: block;
                                      width: 100%;
                                      padding: 8px 12px;
                                      text-align: left;
                                      background: ${user.permission === permission ? 'var(--color-bg-tertiary)' : 'transparent'};
                                      color: var(--color-text-primary);
                                      border: none;
                                      cursor: pointer;
                                      font-size: 13px;
                                      text-transform: capitalize;
                                      transition: background-color 0.2s ease;
                                    `}
                                    onMouseEnter={(e: MouseEvent) => {
                                      if (user.permission !== permission) {
                                        (e.target as HTMLElement).style.background = 'var(--color-bg-secondary)';
                                      }
                                    }}
                                    onMouseLeave={(e: MouseEvent) => {
                                      if (user.permission !== permission) {
                                        (e.target as HTMLElement).style.background = 'transparent';
                                      }
                                    }}
                                  >
                                    {permission}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            <button
                              onClick={(e: MouseEvent) => {
                                e.stopPropagation();
                                setEditingPermission(editingPermission() === user.email ? null : user.email);
                              }}
                              style={`
                                background: var(--color-bg-tertiary);
                                color: var(--color-text-primary);
                                padding: 4px 12px;
                                border-radius: 4px;
                                font-size: 12px;
                                font-weight: 500;
                                text-transform: capitalize;
                                border: 1px solid var(--color-border-primary);
                                cursor: pointer;
                                transition: all 0.2s ease;
                                display: inline-flex;
                                align-items: center;
                                gap: 6px;
                              `}
                              onMouseEnter={(e: MouseEvent) => {
                                (e.target as HTMLElement).style.background = 'var(--color-bg-secondary)';
                                (e.target as HTMLElement).style.borderColor = 'var(--color-primary)';
                              }}
                              onMouseLeave={(e: MouseEvent) => {
                                (e.target as HTMLElement).style.background = 'var(--color-bg-tertiary)';
                                (e.target as HTMLElement).style.borderColor = 'var(--color-border-primary)';
                              }}
                            >
                              {user.permission}
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                              </svg>
                            </button>
                          </td>
                          <td style="padding: 12px 16px;">
                            {user.status === "active" ? (
                              <div style="
                                display: flex; 
                                align-items: center; 
                                gap: 6px;
                                color: #10b981;
                                font-size: 12px;
                                font-weight: 500;
                              ">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  <path d="M9 12L11 14L15 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                  <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                Active
                              </div>
                            ) : user.status === "invited" ? (
                              <div style="
                                display: flex; 
                                align-items: center; 
                                gap: 6px;
                                color: #3b82f6;
                                font-size: 12px;
                                font-weight: 500;
                              ">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  <path d="M4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6C2 4.9 2.9 4 4 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                  <polyline points="22,6 12,13 2,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                                Invited
                              </div>
                            ) : (
                              <div style="
                                display: flex; 
                                align-items: center; 
                                gap: 6px;
                                color: #ef4444;
                                font-size: 12px;
                                font-weight: 500;
                              ">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                                  <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2"/>
                                  <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2"/>
                                </svg>
                                Pending
                              </div>
                            )}
                          </td>
                          <td style="padding: 12px 16px;">
                            <div style="display: flex; gap: 8px; align-items: center;">
                              <button 
                                onClick={() => handleSendInvite(user.email, user.permission)}
                                title="Send Invite"
                                class="builder-form-icon-button"
                                style="
                                  background: var(--color-bg-tertiary);
                                  border: 1px solid var(--color-border-primary);
                                  color: var(--color-text-primary);
                                  padding: 6px;
                                  border-radius: 4px;
                                  cursor: pointer;
                                  transition: all 0.2s ease;
                                  display: flex;
                                  align-items: center;
                                  justify-content: center;
                                "
                                onMouseEnter={(e: MouseEvent) => {
                                  (e.target as HTMLElement).style.background = 'var(--color-bg-secondary)';
                                  (e.target as HTMLElement).style.borderColor = 'var(--color-primary)';
                                }}
                                onMouseLeave={(e: MouseEvent) => {
                                  (e.target as HTMLElement).style.background = 'var(--color-bg-tertiary)';
                                  (e.target as HTMLElement).style.borderColor = 'var(--color-border-primary)';
                                }}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  <path d="M4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6C2 4.9 2.9 4 4 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                  <polyline points="22,6 12,13 2,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                              </button>
                              <button 
                                onClick={() => handleRemovePendingUser(user.email)}
                                title="Remove user"
                                class="builder-form-icon-button-delete"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  <path d="M3 6H5H21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                  <path d="M8 6V4C8 3.46957 8.21071 2.96086 8.58579 2.58579C8.96086 2.21071 9.46957 2 10 2H14C14.5304 2 15.0391 2.21071 15.4142 2.58579C15.7893 2.96086 16 3.46957 16 4V6M19 6V20C19 20.5304 18.7893 21.0391 18.4142 21.4142C18.0391 21.7893 17.5304 22 17 22H7C6.46957 22 5.96086 21.7893 5.58579 21.4142C5.21071 21.0391 5 20.5304 5 20V6H19Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style="
                  margin-top: 12px; 
                  padding: 12px; 
                  background: var(--color-bg-tertiary); 
                  border-radius: 6px;
                  font-size: 12px;
                  color: var(--color-text-secondary);
                ">
                  <p style="margin: 0 0 4px 0;"><strong>Note:</strong> Users listed above will be invited to see data and reporting for any visible data sources listed in this project.</p>
                  <p style="margin: 0 0 4px 0;"><strong>Permissions:</strong> Administrators & publishers can add and modify data. Contributors can make comments. Readers can only view content.</p>
                  <p style="margin: 0;"><strong>Status:</strong> Users with a green check have registered and logged into the project. Those with red crosses have not.</p>
                </div>
                
                <div style="margin-top: 16px;">
                  <div class="form-group">
                    <label for="email-input" class="form-label">Invite More Users</label>
                    <div class="input-container">
                      <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6C2 4.9 2.9 4 4 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <polyline points="22,6 12,13 2,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      <input 
                        id="email-input" 
                        type="text" 
                        value={emailInput()} 
                        onInput={(e) => setEmailInput((e.target as HTMLInputElement).value)} 
                        placeholder="Enter email addresses separated by commas"
                        class="form-input"
                      />
                    </div>
                    <p class="form-help-text">Separate multiple email addresses with commas</p>
                    <button class="builder-form-button px-6 py-3 font-semibold" type="button" onClick={handleAddUsers} style="margin-top: 8px;">
                      <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path d="M16 21V19C16 17.9391 15.5786 16.9217 14.8284 16.1716C14.0783 15.4214 13.0609 15 12 15H5C3.93913 15 2.92172 15.4214 2.17157 16.1716C1.42143 16.9217 1 17.9391 1 19V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <circle cx="8.5" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <line x1="20" y1="8" x2="20" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <line x1="23" y1="11" x2="17" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      Add Users
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>

        <Show when={showModal()}>
          <ColorPicker colors={colors} onSelect={handleColorSelect} />
        </Show>

        <Show when={showAddSourceModal()}>
          <div
            class={`modal ${themeStore.isDark() ? "dark" : "light"}`}
            role="presentation"
            onClick={() => {
              if (!addingSource()) closeAddSourceModal();
            }}
          >
            <div
              class="modal-dialog project-info-add-source-modal-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="add-source-modal-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div class="modal-content">
                <div class="modal-header">
                  <h2 class="modal-title" id="add-source-modal-title">
                    Add data source
                  </h2>
                  <button
                    type="button"
                    class="close"
                    aria-label="Close"
                    disabled={addingSource()}
                    onClick={() => closeAddSourceModal()}
                  >
                    ×
                  </button>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleAddSource();
                  }}
                >
                  <div class="modal-body project-info-add-source-modal-body">
                    <div class="form-group">
                      <label for="add-source-modal-input" class="form-label">
                        Source name
                      </label>
                      <input
                        id="add-source-modal-input"
                        type="text"
                        class="form-input"
                        placeholder="e.g. Boat name or device id"
                        value={newSourceName()}
                        disabled={addingSource()}
                        onInput={(e) => setNewSourceName((e.target as HTMLInputElement).value)}
                        autocomplete="off"
                        autofocus
                      />
                    </div>
                  </div>
                  <div class="modal-footer">
                    <button
                      type="button"
                      class="builder-form-button-secondary px-4 py-2"
                      disabled={addingSource()}
                      onClick={() => {
                        if (!addingSource()) closeAddSourceModal();
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      class="builder-form-button-success px-4 py-2"
                      disabled={addingSource()}
                    >
                      {addingSource() ? "Adding…" : "Add"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </Show>
      </Show>

      <BackButton />
    </div>
    </Show>
    </>
  );
};
