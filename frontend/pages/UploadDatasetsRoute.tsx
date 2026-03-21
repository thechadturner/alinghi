import { createSignal, onMount, Show } from "solid-js";
import { useParams } from "@solidjs/router";
import { debug, error as logError } from "../utils/console";
import { persistantStore } from "../store/persistantStore";

/** Default boat/class when URL omits :className */
const DEFAULT_REPORT_CLASS = "ac40";

// Static mapping — Vite must see literal import() paths (no dynamic template strings)
const uploadDatasetsMap: Record<string, () => Promise<any>> = {
  ac40: () => import("../reports/ac40/UploadDatasets"),
};

export default function UploadDatasetsRoute() {
  const [Component, setComponent] = createSignal<any>(null);
  const params = useParams();
  const className = (params.className || DEFAULT_REPORT_CLASS).toLowerCase();

  debug(
    "[UploadDatasetsRoute] className from URL params:",
    params.className,
    "final className:",
    className
  );

  onMount(async () => {
    if (className && className !== persistantStore.selectedClassName()) {
      persistantStore.setSelectedClassName(className);
    }

    debug("[UploadDatasetsRoute] onMount: Loading component for className:", className);

    try {
      const loader = uploadDatasetsMap[className] || uploadDatasetsMap[DEFAULT_REPORT_CLASS];
      const module = await loader();
      debug("[UploadDatasetsRoute] Successfully loaded component for:", className);
      setComponent(() => module.default);
    } catch (error) {
      logError(`[UploadDatasetsRoute] Failed to load UploadDatasets for class ${className}:`, error);
      try {
        const module = await uploadDatasetsMap[DEFAULT_REPORT_CLASS]();
        setComponent(() => module.default);
      } catch (fallbackError) {
        logError("[UploadDatasetsRoute] Failed to load fallback UploadDatasets:", fallbackError);
      }
    }
  });

  return <Show when={Component()}>{Component()}</Show>;
}
