import { createSignal, Show, createEffect, on, untrack } from "solid-js";
import { useNavigate } from "@solidjs/router";
import GridChart from "../../../../components/charts/Grid";
import { getData } from "../../../../utils/global";
import { apiEndpoints } from "@config/env";
import { persistantStore } from "../../../../store/persistantStore";
import { user } from "../../../../store/userStore";
import { sidebarMenuRefreshTrigger } from "../../../../store/globalStore";
import { error as logError, info as logInfo } from "../../../../utils/console";
import LoadingOverlay from "../../../../components/utilities/Loading";

interface GridProps {
  [key: string]: any;
}

export default function Grid(props: GridProps) {
  // Only use navigate if we're not in split view
  let navigate;
  try {
    navigate = useNavigate();
  } catch (error) {
    // If useNavigate fails (e.g., in split view), set navigate to null
    navigate = null;
  }
  const { selectedClassName, selectedProjectId } = persistantStore;
  
  const [hasChartConfig, setHasChartConfig] = createSignal(false);
  const [isLoading, setIsLoading] = createSignal(true);
  
  // Get object name from props or use default
  const objectName = () => props?.objectName || 'default';

  // Check if chart configuration exists
  const checkChartConfig = async () => {
    try {
      setIsLoading(true);
      // Removed loading safety timeout to avoid artificial delays
      const response = await getData(
        `${apiEndpoints.app.users}/object?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(user()?.user_id)}&parent_name=grid&object_name=${objectName()}`
      );
      
      if (response.success && response.data && response.data.chart_info && response.data.chart_info.length > 0) {
        setHasChartConfig(true);
      } else {
        setHasChartConfig(false);
      }
    } catch (error) {
      logError('Error checking chart configuration:', error);
      setHasChartConfig(false);
    } finally {
      // No timeout cleanup necessary
      setIsLoading(false);
    }
  };

  // Check chart config on mount, when objectName changes, and when returning from builder (sidebar refresh trigger)
  createEffect(
    on(
      [objectName, sidebarMenuRefreshTrigger],
      () => {
        untrack(() => {
          checkChartConfig();
        });
      }
    )
  );

  return (
    <div class="Grid bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100 min-h-[500px]">
      <Show 
        when={!isLoading()}
        fallback={<LoadingOverlay message="Loading grid chart..." type="spinner" />}
      >
        <Show 
          when={hasChartConfig()}
          fallback={
            <div class="flex flex-col items-center justify-center h-screen min-h-[500px] text-center p-8 pt-18">
              <div class="mb-6">
                <svg class="w-16 h-16 mx-auto text-gray-400 dark:text-gray-500 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"></path>
                </svg>
                <h3 class="text-xl font-semibold text-gray-700 dark:text-gray-200 mb-2">No Grid Charts Available</h3>
                <p class="text-gray-500 dark:text-gray-400 mb-6">Create your first grid chart to start visualizing your data</p>
              </div>
              <button 
                onClick={() => {
                  if (navigate) {
                    navigate('/grid-builder');
                  } else {
                    // In split view, we can't navigate - just show a message or do nothing
                    logInfo('Grid: Cannot navigate to grid-builder in split view');
                  }
                }}
                class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg transition-colors duration-200 shadow-md hover:shadow-lg"
              >
                Create Grid Chart
              </button>
            </div>
          }
        >
          <GridChart objectName={objectName()} />
        </Show>
      </Show>
    </div>
  );
}
