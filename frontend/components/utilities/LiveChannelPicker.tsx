import { createSignal, createEffect } from "solid-js";
import { Portal } from "solid-js/web";
import { themeStore } from "../../store/themeStore";

export interface LiveChannelPickerProps {
  isOpen: boolean;
  onClose: () => void;
  availableChannels: string[];
  selectedChannels: string[];
  onSave: (channels: string[]) => void;
}

const LiveChannelPicker = (props: LiveChannelPickerProps) => {
  const { isOpen, onClose, availableChannels, selectedChannels, onSave } = props;

  const [search, setSearch] = createSignal("");
  const [localSelected, setLocalSelected] = createSignal<string[]>([]);

  // When modal opens, sync local selection from props
  createEffect(() => {
    if (isOpen) {
      setLocalSelected([...selectedChannels]);
      setSearch("");
    }
  });

  // Available = all live channels not currently selected
  const available = () =>
    availableChannels.filter((c) => !localSelected().includes(c));

  const filteredAvailable = () => {
    const q = search().toLowerCase().trim();
    if (!q) return available();
    const terms = q.includes(" ") ? q.split(" ") : [q];
    return available().filter((ch) =>
      terms.every((t) => ch.toLowerCase().includes(t))
    );
  };

  const handleAdd = (channel: string) => {
    setLocalSelected((prev) => [...prev, channel]);
  };

  const handleRemove = (channel: string) => {
    setLocalSelected((prev) => prev.filter((c) => c !== channel));
  };

  const handleSave = () => {
    onSave(localSelected());
    onClose();
  };

  const handleClose = () => {
    onClose();
  };

  if (!isOpen) return null;

  const hasChannels = availableChannels.length > 0;

  return (
    <Portal>
      <div
        class={`modal block ${themeStore.isDark() ? "dark" : "light"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="live-channel-picker-title"
      >
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 id="live-channel-picker-title" class="modal-title">
                Live Table Channels
              </h5>
              <button type="button" class="close" onClick={handleClose} aria-label="Close">
                &times;
              </button>
            </div>
            <div class="modal-body">
              {!hasChannels ? (
                <p class="live-channel-picker-empty" style="color: var(--color-text-secondary);">
                  No live channels available. Ensure streaming is active and sources have data.
                </p>
              ) : (
                <>
                  <div class="mb-4">
                    <label for="live-channel-search" class="block text-sm font-medium mb-1" style="color: var(--color-text-primary);">
                      Search channels
                    </label>
                    <input
                      id="live-channel-search"
                      type="text"
                      class="w-full border rounded px-3 py-2"
                      style="border-color: var(--color-border-primary); background: var(--color-bg-input); color: var(--color-text-primary);"
                      value={search()}
                      onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                      placeholder="Search for channels..."
                      autocomplete="off"
                    />
                  </div>
                  <div class="mb-2 text-sm font-medium" style="color: var(--color-text-primary);">
                    Available ({filteredAvailable().length})
                  </div>
                  <div
                    class="border rounded p-2 mb-4 max-h-40 overflow-y-auto"
                    style="border-color: var(--color-border-primary); background: var(--color-bg-secondary);"
                  >
                    {filteredAvailable().length > 0 ? (
                      <ul class="list-none p-0 m-0">
                        {filteredAvailable().map((channel) => (
                          <li key={channel} class="flex items-center gap-2 py-1">
                            <input
                              type="checkbox"
                              id={`avail-${channel}`}
                              checked={false}
                              onChange={() => handleAdd(channel)}
                            />
                            <label for={`avail-${channel}`} style="color: var(--color-text-primary); cursor: pointer;">
                              {channel}
                            </label>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p style="color: var(--color-text-secondary);">
                        {search().length > 0 ? "No channels match." : "All channels are selected."}
                      </p>
                    )}
                  </div>
                  <div class="mb-2 text-sm font-medium" style="color: var(--color-text-primary);">
                    Channels to show in table ({localSelected().length})
                  </div>
                  <div
                    class="border rounded p-2 max-h-48 overflow-y-auto"
                    style="border-color: var(--color-border-primary); background: var(--color-bg-secondary);"
                  >
                    {localSelected().length > 0 ? (
                      <ul class="list-none p-0 m-0">
                        {localSelected().map((channel) => (
                          <li key={channel} class="flex items-center gap-2 py-1">
                            <input
                              type="checkbox"
                              id={`sel-${channel}`}
                              checked
                              onChange={() => handleRemove(channel)}
                            />
                            <label for={`sel-${channel}`} style="color: var(--color-text-primary); cursor: pointer;">
                              {channel}
                            </label>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p style="color: var(--color-text-secondary);">No channels selected. Add from search or from the list above.</p>
                    )}
                  </div>
                </>
              )}
            </div>
            <div class="modal-footer">
              <button
                type="button"
                class="px-4 py-2"
                style="background: #22c55e; color: white;"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "#16a34a";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "#22c55e";
                }}
                onClick={handleSave}
                disabled={!hasChannels}
              >
                Save
              </button>
              <button
                type="button"
                class="btn btn-secondary px-4 py-2 ml-2"
                style="background: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--color-bg-button-secondary-hover)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--color-bg-button-secondary)";
                }}
                onClick={handleClose}
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

export default LiveChannelPicker;
