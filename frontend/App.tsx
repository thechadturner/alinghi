import "@styles/app.css";
import { Router, Route, useSearchParams, useParams } from "@solidjs/router";
import { lazy, createSignal, onMount, Show } from "solid-js";
import { error as logError } from "./utils/console";

import Layout from "@components/app/Layout";
import Index from "@pages/Index";

// Lazy load routes to reduce initial bundle size and improve reload performance
const Register = lazy(() => import("@pages/Register"));
const Login = lazy(() => import("@pages/Login"));
const CookiePolicy = lazy(() => import("@pages/CookiePolicy"));
const PrivacyPolicy = lazy(() => import("@pages/PrivacyPolicy"));
const TermsOfService = lazy(() => import("@pages/TermsOfService"));
const Contact = lazy(() => import("@pages/Contact"));
const Verify = lazy(() => import("@pages/Verify"));
const ForgotPassword = lazy(() => import("@pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@pages/ResetPassword"));

const Admin = lazy(() => import("@pages/Admin"));
const Profile = lazy(() => import("@pages/Profile"));
const Project = lazy(() => import("@pages/Project"));
const ProjectInfo = lazy(() => import("@pages/ProjectInfo"));
// DatasetInfo will be loaded dynamically based on class_name
const PerformanceBuilder = lazy(() => import("@components/builders/Performance"));
const ScatterBuilder = lazy(() => import("@/components/builders/Scatter"));
const TimeSeriesBuilder = lazy(() => import("@/components/builders/Timeseries"));
const TargetsBuilder = lazy(() => import("@components/builders/Targets"));
const ProbabilityBuilder = lazy(() => import("@/components/builders/Probability"));
const OverlayBuilder = lazy(() => import("@/components/builders/Overlay"));
const ParallelBuilder = lazy(() => import("@/components/builders/Parallel"));
const PolarRoseBuilder = lazy(() => import("@/components/builders/PolarRose"));
const GridBuilder = lazy(() => import("@/components/builders/Grid"));
const TableBuilder = lazy(() => import("@/components/builders/Table"));
const VideoBuilder = lazy(() => import("@/components/builders/Video"));
const VideoSyncPage = lazy(() => import("@pages/VideoSync"));
const UploadTargets = lazy(() => import("@pages/UploadTargets"));
const UploadMedia = lazy(() => import("@pages/UploadMedia"));
const UploadRaceCourse = lazy(() => import("@pages/UploadRaceCourse"));
const UploadDatasetsRoute = lazy(() => import("@pages/UploadDatasetsRoute"));
const Window = lazy(() => import("@pages/Window"));
const Dashboard = lazy(() => import("@pages/Dashboard"));
const Tagger = lazy(() => import("@pages/Tagger"));

import { registerSelectionStoreCleanup } from "@store/selectionStore";
import { registerPlaybackStoreCleanup, initializeSelectionEffect, initializeManualTimeChangeEffect } from "@store/playbackStore";
import { registerFilterStoreCleanup } from "@store/filterStore";
import { persistantStore } from "@store/persistantStore";
import GlobalToast from "@components/utilities/GlobalToast";
import SSEManagerComponent from "@components/background/SSEManagerComponent";

// Wrapper components for builders to handle fleet parameter from URL (day mode)
function TimeSeriesBuilderWrapper(props: Record<string, any>) {
  const [searchParams] = useSearchParams();
  const fleetParam = searchParams.fleet;
  const isFleet = fleetParam === 'true' || fleetParam === '1' || fleetParam === 'true';
  return <TimeSeriesBuilder {...props} isFleet={isFleet} type={isFleet ? 'fleet' : undefined} />;
}
function ScatterBuilderWrapper(props: Record<string, any>) {
  const [searchParams] = useSearchParams();
  const fleetParam = searchParams.fleet;
  const isFleet = fleetParam === 'true' || fleetParam === '1' || fleetParam === 'true';
  return <ScatterBuilder {...props} isFleet={isFleet} type={isFleet ? 'fleet' : undefined} />;
}
function ProbabilityBuilderWrapper(props: Record<string, any>) {
  const [searchParams] = useSearchParams();
  const fleetParam = searchParams.fleet;
  const isFleet = fleetParam === 'true' || fleetParam === '1' || fleetParam === 'true';
  return <ProbabilityBuilder {...props} isFleet={isFleet} type={isFleet ? 'fleet' : undefined} />;
}

