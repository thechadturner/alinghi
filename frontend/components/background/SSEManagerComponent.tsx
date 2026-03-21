import { onCleanup, onMount } from "solid-js";
import { sseManager } from "../../store/sseManager";
import { processStore } from "../../store/processStore";
import { warn, debug } from "../../utils/console";

export default function SSEManagerComponent(): null {
  // This component manages SSE connections based on process lifecycle
  // Connections are established when processes start and disconnected when they complete
  
  onMount(async () => {
    // Clear any old processes on page load to prevent interference
    processStore.clearAllProcesses();
    
    // No longer automatically connect - connections will be established
    // when processes are started via sseManager.onProcessStart()
    debug('[SSEManagerComponent] SSE manager initialized - connections will be event-driven');
  });
  
  onCleanup(() => {
    // Clean up connections when component unmounts
    sseManager.disconnectAll();
  });

  // Return null since this component doesn't render anything
  return null;
}
