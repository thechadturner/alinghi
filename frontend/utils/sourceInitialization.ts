import { sourcesStore } from '../store/sourcesStore';
import { persistentSettingsService } from '../services/persistentSettingsService';
import { persistantStore } from '../store/persistantStore';
import { user } from '../store/userStore';
import { debug } from './console';

/**
 * Initialize source selections from persistent settings or default to first 6 sources
 * ordered by source_id. Saves the default selection to API if no persisted selection exists.
 * 
 * @returns Array of source names (strings) to select
 */
export async function initializeSourceSelections(): Promise<string[]> {
  // Wait for sources to be ready
  let attempts = 0;
  while (!sourcesStore.isReady() && attempts < 10) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }
  
  if (!sourcesStore.isReady()) {
    debug('initializeSourceSelections: sourcesStore not ready');
    return [];
  }
  
  const sources = sourcesStore.sources();
  if (sources.length === 0) {
    debug('initializeSourceSelections: No sources available');
    return [];
  }
  
  // Try to load from persistent settings API
  const currentUser = user();
  if (currentUser?.user_id) {
    const { selectedClassName, selectedProjectId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    
    if (className && projectId) {
      try {
        const settings = await persistentSettingsService.loadSettings(
          currentUser.user_id,
          className,
          projectId
        );
        
        if (settings?.fleetPerformanceSources) {
          // Ensure it's an array
          let sources = settings.fleetPerformanceSources;
          if (typeof sources === 'string') {
            try {
              sources = JSON.parse(sources);
            } catch (parseError) {
              debug('initializeSourceSelections: Failed to parse fleetPerformanceSources as JSON:', parseError);
              sources = [];
            }
          }
          
          if (Array.isArray(sources) && sources.length > 0) {
            // Filter out any invalid values and ensure all are strings
            const validSources = sources
              .map(s => String(s).trim())
              .filter(s => s.length > 0);
            
            // Validate that the sources actually exist in the current sources list
            const availableSourceNames = sourcesStore.sources().map(s => s.source_name?.toLowerCase() || '');
            const validatedSources = validSources.filter(sourceName => {
              const normalized = sourceName.toLowerCase();
              return availableSourceNames.includes(normalized);
            });
            
            if (validatedSources.length > 0) {
              debug('initializeSourceSelections: Loaded from persistent settings API', {
                loaded: validSources,
                validated: validatedSources,
                available: sourcesStore.sources().map(s => s.source_name)
              });
              return validatedSources;
            } else {
              debug('initializeSourceSelections: Loaded sources from API but none match available sources', {
                loaded: validSources,
                available: sourcesStore.sources().map(s => s.source_name)
              });
            }
          }
        }
      } catch (error) {
        debug('initializeSourceSelections: Error loading from persistent settings API', error);
      }
    }
  }
  
  // Default to first 6 sources ordered by source_id (ascending)
  const sortedSources = [...sources].sort((a, b) => a.source_id - b.source_id);
  const firstSix = sortedSources.slice(0, 6).map(s => s.source_name).filter(Boolean);
  debug('initializeSourceSelections: Defaulting to first 6 sources (ordered by source_id)', firstSix);
  
  // Save the default selection to API for persistence
  if (currentUser?.user_id && firstSix.length > 0) {
    const { selectedClassName, selectedProjectId } = persistantStore;
    const className = selectedClassName();
    const projectId = selectedProjectId();
    
    if (className && projectId) {
      try {
        await persistentSettingsService.saveSettings(
          currentUser.user_id,
          className,
          projectId,
          { fleetPerformanceSources: firstSix }
        );
        debug('initializeSourceSelections: Saved default sources to API', firstSix);
      } catch (error) {
        debug('initializeSourceSelections: Error saving default sources to API', error);
      }
    }
  }
  
  return firstSix;
}