/** Default boat/class for report chunks when URL omits :className */
const DEFAULT_REPORT_CLASS = 'ac40';

// Static mapping for DatasetInfo components - allows Vite to analyze imports at build time
// These imports must be static (not template literals) so Vite can create chunks in production
const datasetInfoMap: Record<string, () => Promise<any>> = {
  ac40: () => import('./reports/ac40/DatasetInfo'),
};

// Wrapper component for DatasetInfo to dynamically load based on class_name
function DatasetInfoWrapper() {
  const [Component, setComponent] = createSignal<any>(null);
  const params = useParams();
  const className = (params.className || DEFAULT_REPORT_CLASS).toLowerCase();
  
  onMount(async () => {
    // Set className in store from URL params
    if (className && className !== persistantStore.selectedClassName()) {
      persistantStore.setSelectedClassName(className);
    }
    
    try {
      // Use static mapping so Vite can analyze imports at build time
      const loader = datasetInfoMap[className] || datasetInfoMap[DEFAULT_REPORT_CLASS];
      const module = await loader();
      setComponent(() => module.default);
    } catch (error) {
      logError(`Failed to load DatasetInfo for class ${className}:`, error);
      try {
        const module = await datasetInfoMap[DEFAULT_REPORT_CLASS]();
        setComponent(() => module.default);
      } catch (fallbackError) {
        logError('Failed to load fallback DatasetInfo:', fallbackError);
      }
    }
  });
  
  return <Show when={Component()}>{Component()}</Show>;
}

// Static mapping for DayInfo components (fleet/day edit - admin/publisher/super only)
const dayInfoMap: Record<string, () => Promise<any>> = {
  ac40: () => import('./reports/ac40/DayInfo'),
};

// Wrapper component for DayInfo to dynamically load based on class_name
function DayInfoWrapper() {
  const [Component, setComponent] = createSignal<any>(null);
  const params = useParams();
  const className = (params.className || DEFAULT_REPORT_CLASS).toLowerCase();
  
  onMount(async () => {
    if (className && className !== persistantStore.selectedClassName()) {
      persistantStore.setSelectedClassName(className);
    }
    try {
      const loader = dayInfoMap[className] || dayInfoMap[DEFAULT_REPORT_CLASS];
      const module = await loader();
      setComponent(() => module.default);
    } catch (error) {
      logError(`Failed to load DayInfo for class ${className}:`, error);
      try {
        const module = await dayInfoMap[DEFAULT_REPORT_CLASS]();
        setComponent(() => module.default);
      } catch (fallbackError) {
        logError('Failed to load fallback DayInfo:', fallbackError);
      }
    }
  });
  return <Show when={Component()}>{Component()}</Show>;
}

// Static mapping for Events components - allows Vite to analyze imports at build time
// These imports must be static (not template literals) so Vite can create chunks in production
const eventsMap: Record<string, () => Promise<any>> = {
  ac40: () => import('./reports/ac40/Events'),
};

