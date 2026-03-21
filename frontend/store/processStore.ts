import { createSignal } from "solid-js";
import { debug, log, warn } from "../utils/console";
import { sseManager } from "./sseManager";

export interface ProcessState {
  process_id: string;
  type: 'script_execution' | 'video_upload';
  status: 'running' | 'complete' | 'timeout' | 'error';
  messages: string[];
  latestMessage: string;
  timestamp: number;
  completionData?: any; // Store completion data for toasts
  showToast?: boolean; // Explicit flag to show toast (default: false for script_execution, true for video_upload)
}

export interface ProcessMessage {
  process_id: string;
  type: 'script_execution' | 'video_upload';
  event: 'process_complete' | 'process_timeout' | 'upload_progress' | 'script_progress' | 'progress_event' | 'script_output';
  text: string;
  now: number;
  data?: any;
  toast?: boolean; // Explicit flag from SSE message to show toast
}

class ProcessStore {
  private processes = createSignal<Map<string, ProcessState>>(new Map());
  private listeners = new Map<string, Set<() => void>>();
  private globalListeners = new Set<() => void>();
  private activeModalProcessId = createSignal<string | null>(null);
  private userDismissedProcesses = new Set<string>();
  private suppressToastProcessIds = new Set<string>(); // Process IDs that should not show toasts
  private batchSuppressMode = false; // If true, suppress all script_execution toasts during batch operations

  get processesMap() {
    return this.processes[0]();
  }

  get processesList() {
    return Array.from(this.processes[0]().values());
  }

  // Subscribe to changes for a specific process
  subscribe(process_id: string, listener: () => void) {
    if (!this.listeners.has(process_id)) {
      this.listeners.set(process_id, new Set());
    }
    this.listeners.get(process_id)!.add(listener);
    return () => {
      this.listeners.get(process_id)?.delete(listener);
    };
  }

