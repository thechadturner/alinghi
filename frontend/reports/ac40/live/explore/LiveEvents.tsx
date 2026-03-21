import { onMount, onCleanup, createSignal, Show, For, createMemo, createEffect } from "solid-js";
import { FiSearch, FiTrash2 } from "solid-icons/fi";
import { getData, postData, deleteData, formatDateTime } from "../../../../utils/global";
import { apiEndpoints } from "@config/env";
import { persistantStore } from "../../../../store/persistantStore";
import { selectedTime, setSelectedTime, requestTimeControl, setIsManualTimeChange, releaseTimeControl } from "../../../../store/playbackStore";
import { user } from "../../../../store/userStore";
import { selectedRange, cutEvents, hasSelection, isCut, setSelectedRange, setHasSelection, setIsCut } from "../../../../store/selectionStore";
import { error as logError, debug, warn } from "../../../../utils/console";
import { unifiedDataStore } from "../../../../store/unifiedDataStore";
import type { EventData } from "../../../../store/selectionStore";
import { getCurrentDatasetTimezone } from "../../../../store/datasetTimezoneStore";

const { selectedClassName, selectedProjectId, selectedDatasetId } = persistantStore;

/** Window for live events: last 6 hours */
const LIVE_EVENTS_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Poll interval for background refresh (ms) */
const POLL_INTERVAL_MS = 30 * 1000;

interface CommentEvent {
  datetime: string;
  event_type: string;
  comment: string;
  user_name?: string;
  [key: string]: any;
}

function eventKey(e: CommentEvent): string {
  return `${e.datetime}|${e.comment ?? ''}|${e.user_name ?? ''}`;
}

function filterLastSixHours(list: CommentEvent[]): CommentEvent[] {
  const cutoff = Date.now() - LIVE_EVENTS_WINDOW_MS;
  return list.filter((e) => e.datetime && new Date(e.datetime).getTime() >= cutoff);
}

