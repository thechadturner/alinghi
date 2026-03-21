/**
 * Shown when chart config exists but data/channels cannot be found (API or HuniDB).
 * For non-readers, shows "Would you like to review the chart design?" and a button to the builder.
 */

import { Show } from "solid-js";
import { user } from "../../store/userStore";
import { isReader } from "../../utils/userPermissions";

export interface DataNotFoundMessageProps {
  /** Builder route to navigate to (e.g. '/scatter-builder') */
  builderRoute: string;
  /** Optional query string (e.g. '?object_name=default') */
  builderQuery?: string;
  /** Button label (default: "Review chart design") */
  builderButtonLabel?: string;
  /** Called when user clicks the builder button (navigate or window.location) */
  onNavigateToBuilder: () => void;
}

export default function DataNotFoundMessage(props: DataNotFoundMessageProps) {
  const currentUser = user();
  const showReviewDesign = !isReader(currentUser);

  return (
    <div class="flex flex-col items-center justify-center min-h-[400px] text-center p-8">
      <div class="mb-6">
        <svg
          class="w-16 h-16 mx-auto text-gray-400 dark:text-gray-500 mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1"
            d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
          />
        </svg>
        <h3 class="text-xl font-semibold text-gray-700 dark:text-gray-200 mb-2">
          Data cannot be found
        </h3>
        <p class="text-gray-500 dark:text-gray-400 mb-4">
          Data or channels could not be loaded from the API or HuniDB for this chart.
        </p>
        <Show when={showReviewDesign}>
          <p class="text-gray-600 dark:text-gray-300 mb-6">
            Would you like to review the chart design?
          </p>
          <button
            type="button"
            onClick={props.onNavigateToBuilder}
            class="bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-6 rounded-lg shadow-md hover:shadow-lg transition-colors"
          >
            {props.builderButtonLabel ?? "Review chart design"}
          </button>
        </Show>
      </div>
    </div>
  );
}
