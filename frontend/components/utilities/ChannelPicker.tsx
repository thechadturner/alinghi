import { createSignal, onMount, createEffect } from "solid-js";
import { Portal } from "solid-js/web";

import { getData } from "../../utils/global";
import { persistantStore } from "../../store/persistantStore";
import { themeStore } from "../../store/themeStore";
import { apiEndpoints } from "@config/env";
import { error as logError } from "../../utils/console";
const { selectedProjectId, selectedClassName, selectedDatasetId, selectedSourceName } = persistantStore;

export interface ChannelPickerProps {
  onSave: (channels: string[]) => void;
  tableName?: string;
  additionalChannels?: string[];
  isUpdate?: boolean;
}

interface SearchChannel {
  name: string;
  isChecked: boolean;
}

const ChannelPicker = (props: ChannelPickerProps) => {
  const { onSave, tableName = 'events_aggregate', additionalChannels = [], isUpdate = false } = props;

  const [search, setSearch] = createSignal("");
  const [searchChannels, setSearchChannels] = createSignal<SearchChannel[]>([]);
  const [availableChannels, setAvailableChannels] = createSignal<string[]>([]); // Fetched channels from API
  const [channels, setChannels] = createSignal<string[]>([]); // Selected channels
  const [isModalOpen, setModalOpen] = createSignal(true);
  let searchInputRef: HTMLInputElement | undefined;

  onMount(async () => {
    await getChannels();
    // Focus search input after modal is rendered
    setTimeout(() => {
      searchInputRef?.focus();
    }, 100);
  });

  // Auto-focus search input when modal opens
  createEffect(() => {
    if (isModalOpen() && searchInputRef) {
      // Small delay to ensure modal is fully rendered
      setTimeout(() => {
        searchInputRef?.focus();
      }, 100);
    }
  });

  const getChannels = async () => {
    const controller = new AbortController();
    
    // Default channels that are always available
    const defaultChannels = [
      "Race_number",
      "Leg_number",
      "Tack",
      "PointofSail"
    ];
    
    // Merge default channels with additional channels from props
    const channelsFromProps = Array.isArray(additionalChannels) ? additionalChannels : [];
    const predefinedChannels = [...defaultChannels];
    channelsFromProps.forEach(channel => {
      if (!predefinedChannels.includes(channel)) {
        predefinedChannels.push(channel);
      }
    });
    
    try {
      const response = await getData(`${apiEndpoints.app.data}/channels?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&table_name=${encodeURIComponent(tableName)}`, controller.signal);

      if (response.success) {
        let channels: string[] = []
        response.data.forEach((channel: any) => {
          channels.push(channel.column_name)
        })
        
        // Combine predefined channels with fetched channels, ensuring no duplicates
        const allChannels = [...predefinedChannels];
        channels.forEach(channel => {
          if (!allChannels.includes(channel)) {
            allChannels.push(channel);
          }
        });

        setAvailableChannels(allChannels); // Store fetched channels
      } else {
        // Even if fetch fails, set predefined channels
        setAvailableChannels([...predefinedChannels]);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {

      } else {
        logError('Error fetching channels:', error);
        // Even if fetch fails, set predefined channels
        setAvailableChannels([...predefinedChannels]);
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
                  ref={searchInputRef}
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
                {isUpdate ? 'Update' : 'Add Channels'}
              </button>
              <button 
                class="btn btn-secondary px-4 py-2 ml-2"
                style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-button-secondary-hover)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--color-bg-button-secondary)';
                }}
                onClick={() => save([])}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default ChannelPicker;