export default function LiveEvents() {
  const [events, setEvents] = createSignal<CommentEvent[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [searchTerm, setSearchTerm] = createSignal("");
  const [selectedUser, setSelectedUser] = createSignal("all");
  const [selectedEventType, setSelectedEventType] = createSignal("all");
  const [newNote, setNewNote] = createSignal("");
  const [submittingNote, setSubmittingNote] = createSignal(false);
  const [commentDatetime, setCommentDatetime] = createSignal("");
  const [selectedComment, setSelectedComment] = createSignal<CommentEvent | null>(null);
  const [deletingComment, setDeletingComment] = createSignal(false);
  
  // AbortController for initial load (cleaned up on unmount)
  let abortController: AbortController | null = null;

  // Helper function to remove quotes from comment text
  const removeQuotes = (text: string | null | undefined): string => {
    if (!text) return '-';
    return text.replace(/^["']|["']$/g, '').trim();
  };

  // Fetch events from API (optionally with a signal for cancellation)
  const fetchEventsTable = async (signal?: AbortSignal): Promise<CommentEvent[]> => {
    try {
      const response = await getData(
        `${apiEndpoints.app.comments}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(selectedDatasetId())}`,
        signal
      );

      if (response.success) {
        return (response.data || []) as CommentEvent[];
      }

      return [];
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return [];
      }
      logError('Error fetching events table:', error);
      return [];
    }
  };

  // Get unique users and event types for filter dropdowns
  const uniqueUsers = createMemo<string[]>(() => {
    const users = [...new Set(events().map(event => event.user_name).filter(Boolean))] as string[];
    return users.sort();
  });

  const uniqueEventTypes = createMemo<string[]>(() => {
    const types = [...new Set(events().map(event => event.event_type).filter(Boolean))] as string[];
    return types.sort();
  });

  // Filter events based on search, filters, and time range
  const filteredEvents = createMemo<CommentEvent[]>(() => {
    let filtered = events();
    
    // Apply time range filtering first (selectedRange or cutEvents)
    const currentSelectedRange = selectedRange();
    const currentCutEvents = cutEvents();
    
    if (currentSelectedRange && currentSelectedRange.length > 0) {
      // Filter by selectedRange
      const rangeItem = currentSelectedRange[0] as EventData;
      const startTime = rangeItem.start_time ? new Date(rangeItem.start_time) : null;
      const endTime = rangeItem.end_time ? new Date(rangeItem.end_time) : null;
      
      if (startTime && endTime) {
        filtered = filtered.filter(event => {
          if (!event.datetime) return false;
          const eventTime = new Date(event.datetime);
          return eventTime >= startTime && eventTime <= endTime;
        });
      }
    } else if (currentCutEvents && currentCutEvents.length > 0) {
      // Filter by cutEvents
      const cutItem = currentCutEvents[0] as EventData;
      const startTime = new Date(cutItem.start_time as string);
      const endTime = new Date(cutItem.end_time as string);
      
      filtered = filtered.filter(event => {
        if (!event.datetime) return false;
        const eventTime = new Date(event.datetime);
        return eventTime >= startTime && eventTime <= endTime;
      });
    }
    
    // Filter by search term
    if (searchTerm()) {
      const term = searchTerm().toLowerCase();
      filtered = filtered.filter(event => 
        removeQuotes(event.comment)?.toLowerCase().includes(term) ||
        event.user_name?.toLowerCase().includes(term) ||
        event.event_type?.toLowerCase().includes(term) ||
        event.datetime?.toLowerCase().includes(term)
      );
    }
    
    // Filter by user
    if (selectedUser() !== "all") {
      filtered = filtered.filter(event => event.user_name === selectedUser());
    }
    
    // Filter by event type
    if (selectedEventType() !== "all") {
      filtered = filtered.filter(event => event.event_type === selectedEventType());
    }
    
    return filtered;
  });

  // Handle datetime click to set selectedTime
  const handleDateTimeClick = (datetime: string) => {
    try {
      const date = new Date(datetime);
      if (!isNaN(date.getTime())) {
        debug('Events: Attempting to request time control...');
        // Request control of selectedTime to trigger boat halo effect
        if (requestTimeControl('events')) {
          debug('Events: Time control granted, setting selectedTime');
          setIsManualTimeChange(true); // Set manual change flag for boat animation
          setSelectedTime(date, 'events');
          debug('Selected time set to:', date.toISOString());
          
          // Update comment datetime input (convert to local time)
          const localDate = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
          const formatted = localDate.toISOString().slice(0, 19).replace('T', ' ');
          setCommentDatetime(formatted);
          
          // Release time control immediately after setting
          setTimeout(() => {
            debug('Events: Releasing time control');
            releaseTimeControl('events');
          }, 100);
        } else {
          debug('Events: Time control denied - another component has higher priority');
        }
      } else {
        warn('Invalid datetime:', datetime);
      }
    } catch (error: unknown) {
      logError('Error setting selected time:', error as any);
    }
  };

  // Handle magnify click to set selectedTime and selectedRange
  const handleMagnifyClick = async (datetime: string, eventType: string) => {
    try {
      const date = new Date(datetime);
      if (!isNaN(date.getTime())) {
        debug('Events: Magnify click - requesting time control...', {
          datetime,
          eventType,
          parsedDate: date.toISOString()
        });
        if (requestTimeControl('events')) {
          debug('Events: Time control granted, setting selectedTime and selectedRange');
          setIsManualTimeChange(true); // Set manual change flag for boat animation
          setSelectedTime(date, 'events');
          
          let startTime, endTime;
          
          // Try to find the event in IndexedDB
          try {
            const className = selectedClassName();
            if (className && eventType) {
              debug('Events: Fetching events from IndexedDB', {
                className,
                projectId: selectedProjectId(),
                datasetId: selectedDatasetId(),
                eventType
              });
              
              const allEvents = await unifiedDataStore.fetchEvents(
                className,
                selectedProjectId(),
                selectedDatasetId()
              );
              
              debug('Events: Fetched events from IndexedDB', {
                totalEvents: allEvents?.length || 0,
                eventTypes: [...new Set(allEvents?.map(e => e.event_type) || [])]
              });
              
              if (allEvents && allEvents.length > 0) {
                const targetTime = date.getTime();
                let matchingEvent = null;
                let closestEvent = null;
                let closestDistance = Infinity;
                
                // Filter events by type and find the one closest to the datetime
                const eventsOfType = allEvents.filter(evt => 
                  evt.event_type?.toUpperCase() === eventType.toUpperCase()
                );
                
                debug('Events: Filtered events by type', {
                  eventType,
                  matchingCount: eventsOfType.length,
                  eventIds: eventsOfType.map(e => e.event_id)
                });
                
                for (const evt of eventsOfType) {
                  // Ensure start_time and end_time are properly parsed
                  const eventStart = evt.start_time ? new Date(evt.start_time).getTime() : 0;
                  const eventEnd = evt.end_time ? new Date(evt.end_time).getTime() : 0;
                  
                  if (isNaN(eventStart) || isNaN(eventEnd)) {
                    debug('Events: Invalid event times', {
                      event_id: evt.event_id,
                      start_time: evt.start_time,
                      end_time: evt.end_time
                    });
                    continue;
                  }
                  
                  // Check if target time is within this event's range (with 1 second tolerance)
                  const tolerance = 1000; // 1 second in milliseconds
                  if (targetTime >= (eventStart - tolerance) && targetTime <= (eventEnd + tolerance)) {
                    matchingEvent = evt;
                    debug('Events: Found exact match', {
                      event_id: evt.event_id,
                      targetTime: new Date(targetTime).toISOString(),
                      eventStart: new Date(eventStart).toISOString(),
                      eventEnd: new Date(eventEnd).toISOString()
                    });
                    break; // Found exact match
                  }
                  
                  // Track closest event (smallest distance to either start or end)
                  const distToStart = Math.abs(targetTime - eventStart);
                  const distToEnd = Math.abs(targetTime - eventEnd);
                  const minDist = Math.min(distToStart, distToEnd);
                  
                  if (minDist < closestDistance) {
                    closestDistance = minDist;
                    closestEvent = evt;
                  }
                }
                
                const eventToUse = matchingEvent || closestEvent;
                
                if (eventToUse) {
                  startTime = new Date(eventToUse.start_time);
                  endTime = new Date(eventToUse.end_time);
                  
                  // Validate the dates
                  if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
                    warn('Events: Invalid start/end times from event, using fallback', {
                      start_time: eventToUse.start_time,
                      end_time: eventToUse.end_time
                    });
                    startTime = new Date(date.getTime() - 30000);
                    endTime = new Date(date.getTime() + 30000);
                  } else {
                    debug('Events: Found event in IndexedDB', {
                      event_id: eventToUse.event_id,
                      event_type: eventToUse.event_type,
                      wasExactMatch: !!matchingEvent,
                      closestDistance: closestDistance,
                      start_time: startTime.toISOString(),
                      end_time: endTime.toISOString()
                    });
                  }
                } else {
                  // Fallback: 30 seconds before and 30 seconds after
                  startTime = new Date(date.getTime() - 30000); // 30 seconds before
                  endTime = new Date(date.getTime() + 30000);   // 30 seconds after
                  warn('Events: No matching event found, using fallback range (30s before/after)', {
                    targetTime: date.toISOString(),
                    eventType,
                    eventsOfTypeCount: eventsOfType.length,
                    closestDistance: closestDistance !== Infinity ? closestDistance : 'N/A'
                  });
                }
              } else {
                // Fallback: 30 seconds before and 30 seconds after
                startTime = new Date(date.getTime() - 30000); // 30 seconds before
                endTime = new Date(date.getTime() + 30000);   // 30 seconds after
                warn('Events: No events in IndexedDB, using fallback range (30s before/after)');
              }
            } else {
              // Fallback: 30 seconds before and 30 seconds after
              startTime = new Date(date.getTime() - 30000); // 30 seconds before
              endTime = new Date(date.getTime() + 30000);   // 30 seconds after
              warn('Events: Missing className or eventType, using fallback range (30s before/after)', {
                className,
                eventType
              });
            }
          } catch (error: unknown) {
            // Fallback: 30 seconds before and 30 seconds after
            logError('Events: Error looking up event in IndexedDB, using fallback range:', error);
            startTime = new Date(date.getTime() - 30000); // 30 seconds before
            endTime = new Date(date.getTime() + 30000);   // 30 seconds after
          }
          
          // Create range with ISO strings (type expects strings, but code handles both strings and Date objects)
          const range: EventData = {
            type: "range",
            start_time: startTime.toISOString(),
            end_time: endTime.toISOString()
          };
          
          // Set selection state - this should trigger map updates via TrackLayer's reactive effects
          debug('Events: Setting selectedRange to trigger map update', {
            selectedTime: date.toISOString(),
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            range
          });
          
          setSelectedRange([range]);
          setHasSelection(true);
          setIsCut(false);
          
          // Update comment datetime input (convert to local time)
          const localDate = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
          const formatted = localDate.toISOString().slice(0, 19).replace('T', ' ');
          setCommentDatetime(formatted);
          
          // Verify the range was set correctly after a delay to allow MapTimeSeries to sync
          setTimeout(() => {
            const currentRange = selectedRange();
            debug('Events: Verified selectedRange after setting', {
              rangeSet: currentRange?.length || 0,
              rangeValue: currentRange?.[0]
            });
            
            // If range was cleared, restore it (MapTimeSeries brush sync might have cleared it)
            if (!currentRange || currentRange.length === 0) {
              warn('Events: selectedRange was cleared, restoring it');
              setSelectedRange([range]);
              setHasSelection(true);
            }
          }, 200); // Increased delay to allow MapTimeSeries brush sync to complete
          
          // Release time control after ensuring range is set
          setTimeout(() => {
            debug('Events: Releasing time control');
            releaseTimeControl('events');
          }, 250); // Delay release to ensure range persists
        } else {
          debug('Events: Time control denied - another component has higher priority');
        }
      } else {
        warn('Invalid datetime:', datetime);
      }
    } catch (error) {
      logError('Error setting selected time and range:', error);
    }
  };

  // Helper function to validate datetime
  const isValidDatetime = (datetimeStr: string): boolean => {
    if (!datetimeStr.trim()) return false;
    
    try {
      let parsedDate = new Date(datetimeStr);
      
      // Try various parsing methods
      if (isNaN(parsedDate.getTime())) {
        parsedDate = new Date(datetimeStr + 'Z');
      }
      if (isNaN(parsedDate.getTime())) {
        parsedDate = new Date(datetimeStr.replace(' ', 'T'));
      }
      
      return !isNaN(parsedDate.getTime());
    } catch (error) {
      return false;
    }
  };

  // Check if user can delete comments (administrator or publisher)
  const canDeleteComments = (): boolean => {
    const userPermissions = user()?.permissions;
    if (typeof userPermissions === 'string') {
      return userPermissions === 'administrator' || userPermissions === 'publisher';
    }
    if (userPermissions && typeof userPermissions === 'object') {
      const values = Object.values(userPermissions);
      return values.includes('administrator') || values.includes('publisher');
    }
    return false;
  };

  // Handle note submission
  const handleSubmitNote = async () => {
    debug('handleSubmitNote called!', { newNote: newNote(), user: user() });
    
    if (!newNote().trim()) {
      debug('No note text, returning early');
      return;
    }

    // Validate datetime
    const datetimeStr = commentDatetime().trim();
    if (!datetimeStr) {
      debug('No datetime provided');
      return;
    }

    // Try to parse the datetime - accept various formats
    let parsedDate;
    try {
      // Try parsing as-is first (treats as local time)
      parsedDate = new Date(datetimeStr);
      
      // If that fails, try adding timezone info
      if (isNaN(parsedDate.getTime())) {
        parsedDate = new Date(datetimeStr + 'Z'); // Add UTC timezone
      }
      
      // If still invalid, try replacing space with T
      if (isNaN(parsedDate.getTime())) {
        parsedDate = new Date(datetimeStr.replace(' ', 'T'));
      }
      
      // If still invalid, try replacing space with T and adding Z
      if (isNaN(parsedDate.getTime())) {
        parsedDate = new Date(datetimeStr.replace(' ', 'T') + 'Z');
      }
      
      // Final check
      if (isNaN(parsedDate.getTime())) {
        debug('Invalid datetime format:', datetimeStr);
        alert('Please enter a valid datetime in format YYYY-MM-DD HH:MM:SS');
        return;
      }
    } catch (error) {
      debug('Error parsing datetime:', error);
      alert('Please enter a valid datetime in format YYYY-MM-DD HH:MM:SS');
      return;
    }

    debug('Valid datetime parsed:', parsedDate.toISOString());
    
    setSubmittingNote(true);
    try {
      const response = await postData(
        `${apiEndpoints.app.comments}`,
        {
          class_name: selectedClassName(),
          project_id: selectedProjectId(),
          dataset_id: selectedDatasetId(),
          user_id: user()?.user_id,
          datetime: parsedDate.toISOString(),
          comment: newNote().trim()
        }
      );

      if (response.success) {
        // Clear the input
        setNewNote("");
        
        // Release time control to allow future requests
        releaseTimeControl('events');
        
        // Refresh events data
        await loadEvents();
      } else {
        logError('Failed to submit note:', response.message);
      }
    } catch (error: unknown) {
      logError('Error submitting note:', error as any);
    } finally {
      setSubmittingNote(false);
    }
  };

  // Load events data (full load; shows loading state)
  const loadEvents = async () => {
    setLoading(true);
    abortController = new AbortController();
    const raw = await fetchEventsTable(abortController.signal);
    const windowed = filterLastSixHours(raw);
    const sorted = [...windowed].sort(
      (a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime()
    );
    setEvents(sorted);
    setLoading(false);
  };

  // Background poll: fetch and merge only new events (no loading flash, prepend new rows)
  const pollForNewEvents = async () => {
    const ac = new AbortController();
    const raw = await fetchEventsTable(ac.signal);
    const windowed = filterLastSixHours(raw);
    const existing = events();
    const existingKeys = new Set(existing.map(eventKey));
    const newOnes = windowed.filter((e) => !existingKeys.has(eventKey(e)));
    if (newOnes.length > 0) {
      const byDateDesc = (a: CommentEvent, b: CommentEvent) =>
        new Date(b.datetime).getTime() - new Date(a.datetime).getTime();
      const merged = [...newOnes.sort(byDateDesc), ...existing];
      setEvents(merged);
      debug('LiveEvents: merged', newOnes.length, 'new event(s)');
    }
  };

  let pollIntervalId: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    await loadEvents();
    pollIntervalId = setInterval(pollForNewEvents, POLL_INTERVAL_MS);
  });

  // Effect to initialize comment datetime with selected time
  createEffect(() => {
    if (selectedTime()) {
      const date = new Date(selectedTime());
      // Convert UTC to local time for display
      const localDate = new Date(date.getTime() - (date.getTimezoneOffset() * 60000));
      const formatted = localDate.toISOString().slice(0, 19).replace('T', ' '); // Format as YYYY-MM-DD HH:MM:SS
      setCommentDatetime(formatted);
    }
  });

  // Cleanup on unmount
  onCleanup(() => {
    if (pollIntervalId != null) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    // Release time control when component unmounts
    releaseTimeControl('events');
  });

  // Handle comment deletion
  const handleDeleteComment = async (comment: CommentEvent) => {
    if (!canDeleteComments()) {
      debug('User does not have permission to delete comments');
      return;
    }

    if (!confirm(`Are you sure you want to delete this comment?\n\n"${removeQuotes(comment.comment)}"`)) {
      return;
    }

    setDeletingComment(true);
    try {
      const response = await deleteData(
        `${apiEndpoints.app.comments}`,
        {
          class_name: selectedClassName(),
          project_id: selectedProjectId(),
          dataset_id: selectedDatasetId(),
          user_id: user()?.user_id,
          datetime: new Date(comment.datetime).toISOString(),
          comment: comment.comment
        },
        abortController ? abortController.signal : undefined
      );

      debug('Delete response:', response);

      if (response.success) {
        // Clear selection
        setSelectedComment(null);
        
        // Release time control to allow future requests
        releaseTimeControl('events');
        
        // Refresh events data
        await loadEvents();
      } else {
        logError('Failed to delete comment:', response.message);
        alert('Failed to delete comment: ' + response.message);
      }
    } catch (error: unknown) {
      logError('Error deleting comment:', error as any);
      alert('Error deleting comment');
    } finally {
      setDeletingComment(false);
    }
  };

  return (
    <div class="events-container h-full max-h-screen flex flex-col overflow-hidden">
      {/* Row 1: Filter Controls - Fixed Height */}
      <div class="flex-shrink-0 mb-2 p-2">
        <div class="grid grid-cols-1 md:grid-cols-4 gap-2">
          {/* Search */}
          <div>
            <div class="relative">
              <FiSearch class="absolute left-3 top-1/2 transform -translate-y-1/2" style={{ "color": "var(--color-text-tertiary)" }} size={14} />
              <input
                type="text"
                placeholder="Search events..."
                class="w-full pl-10 pr-3"
                style={{ "padding-top": "8px", "padding-bottom": "8px", "border": "1px solid var(--color-border-primary)", "border-radius": "6px", "background": "var(--color-bg-input)", "color": "var(--color-text-primary)" }}
                value={searchTerm()}
                onInput={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>

          {/* User Filter */}
          <div>
            <select
              class="w-full"
              style={{ "padding": "8px 12px", "border": "1px solid var(--color-border-primary)", "border-radius": "6px", "background": "var(--color-bg-input)", "color": "var(--color-text-primary)" }}
              value={selectedUser()}
              onChange={(e) => setSelectedUser(e.target.value)}
            >
              <option value="all">All Users</option>
              <For each={uniqueUsers()}>
                {(user) => <option value={user}>{user}</option>}
              </For>
            </select>
          </div>

          {/* Event Type Filter */}
          <div>
            <select
              class="w-full"
              style={{ "padding": "8px 12px", "border": "1px solid var(--color-border-primary)", "border-radius": "6px", "background": "var(--color-bg-input)", "color": "var(--color-text-primary)" }}
              value={selectedEventType()}
              onChange={(e) => setSelectedEventType(e.target.value)}
            >
              <option value="all">All Types</option>
              <For each={uniqueEventTypes()}>
                {(type) => <option value={type}>{type}</option>}
              </For>
            </select>
          </div>

          {/* Results Count */}
          <div class="flex items-center">
            <div class="text-xs" style={{ "color": "var(--color-text-secondary)" }}>
              {filteredEvents().length}/{events().length} events
              <Show when={hasSelection() || isCut()}>
                <span class="ml-1 px-1 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded text-xs">
                  {hasSelection() ? 'Filtered' : 'Cut'}
                </span>
              </Show>
            </div>
          </div>
        </div>
      </div>

      {/* Row 2: Events Table - Scrollable */}
      <div class="flex-1 min-h-0 mb-2 events-table-scroll">
        <div class="h-full overflow-auto">
          <Show when={loading()} fallback={
            <table class="data-table compact w-full text-left text-sm">
              <thead>
                <tr>
                  <th class="w-4">Zoom</th>
                  <th class="w-32">Datetime</th>
                  <th class="w-20">Type</th>
                  <th>Note</th>
                  <th class="w-20">User</th>
                  <th class="w-4">Delete</th>
                </tr>
              </thead>
              <tbody>
                <For each={filteredEvents()}>
                  {(event) => (
                    <tr 
                      class={`cursor-pointer transition-colors ${
                        selectedComment()?.datetime === event.datetime && 
                        selectedComment()?.comment === event.comment && 
                        selectedComment()?.user_name === event.user_name
                          ? 'bg-blue-50 dark:bg-blue-900' 
                          : ''
                      }`}
                      onClick={() => {
                        setSelectedComment(event);
                        if (event.datetime) {
                          handleDateTimeClick(event.datetime);
                        }
                      }}
                    >
                      {/* Magnify Icon */}
                      <td class="text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleMagnifyClick(event.datetime, event.event_type);
                          }}
                          class="p-0 text-gray-400 dark:!text-white hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900 rounded transition-colors"
                          title="Set time and range from event"
                        >
                          <FiSearch size={10} />
                        </button>
                      </td>

                      {/* Datetime */}
                      <td class="text-xs" style={{ "color": "var(--color-text-primary)" }}>
                        {event.datetime ? formatDateTime(event.datetime, getCurrentDatasetTimezone()) || new Date(event.datetime).toLocaleString() : '-'}
                      </td>
                      
                      {/* Type */}
                      <td>
                        <span class="px-1 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded text-xs font-medium">
                          {event.event_type || '-'}
                        </span>
                      </td>
                      
                      {/* Note - with tooltip for long text */}
                      <td class="text-xs" style={{ "color": "var(--color-text-primary)" }}>
                        <div 
                          class="truncate cursor-help" 
                          title={removeQuotes(event.comment)}
                        >
                          {removeQuotes(event.comment)}
                        </div>
                      </td>
                      
                      {/* User */}
                      <td class="text-xs font-medium" style={{ "color": "var(--color-text-primary)" }}>
                        {event.user_name || '-'}
                      </td>

                      {/* Delete Button - only for comments and users with permission */}
                      <td class="text-center" onClick={(e) => e.stopPropagation()}>
                        <Show when={canDeleteComments() && event.event_type === 'NOTE'}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteComment(event);
                            }}
                            disabled={deletingComment()}
                            class="p-0 text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Delete comment"
                          >
                            <FiTrash2 size={10} />
                          </button>
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          }>
            <div class="flex justify-center items-center h-full">
              <div class="text-sm" style={{ "color": "var(--color-text-secondary)" }}>Loading events...</div>
            </div>
          </Show>
        </div>
      </div>

      {/* Row 3: Note Input Form - Fixed Height */}
      <div class="flex-shrink-0 p-2">
        <div class="flex items-center gap-2">
          <label class="text-sm font-medium whitespace-nowrap" style={{ "color": "var(--color-text-primary)" }}>Datetime:</label>
          <input
            type="text"
            placeholder="YYYY-MM-DD HH:MM:SS"
            class="flex-shrink-0"
            style={{ "width": "180px", "padding": "8px 12px", "border": "1px solid var(--color-border-primary)", "border-radius": "6px", "background": "var(--color-bg-input)", "color": "var(--color-text-primary)" }}
            value={commentDatetime()}
            onInput={(e) => setCommentDatetime(e.target.value)}
          />
          <label class="text-sm font-medium whitespace-nowrap" style={{ "color": "var(--color-text-primary)" }}>Add Note:</label>
          <div class="flex-1">
            <input
              type="text"
              placeholder="Enter your note here..."
              class="w-full"
              style={{ "padding": "8px 12px", "border": "1px solid var(--color-border-primary)", "border-radius": "6px", "background": "var(--color-bg-input)", "color": "var(--color-text-primary)" }}
              value={newNote()}
              onInput={(e) => setNewNote(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleSubmitNote();
                }
              }}
            />
          </div>
          <button
            onClick={handleSubmitNote}
            disabled={!newNote().trim() || !isValidDatetime(commentDatetime()) || submittingNote()}
            class="px-3 py-1 text-white text-sm rounded disabled:bg-gray-300 disabled:cursor-not-allowed border-0 outline-none flex-shrink-0"
            style={{ "background-color": "#10b981" }}
          >
            {submittingNote() ? '...' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}