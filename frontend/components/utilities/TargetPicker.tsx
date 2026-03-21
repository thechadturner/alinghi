import { createSignal, onMount, createEffect } from "solid-js";
import { Portal } from "solid-js/web";

import { getData } from "../../utils/global";
import { persistantStore } from "../../store/persistantStore";
import { themeStore } from "../../store/themeStore";
import { apiEndpoints } from "@config/env";
import { error as logError, log } from "../../utils/console";
const { selectedProjectId, selectedClassName } = persistantStore;

export interface TargetPickerProps {
  onSave: (channels: string[]) => void;
}

interface SearchChannel {
  name: string;
  isChecked: boolean;
}

const TargetPicker = (props: TargetPickerProps) => {
  const { onSave } = props;

  const [search, setSearch] = createSignal("");
  const [searchChannels, setSearchChannels] = createSignal<SearchChannel[]>([]);
  const [availableChannels, setAvailableChannels] = createSignal<string[]>([]); // Fetched channels from API
  const [channels, setChannels] = createSignal<string[]>([]); // Selected channels
  const [isModalOpen, setModalOpen] = createSignal(true);
  let searchInputRef: HTMLInputElement | undefined;

  onMount(async () => {
    await getChannels();
    fillChannels(); // Ensure the full list of channels is shown by default
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
    
    try {
      const response = await getData(`${apiEndpoints.app.targets}/channels?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}`, controller.signal);
      if (!response.success) throw new Error("Failed to fetch dataset object.");

      let channels: string[] = []
      response.data.forEach((channel: any) => {
        channels.push(channel.keys)
      })
      
      setAvailableChannels(channels);
      log(channels)
    } catch (error: any) {
      if (error.name === 'AbortError') {

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
        filteredChannels.map((channel) => ({
          name: channel,
          isChecked: false,
        }))
      );
    } else {
      setSearchChannels([])
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
              <label for="search" class="block text-sm font-medium mb-1">Search Channels</label>
              <input
                ref={searchInputRef}
                id="search"
                type="text"
                class="w-full border border-gray-300 rounded px-3 py-2"
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
              <div id="search_channels" class="border rounded p-2 mb-4">
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
                      <label for={channel.name}>{channel.name}</label>
                    </div>
                  ))
                ) : (
                  <p class="text-gray-500">No channels found.</p>
                )}
              </div>
            )}
            {/* Selected Channels */}
            {channels().length > 0 && (
              <div id="channels" class="border rounded p-2 mb-4">
                {channels().map((channel) => (
                  <div class="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked
                      onClick={() => handleChannelSelection(channel, false)} // Add back to available channels
                    />
                    <span>{channel}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary px-4 py-2" onClick={() => save(channels())}>
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

export default TargetPicker;

