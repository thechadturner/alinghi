import { createSignal, onMount, createEffect } from "solid-js";
import { Portal } from "solid-js/web";

import { getData } from "../../utils/global";
import { persistantStore } from "../../store/persistantStore";
import { themeStore } from "../../store/themeStore";
import { apiEndpoints } from "@config/env";
import { error as logError, debug, log } from "../../utils/console";
import { getCachedChannels } from "../../store/channelDiscoveryStore";
import { getChannelsFromFileServer, mergeChannelLists } from "../../services/channelsService";
const { selectedProjectId, selectedClassName, selectedDatasetId, selectedSourceId, selectedSourceName, selectedDate } = persistantStore;

export interface FileChannelPickerProps {
  onSave: (channels: string[]) => void;
}

interface SearchChannel {
  name: string;
  isChecked: boolean;
}

const FileChannelPicker = (props: FileChannelPickerProps) => {
  const { onSave } = props;

  const [date, setDate] = createSignal("");
  const [search, setSearch] = createSignal("");
  const [searchChannels, setSearchChannels] = createSignal<SearchChannel[]>([]);
  const [availableChannels, setAvailableChannels] = createSignal<string[]>([]); // Fetched channels from API
  const [channels, setChannels] = createSignal<string[]>([]); // Selected channels
  const [isModalOpen, setModalOpen] = createSignal(true);

  onMount(async () => {
    await getDate();
    await getChannels();
  });

  // Refetch channels when date or source name changes
  createEffect(async () => {
    const currentDate = date();
    const currentSourceName = selectedSourceName();
    
    // Only refetch if we have date and source name
    if (currentDate && currentSourceName) {
      try {
        await getChannels();
      } catch (error: any) {
        // Error handling is already in getChannels, but ensure effect doesn't break
        if (error.name !== 'AbortError') {
          logError('Error in createEffect refetch:', error);
        }
      }
    }
  });

  const getDate = async () => {
    const controller = new AbortController();
    
    try {
      // In fleet mode (when selectedDatasetId is 0 or not set), use selectedDate directly
      if (!selectedDatasetId() || selectedDatasetId() === 0) {
        const dateStr = selectedDate();
        if (dateStr) {
          // Format date to YYYYMMDD if needed
          let formattedDate = dateStr;
          if (dateStr.includes('-')) {
            formattedDate = dateStr.replace(/-/g, '');
          }
          setDate(formattedDate);
          return;
        }
      }
      
      // Otherwise, fetch date from dataset info
      const response = await getData(
        `${apiEndpoints.app.datasets}/info?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`,
        controller.signal
      );

      if (response.success) {
        let date_str = response.data.date;
        setDate(date_str);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {

      } else {
        logError('Error fetching date:', error);
      }
    }
  };

  const getChannels = async () => {
    const controller = new AbortController();
    
    try {
      // Check if we have required data
      const currentDate = date();
      const currentSource = selectedSourceName();
      
      if (!currentDate) {
        logError('[FileChannelPicker] Cannot fetch channels: date is not set');
        setAvailableChannels([]);
        return;
      }
      
      if (!currentSource) {
        logError('[FileChannelPicker] Cannot fetch channels: source_name is not set');
        setAvailableChannels([]);
        return;
      }
      
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      // 1. Try HuniDB cache first (fastest, preserves original case)
      // Only check HuniDB if we have valid IDs (not in fleet mode where datasetId might be 0)
      try {
        // Channels are unique to the class, so we only need className
        if (className) {
          const { huniDBStore } = await import('../../store/huniDBStore');
          const cachedChannels = await huniDBStore.getCachedChannelNames(
            className
          );
          
          if (cachedChannels.length > 0) {
            log(`[FileChannelPicker] Using ${cachedChannels.length} channels from HuniDB cache`);
            const fileServerChannels = await getChannelsFromFileServer(className, projectId, currentDate.replace(/[-/]/g, ''), currentSource, 'unified');
            const merged = mergeChannelLists(cachedChannels, fileServerChannels);
            if (merged.length > cachedChannels.length) {
              debug(`[FileChannelPicker] Merged ${fileServerChannels.length} file-server channels; total ${merged.length} (includes e.g. fusion channels)`);
            }
            setAvailableChannels(merged);

            if (className && projectId && currentDate) {
              const { syncChannelsFromPostgreSQL } = await import('../../services/channelsService');
              syncChannelsFromPostgreSQL(className, projectId, currentDate, currentSource)
                .catch(err => {
                  if (err?.name !== 'AbortError') debug('[FileChannelPicker] Background sync failed:', err);
                });
            }

            return;
          }
        } else {
          debug('[FileChannelPicker] Skipping HuniDB cache (missing className)');
        }
      } catch (huniErr) {
        debug('[FileChannelPicker] HuniDB cache not available, falling back to discovery cache:', huniErr);
      }
      
      // 2. If not found in hunidb, try PostgreSQL API (backend is source of truth)
      if (className && projectId) {
        try {
          const { getChannels } = await import('../../services/channelsService');
          const normalizedDate = currentDate.replace(/[-/]/g, '');
          const apiChannels = await getChannels(className, projectId, normalizedDate);
          
          if (apiChannels && apiChannels.length > 0) {
            log(`[FileChannelPicker] Using ${apiChannels.length} channels from PostgreSQL API`);
            const fileServerChannels = await getChannelsFromFileServer(className, projectId, normalizedDate, currentSource, 'unified');
            const merged = mergeChannelLists(apiChannels, fileServerChannels);
            if (merged.length > apiChannels.length) {
              debug(`[FileChannelPicker] Merged ${fileServerChannels.length} file-server channels; total ${merged.length} (includes e.g. fusion channels)`);
            }
            setAvailableChannels(merged);

            if (className) {
              const { huniDBStore } = await import('../../store/huniDBStore');
              huniDBStore.cacheChannelNames(className, normalizedDate, 'UNIFIED', merged)
                .catch(err => debug('[FileChannelPicker] Failed to cache to hunidb:', err));
            }

            return;
          } else {
            const fileServerChannels = await getChannelsFromFileServer(className, projectId, normalizedDate, currentSource, 'unified');
            if (fileServerChannels.length > 0) {
              log(`[FileChannelPicker] No channels from PostgreSQL; using ${fileServerChannels.length} from file server (e.g. fusion parquet)`);
              setAvailableChannels(fileServerChannels);
            } else {
              log(`[FileChannelPicker] No channels returned from PostgreSQL API - returning empty array (backend is source of truth)`);
              setAvailableChannels([]);
            }
            return;
          }
        } catch (apiErr) {
          log('[FileChannelPicker] PostgreSQL API error - returning empty array (backend is source of truth):', apiErr);
          setAvailableChannels([]);
          return;
        }
      }
      
      // 3. Check in-memory cache (from channel discovery store) - this may have channels from previous successful API calls
      const cachedChannels = getCachedChannels(currentDate, currentSource, 'UNIFIED');
      if (cachedChannels.length > 0) {
        log(`[FileChannelPicker] Using ${cachedChannels.length} cached unified channels`);
        const normalizedDate = currentDate.replace(/[-/]/g, '');
        if (className && projectId) {
          const fileServerChannels = await getChannelsFromFileServer(className, projectId, normalizedDate, currentSource, 'unified');
          const merged = mergeChannelLists(cachedChannels, fileServerChannels);
          setAvailableChannels(merged);
        } else {
          setAvailableChannels(cachedChannels);
        }
        if (className && projectId && currentDate) {
          const { syncChannelsFromPostgreSQL } = await import('../../services/channelsService');
          syncChannelsFromPostgreSQL(className, projectId, currentDate, currentSource)
            .catch(err => debug('[FileChannelPicker] Background sync failed:', err));
        }
        return;
      }

      // 4. Fallback: try file server only (e.g. fusion parquet exists but DB not populated)
      if (className && projectId) {
        const normalizedDate = currentDate.replace(/[-/]/g, '');
        const fileServerChannels = await getChannelsFromFileServer(className, projectId, normalizedDate, currentSource, 'unified');
        if (fileServerChannels.length > 0) {
          log(`[FileChannelPicker] No channels in cache or PostgreSQL; using ${fileServerChannels.length} from file server (e.g. fusion parquet)`);
          setAvailableChannels(fileServerChannels);
          return;
        }
      }

      log('[FileChannelPicker] No channels found in cache, PostgreSQL API, or file server - returning empty array');
      setAvailableChannels([]);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Request was cancelled, do nothing
      } else {
        logError('Error fetching channels:', error);
      }
    }
  };

  const fillChannels = async () => {
    const searchText = search().toLowerCase().trim();
    if (searchText.length > 0) {
      const searchArray = searchText.includes(" ") ? searchText.split(" ") : [searchText];

      const filteredChannels = availableChannels().filter((channel) => {
        const channelStr = channel.toLowerCase();
        return searchArray.every((searchStr) => channelStr.includes(searchStr));
      });

      setSearchChannels(
        filteredChannels.slice(0, 20).map((channel) => ({
          name: channel,
          isChecked: false,
        }))
      );
    } else {
      setSearchChannels([]);
    }
  };

  const handleChannelSelection = (channel: string, isChecked: boolean) => {
    if (isChecked) {
      setChannels([...channels(), channel]); // Add to selected channels
      setAvailableChannels((prev) => prev.filter((ch) => ch !== channel)); // Remove from available channels
      setSearchChannels((prev) => prev.filter((ch) => ch.name !== channel)); // Remove from searched channels
    } else {
      setChannels((prev) => prev.filter((ch) => ch !== channel)); // Remove from selected channels
      setAvailableChannels((prev) => [...prev, channel]); // Add back to available channels
      setSearchChannels((prev) => [...prev, { name: channel, isChecked: false }]); // Add back to searched channels
    }
  };

  const save = (list: string[]) => {
    setModalOpen(false);
    onSave(list)
  };

  return (
    <Portal>
      <div class={`modal ${isModalOpen() ? "block" : "hidden"} ${themeStore.isDark() ? 'dark' : 'light'}`}>
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Manage Channels</h5>
              <button class="close" onClick={() => save([])}>
                &times;
              </button>
            </div>
            <div class="modal-body">
              {/* Search Box */}
              <div class="mb-4">
                <label for="search" class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">Search Channels</label>
                <input
                  id="search"
                  type="text"
                  class="w-full border rounded px-3 py-2"
                  style="border-color: var(--color-border-primary); background: var(--color-bg-input);"
                  value={search()}
                  onInput={(e) => {
                    setSearch((e.target as HTMLInputElement).value);
                    fillChannels();
                  }}
                  placeholder="Search for channels..."
                  autocomplete="off" // Disable HTML autofill
                />
              </div>
              {/* Search Results */}
              {search().length > 0 && (
                <div id="search_channels" class="border rounded p-2 mb-4" style="border-color: var(--color-border-primary); background: var(--color-bg-secondary);">
                  {searchChannels().length > 0 ? (
                    searchChannels().map((channel) => (
                      <div class="flex items-center space-x-2">
                        <input
                          type="checkbox"
                          id={channel.name}
                          checked={channels().includes(channel.name)} // Reflect selection state
                          onChange={(e) => {
                            handleChannelSelection(channel.name, (e.target as HTMLInputElement).checked);
                          }}
                        />
                        <label for={channel.name} style="color: var(--color-text-primary);">{channel.name}</label>
                      </div>
                    ))
                  ) : (
                    <p style="color: var(--color-text-secondary);">No channels found.</p>
                  )}
                </div>
              )}
              {/* Selected Channels */}
              {channels().length > 0 && (
                <div id="channels" class="border rounded p-2 mb-4" style="border-color: var(--color-border-primary); background: var(--color-bg-secondary);">
                  {channels().map((channel) => (
                    <div class="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked
                        onClick={() => handleChannelSelection(channel, false)} // Add back to available channels
                      />
                      <span style="color: var(--color-text-primary);">{channel}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div class="modal-footer">
              <button 
                class="px-4 py-2"
                style="background: #22c55e; color: white;"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = '#16a34a';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = '#22c55e';
                }}
                onClick={() => save(channels())}
              >
                Add Channels
              </button>
              <button class="btn btn-secondary px-4 py-2 ml-2" onClick={() => save([])}>
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default FileChannelPicker;

