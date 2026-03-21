import { createSignal, createEffect, Show, createMemo, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { FiSettings } from "solid-icons/fi";
import { selectedSources, setSelectedSources } from "../../store/filterStore";
import { sourcesStore } from "../../store/sourcesStore";
import { debug } from "../../utils/console";
import { user } from "../../store/userStore";
import { persistentSettingsService } from "../../services/persistentSettingsService";
import { persistantStore } from "../../store/persistantStore";

interface RaceSettingsProps {
  /** Optional callback when Apply button is clicked */
  onApply?: () => void;
}

/**
 * RaceSettings: Modal for managing source visibility in race reports (Race Summary, Prestart)
 * Links to the same global selectedSources from filterStore that FleetMap uses
 */
export default function RaceSettings(props: RaceSettingsProps) {
  const [showPopup, setShowPopup] = createSignal(false);

  // Local state for source selections (deferred until Apply is clicked)
  const [localSourceSelections, setLocalSourceSelections] = createSignal<Set<string>>(new Set());
  const [initialSourceSelections, setInitialSourceSelections] = createSignal<Set<string>>(new Set());

  // Get all available sources from sourcesStore
  const availableSources = createMemo(() => {
    const sources = sourcesStore.sources();
    // Sort by source_id for consistent ordering
    return sources.sort((a, b) => (a.source_id || 0) - (b.source_id || 0));
  });

  // Initialize local source selections when modal opens
  createEffect(() => {
    const isPopupOpen = showPopup();
    
    if (isPopupOpen) {
      // Capture current source selections from filterStore
      const currentSelections = new Set<string>(selectedSources());
      setLocalSourceSelections(currentSelections);
      setInitialSourceSelections(new Set(currentSelections));
      debug('RaceSettings: Initialized local source selections', { 
        selections: Array.from(currentSelections)
      });
    } else {
      // Reset when modal closes
      setLocalSourceSelections(new Set());
      setInitialSourceSelections(new Set());
    }
  });

  // Helper to compare sets
  const setsEqual = (a: Set<string>, b: Set<string>): boolean => {
    if (a.size !== b.size) return false;
    for (const item of a) {
      if (!b.has(item)) return false;
    }
    return true;
  };

  // Check if source selections have changed
  const hasSourceChanges = createMemo(() => {
    if (!showPopup()) return false;
    const current = localSourceSelections();
    const initial = initialSourceSelections();
    return !setsEqual(current, initial);
  });

  // Toggle source selection in local state
  const toggleSource = (sourceName: string) => {
    setLocalSourceSelections((prev) => {
      const next = new Set(prev);
      if (next.has(sourceName)) {
        next.delete(sourceName);
      } else {
        next.add(sourceName);
      }
      debug('RaceSettings: Source toggle - updated local state', { 
        sourceName, 
        selected: next.has(sourceName), 
        localSelections: Array.from(next) 
      });
      return next;
    });
  };

  // Check if source is selected in local state
  const isSourceSelected = (sourceName: string): boolean => {
    return localSourceSelections().has(sourceName);
  };

  // Apply source changes to global filterStore
  const handleApplySourceChanges = async () => {
    const selections = localSourceSelections();
    const sourceNames = Array.from(selections);
    
    debug('RaceSettings: Applying source changes', { selections: sourceNames });
    
    // Update global filterStore (this will trigger updates in RaceSummary, Prestart, and FleetMap)
    setSelectedSources(sourceNames);
    
    // Save to persistent settings API
    const currentUser = user();
    if (currentUser?.user_id && sourceNames.length > 0) {
      const { selectedClassName, selectedProjectId } = persistantStore;
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (className && projectId) {
        try {
          await persistentSettingsService.saveSettings(
            currentUser.user_id,
            className,
            projectId,
            { fleetPerformanceSources: sourceNames }
          );
          debug('RaceSettings: Saved sources to API', sourceNames);
        } catch (error) {
          debug('RaceSettings: Error saving sources to API', error);
        }
      }
    }
    
    // Update initial selections to current
    setInitialSourceSelections(new Set(selections));
    
    // Call onApply callback if provided
    if (props.onApply) {
      props.onApply();
    }
  };

  // Select all sources
  const handleSelectAll = () => {
    const allSourceNames = new Set(availableSources().map(s => s.source_name).filter(Boolean));
    setLocalSourceSelections(allSourceNames);
    debug('RaceSettings: Select All - updated local state', { count: allSourceNames.size });
  };

  // Deselect all sources
  const handleSelectNone = () => {
    setLocalSourceSelections(new Set());
    debug('RaceSettings: None - updated local state');
  };

  return (
    <>
      {/* Settings Icon Trigger */}
      <div
        onClick={() => setShowPopup(!showPopup())}
        onContextMenu={(e) => e.preventDefault()}
        class="cursor-pointer"
        title="Race Settings"
        style={{
          display: "inline-flex",
          "align-items": "center",
          "justify-content": "center",
          padding: "0.25rem",
          "transition": "opacity 0.2s ease",
          "opacity": "1"
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = "0.7";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = "1";
        }}
      >
        <FiSettings size={24} />
      </div>

      {/* Modal Overlay */}
      <Show when={showPopup()}>
        <Portal mount={typeof document !== 'undefined' ? (document.getElementById('main-content') || document.body) : undefined}>
          <div class="pagesettings-overlay">
            <div
              class="pagesettings-modal"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div class="flex justify-between items-center p-4 border-b" style="border-color: var(--color-border-primary);">
                <h2 class="text-lg font-semibold" style="color: var(--color-text-primary);">Race Settings</h2>
                <Show 
                  when={!hasSourceChanges()} 
                  fallback={
                    <div class="w-6 h-6"></div>
                  }
                >
                  <button
                    onClick={() => setShowPopup(false)}
                    class="text-gray-500 hover:text-gray-700 transition-colors"
                    style="color: var(--color-text-secondary);"
                  >
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                  </button>
                </Show>
              </div>

              {/* Modal Body */}
              <div class="p-6">
                {/* Data Sources Section */}
                <div class="mb-6">
                  <div class="flex items-center justify-between mb-3">
                    <h3 class="text-base font-semibold" style="color: var(--color-text-primary);">Data Sources</h3>
                    <div class="flex gap-2">
                      <button
                        class="px-2 py-1 text-xs rounded-md"
                        style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                        onClick={handleSelectAll}
                      >
                        Select All
                      </button>
                      <button
                        class="px-2 py-1 text-xs rounded-md"
                        style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                        onClick={handleSelectNone}
                      >
                        None
                      </button>
                    </div>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <Show when={availableSources().length > 0} fallback={
                      <p style="color: var(--color-text-secondary); font-size: 0.875rem;">
                        No sources available. Please ensure sources are configured for this project.
                      </p>
                    }>
                      {availableSources().map((source) => {
                        const sourceName = source.source_name || '';
                        const sourceColor = sourcesStore.getSourceColor(sourceName);
                        const selected = isSourceSelected(sourceName);
                        
                        return (
                          <span
                            class={`px-3 py-1 rounded-full text-sm cursor-pointer font-medium transition-colors ${
                              selected 
                                ? 'bg-blue-600 text-white' 
                                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                            }`}
                            style={selected && sourceColor ? `background-color: ${sourceColor}; color: white;` : ''}
                            onClick={() => toggleSource(sourceName)}
                          >
                            {sourceName}
                          </span>
                        );
                      })}
                    </Show>
                  </div>
                </div>

                {/* Info Text */}
                <div class="text-sm" style="color: var(--color-text-secondary);">
                  <p>
                    Select which data sources to display in Race Summary and Prestart reports. 
                    These settings are shared with the Fleet Map.
                  </p>
                </div>
              </div>

              {/* Modal Footer */}
              <div class="flex justify-end items-center p-4 border-t gap-2" style="border-color: var(--color-border-primary);">
                <Show 
                  when={hasSourceChanges()} 
                  fallback={
                    <button
                      onClick={() => setShowPopup(false)}
                      class="px-4 py-2 text-sm rounded-md transition-colors"
                      style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                      onMouseEnter={(e) => {
                        const btn = e.currentTarget;
                        if (btn) btn.style.backgroundColor = 'var(--color-bg-button-secondary-hover)';
                      }}
                      onMouseLeave={(e) => {
                        const btn = e.currentTarget;
                        if (btn) btn.style.backgroundColor = 'var(--color-bg-button-secondary)';
                      }}
                    >
                      Close
                    </button>
                  }
                >
                  <button
                    onClick={() => {
                      handleApplySourceChanges();
                      setShowPopup(false);
                    }}
                    class="px-4 py-2 text-sm rounded-md transition-colors font-medium"
                    style="background: #22c55e; color: white;"
                    onMouseEnter={(e) => {
                      const btn = e.currentTarget;
                      if (btn) btn.style.backgroundColor = '#16a34a';
                    }}
                    onMouseLeave={(e) => {
                      const btn = e.currentTarget;
                      if (btn) btn.style.backgroundColor = '#22c55e';
                    }}
                  >
                    Apply
                  </button>
                </Show>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}
