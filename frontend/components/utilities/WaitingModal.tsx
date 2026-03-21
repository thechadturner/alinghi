import { createSignal, createEffect, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { formatSeconds } from "../../utils/global";
import { themeStore } from "../../store/themeStore";
import { sseManager } from "../../store/sseManager";
import { processStore } from "../../store/processStore";
import { debug } from "../../utils/console";

export interface WaitingModalProps {
  visible: boolean;
  process_id?: string | null;
  /** When set (e.g. multi-batch upload), accept messages from any of these process ids for status updates */
  acceptProcessIds?: string[];
  title?: string;
  subtitle?: string;
  closable?: boolean;
  customStatus?: string;
  disableAutoNavigation?: boolean;
  onClose?: () => void;
}

export default function WaitingModal(props: WaitingModalProps) {
    const [timeElapsed, setTimeElapsed] = createSignal(0);
    const [currentMessage, setCurrentMessage] = createSignal("Connecting...");
    const [hasReceivedSSEMessage, setHasReceivedSSEMessage] = createSignal(false);
    const [processId, setProcessId] = createSignal(props.process_id || null);
    const navigate = useNavigate();
    
    // Prioritize SSE messages over customStatus when SSE messages are available
    // Only use customStatus as fallback when no SSE messages have been received
    const displayStatus = () => {
        // If we've received SSE messages, always use them (they're more up-to-date)
        if (hasReceivedSSEMessage() && currentMessage() !== "Connecting...") {
            return currentMessage();
        }
        // Otherwise, use customStatus if provided and not empty, or fall back to currentMessage
        const customStatus = props.customStatus;
        return (customStatus && customStatus.trim() !== "") ? customStatus : currentMessage();
    };

    let interval: ReturnType<typeof setInterval> | undefined;

    // Timer for elapsed time
    createEffect(() => {
        interval = setInterval(() => {
            setTimeElapsed((prev) => prev + 1);
        }, 1000);

        onCleanup(() => {
            if (interval) {
                clearInterval(interval);
            }
        });
    });

    // Listen for SSE messages to get process_id and updates
    createEffect(() => {
        debug('[WaitingModal] Effect triggered, visible:', props.visible, 'process_id:', props.process_id);
        if (!props.visible) {
            debug('[WaitingModal] Modal not visible, returning');
            return;
        }

        debug('[WaitingModal] Modal is visible, starting setup');
        // Start with connecting message
        setCurrentMessage("Connecting...");
        
        // Check if process (or all acceptProcessIds) already complete when modal opens (handles instant completion e.g. skip-ffmpeg)
        const idsToCheck = (props.acceptProcessIds?.length ? props.acceptProcessIds : (props.process_id ? [props.process_id] : [])) as string[];
        if (idsToCheck.length > 0) {
            const allComplete = idsToCheck.every((pid) => {
                const p = processStore.getProcess(pid);
                return p && (p.status === 'complete' || p.status === 'timeout' || p.status === 'error');
            });
            if (allComplete && !props.disableAutoNavigation) {
                const last = idsToCheck.map((pid) => processStore.getProcess(pid)).filter(Boolean).pop();
                setCurrentMessage((last as any)?.latestMessage || "Process completed");
                setHasReceivedSSEMessage(true);
                setTimeout(() => {
                    if (props.onClose) props.onClose();
                    navigate('/dashboard', { replace: true });
                }, 2000);
                return;
            }
            if (allComplete) {
                const last = idsToCheck.map((pid) => processStore.getProcess(pid)).filter(Boolean).pop();
                setCurrentMessage((last as any)?.latestMessage || "All complete");
                setHasReceivedSSEMessage(true);
            }
        }
        
        // Subscribe to SSE messages to get process_id and updates
        debug('[WaitingModal] Subscribing to SSE messages...');
        const unsubscribe = sseManager.subscribe((message: any) => {
            debug('[WaitingModal] Received SSE message:', message);
            // Use the process_id from props if available, otherwise use the first one we get
            if (!processId()) {
                if (props.process_id) {
                    debug('[WaitingModal] Using process_id from props:', props.process_id);
                    setProcessId(props.process_id);
                } else if (message.process_id) {
                    debug('[WaitingModal] Using process_id from message:', message.process_id);
                    setProcessId(message.process_id);
                }
            }
            
            // Update message if this is for our process (or any of acceptProcessIds when in batch mode)
            const currentProcessId = processId();
            const acceptSet = props.acceptProcessIds?.length ? new Set(props.acceptProcessIds) : null;
            let isOurProcess = message.process_id === currentProcessId || 
                              (props.process_id && message.process_id === props.process_id) ||
                              (acceptSet?.has(message.process_id) ?? false);
            
            // Special case: If this is a script execution message and we have a props.process_id,
            // but the server is sending a different process ID, accept the server's process ID
            // This handles the case where the client generates a process ID but the server
            // generates its own and sends it back via SSE
            if (!isOurProcess && message.process_id && message.type === 'script_execution' && props.process_id) {
                debug('[WaitingModal] Server sent different process ID, accepting it as our own:', message.process_id);
                setProcessId(message.process_id);
                isOurProcess = true;
            }
            
            // If disableAutoNavigation is true, accept messages from ANY script_execution process
            // This allows the modal to show progress for multiple sequential processes
            if (!isOurProcess && props.disableAutoNavigation && message.type === 'script_execution' && message.process_id) {
                debug('[WaitingModal] Accepting message from any script_execution process (batch mode):', message.process_id);
                isOurProcess = true;
                // Update to track this process ID as well
                if (!currentProcessId) {
                    setProcessId(message.process_id);
                }
            }
            
            debug('[WaitingModal] Process matching check:', {
                messageProcessId: message.process_id,
                currentProcessId,
                propsProcessId: props.process_id,
                isOurProcess,
                disableAutoNavigation: props.disableAutoNavigation
            });
            
            if (isOurProcess) {
                // If we got a different process ID from the server, update to use that one
                if (message.process_id !== currentProcessId) {
                    debug(`[WaitingModal] Updating process ID from ${currentProcessId} to ${message.process_id}`);
                    setProcessId(message.process_id);
                }
                const messageText = message.text || "Processing...";
                setCurrentMessage(messageText);
                setHasReceivedSSEMessage(true); // Mark that we've received SSE messages
                
                // Debug: Log all events for this process
                debug(`[WaitingModal] Process ${message.process_id} event:`, message.event, 'text:', message.text);
                
                // Check for completion or error - check both event field and message text for completion indicators
                const isComplete = message.event === 'process_complete' || 
                                 message.event === 'process_timeout' || 
                                 message.event === 'process_error' ||
                                 message.event === 'script_complete' ||
                                 message.event === 'complete' ||
                                 message.event === 'error' ||
                                 message.text?.toLowerCase().includes('completed') ||
                                 message.text?.toLowerCase().includes('finished') ||
                                 message.text?.toLowerCase().includes('done') ||
                                 message.text?.toLowerCase().includes('error') ||
                                 message.text?.toLowerCase().includes('failed');
                
                if (isComplete) {
                    debug(`[WaitingModal] Process ${message.process_id} completed with event:`, message.event, 'text:', message.text);
                    setCurrentMessage(message.text || "Process completed");
                    // Only auto-close if disableAutoNavigation is false
                    // If disableAutoNavigation is true, the parent component controls when to close
                    if (!props.disableAutoNavigation) {
                        // Close modal after a short delay
                        setTimeout(() => {
                            if (props.onClose) props.onClose();
                            navigate('/dashboard', { replace: true });
                        }, 2000);
                    } else {
                        // Just update the message, don't close - parent will handle closing
                        debug(`[WaitingModal] Process ${message.process_id} completed, but auto-close disabled - parent will handle closing`);
                    }
                }
            }
        });

        onCleanup(() => {
            if (unsubscribe) {
                unsubscribe();
            }
        });
    });

    const closeAndReturn = () => {
        if (props.onClose) {
            props.onClose();
        }
        // Only navigate if auto-navigation is not disabled
        if (!props.disableAutoNavigation) {
            navigate('/dashboard', { replace: true });
        }
    };

    const isReady = () => {
        return currentMessage().includes('completed') || currentMessage().includes('Processed') || currentMessage().includes('Upload complete');
    };

    // When server reports "encoding skipped", show "Upload complete" instead of "Processing complete"
    const completionBlurb = () => {
        const msg = currentMessage();
        if (msg.includes('encoding skipped') || msg.includes('Upload complete')) {
            return 'Upload complete. You can close this window and return to work.';
        }
        return 'Processing complete. You can close this window and return to work.';
    };

    // Debug logging for render
    debug('[WaitingModal] Render - visible:', props.visible, 'process_id:', props.process_id);
    
    return (
        <Show when={props.visible}>
            <div class={`modal ${themeStore.isDark() ? 'dark' : 'light'}`}>
                <div class="modal-dialog">
                    <div class="modal-content">
                        <div class="modal-header" style="display:flex; align-items:center; justify-content:space-between;">
                            <h5 class="modal-title">{props?.title || 'Processing Data...'}</h5>
                            <Show when={props?.closable !== false}>
                                <button
                                    aria-label="Close"
                                    title="Close"
                                    onClick={closeAndReturn}
                                    style="background:transparent; border:none; color:#fff; font-size:18px; cursor:pointer; padding:4px;"
                                >
                                    ×
                                </button>
                            </Show>
                        </div>
                        <div class="modal-body centered">
                            <p><b>Please wait:</b> {isReady() ? completionBlurb() : (props?.subtitle || "This shouldn't take too long...")}</p>
                            <br />
                            <p><b>Status:</b> {displayStatus()}</p>
                            <br />
                            <p>Time: {formatSeconds(timeElapsed())}</p>
                        </div>
                    </div>
                </div>
            </div>
        </Show>
    );
}

