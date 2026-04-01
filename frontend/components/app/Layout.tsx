import { Show, Suspense, createEffect, onCleanup } from "solid-js";
import { useLocation } from "@solidjs/router";
import Header from "./Header";
import LoadingOverlay from "@components/utilities/Loading";
import { persistantStore } from "@store/persistantStore";
import { unifiedDataStore } from "@store/unifiedDataStore";
import { debug } from "@utils/console";

/**
 * Layout component that wraps all routes
 * This ensures Header has access to router context
 */
export default function Layout(props: { children?: any }) {
  const location = useLocation();
  
  // Hide header on /window route (standalone component windows) and index page
  const isWindowRoute = () => location.pathname === "/window";
  const isIndexRoute = () => location.pathname === "/";
  // Dashboard renders its own header so we don't duplicate
  const isDashboardRoute = () => location.pathname === "/dashboard";
  const isTaggerRoute = () => location.pathname === "/tagger";
  
  // Legal pages that don't need header (they have their own styling)
  const isLegalPage = () => {
    const path = location.pathname;
    return path === "/privacy-policy" || 
           path === "/terms-of-service" || 
           path === "/contact" || 
           path === "/cookie-policy";
  };
  
  // Cleanup function to remove scaling classes and ensure clean state on navigation
  const cleanupScalingClasses = () => {
    // Remove scaling-page classes that might persist from previous pages
    document.body.classList.remove('scaling-page');
    document.documentElement.classList.remove('scaling-page');
    
    // Remove scaling-initializing class from media-container if it exists
    const mediaContainer = document.getElementById('media-container');
    if (mediaContainer) {
      mediaContainer.classList.remove('scaling-initializing');
    }
    
    // Force a repaint to ensure browser updates the display
    // This helps when the computer is under load and rendering is slow
    requestAnimationFrame(() => {
      // Double-check and force another repaint if needed
      if (document.body.classList.contains('scaling-page') || 
          document.documentElement.classList.contains('scaling-page')) {
        document.body.classList.remove('scaling-page');
        document.documentElement.classList.remove('scaling-page');
      }
    });
  };
  
  // Preload events into HuniDB (agg.events) in the background whenever a dataset is selected.
  // Defer with setTimeout(0) so the sidebar and rest of the UI update first; events load in the next task.
  createEffect(() => {
    const className = persistantStore.selectedClassName?.();
    const projectId = persistantStore.selectedProjectId?.();
    const datasetId = persistantStore.selectedDatasetId?.();
    const dsId = datasetId != null ? Number(datasetId) : 0;
    if (!className || projectId == null || !Number.isFinite(dsId) || dsId <= 0) return;
    const timer = setTimeout(() => {
      unifiedDataStore.fetchEvents(className, Number(projectId), dsId).then(() => {
        debug('[Layout] Background events load complete for dataset', dsId);
      }).catch((err) => {
        debug('[Layout] Background events load failed (non-blocking):', (err as Error)?.message);
      });
    }, 0);
    return () => clearTimeout(timer);
  });

  // Do not remove scaling-page on route change: the previous page's onCleanup already
  // removes it when unmounting, and the new page (e.g. Prestart, Race Summary) adds it
  // in onMount. Running cleanup here in rAF would run after the new page added it and
  // would break the scroll container (vertical scrollbar missing when returning to Start Summary).
  // Only clean up when Layout unmounts.
  onCleanup(() => {
    cleanupScalingClasses();
  });
  
  return (
    <>
      <Show when={!isWindowRoute() && !isIndexRoute() && !isLegalPage() && !isDashboardRoute() && !isTaggerRoute()}>
        <Header />
      </Show>
      <Suspense fallback={<LoadingOverlay fullScreen message="Loading..." />}>
        {props.children}
      </Suspense>
    </>
  );
}

