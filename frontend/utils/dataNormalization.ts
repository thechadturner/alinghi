/**
 * Data Normalization Utility
 * 
 * Normalizes metadata fields (Grade, Race_number, State, etc.) to consistent
 * lowercase with underscores format for internal storage, while preserving
 * original channel names for user display.
 * 
 * Key Principle: Only metadata fields are normalized. Channel names (Tws_kts, 
 * Bsp_kts, Twa_deg, etc.) remain unchanged.
 */

/**
 * Known metadata field variations mapped to normalized names
 * Standard names: Grade, State, Race_number, Leg_number
 */
const METADATA_FIELD_MAPPINGS: Record<string, string> = {
  // Grade variations -> Grade
  'GRADE': 'Grade',
  'Grade': 'Grade',
  'grade': 'Grade',
  
  // Race number variations -> Race_number
  'RACE': 'Race_number',
  'Race_number': 'Race_number',
  'race_number': 'Race_number',
  'RACE_NUMBER': 'Race_number',
  'RaceNumber': 'Race_number',
  'raceNumber': 'Race_number',
  
  // Leg number variations -> Leg_number
  'LEG': 'Leg_number',
  'Leg_number': 'Leg_number',
  'leg_number': 'Leg_number',
  'LEG_NUMBER': 'Leg_number',
  'LegNumber': 'Leg_number',
  'legNumber': 'Leg_number',
  
  // State variations -> State (also handle Foiling_state)
  'STATE': 'State',
  'State': 'State',
  'state': 'State',
  'FOILING_STATE': 'State',
  'Foiling_state': 'State',
  'foiling_state': 'State',
  'FoilingState': 'State',
  'foilingState': 'State',
  
  // Config variations (keep as-is for now, not in standard list)
  'CONFIG': 'Config',
  'Config': 'Config',
  'config': 'Config',
  
  // Event variations (keep as-is for now, not in standard list)
  'EVENT': 'Event',
  'Event': 'Event',
  'event': 'Event',
  'event_name': 'Event',
  'Event_name': 'Event',
  'EVENT_NAME': 'Event',
  
  // Source name variations (keep as-is for now, not in standard list)
  'SOURCE_NAME': 'source_name',
  'Source_name': 'source_name',
  'source_name': 'source_name',
  'SOURCE': 'source_name',
  'Source': 'source_name',
  'source': 'source_name',
};

/**
 * Extract and normalize metadata fields from API response
 * Handles all known case variations and returns normalized metadata object
 */
export function extractAndNormalizeMetadata(item: any): {
  Grade?: number;
  Race_number?: number | string;
  Leg_number?: number;
  State?: string;
  Config?: string;
  Event?: string;
  source_name?: string;
  Datetime?: string;
  Year?: string;
  Tack?: string;
} {
  // Helper to find value from multiple possible field names
  const findValue = (...variations: string[]): any => {
    for (const variation of variations) {
      if (item[variation] !== undefined && item[variation] !== null && item[variation] !== 'NONE' && item[variation] !== '') {
        return item[variation];
      }
    }
    return undefined;
  };

  // Normalize race_number: keep as-is (backend stores -1 for training, frontend shows "TRAINING" in UI only)
  // 
  // RACE_NUMBER DUAL-ROLE ARCHITECTURE:
  // - Data layer (here): Always keep -1 (numeric) from backend
  // - UI layer: Show "TRAINING" (string) in filter dropdowns via formatRaceForDisplay()
  // - Filter layer: Translate 'TRAINING' → -1 in filterCore.ts createFilterConfig()
  // 
  // Design principle: "Whenever a user requests 'TRAINING' data, 
  // the internal code automatically uses -1 for Race_number."
  // 
  // See: frontend/utils/raceValueUtils.ts for centralized race value handling
  const normalizeRaceNumber = (value: any): number | string | undefined => {
    if (value === undefined || value === null) return undefined;
    // Keep -1 as-is; don't convert to 'TRAINING' string (that's only for UI display in filter options)
    return value;
  };

  return {
    Grade: findValue('Grade', 'GRADE', 'grade'),
    Race_number: normalizeRaceNumber(findValue('Race_number', 'RACE', 'race_number', 'RACE_NUMBER', 'RaceNumber', 'raceNumber')),
    Leg_number: findValue('Leg_number', 'LEG', 'leg_number', 'LEG_NUMBER', 'LegNumber', 'legNumber'),
    State: findValue('State', 'STATE', 'state', 'FOILING_STATE', 'Foiling_state', 'foiling_state', 'FoilingState', 'foilingState'),
    Config: findValue('Config', 'CONFIG', 'config'),
    Event: findValue('Event', 'EVENT', 'event', 'event_name', 'Event_name', 'EVENT_NAME'),
    source_name: findValue('Source_name', 'SOURCE_NAME', 'source_name', 'Source', 'SOURCE', 'source'),
    Datetime: findValue('Datetime', 'datetime'),
    Year: findValue('Year', 'year', 'YEAR'),
    Tack: findValue('Tack', 'TACK', 'tack'),
  };
}

/**
 * Normalize metadata fields in a data point
 * Returns both normalized and original data for reference
 * 
 * Note: This preserves channel names (Tws_kts, Bsp_kts, etc.) as-is
 */
export function normalizeMetadataFields(dataPoint: any): { normalized: any; original: any } {
  const original = { ...dataPoint };
  const normalized = { ...dataPoint };
  
  // Extract and normalize metadata
  const normalizedMetadata = extractAndNormalizeMetadata(dataPoint);
  
  // Replace metadata fields with normalized versions
  // Remove all case variations first (but keep standard names if they exist)
  const fieldsToRemove = [
    'GRADE', 'grade',  // Keep 'Grade'
    'RACE', 'race_number', 'RACE_NUMBER', 'RaceNumber', 'raceNumber',  // Keep 'Race_number'
    'LEG', 'leg_number', 'LEG_NUMBER', 'LegNumber', 'legNumber',  // Keep 'Leg_number'
    'STATE', 'state', 'FOILING_STATE', 'Foiling_state', 'foiling_state', 'FoilingState', 'foilingState',  // Keep 'State'
    'CONFIG', 'config',  // Keep 'Config'
    'EVENT', 'event', 'event_name', 'Event_name', 'EVENT_NAME',  // Keep 'Event'
    'SOURCE_NAME', 'Source_name', 'Source', 'SOURCE', 'source',  // Keep 'source_name'
  ];
  
  fieldsToRemove.forEach(field => {
    if (field in normalized) {
      delete normalized[field];
    }
  });
  
  // Add normalized metadata fields (using standard names)
  Object.assign(normalized, normalizedMetadata);
  
  return { normalized, original };
}

/**
 * Check if a field name is a metadata field (should be normalized)
 */
export function isMetadataField(fieldName: string): boolean {
  const normalized = METADATA_FIELD_MAPPINGS[fieldName] || fieldName.toLowerCase();
  return normalized in METADATA_FIELD_MAPPINGS || 
         Object.values(METADATA_FIELD_MAPPINGS).includes(normalized);
}

/**
 * Get normalized field name for a metadata field
 * Returns the field name as-is if it's not a metadata field
 */
export function getNormalizedFieldName(fieldName: string): string {
  return METADATA_FIELD_MAPPINGS[fieldName] || fieldName;
}

