import { onMount, createEffect, createSignal, For, Show, createMemo } from "solid-js";
import { Portal } from "solid-js/web";

import Scatter from "../../../components/charts/TargetScatter";
import Table from "../../../components/charts/TargetTable";

import Legend from "../../../components/legends/Targets";
import Loading from "../../../components/utilities/Loading";
import DropDownButton from "../../../components/buttons/DropDownButton";

import { getData, setupMediaContainerScaling } from "../../../utils/global";
import { tooltip } from "../../../store/globalStore";
import { warn, error as logError, debug } from "../../../utils/console";
import { persistantStore } from "../../../store/persistantStore";
import { user } from "../../../store/userStore";
import { themeStore } from "../../../store/themeStore";
import { apiEndpoints } from "@config/env";
import { logPageLoad } from "../../../utils/logging";
import { huniDBStore } from "../../../store/huniDBStore";
import { defaultChannelsStore } from "../../../store/defaultChannelsStore";

const { selectedClassName, selectedProjectId } = persistantStore;

export default function ScatterPage() {
  const [loading, setLoading] = createSignal(true);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showModal, setShowModal] = createSignal(false);
  const [updateCharts, setUpdateCharts] = createSignal(false);

  const [showUwDw, setShowUwDw] = createSignal(true);
  const [pos] = createSignal(["upwind", "downwind"]);
  const [UwDw, setUwDw] = createSignal("upwind");

  const [selectedChart, setSelectedChart] = createSignal<any[]>([]);
  const [zoom, setZoom] = createSignal(false);
  
  // Use default channel names for axes
  const { twsName, bspName } = defaultChannelsStore;
  // Axis labels for scatter (TWS / BSP from default channel names)
  const axes = createMemo(() => ['TWS', 'BSP']);
  const [xAxis, setXAxis] = createSignal(twsName());

  const [groups, setGroups] = createSignal<any[]>([]);
  const [targets, setTargets] = createSignal<string[]>([]);

  const [redTargetName, setRedTargetName] = createSignal<string | null>(localStorage.getItem("red_target_name"));
  const [greenTargetName, setGreenTargetName] = createSignal<string | null>(localStorage.getItem("green_target_name"));
  const [blueTargetName, setBlueTargetName] = createSignal<string | null>(localStorage.getItem("blue_target_name"));

  const [redTargetData, setRedTargetData] = createSignal<Record<string, any[]>>({});
  const [greenTargetData, setGreenTargetData] = createSignal<Record<string, any[]>>({});
  const [blueTargetData, setBlueTargetData] = createSignal<Record<string, any[]>>({});

  const fetchCharts = async () => {
    const controller = new AbortController();
    
    try {
      // Check if user is available
      const currentUser = user();
      if (!currentUser || !currentUser.user_id) {
        warn("User not available, skipping chart fetch");
        return [];
      }
      
      const response = await getData(`${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&parent_name=targets&object_name=targets_default`, controller.signal);
      if (!response.success) throw new Error("Failed to fetch dataset object.");
      
      return response.data?.chart_info || [];
      
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return [];
      }
      logError("Error fetching charts:", error);
      return [];
    }
  };

  const fetchTargets = async (): Promise<{ name: string }[]> => {
    const controller = new AbortController();
    
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId) {
        warn('Targets: Missing className or projectId, cannot fetch targets');
        return [];
      }
      
      const projectIdStr = projectId.toString();
      
      // Same API and pattern as performance page (FleetPerformance / FleetPerformanceHistory)
      debug('Targets: Fetching targets list from API');
      const response = await getData(
        `${apiEndpoints.app.targets}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&isPolar=0`,
        controller.signal
      );
      if (!response.success) {
        const msg = (response as { message?: string }).message || response.error || 'Failed to fetch targets.';
        throw new Error(msg);
      }

      // Parse like performance page: backend returns 200 with data = array of { name } or 204/empty (data null)
      const raw = response.data;
      let targets: { name: string }[] = [];
      if (raw != null) {
        if (Array.isArray(raw)) {
          targets = raw;
        } else if (typeof raw === 'object' && Array.isArray((raw as { targets?: unknown }).targets)) {
          targets = (raw as { targets: { name: string }[] }).targets;
        } else if (typeof raw === 'object' && (raw as { name?: string }).name) {
          targets = [{ name: (raw as { name: string }).name }];
        }
      }
      // Extract names only (backend rows are { name })
      const targetList = targets.map((t) => (typeof t === 'object' && t && typeof (t as { name?: string }).name === 'string' ? { name: (t as { name: string }).name } : null)).filter(Boolean) as { name: string }[];
      
      if (targetList.length === 0) {
        debug('Targets: API returned no targets (empty list or 204)');
      }
      
      // Replace HuniDB cache for this project's non-polar list (clear then store so removed targets disappear)
      try {
        await huniDBStore.clearTargetsForProject(className, projectIdStr, 0);
        if (targetList.length > 0) {
          debug(`Targets: Storing ${targetList.length} targets in HuniDB (batch)`);
          const targetEntries = targetList.map((target: { name: string }) => ({
            id: `target-${projectIdStr}-${target.name}`,
            projectId: projectIdStr,
            name: target.name,
            isPolar: 0,
            data: {},
            dateModified: Date.now(),
          }));
          await huniDBStore.storeTargetsBatch(className, targetEntries);
          debug('Targets: Successfully stored targets in HuniDB (batch)');
        }
      } catch (storeError) {
        logError('Targets: Error updating targets in HuniDB:', storeError);
        // Don't throw - we still have the API list to show
      }

      return targetList;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return [];
      }
      logError('Targets: Error fetching targets list:', error);
      // Re-throw so caller can show error UI (e.g. production when API/auth fails)
      throw error;
    }
  };

  const fetchTargetsData = async (targetName: string): Promise<Record<string, any[]>> => {
    if (!targetName) {
      debug(`Targets: No target name provided, returning empty data`);
      return {};
    }
    
    const controller = new AbortController();
    
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId) {
        warn('Targets: Missing className or projectId, cannot fetch target data');
        return {};
      }
      
      const projectIdStr = projectId.toString();
      
      // Check HuniDB first
      debug(`Targets: Checking HuniDB for target data: ${targetName}`);
      try {
        const cachedTargets = await huniDBStore.queryTargets(className, projectIdStr, targetName);
        const target = cachedTargets.find(t => (t.isPolar ?? 0) === 0 && t.name === targetName);
        
        if (target && target.data && typeof target.data === 'object' && !Array.isArray(target.data)) {
          const dataKeys = Object.keys(target.data);
          const dataLengths = Object.values(target.data).map((arr: any) => Array.isArray(arr) ? arr.length : 0);
          debug(`Targets: Found cached target data in HuniDB for ${targetName}`, {
            keys: dataKeys,
            lengths: dataLengths,
            hasData: Object.keys(target.data).length > 0
          });
          
          // Check if data is actually populated
          if (Object.keys(target.data).length > 0) {
            return target.data as Record<string, any[]>;
          } else {
            debug(`Targets: Cached data exists but is empty, will fetch from API`);
          }
        } else {
          debug(`Targets: Target found but data is invalid`, {
            hasTarget: !!target,
            hasData: !!(target?.data),
            dataType: target?.data ? typeof target.data : 'none',
            isArray: Array.isArray(target?.data)
          });
        }
      } catch (huniError) {
        debug('Targets: Error querying HuniDB, will fetch from API:', huniError);
      }
      
      // Not in HuniDB, fetch from API
      debug(`Targets: Fetching target data from API for ${targetName}`);
      const response = await getData(`${apiEndpoints.app.targets}/data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&name=${encodeURIComponent(targetName)}&isPolar=0`, controller.signal);
      if (!response.success) throw new Error("Failed to fetch data.");

      // API returns data as Record<string, any[]> (e.g., { UPWIND: [...], DOWNWIND: [...] })
      const targetData = (response.data || {}) as Record<string, any[]>;
      
      const dataKeys = Object.keys(targetData);
      const dataLengths = Object.values(targetData).map((arr: any) => Array.isArray(arr) ? arr.length : 0);
      debug(`Targets: Fetched target data from API for ${targetName}`, {
        keys: dataKeys,
        lengths: dataLengths,
        hasData: Object.keys(targetData).length > 0
      });
      
      // Store in HuniDB
      if (Object.keys(targetData).length > 0) {
        debug(`Targets: Storing target data in HuniDB for ${targetName}`);
        try {
          await huniDBStore.storeTarget(className, {
            id: `target-${projectIdStr}-${targetName}`,
            projectId: projectIdStr,
            name: targetName,
            isPolar: 0,
            data: targetData, // Store the actual target data Record
            dateModified: Date.now(),
          });
          debug(`Targets: Successfully stored target data in HuniDB for ${targetName}`);
        } catch (storeError) {
          logError(`Targets: Error storing target data in HuniDB for ${targetName}:`, storeError);
        }
      }

      return targetData;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return {};
      }
      logError("Error fetching data:", error);
      return {};
    }
  };

  const initializeCharts = async () => {
    setLoading(true);
    setIsLoading(true);
    setError(null);
    
    try {
      setUpdateCharts(false);

      const groupData = await fetchCharts();
      setGroups(groupData);

      const targetsJson = await fetchTargets();
      const targetNames = targetsJson.map((obj: any) => obj.name);
      setTargets(targetNames);

      // Validate saved target names exist in available targets
      const savedRed = localStorage.getItem('red_target_name');
      const savedGreen = localStorage.getItem('green_target_name');
      const savedBlue = localStorage.getItem('blue_target_name');
      
      const validRed = savedRed && targetNames.includes(savedRed) ? savedRed : null;
      const validGreen = savedGreen && targetNames.includes(savedGreen) ? savedGreen : null;
      const validBlue = savedBlue && targetNames.includes(savedBlue) ? savedBlue : null;
      
      // Set target names: use saved if valid, otherwise use default
      if (!redTargetName() || !targetNames.includes(redTargetName())) {
        setRedTargetName(validRed || (targetNames.length > 0 ? targetNames[0] : ''));
      }
      if (!greenTargetName() || !targetNames.includes(greenTargetName())) {
        setGreenTargetName(validGreen || (targetNames.length > 0 ? targetNames[0] : ''));
      }
      if (!blueTargetName() || !targetNames.includes(blueTargetName())) {
        setBlueTargetName(validBlue || (targetNames.length > 0 ? targetNames[0] : ''));
      }

      const redName = redTargetName() || '';
      const blueName = blueTargetName() || '';
      const greenName = greenTargetName() || '';
      
      debug(`Targets: Fetching target data for red: ${redName}, green: ${greenName}, blue: ${blueName}`);
      
      const redData = await fetchTargetsData(redName);
      const blueData = await fetchTargetsData(blueName);
      const greenData = await fetchTargetsData(greenName);

      debug(`Targets: Target data fetched`, {
        red: { keys: Object.keys(redData), hasData: Object.keys(redData).length > 0 },
        green: { keys: Object.keys(greenData), hasData: Object.keys(greenData).length > 0 },
        blue: { keys: Object.keys(blueData), hasData: Object.keys(blueData).length > 0 }
      });

      setRedTargetData(redData);
      setBlueTargetData(blueData);
      setGreenTargetData(greenData);

      let showUwDw = true
      groups().forEach((group: any) => {
        if (group.charts && group.charts[0] && group.charts[0].filters && group.charts[0].filters.length > 0) {
          showUwDw = false;
        }
      })
      setShowUwDw(showUwDw)

      setUpdateCharts(true);
    } catch (error: unknown) {
      logError('Error initializing targets charts:', error);
      const errorMsg = error instanceof Error 
        ? error.message 
        : (typeof error === 'string' 
          ? error 
          : 'Failed to initialize targets charts');
      setError(errorMsg);
    } finally {
      setLoading(false);
      setIsLoading(false);
    }
  };

  const handleZoom = (info: any[]) => {
    if (info.length > 0) {
      setSelectedChart(info);
      setZoom(true);
    } else {
      setSelectedChart([]);
      setZoom(false);
    }
  };

  const handleAxisChange = (selected: string) => {
    // Map display label back to actual channel name
    const tws = twsName();
    const bsp = bspName();
    if (selected === 'TWS') {
      setXAxis(tws);
    } else if (selected === 'BSP') {
      setXAxis(bsp);
    } else {
      // Fallback: try to use the selected value directly (backward compatibility)
      setXAxis(selected);
    }
    setZoom(false);
    setUpdateCharts(true);
  }

  // Update xAxis when default channels become available
  createEffect(() => {
    if (defaultChannelsStore.isReady()) {
      const currentTws = twsName();
      const currentBsp = bspName();
      const currentXAxis = xAxis();
      
      // If xAxis is still the old hard-coded value or matches TWS (case-insensitive), update it to use the default channel name
      const currentXAxisLower = currentXAxis.toLowerCase();
      if (currentXAxisLower === 'tws' || currentXAxis === currentTws) {
        setXAxis(currentTws);
      } else if (currentXAxisLower === 'bsp' || currentXAxis === currentBsp) {
        setXAxis(currentBsp);
      }
    }
  });

  onMount(async () => {
    await logPageLoad('Targets.jsx', 'Targets Analysis Report');
    initializeCharts();
    
    // Set up dynamic scaling for media-container using the global utility
    // Use width-based scaling to fill available width when zoomed
    const cleanupScaling = setupMediaContainerScaling({
      logPrefix: 'Targets',
      scaleToWidth: true
    });
    
    // Cleanup on unmount
    return () => {
      cleanupScaling(); // Call the cleanup function returned by the utility
    };
  });

  // When project/class become available after first load had none (store not ready on mount), load targets again
  let hadProjectAndClass = !!(selectedClassName() && selectedProjectId());
  createEffect(() => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    const nowHasProjectAndClass = !!(className && projectId);
    const hadNoneNowHas = !hadProjectAndClass && nowHasProjectAndClass;
    hadProjectAndClass = nowHasProjectAndClass;
    const hasTargets = targets().length > 0;
    if (hadNoneNowHas && !hasTargets && !error() && !loading() && !isLoading()) {
      debug('Targets: className/projectId now available (were missing on first load), re-loading');
      initializeCharts();
    }
  });

  // Track previous values to prevent unnecessary re-initialization
  let prevRedTarget = redTargetName();
  let prevGreenTarget = greenTargetName();
  let prevBlueTarget = blueTargetName();
  let prevXAxis = xAxis();
  
  createEffect(() => {
    const currentRed = redTargetName();
    const currentGreen = greenTargetName();
    const currentBlue = blueTargetName();
    const currentXAxis = xAxis();
    
    // Only re-initialize if target names or xAxis actually changed
    const targetsChanged = currentRed !== prevRedTarget || 
                          currentGreen !== prevGreenTarget || 
                          currentBlue !== prevBlueTarget;
    const axisChanged = currentXAxis !== prevXAxis;
    
    if ((targetsChanged || axisChanged) && currentRed && currentGreen && currentBlue && currentXAxis) {
      debug(`Targets: Target names or axis changed, re-initializing`, {
        red: { from: prevRedTarget, to: currentRed },
        green: { from: prevGreenTarget, to: currentGreen },
        blue: { from: prevBlueTarget, to: currentBlue },
        xAxis: { from: prevXAxis, to: currentXAxis }
      });
      
      prevRedTarget = currentRed;
      prevGreenTarget = currentGreen;
      prevBlueTarget = currentBlue;
      prevXAxis = currentXAxis;
      
      initializeCharts();
    }
  });

  return (
    <div id='media-container' class="targets-page">
      <Show when={!loading() && !isLoading()} fallback={<Loading />}>
        <Show when={error()}>
          <div class="flex flex-col items-center justify-center h-screen min-h-[500px] text-center p-8">
            <div class="mb-6">
              <div class="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg class="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"></path>
                </svg>
              </div>
              <h3 class="text-xl font-semibold text-red-700 mb-2">Error Loading Targets Data</h3>
              <p class="text-red-600 mb-6">{error()}</p>
              <button
                onClick={() => initializeCharts()}
                class="inline-flex items-center px-6 py-3 bg-red-600 text-white font-semibold rounded-md hover:bg-red-700 transition-colors duration-200"
              >
                <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                </svg>
                Retry
              </button>
            </div>
          </div>
        </Show>
      <Show when={showModal()}>
        <Portal mount={typeof document !== 'undefined' ? (document.getElementById('main-content') || document.body) : undefined}>
          <div class={`modal ${themeStore.isDark() ? 'dark' : 'light'}`}>
            <div class="modal-dialog" style="width: 500px; max-width: 600px;">
              <div class="modal-content">
                <div class="modal-header">
                  <h5 class="modal-title">Target Selection</h5>
                  <button type="button" class="close" onclick={() => setShowModal(false)}>
                    <span aria-hidden="true">&times;</span>
                  </button>
                </div>
                <div class="modal-body centered">
                <Show when={targets().length === 0}>
                  <p class="targets-modal-empty-hint">No targets available. Upload targets from the dashboard, then refresh this page.</p>
                </Show>
                <div class="flex items-center space-x-4">
                  <div class="w-1/6 text-center">
                    <p class="text-red-500 font-bold">Red</p>
                  </div>
                  <div class="w-5/6 text-center">
                    <select
                      id="red_targets"
                      class="text-red-500"
                      onChange={(e) => {
                        const value = e.target.value;
                        setRedTargetName(value);
                        localStorage.setItem('red_target_name', value);
                      }}
                    >
                      <For each={targets()}>
                        {(name) => (
                          <option value={name} selected={redTargetName() === name}>
                            {name}
                          </option>
                        )}
                      </For>
                    </select>
                  </div>
                </div>
                <div class="flex items-center space-x-4 mt-2">
                  <div class="w-1/6 text-center">
                    <p class="text-green-500 font-bold">Green</p>
                  </div>
                  <div class="w-5/6 text-center">
                    <select
                      id="green_targets"
                      class="text-green-500"
                      onChange={(e) => {
                        const value = e.target.value;
                        setGreenTargetName(value);
                        localStorage.setItem('green_target_name', value);
                      }}
                    >
                      <For each={targets()}>
                        {(name) => (
                          <option value={name} selected={greenTargetName() === name}>
                            {name}
                          </option>
                        )}
                      </For>
                    </select>
                  </div>
                </div>
                <div class="flex items-center space-x-4 mt-2">
                  <div class="w-1/6 text-center">
                    <p class="text-blue-500 font-bold">Blue</p>
                  </div>
                  <div class="w-5/6 text-center">
                    <select
                      id="blue_targets"
                      class="text-blue-500"
                      onChange={(e) => {
                        const value = e.target.value;
                        setBlueTargetName(value);
                        localStorage.setItem('blue_target_name', value);
                      }}
                    >
                      <For each={targets()}>
                        {(name) => (
                          <option value={name} selected={blueTargetName() === name}>
                            {name}
                          </option>
                        )}
                      </For>
                    </select>
                  </div>
                </div>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
        <Show when={updateCharts() && !error()}>
          <div class="container">
            {/* Keep header section unchanged */}
            <div class="flex w-full">
              <div class="w-1/6 flex gap-x-2 pt-2 pl-2">
                <Show when={showUwDw()}>
                  <DropDownButton
                    options={pos()}
                    defaultText={UwDw()}
                    handleSelection={setUwDw}
                    smallLabel="Uw/Dw"
                    size="medium"
                  />
                </Show>
                <DropDownButton
                  options={axes()}
                  defaultText={xAxis() === twsName() ? 'TWS' : 'BSP'}
                  handleSelection={(axis) => handleAxisChange(axis)}
                  smallLabel="X-Axis"
                  size="small"
                />
              </div>
              <div class="w-5/6">
                <Legend
                  elementId="legend-container"
                  redTargetName={redTargetName() || ''}
                  greenTargetName={greenTargetName() || ''}
                  blueTargetName={blueTargetName() || ''}
                  onClick={() => setShowModal(true)}
                />
              </div>
            </div>
        
          <Show when={!zoom()}>
            <Show when={groups().length > 0} fallback={
              <div class="text-center py-16">
                <div class="mx-auto w-24 h-24 bg-blue-100 rounded-full flex items-center justify-center mb-6">
                  <svg class="w-12 h-12 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                  </svg>
                </div>
                <h3 class="text-xl font-semibold text-gray-900 mb-2">No target charts configured</h3>
                <p class="text-gray-600 mb-8 max-w-md mx-auto">Create target charts using the Target Page Builder to visualize your data</p>
                <button
                  onClick={() => window.location.href = '/targets-builder'}
                  class="inline-flex items-center px-6 py-3 bg-blue-600 text-white font-semibold rounded-md hover:bg-blue-700 transition-colors duration-200"
                >
                  <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path>
                  </svg>
                  Create Target Charts
                </button>
              </div>
            }>
              <div class="target-container">
                <For each={groups()}>
                  {(group) => (
                  <div class="group-container">
                    <div class="break">
                      <h2>{group.name}</h2>
                    </div>
                    <div class="target-plots">
                      <For each={group.charts[0].series}>
                        {(series) => (
                          <Scatter
                            xaxis={xAxis()}
                            yaxis={series.yaxis.name}
                            filters={group.charts[0].filters}
                            green={greenTargetData()}
                            red={redTargetData()}
                            blue={blueTargetData()}
                            infoType={series.info_type ?? "info"}
                            infoMessage={series.info_message ?? ""}
                            handleZoom={handleZoom}
                          />
                        )}
                      </For>
                      <div
                        id="tt"
                        class="tooltip"
                        style={{
                          opacity: tooltip().visible ? 1 : 0,
                          left: `${tooltip().x}px`,
                          top: `${tooltip().y}px`,
                        }}
                        innerHTML={tooltip().content}
                      ></div>
                    </div>
                  </div>
                )}
              </For>
            </div>
            </Show>
          </Show>
          <Show when={zoom()}>
            <div class="zoom-container">
              <div class="targets-zoom-inner flex w-full h-full">
                <div class="targets-zoom-chart">
                  <Scatter
                    xaxis={selectedChart()[0]}
                    yaxis={selectedChart()[1]}
                    filters={selectedChart()[2]}
                    green={selectedChart()[3] ?? {}}
                    red={selectedChart()[4] ?? {}}
                    blue={selectedChart()[5] ?? {}}
                    handleZoom={handleZoom}
                    zoom={true}
                    class_name="col1"
                  />
                </div>
                <div class="targets-zoom-table">
                  <Table
                    xaxis={selectedChart()[0]}
                    yaxis={selectedChart()[1]}
                    filters={selectedChart()[2]}
                    green={selectedChart()[3] ?? {}}
                    red={selectedChart()[4] ?? {}}
                    blue={selectedChart()[5] ?? {}}
                    handleZoom={handleZoom}
                  />
                </div>
              </div>
              <div
                id="tt"
                class="tooltip"
                style={{
                  opacity: tooltip().visible ? 1 : 0,
                  left: `${tooltip().x}px`,
                  top: `${tooltip().y}px`,
                }}
                innerHTML={tooltip().content}
              ></div>
            </div>
          </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}