// Wrapper component for Events to dynamically load based on class_name
function EventsWrapper() {
  const [Component, setComponent] = createSignal<any>(null);
  const params = useParams();
  const [searchParams] = useSearchParams();
  const className = (params.className || DEFAULT_REPORT_CLASS).toLowerCase();

  onMount(() => {
    // Restore project/dataset/date from URL so reload keeps context
    const pid = searchParams.pid ?? searchParams.project_id;
    const datasetId = searchParams.dataset_id;
    const dateVal = searchParams.date;
    if (pid != null && pid !== '') {
      const n = parseInt(pid, 10);
      if (!isNaN(n)) persistantStore.setSelectedProjectId(n);
    }
    if (datasetId != null && datasetId !== '') {
      const n = parseInt(datasetId, 10);
      if (!isNaN(n)) {
        persistantStore.setSelectedDatasetId(n);
        persistantStore.setSelectedDate('');
      }
    }
    if (dateVal != null && dateVal !== '') {
      persistantStore.setSelectedDate(decodeURIComponent(dateVal));
      persistantStore.setSelectedDatasetId(0);
    }
    // If URL had no params but store has context, sync URL so next reload keeps it
    const hasUrlParams = (pid != null && pid !== '') || (datasetId != null && datasetId !== '') || (dateVal != null && dateVal !== '');
    if (!hasUrlParams) {
      const storePid = persistantStore.selectedProjectId();
      const storeDatasetId = persistantStore.selectedDatasetId();
      const storeDate = persistantStore.selectedDate();
      if (storePid > 0 && (storeDatasetId > 0 || (storeDate && storeDate.trim() !== ''))) {
        const next: Record<string, string> = { pid: String(storePid) };
        if (storeDatasetId > 0) next.dataset_id = String(storeDatasetId);
        else if (storeDate && storeDate.trim() !== '') next.date = storeDate;
        window.history.replaceState(null, '', `${window.location.pathname}?${new URLSearchParams(next).toString()}`);
      }
    }
  });

  onMount(async () => {
    // Set className in store from URL params
    if (className && className !== persistantStore.selectedClassName()) {
      persistantStore.setSelectedClassName(className);
    }

    try {
      // Use static mapping so Vite can analyze imports at build time
      const loader = eventsMap[className] || eventsMap[DEFAULT_REPORT_CLASS];
      const module = await loader();
      setComponent(() => module.default);
    } catch (error) {
      logError(`Failed to load Events for class ${className}:`, error);
      try {
        const module = await eventsMap[DEFAULT_REPORT_CLASS]();
        setComponent(() => module.default);
      } catch (fallbackError) {
        logError('Failed to load fallback Events:', fallbackError);
      }
    }
  });
  
  return <Show when={Component()}>{Component()}</Show>;
}

function App() {
  // Register cleanup for all stores - cleanup now happens automatically via onCleanup
  registerSelectionStoreCleanup();
  registerPlaybackStoreCleanup();
  registerFilterStoreCleanup();
  
  // Initialize playback store effects
  initializeSelectionEffect();
  initializeManualTimeChangeEffect();

  return (
    <>
      {/* SSE Manager for handling connections to both servers */}
      <SSEManagerComponent />
      {/* Global toast system for persistent notifications across all pages */}
      <GlobalToast />
      <Router root={Layout}>
        <Route path="/" component={Index} />
        <Route path="/cookie-policy" component={CookiePolicy} />
        <Route path="/privacy-policy" component={PrivacyPolicy} />
        <Route path="/terms-of-service" component={TermsOfService} />
        <Route path="/contact" component={Contact} />
        <Route path="/register" component={Register} />
        <Route path="/login" component={Login} />
        <Route path="/verify" component={Verify} />
        <Route path="/forgot-password" component={ForgotPassword} />
        <Route path="/reset-password" component={ResetPassword} />

        <Route path="/admin" component={Admin} />
        <Route path="/profile" component={Profile} />
        <Route path="/project" component={Project} />
        <Route path="/project-info" component={ProjectInfo} />
        <Route path="/dataset-info/:className?" component={DatasetInfoWrapper} />
        <Route path="/day-info/:className?" component={DayInfoWrapper} />
        <Route path="/targets-builder" component={TargetsBuilder} />
        <Route path="/performance-builder" component={PerformanceBuilder} />
        <Route path="/scatter-builder" component={ScatterBuilderWrapper} />
        <Route path="/timeseries-builder" component={TimeSeriesBuilderWrapper} />
        <Route path="/probability-builder" component={ProbabilityBuilderWrapper} />
        <Route path="/histogram-builder" component={ProbabilityBuilderWrapper} />
        <Route path="/overlay-builder" component={OverlayBuilder} />
        <Route path="/parallel-builder" component={ParallelBuilder} />
        <Route path="/polar-rose-builder" component={PolarRoseBuilder} />
        <Route path="/grid-builder" component={GridBuilder} />
        <Route path="/table-builder" component={TableBuilder} />
        <Route path="/video-builder" component={VideoBuilder} />
        <Route path="/video-sync" component={VideoSyncPage} />
        <Route path="/upload-datasets/:className?" component={UploadDatasetsRoute} />
        <Route path="/upload-targets" component={UploadTargets} />
        <Route path="/upload-race-course" component={UploadRaceCourse} />
        <Route path="/upload-video" component={UploadMedia} />
        <Route path="/upload-images" component={UploadMedia} />
        <Route path="/events/:className?" component={EventsWrapper} />
        <Route path="/window" component={Window} />

        <Route path="/dashboard" component={Dashboard} />
        <Route path="/tagger" component={Tagger} />
      </Router>
    </>
  );
}

export default App;
