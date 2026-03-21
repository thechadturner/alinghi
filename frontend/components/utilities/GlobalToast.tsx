import { createSignal, Show, onCleanup, createEffect, onMount } from "solid-js";
import { toastStore } from "../../store/toastStore";
import { processStore } from "../../store/processStore";
import { log, warn } from "../../utils/console";

interface ToastAction {
  label: string;
  onClick: () => void;
  style?: string;
}

interface Toast {
  id: string;
  type: string;
  message: string;
  details?: string;
  actions?: ToastAction[];
}

export default function GlobalToast() {
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const [shownProcesses, setShownProcesses] = createSignal<Set<string>>(new Set());

  // Reuse a single AudioContext instance
  let audioContext: AudioContext | null = null;
  let audioContextInitialized = false;
  let resumeInProgress = false;
  
  const getAudioContext = (): AudioContext | null => {
    if (!audioContext) {
      // Don't create AudioContext until after user interaction
      return null;
    }
    return audioContext;
  };

  // Create AudioContext synchronously (must be called within user gesture handler)
  const createAudioContextSync = (): boolean => {
    if (audioContext) {
      // Already created
      return true;
    }
    
    try {
      // Create AudioContext synchronously - this must happen within user gesture event handler
      audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      return true;
    } catch (error) {
      // Ignore errors - AudioContext may not be available
      warn('[GlobalToast] Could not create AudioContext:', error);
      return false;
    }
  };

  // Resume AudioContext if suspended (can be called asynchronously)
  const resumeAudioContext = async (): Promise<boolean> => {
    if (!audioContext) {
      return false;
    }
    
    // Prevent concurrent resume attempts
    if (resumeInProgress) {
      return false;
    }
    
    // If already running, no need to resume
    if (audioContext.state === 'running') {
      audioContextInitialized = true;
      return true;
    }
    
    // Only resume if suspended
    if (audioContext.state !== 'suspended') {
      return false;
    }
    
    resumeInProgress = true;
    try {
      // Resume must be initiated within user gesture handler
      // The promise will resolve asynchronously, but initiation must be synchronous
      await audioContext.resume();
      
      // Verify context is actually running
      if (audioContext.state === 'running') {
        audioContextInitialized = true;
        return true;
      } else {
        // Context is still suspended - this can happen if resume wasn't called within gesture
        warn('[GlobalToast] AudioContext still suspended after resume attempt. State:', audioContext.state);
        return false;
      }
    } catch (error: any) {
      // Suppress the specific error about user gesture - browser will log it anyway
      const errorMessage = error?.message || String(error);
      if (!errorMessage.includes('user gesture') && !errorMessage.includes('not allowed to start')) {
        warn('[GlobalToast] Could not resume AudioContext:', error);
      }
      return false;
    } finally {
      resumeInProgress = false;
    }
  };

  // Initialize AudioContext - handles both creation and resume
  const initializeAudioContext = async () => {
    if (audioContextInitialized && audioContext) {
      // Already initialized, just ensure it's running
      if (audioContext.state === 'suspended') {
        await resumeAudioContext();
      }
      return;
    }
    
    // If not created yet, we can't create it here (must be in user gesture handler)
    if (!audioContext) {
      return;
    }
    
    // Context exists but may need resuming
    await resumeAudioContext();
  };

  // Initialize AudioContext only on user interaction (required by browser autoplay policies)
  onMount(() => {
    let hasInteracted = false;
    
    // Set up listeners for user interaction - create AudioContext synchronously within gesture handler
    const initOnInteraction = (event?: Event) => {
      // Only run when we have a trusted user event (required for AudioContext; avoids synthetic/script-driven events)
      if (!event || !(event as Event & { isTrusted?: boolean }).isTrusted) {
        return;
      }
      // Only initialize on actual user interaction events
      if (!hasInteracted) {
        hasInteracted = true;
        
        // Create AudioContext synchronously within the user gesture event handler
        if (createAudioContextSync() && audioContext) {
          if (audioContext.state === 'suspended') {
            // resume() must run in same tick as user gesture; catch to avoid unhandled rejection
            audioContext.resume().then(() => {
              audioContextInitialized = true;
            }).catch(() => {
              // Context not allowed to start (e.g. no real user gesture); leave uninitialized
            });
          } else {
            audioContextInitialized = true;
          }
        }
      } else if (audioContext?.state === 'suspended') {
        // Only attempt resume on subsequent trusted user events
        audioContext.resume().then(() => {}).catch(() => {});
      }
    };
    
    // Prefer click/keydown for first init (most reliably treated as user gesture by autoplay policy)
    const primaryGestureTypes = ['click', 'keydown'];
    const secondaryGestureTypes = ['mousedown', 'touchstart', 'pointerdown'];
    primaryGestureTypes.forEach(eventType => {
      window.addEventListener(eventType, initOnInteraction, { capture: true });
    });
    secondaryGestureTypes.forEach(eventType => {
      const passive = eventType === 'touchstart';
      window.addEventListener(eventType, initOnInteraction, { capture: true, passive });
    });
    
    // Cleanup on unmount
    onCleanup(() => {
      [...primaryGestureTypes, ...secondaryGestureTypes].forEach(eventType => {
        window.removeEventListener(eventType, initOnInteraction, { capture: true } as EventListenerOptions);
      });
    });
  });

  const playNotificationSound = async () => {
    try {
      const ctx = getAudioContext();
      
      // If AudioContext wasn't created yet (no user interaction), silently fail
      if (!ctx) {
        return;
      }
      
      // Resume AudioContext if suspended (required by modern browsers)
      // This can be async - resume operations don't need to be in gesture handler
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch (e) {
          // Resume failed - context may not be allowed to start
          warn('[GlobalToast] Could not resume AudioContext for sound playback');
          return;
        }
      }
      
      // Check if context is still suspended after resume attempt
      if (ctx.state === 'suspended') {
        warn('[GlobalToast] AudioContext suspended, cannot play sound');
        return;
      }
      
      // Ensure context is running before playing
      if (ctx.state !== 'running') {
        warn('[GlobalToast] AudioContext not running, cannot play sound');
        return;
      }
      
      log('[GlobalToast] Playing notification sound');
      
      const now = ctx.currentTime;
      
      // First tone - higher pitch, more noticeable
      const oscillator1 = ctx.createOscillator();
      const gainNode1 = ctx.createGain();
      
      oscillator1.type = 'sine';
      oscillator1.connect(gainNode1);
      gainNode1.connect(ctx.destination);
      
      oscillator1.frequency.setValueAtTime(800, now);
      oscillator1.frequency.linearRampToValueAtTime(1000, now + 0.1);
      
      gainNode1.gain.setValueAtTime(0, now);
      gainNode1.gain.linearRampToValueAtTime(0.4, now + 0.01);
      gainNode1.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
      
      oscillator1.start(now);
      oscillator1.stop(now + 0.25);
      
      // Second tone - plays shortly after first
      setTimeout(async () => {
        try {
          const ctx2 = getAudioContext();
          if (!ctx2) {
            return;
          }
          
          // Resume if suspended
          if (ctx2.state === 'suspended') {
            try {
              await ctx2.resume();
            } catch (e) {
              // Resume failed, skip second tone
              return;
            }
          }
          
          // Check if context is running before playing
          if (ctx2.state !== 'running') {
            return;
          }
          
          const now2 = ctx2.currentTime;
          const oscillator2 = ctx2.createOscillator();
          const gainNode2 = ctx2.createGain();
          
          oscillator2.type = 'sine';
          oscillator2.connect(gainNode2);
          gainNode2.connect(ctx2.destination);
          
          oscillator2.frequency.setValueAtTime(1000, now2);
          oscillator2.frequency.linearRampToValueAtTime(1200, now2 + 0.1);
          
          gainNode2.gain.setValueAtTime(0, now2);
          gainNode2.gain.linearRampToValueAtTime(0.35, now2 + 0.01);
          gainNode2.gain.exponentialRampToValueAtTime(0.01, now2 + 0.25);
          
          oscillator2.start(now2);
          oscillator2.stop(now2 + 0.25);
        } catch (e) {
          // Silently fail on second tone
        }
      }, 200);
    } catch (error: any) {
      log('[GlobalToast] Could not play notification sound:', error.message || error);
    }
  };

  createEffect(() => {
    let previousToastIds = new Set(toastStore.toastsList.map((t: Toast) => t.id));
    
    const unsubscribe = toastStore.subscribe(() => {
      const currentToasts = toastStore.toastsList;
      const currentToastIds = new Set(currentToasts.map((t: Toast) => t.id));
      
      // Check if any new toasts were added (by comparing IDs, not just count)
      const newToasts = currentToasts.filter((toast: Toast) => !previousToastIds.has(toast.id));
      
      if (newToasts.length > 0) {
        // Play sound for each new toast (but only once per toast)
        newToasts.forEach(() => {
          playNotificationSound();
        });
      }
      
      previousToastIds = currentToastIds;
      setToasts([...currentToasts]);
    });
    
    // Initial load
    setToasts([...toastStore.toastsList]);

    onCleanup(unsubscribe);
  });

  // Listen for process completion events
  createEffect(() => {
    // Track previous process states to detect status transitions
    // Map<process_id, previous_status>
    const previousProcessStates = new Map<string, 'running' | 'complete' | 'timeout' | 'error'>();
    
    // Debounce timer to prevent rapid-fire triggers from progress messages
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const DEBOUNCE_MS = 100; // Only check for completions every 100ms max
    
    // Use a local Set to track what we've shown in this callback execution
    // to prevent duplicates when notify() is called multiple times rapidly
    let shownInThisCallback = new Set<string>();
    
    const unsubscribe = processStore.subscribeGlobal(() => {
      // Debounce: Clear existing timer and set a new one
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      
      debounceTimer = setTimeout(() => {
        const allProcesses = processStore.processesList;
        const completedProcesses = processStore.getCompletedProcesses();
        const shown = shownProcesses();
        
        // Show toasts only for processes that have transitioned from 'running' to completed
        completedProcesses.forEach((process: any) => {
          // CRITICAL: Explicitly filter out any running processes
          if (process.status === 'running') {
            return; // Skip running processes - should never happen in getCompletedProcesses, but safety check
          }
          
          // Only process processes with completed status
          if (process.status !== 'complete' && process.status !== 'timeout' && process.status !== 'error') {
            return; // Skip any other status
          }
          
          const previousStatus = previousProcessStates.get(process.process_id);
          const currentStatus = process.status;
          
          // Only show toast if process transitioned from 'running' to completed
          // This prevents showing toasts on every progress message
          if (previousStatus !== 'running' && previousStatus !== undefined) {
            // Process was already completed or had a different previous status
            // Update the tracked state but don't show toast
            previousProcessStates.set(process.process_id, currentStatus);
            return;
          }
          
          // If this is the first time we see this process, it might have completed before we started tracking
          // In that case, only show if it's explicitly marked for toast
          if (previousStatus === undefined && currentStatus !== 'running') {
            // First time seeing this process and it's already completed
            // Only show if explicitly marked for toast (to handle edge cases)
            previousProcessStates.set(process.process_id, currentStatus);
            // Continue to check showToast below
          } else if (previousStatus === 'running') {
            // Process transitioned from running to completed - this is what we want!
            previousProcessStates.set(process.process_id, currentStatus);
            // Continue to show toast below
          } else {
            // Process status hasn't changed or is in an unexpected state
            return;
          }
          
          const isShown = shown.has(process.process_id);
          const shouldShowToast = process.showToast === true;
          
          // Skip if already processed in this callback
          if (shownInThisCallback.has(process.process_id)) {
            return;
          }
          
          // If already shown, skip (unless showToast changed from false to true)
          if (isShown) {
            if (shouldShowToast) {
              // This process was previously skipped but now has showToast: true
              // Remove from shown set and continue to show the toast
              setShownProcesses(prev => {
                const newSet = new Set(prev);
                newSet.delete(process.process_id);
                return newSet;
              });
            } else {
              // Already processed and still doesn't need toast - skip
              return;
            }
          }
          
          if (!shouldShowToast) {
            // Don't mark as shown yet - allow it to be re-checked if showToast is updated later
            // Only mark as shown if showToast is explicitly false (not just undefined)
            if (process.showToast === false) {
              setShownProcesses(prev => new Set([...prev, process.process_id]));
              shownInThisCallback.add(process.process_id);
            }
            return;
          }
          
          // Check if toasts should be suppressed for this process (e.g., during batch uploads)
          // This is a safety net - even if showToast is true, batch suppression can override
          const isSuppressed = processStore.shouldSuppressToast(process.process_id);
          if (isSuppressed) {
            setShownProcesses(prev => new Set([...prev, process.process_id]));
            shownInThisCallback.add(process.process_id);
            return;
          }
          
          // CRITICAL: Mark as shown immediately to prevent duplicates
          shownInThisCallback.add(process.process_id);
          setShownProcesses(prev => new Set([...prev, process.process_id]));
          
          // Show toast - only for processes that transitioned from running to completed
          showProcessToast(process);
        });
        
        // Update tracked states for all processes (including running ones)
        allProcesses.forEach((process: any) => {
          if (!previousProcessStates.has(process.process_id)) {
            // First time seeing this process - track its initial state
            previousProcessStates.set(process.process_id, process.status);
          } else {
            // Update tracked state if it changed
            const previousStatus = previousProcessStates.get(process.process_id);
            if (previousStatus !== process.status) {
              previousProcessStates.set(process.process_id, process.status);
            }
          }
        });
        
        // Clear the callback-local set after a short delay to allow for new notifications
        setTimeout(() => {
          shownInThisCallback.clear();
        }, 100);
      }, DEBOUNCE_MS);
    });

    onCleanup(() => {
      unsubscribe();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
    });
  });

  const showProcessToast = (process: any) => {
    const { type, latestMessage, completionData } = process;
    
    if (type === 'video_upload') {
      // Video upload completion toast
      const actions = completionData?.outputs?.[0]?.renditions?.find((r: any) => r.name === 'med_res') ? [{
        label: 'Review',
        onClick: () => {
          try {
            const medRes = completionData.outputs[0].renditions.find((r: any) => r.name === 'med_res');
            if (medRes?.file) {
              sessionStorage.setItem('video_review_path', medRes.file);
            }
          } catch {}
          try {
            window.history.pushState({}, '', '/video-sync');
            window.dispatchEvent(new PopStateEvent('popstate'));
          } catch {
            window.location.href = '/video-sync';
          }
        },
        style: "padding:6px 10px; font-size: 12px; background: #1e3a8a !important; color: white !important; border: 1px solid #1e3a8a !important; border-radius: 6px; cursor: pointer;"
      }] : undefined;

      toastStore.showToast('upload', latestMessage, '', actions);
      // Note: Sound will be played by the toastStore subscription effect above
      
    } else if (type === 'script_execution') {
      // Script execution completion toast
      // Check completion data to determine if script succeeded or failed
      const scriptSucceeded = completionData?.script_succeeded !== false; // Default to true if not specified
      const returnCode = completionData?.return_code;
      const hasErrorLines = completionData?.error_lines && completionData.error_lines.length > 0;
      // Only treat as failed by status, return code, or explicit script_succeeded.
      // Do not treat stderr output (error_lines) as failure when return_code === 0.
      const isFailure =
        process.status === 'timeout' ||
        process.status === 'error' ||
        !scriptSucceeded ||
        (returnCode !== undefined && returnCode !== 0);

      let details: string;
      let toastType: 'script' | 'error' = 'script';

      if (process.status === 'timeout') {
        details = 'Script execution timed out';
        toastType = 'error';
      } else if (isFailure) {
        // Script failed - use error_lines for message when available
        if (hasErrorLines && completionData.error_lines.length > 0) {
          const lastError = completionData.error_lines[completionData.error_lines.length - 1];
          details = lastError.length > 100 ? lastError.substring(0, 100) + '...' : lastError;
        } else if (returnCode !== undefined && returnCode !== 0) {
          details = `Script failed with return code ${returnCode}`;
        } else {
          details = 'Script execution failed';
        }
        toastType = 'error';
      } else {
        details = 'Script completed successfully';
        toastType = 'script';
      }
      
      toastStore.showToast(toastType, latestMessage || 'Script execution complete', details);
      // Note: Sound will be played by the toastStore subscription effect above
    } else {
      warn('[GlobalToast] Unknown process type for toast:', type);
    }
  };

  const getToastIcon = (type: string) => {
    switch (type) {
      case 'script': return '🐍';
      case 'upload': return '🎬'; // Movie camera icon to match original UploadToast
      case 'success': return '✅';
      case 'error': return '❌';
      case 'info': return 'ℹ️';
      default: return '📢';
    }
  };

  const getToastTitle = (type: string) => {
    switch (type) {
      case 'script': return 'Script execution complete';
      case 'upload': return 'Video processing completed'; // Match original UploadToast title
      case 'success': return 'Success';
      case 'error': return 'Error';
      case 'info': return 'Information';
      default: return 'Notification';
    }
  };

  return (
    <div style="position: fixed; right: 16px; bottom: 16px; z-index: 20000; display: flex; flex-direction: column; gap: 12px;">
      {toasts().map((toast) => {
        return (
        <div 
          key={toast.id}
          style="background: #f3f4f6; color: #000; padding: 14px 16px; border-radius: 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.35); max-width: 400px; min-width: 330px; animation: slideIn 0.3s ease-out;"
        >
          <div style="display:flex; align-items:center; gap:10px;">
            <div style="font-size:18px; line-height:1">{getToastIcon(toast.type)}</div>
            <div style="flex:1;">
              <div style="font-weight:600; font-size:14px; margin-bottom:2px;">
                {getToastTitle(toast.type)}
              </div>
              <div style="font-size: 13px; line-height: 1.35; opacity: 0.95;">
                {toast.message}
              </div>
              {toast.details && (
                <div style="margin-top:6px; font-size:12px; opacity:0.8;">
                  {toast.details}
                </div>
              )}
            </div>
            <div style="display:flex; gap:8px; align-items:center;">
              {toast.actions && toast.actions.map((action, index) => (
                <button
                  key={index}
                  onClick={action.onClick}
                  style={action.style || "padding:6px 10px; font-size: 12px; background: #1e3a8a; color: white; border: 1px solid #1e3a8a; border-radius: 6px; cursor: pointer;"}
                >
                  {action.label}
                </button>
              ))}
              <button
                aria-label="Close"
                title="Close"
                onClick={() => toastStore.removeToast(toast.id)}
                style="background:transparent;border:none;color:#6b7280;cursor:pointer;font-size:16px;padding:2px;"
              >
                ×
              </button>
            </div>
          </div>
        </div>
        );
      })}
    </div>
  );
}

// Add CSS animation
const style = document.createElement('style');
style.textContent = `
  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
`;
document.head.appendChild(style);

