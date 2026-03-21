import { createSignal, onMount, For } from "solid-js";
import { useNavigate } from "@solidjs/router";
import BackButton from "../components/buttons/BackButton";
import { getData, postData } from "../utils/global";
import { logPageLoad } from "../utils/logging";
import { error as logError, log } from "../utils/console";
import { user } from "../store/userStore";
import { apiEndpoints } from "@config/env";
import { toastStore } from "../store/toastStore";

import { persistantStore } from "../store/persistantStore";
const { setSelectedProjectId, selectedProjectId } = persistantStore;

interface Class {
  class_id: number;
  class_name: string;
}

export default function Project() {
  const navigate = useNavigate();
  const [classes, setClasses] = createSignal<Class[]>([]);
  const [projectName, setProjectName] = createSignal("");
  const [selectedClassId, setSelectedClassId] = createSignal(0);

  const fetchClasses = async () => {
    const controller = new AbortController();
    
    try {
      const response = await getData(apiEndpoints.app.classes, controller.signal)

      if (!response.success) {
        logError(`[Project] API returned failure:`, response);
        throw new Error("Failed to fetch classes");
      }

      const data = response.data;
      // Use setter function form to ensure reactivity
      setClasses(data);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Request was aborted
      } else {
        logError("[Project] Error fetching classes:", error);
      }
    }
  };

  const handleAddProject = async () => {
    // Validate form inputs
    const trimmedProjectName = projectName().trim();
    if (!trimmedProjectName) {
      toastStore.showToast('error', 'Validation Error', 'Please enter a project name');
      return;
    }

    if (selectedClassId() === 0) {
      toastStore.showToast('error', 'Validation Error', 'Please select a class');
      return;
    }

    const controller = new AbortController();
    
    try {
      log(`[Project] Submitting project creation request...`);
      const response = await postData(apiEndpoints.app.projects, {
        project_name: trimmedProjectName,
        class_id: selectedClassId(),
        user_id: user()?.user_id,
      }, controller.signal)

      log(`[Project] Response received:`, response);

      if (!response || !response.success) {
        const errorMessage = response?.message || `Failed to add project: ${trimmedProjectName}`;
        logError(`[Project] API returned failure:`, response);
        toastStore.showToast('error', 'Failed to Add Project', errorMessage);
        return;
      }

      // Success - show toast and navigate
      const projectId = response.data;
      log(`[Project] Project created successfully with ID: ${projectId}`);
      
      // Set the project ID - this persists to localStorage immediately via createPersistentSignal
      setSelectedProjectId(projectId);
      
      // Verify it was set correctly (should be immediate since createPersistentSignal is synchronous)
      const verifyProjectId = selectedProjectId();
      if (verifyProjectId === projectId) {
        log(`[Project] ✓ Selected project ID confirmed: ${verifyProjectId}`);
      } else {
        logError(`[Project] ✗ Selected project ID mismatch! Expected: ${projectId}, Got: ${verifyProjectId}`);
      }
      
      // Also verify localStorage directly
      try {
        const storedValue = localStorage.getItem('selectedProjectId');
        const parsedValue = storedValue ? JSON.parse(storedValue) : null;
        if (parsedValue === projectId) {
          log(`[Project] ✓ localStorage confirmed: selectedProjectId = ${parsedValue}`);
        } else {
          logError(`[Project] ✗ localStorage mismatch! Expected: ${projectId}, Got: ${parsedValue}`);
        }
      } catch (e) {
        logError(`[Project] Error reading from localStorage:`, e);
      }
      
      // Show success toast
      toastStore.showToast('success', 'Project Added', `Project "${trimmedProjectName}" has been created successfully`);
      
      // Navigate to dashboard - selectedProjectId is already persisted
      log(`[Project] Navigating to dashboard with selectedProjectId: ${selectedProjectId()}`);
      window.location.href = '/dashboard';
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logError("Error adding project:", error);
        const errorMessage = error.message || 'An unexpected error occurred while adding the project';
        toastStore.showToast('error', 'Error Adding Project', errorMessage);
      }
    }
  }

  onMount(async () => {
    await fetchClasses();
    await logPageLoad('Project.tsx', 'Add Project Page');
  });

  return (
    <div class="info-page">
      <div class="info-container">
        <h1>Add Project</h1>
        <form class="info-form" onSubmit={(e) => { e.preventDefault(); handleAddProject(); }}>
          <div class="form-group">
            <label>Project Name:</label>
            <input 
              type="text" 
              value={projectName()} 
              onInput={(e) => setProjectName((e.target as HTMLInputElement).value)}
              placeholder="Enter project name"
              required
            />
            <label>Class Name:</label>
            <select
              id="classname-input"
              value={selectedClassId()}
              onChange={(e) => {
                const target = e.target;
                if (target instanceof HTMLSelectElement) {
                  setSelectedClassId(Number(target.value));
                }
              }}
              required
            >
              <option value="0">Select a class</option>
              <For each={classes()}>
                {(cls) => (
                  <option value={cls.class_id}>{cls.class_name}</option>
                )}
              </For>
            </select>
          </div>
          <div class="form-group">
            <button type="submit">Add Project</button>
          </div>
        </form>
        <BackButton />
      </div>
    </div>
  );
}