  // Subscribe to global changes (for toasts)
  subscribeGlobal(listener: () => void) {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  private notify(process_id?: string) {
    // Notify specific process listeners
    if (process_id) {
      this.listeners.get(process_id)?.forEach(listener => listener());
    }
    // Notify global listeners
    this.globalListeners.forEach(listener => listener());
  }

  // Manually start a process (for cases where process is started before first message)
  startProcess(process_id: string, processType: 'script_execution' | 'video_upload', showToast?: boolean) {
    debug(`[ProcessStore] Manually starting process: ${process_id} (${processType}), showToast: ${showToast}`);
    
    // Notify SSE manager that a new process has started
    sseManager.onProcessStart(process_id, processType);
    
    // Create initial process state
    const [, setProcesses] = this.processes;
    setProcesses(prev => {
      const newMap = new Map(prev);
      if (!newMap.has(process_id)) {
        // If showToast is explicitly provided, use it; otherwise use defaults
        // Default: video_upload shows toasts, script_execution does not
        const defaultShowToast = processType === 'video_upload' ? true : false;
        const finalShowToast = showToast !== undefined ? showToast : defaultShowToast;
        const newProcess: ProcessState = {
          process_id,
          type: processType,
          status: 'running',
          messages: [],
          latestMessage: 'Process started',
          timestamp: Date.now(),
          showToast: finalShowToast
        };
        newMap.set(process_id, newProcess);
      } else {
        // Process already exists (e.g., created by addMessage from SSE)
        // ALWAYS update showToast if explicitly provided, even if process exists
        const existing = newMap.get(process_id)!;
        if (showToast !== undefined && existing.showToast !== showToast) {
          const updated = { ...existing, showToast };
          newMap.set(process_id, updated);
          
          // If process is already completed and we're enabling showToast, notify global listeners
          // This allows GlobalToast to re-check and show the toast even if it was skipped before
          if ((existing.status === 'complete' || existing.status === 'timeout') && showToast === true) {
            this.notify(); // Notify global listeners to re-check completed processes
          }
        }
      }
      return newMap;
    });
    
    this.notify(process_id);
  }

  // Add a message to a process
  addMessage(process_id: string, message: ProcessMessage) {
    const [, setProcesses] = this.processes;
    setProcesses(prev => {
      const newMap = new Map(prev);
      const existing = newMap.get(process_id);
      
      if (existing) {
        // Update existing process
        // If message has explicit toast flag, update it; otherwise preserve existing showToast
        // This is critical - we don't want messages to reset showToast that was set by startProcess
        const showToast = message.toast !== undefined ? message.toast : existing.showToast;
        const updated: ProcessState = {
          ...existing,
          messages: [...existing.messages, message.text],
          latestMessage: message.text,
          timestamp: message.now,
          showToast: showToast // Preserve existing showToast unless message explicitly sets it
        };
        newMap.set(process_id, updated);
      } else {
        // Create new process
        // Default: video_upload shows toasts, script_execution does not (unless explicitly set)
        const defaultShowToast = message.type === 'video_upload' ? true : false;
        const showToast = message.toast !== undefined ? message.toast : defaultShowToast;
        const newProcess: ProcessState = {
          process_id,
          type: message.type,
          status: 'running',
          messages: [message.text],
          latestMessage: message.text,
          timestamp: message.now,
          showToast: showToast
        };
        newMap.set(process_id, newProcess);
        
        // Notify SSE manager that a new process has started
        sseManager.onProcessStart(process_id, message.type);
      }
      
      return newMap;
    });
    
    this.notify(process_id);
  }

  // Complete a process
  completeProcess(process_id: string, status: 'complete' | 'timeout' | 'error' = 'complete', completionData?: any) {
    const [, setProcesses] = this.processes;
    let wasUpdated = false;
    let processType: 'script_execution' | 'video_upload' | undefined;
    
    setProcesses(prev => {
      const newMap = new Map(prev);
      const existing = newMap.get(process_id);
      
      if (existing) {
        // Prevent duplicate completion
        if (existing.status === 'complete' || existing.status === 'timeout' || existing.status === 'error') {
          debug(`[ProcessStore] Process ${process_id} already completed with status ${existing.status}, ignoring duplicate completion`);
          return newMap; // Return unchanged map - this prevents notify() from being called
        }
        const updated: ProcessState = {
          ...existing,
          status,
          completionData
          // showToast is preserved from existing via spread operator
        };
        newMap.set(process_id, updated);
        wasUpdated = true;
        processType = existing.type;
        
      } else {
        // Process doesn't exist yet - this can happen if completion message arrives before startProcess
        // Create it with default showToast based on type (inferred from completionData or default to false)
        debug(`[ProcessStore] Process ${process_id} not found when trying to complete - creating it now`);
        const inferredType = completionData?.type || 'script_execution';
        const defaultShowToast = inferredType === 'video_upload' ? true : false;
        const newProcess: ProcessState = {
          process_id,
          type: inferredType as 'script_execution' | 'video_upload',
          status,
          messages: [],
          latestMessage: 'Process completed',
          timestamp: Date.now(),
          showToast: defaultShowToast,
          completionData
        };
        newMap.set(process_id, newProcess);
        wasUpdated = true;
        processType = inferredType as 'script_execution' | 'video_upload';
      }
      
      return newMap;
    });
    
    // Only notify if the process was actually updated (not a duplicate)
    if (wasUpdated) {
      if (processType) {
        // Notify SSE manager that the process has completed
        sseManager.onProcessComplete(process_id, processType);
      }
      this.notify(process_id);
      this.notify(); // Notify global listeners for toast
    }
  }

  // Get a specific process
  getProcess(process_id: string): ProcessState | undefined {
    return this.processes[0]().get(process_id);
  }

  // Get all completed processes (for cleanup)
  getCompletedProcesses(): ProcessState[] {
    return this.processesList.filter(p => 
      p.status === 'complete' || p.status === 'timeout' || p.status === 'error'
    );
  }

  // Modal control API
  openModal(process_id: string) {
    log('[ProcessStore] Opening modal for process:', process_id);
    const [, setActive] = this.activeModalProcessId;
    setActive(process_id);
    // Remove from dismissed set when explicitly opened
    this.userDismissedProcesses.delete(process_id);
    this.notify();
    log('[ProcessStore] Modal opened, active ID is now:', this.activeModalProcessId[0]());
  }

  closeModal() {
    const currentId = this.activeModalProcessId[0]();
    if (currentId) {
      // Mark this process as user-dismissed
      this.userDismissedProcesses.add(currentId);
    }
    const [, setActive] = this.activeModalProcessId;
    setActive(null);
    this.notify();
  }

  getActiveModalProcessId(): string | null {
    return this.activeModalProcessId[0]();
  }

  // Clear dismissed processes (call when starting a new process)
  clearDismissedProcesses() {
    this.userDismissedProcesses.clear();
  }

  // Clear all processes (for debugging/cleanup)
  clearAllProcesses() {
    const [, setProcesses] = this.processes;
    setProcesses(new Map());
    this.userDismissedProcesses.clear();
    const [, setActive] = this.activeModalProcessId;
    setActive(null);
    this.notify();
  }

  // Get all processes (for debugging)
  getAllProcesses(): ProcessState[] {
    return Array.from(this.processes[0]().values());
  }

  // Clean up old completed processes (older than 10 minutes)
  cleanupOldProcesses() {
    const [, setProcesses] = this.processes;
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes
    
    setProcesses(prev => {
      const newMap = new Map(prev);
      let removed = 0;
      
      for (const [processId, process] of newMap.entries()) {
        const age = now - process.timestamp;
        const isCompleted = process.status === 'complete' || process.status === 'timeout' || process.status === 'error';
        
        if (isCompleted && age > maxAge) {
          newMap.delete(processId);
          removed++;
        }
      }
      
      if (removed > 0) {
        debug(`[ProcessStore] Cleaned up ${removed} old completed processes`);
      }
      
      return newMap;
    });
  }

  // Remove a process (cleanup)
  removeProcess(process_id: string) {
    const [, setProcesses] = this.processes;
    setProcesses(prev => {
      const newMap = new Map(prev);
      newMap.delete(process_id);
      return newMap;
    });
    
    this.notify(process_id);
  }

  // Clear all processes
  clearAll() {
    const [, setProcesses] = this.processes;
    setProcesses(new Map());
    this.notify();
  }

  // Check if any processes are running
  hasRunningProcesses(): boolean {
    return this.processesList.some(p => p.status === 'running');
  }

  // Get running processes by type
  getRunningProcessesByType(type: 'script_execution' | 'video_upload'): ProcessState[] {
    return this.processesList.filter(p => p.status === 'running' && p.type === type);
  }

  // Suppress toasts for specific process IDs (e.g., during batch uploads)
  suppressToastForProcess(process_id: string) {
    this.suppressToastProcessIds.add(process_id);
    debug(`[ProcessStore] Suppressing toasts for process: ${process_id}`);
  }

  // Check if toasts should be suppressed for a process
  shouldSuppressToast(process_id: string): boolean {
    // Check if this specific process ID is suppressed
    if (this.suppressToastProcessIds.has(process_id)) {
      debug(`[ProcessStore] Toast suppression check for ${process_id}: SUPPRESSED (specific)`);
      return true;
    }
    
    // Check if we're in batch mode and this is a script_execution process
    if (this.batchSuppressMode) {
      const process = this.getProcess(process_id);
      if (process && process.type === 'script_execution') {
        debug(`[ProcessStore] Toast suppression check for ${process_id}: SUPPRESSED (batch mode)`);
        return true;
      }
    }
    
    return false;
  }

  // Enable batch suppression mode (suppress all script_execution toasts during batch operations)
  enableBatchSuppressMode() {
    this.batchSuppressMode = true;
    debug('[ProcessStore] Batch suppress mode ENABLED - all script_execution toasts will be suppressed');
  }

  // Disable batch suppression mode
  disableBatchSuppressMode() {
    this.batchSuppressMode = false;
    debug('[ProcessStore] Batch suppress mode DISABLED');
  }

  // Clear suppressed process IDs (call when batch is complete)
  clearSuppressedProcessIds() {
    this.suppressToastProcessIds.clear();
    this.disableBatchSuppressMode();
  }

  // Explicitly set showToast flag for a process (for client-side toast control)
  setShowToast(process_id: string, showToast: boolean) {
    const [, setProcesses] = this.processes;
    setProcesses(prev => {
      const newMap = new Map(prev);
      const existing = newMap.get(process_id);
      
      if (existing) {
        const updated: ProcessState = {
          ...existing,
          showToast: showToast
        };
        newMap.set(process_id, updated);
        debug(`[ProcessStore] Set showToast=${showToast} for process ${process_id}`);
      } else {
        warn(`[ProcessStore] Process ${process_id} not found when trying to set showToast`);
      }
      
      return newMap;
    });
    
    this.notify(process_id);
    this.notify(); // Notify global listeners
  }
}

export const processStore = new ProcessStore();

// Expose debugging methods to window for console access
if (typeof window !== 'undefined') {
  (window as any).processStore = {
    getAllProcesses: () => processStore.getAllProcesses(),
    clearAllProcesses: () => processStore.clearAllProcesses(),
    getProcess: (id: string) => processStore.getProcess(id),
    cleanupOldProcesses: () => processStore.cleanupOldProcesses()
  };
}
