import { onMount, createEffect, createSignal, For, Show, createMemo } from "solid-js";

import PolarPlot from "../../../components/charts/PolarPlot";
import Loading from "../../../components/utilities/Loading";
import DropDownButton from "../../../components/buttons/DropDownButton";

import { getData, getCookie, round } from "../../../utils/global";
import { tooltip } from "../../../store/globalStore";
import { warn, error as logError, debug } from "../../../utils/console";
import { persistantStore } from "../../../store/persistantStore";
import { themeStore } from "../../../store/themeStore";
import { apiEndpoints } from "@config/env";
import { huniDBStore } from "../../../store/huniDBStore";
import { logPageLoad } from "../../../utils/logging";
import { user } from "../../../store/userStore";

const { selectedClassName, selectedProjectId } = persistantStore;

function isAdminOrPublisher(): boolean {
  const currentUser = user();
  if (!currentUser) return false;
  if (currentUser.is_super_user === true) return true;
  const userPermissions = currentUser.permissions;
  if (typeof userPermissions === "string") {
    return userPermissions === "administrator" || userPermissions === "publisher";
  }
  if (Array.isArray(userPermissions)) {
    return userPermissions.includes("administrator") || userPermissions.includes("publisher");
  }
  if (typeof userPermissions === "object" && userPermissions !== null) {
    const permissionValues = Object.values(userPermissions);
    return permissionValues.includes("administrator") || permissionValues.includes("publisher");
  }
  return false;
}

export default function Polars() {
  const [loading, setLoading] = createSignal(true);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showModal, setShowModal] = createSignal(false);
  const [showSaveAs, setShowSaveAs] = createSignal(false);
  const [saveAsName, setSaveAsName] = createSignal('');
  const [updateCharts, setUpdateCharts] = createSignal(false);
  
  // Guard to prevent createEffect from running during initialization
  let isInitializing = false;

  // Display mode controls
  const [displayMode, setDisplayMode] = createSignal(0); // 0 = BSP, 1 = VMG
  const [selectedTWS, setSelectedTWS] = createSignal(12);
  const [selectedPolar, setSelectedPolar] = createSignal(0); // 0 = red, 1 = green, 2 = blue
  const [editMode, setEditMode] = createSignal(false);

  // Data state
  const [scatterData, setScatterData] = createSignal<any[]>([]);
  const [polarData, setPolarData] = createSignal<{
    red: any[];
    green: any[];
    blue: any[];
  }>({
    red: [],
    green: [],
    blue: []
  });
  const [polarNames, setPolarNames] = createSignal({
    red: 'NONE',
    green: 'NONE', 
    blue: 'NONE'
  });

  // Draft state for edit mode: new-format array for selected color; null when not editing. Not applied to polarData until Save.
  const [polarDraft, setPolarDraft] = createSignal<any[] | null>(null);

  // Available options
  const [availableTargets, setAvailableTargets] = createSignal<string[]>([]);
  const [displayModes] = createSignal(["BSP", "VMG"]);
  
  // Extract unique TWS values from polar data (binned)
  const twss = createMemo(() => {
    const data = polarData();
    const twsSet = new Set<number>();
    
    // Helper to bin TWS values with interval of 4
    const binTWS = (tws: number): number => {
      if (tws <= 0) return 4;
      return Math.ceil(tws / 4) * 4;
    };
    
    // Get TWS values from all polar data (red, green, blue) and bin them
    Object.values(data).forEach((arr: any[]) => {
      if (Array.isArray(arr) && arr.length > 0) {
        arr.forEach((d: any) => {
          const tws = d.Tws ?? d.tws ?? d.TWS;
          if (tws != null && !isNaN(Number(tws))) {
            const binnedTWS = binTWS(Number(tws));
            twsSet.add(binnedTWS);
          }
        });
      }
    });
    
    // Convert to sorted array
    const twsList = Array.from(twsSet).sort((a, b) => a - b);
    
    debug('Polars: Extracted TWS values from polar data (binned)', {
      twsList,
      dataLengths: {
        red: data.red?.length || 0,
        green: data.green?.length || 0,
        blue: data.blue?.length || 0
      }
    });
    
    return twsList.length > 0 ? twsList : [4, 8, 12, 16, 20, 24, 28, 32, 36]; // Fallback to default binned values
  });

  // Fetch available polar targets
  const fetchPolarTargets = async () => {
    const controller = new AbortController();
    
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId) {
        warn('Polars: Missing className or projectId, cannot fetch targets');
        return [];
      }
      
      const projectIdStr = projectId.toString();
      
      // Check HuniDB first
      debug('Polars: Checking HuniDB for polar targets');
      try {
        const cachedTargets = await huniDBStore.queryTargets(className, projectIdStr);
        const polarTargets = cachedTargets.filter(t => t.isPolar === 1);
        
        if (polarTargets.length > 0) {
          debug(`Polars: Found ${polarTargets.length} cached polar targets in HuniDB`);
          // Convert TargetEntry format back to API format (array of objects with name)
          return polarTargets.map(t => ({ name: t.name }));
        }
      } catch (huniError) {
        debug('Polars: Error querying HuniDB, will fetch from API:', huniError);
      }
      
      // Not in HuniDB, fetch from API
      debug('Polars: Fetching targets from API');
      const response = await getData(`${apiEndpoints.app.targets}?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&isPolar=1`, controller.signal);
      if (!response.success) throw new Error("Failed to fetch polar targets.");

      const targets = response.data || [];
      
      // Store each target in HuniDB
      if (targets.length > 0) {
        debug(`Polars: Storing ${targets.length} polar targets in HuniDB`);
        try {
          for (const target of targets) {
            await huniDBStore.storeTarget(className, {
              id: `target-${projectIdStr}-${target.name}`,
              projectId: projectIdStr,
              name: target.name,
              isPolar: 1,
              data: {}, // Target list doesn't have data, just names
              dateModified: Date.now(),
            });
          }
          debug('Polars: Successfully stored polar targets in HuniDB');
        } catch (storeError) {
          logError('Polars: Error storing targets in HuniDB:', storeError);
        }
      }

      return targets;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return [];
      }
      logError("Error fetching polar targets:", error);
      return [];
    }
  };

  // Fetch polar data for a specific target
  const fetchPolarData = async (targetName: string) => {
    if (!targetName || targetName === 'NONE') {
      return [];
    }
    
    const controller = new AbortController();
    
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      
      if (!className || !projectId) {
        warn('Polars: Missing className or projectId, cannot fetch polar data');
        return [];
      }
      
      const projectIdStr = projectId.toString();
      
      // Check HuniDB first
      debug(`Polars: Checking HuniDB for polar data: ${targetName}`);
      try {
        const cachedTargets = await huniDBStore.queryTargets(className, projectIdStr, targetName);
        const polarTarget = cachedTargets.find(t => t.isPolar === 1 && t.name === targetName);
        
        if (polarTarget && polarTarget.data && Array.isArray(polarTarget.data) && polarTarget.data.length > 0) {
          debug(`Polars: Found cached polar data in HuniDB for ${targetName}`);
          return polarTarget.data;
        }
      } catch (huniError) {
        debug('Polars: Error querying HuniDB, will fetch from API:', huniError);
      }
      
      // Not in HuniDB, fetch from API
      debug(`Polars: Fetching polar data from API for ${targetName}`);
      const response = await getData(`${apiEndpoints.app.targets}/data?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&name=${encodeURIComponent(targetName)}&isPolar=1`, controller.signal);
      if (!response.success) throw new Error("Failed to fetch polar data.");

      const polarData = response.data || [];
      
      // Store in HuniDB
      if (polarData.length > 0) {
        debug(`Polars: Storing polar data in HuniDB for ${targetName}`);
        try {
          await huniDBStore.storeTarget(className, {
            id: `target-${projectIdStr}-${targetName}`,
            projectId: projectIdStr,
            name: targetName,
            isPolar: 1,
            data: polarData, // Store the actual polar data array
            dateModified: Date.now(),
          });
          debug(`Polars: Successfully stored polar data in HuniDB for ${targetName}`);
        } catch (storeError) {
          logError(`Polars: Error storing polar data in HuniDB for ${targetName}:`, storeError);
        }
      }

      return polarData;
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return [];
      }
      logError("Error fetching polar data:", error);
      return [];
    }
  };

  // Fetch scatter data (this would be replaced with actual sailing data)
  const fetchScatterData = async (): Promise<any[]> => {
    try {
      // This would be replaced with actual API call to get sailing data
      // For now, return empty array
      return [];
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        return [];
      }
      logError("Error fetching scatter data:", error);
      return [];
    }
  };

  // Initialize polar data
  const initializePolars = async () => {
    // Prevent concurrent initializations
    if (isInitializing) {
      return;
    }
    
    isInitializing = true;
    setLoading(true);
    setIsLoading(true);
    setError(null);
    
    try {
      setUpdateCharts(false);

      // Fetch available polar targets
      const targets = await fetchPolarTargets();
      const targetNames = targets.map((obj: any) => obj.name);
      setAvailableTargets(targetNames);

      // Handle case where no polars are available
      if (targetNames.length === 0) {
        setPolarNames({ red: 'NONE', green: 'NONE', blue: 'NONE' });
        setPolarData({ red: [], green: [], blue: [] });
        setUpdateCharts(true);
        setLoading(false);
        setIsLoading(false);
        return;
      }

      // Load saved polar names from localStorage, or set defaults
      const savedRed = localStorage.getItem('red_polar_name');
      const savedGreen = localStorage.getItem('green_polar_name');
      const savedBlue = localStorage.getItem('blue_polar_name');
      
      // Validate saved names exist in available targets, otherwise use default
      const validRed = savedRed && targetNames.includes(savedRed) ? savedRed : null;
      const validGreen = savedGreen && targetNames.includes(savedGreen) ? savedGreen : null;
      const validBlue = savedBlue && targetNames.includes(savedBlue) ? savedBlue : null;
      
      // Update polar names: use saved if valid, otherwise use current if not 'NONE', otherwise default
      // Special handling: if only one polar available, assign it to red only
      const isSinglePolar = targetNames.length === 1;
      
      if (polarNames().red === 'NONE') {
        // For single polar, always assign to red; otherwise use saved or first available
        const newRed = validRed || (targetNames.length > 0 ? targetNames[0] : 'NONE');
        setPolarNames(prev => ({ ...prev, red: newRed }));
      } else if (validRed && polarNames().red !== validRed) {
        setPolarNames(prev => ({ ...prev, red: validRed }));
      }
      
      if (polarNames().green === 'NONE') {
        // For single polar, leave as NONE; for multiple, use saved or second/first
        const newGreen = isSinglePolar ? 'NONE' : (validGreen || (targetNames.length > 1 ? targetNames[1] : (targetNames.length > 0 ? targetNames[0] : 'NONE')));
        setPolarNames(prev => ({ ...prev, green: newGreen }));
      } else if (validGreen && polarNames().green !== validGreen) {
        setPolarNames(prev => ({ ...prev, green: validGreen }));
      } else if (isSinglePolar && polarNames().green !== 'NONE') {
        // If we only have one polar, clear green/blue if they were set
        setPolarNames(prev => ({ ...prev, green: 'NONE' }));
      }
      
      if (polarNames().blue === 'NONE') {
        // For single polar, leave as NONE; for multiple, use saved or third/second/first
        const newBlue = isSinglePolar ? 'NONE' : (validBlue || (targetNames.length > 2 ? targetNames[2] : (targetNames.length > 1 ? targetNames[1] : (targetNames.length > 0 ? targetNames[0] : 'NONE'))));
        setPolarNames(prev => ({ ...prev, blue: newBlue }));
      } else if (validBlue && polarNames().blue !== validBlue) {
        setPolarNames(prev => ({ ...prev, blue: validBlue }));
      } else if (isSinglePolar && polarNames().blue !== 'NONE') {
        // If we only have one polar, clear blue if it was set
        setPolarNames(prev => ({ ...prev, blue: 'NONE' }));
      }

      // Fetch polar data for each color
      const redData = await fetchPolarData(polarNames().red);
      const greenData = await fetchPolarData(polarNames().green);
      const blueData = await fetchPolarData(polarNames().blue);

      setPolarData({
        red: redData,
        green: greenData,
        blue: blueData
      });

      // Update selected TWS to first available value if current selection doesn't exist
      // Bin TWS values with interval of 4
      const binTWS = (tws: number): number => {
        if (tws <= 0) return 4;
        return Math.ceil(tws / 4) * 4;
      };
      
      const allTws = new Set<number>();
      [redData, greenData, blueData].forEach(arr => {
        if (Array.isArray(arr)) {
          arr.forEach((d: any) => {
            const tws = d.Tws ?? d.tws ?? d.TWS;
            if (tws != null && !isNaN(Number(tws))) {
              const binnedTWS = binTWS(Number(tws));
              allTws.add(binnedTWS);
            }
          });
        }
      });
      
      const availableTws = Array.from(allTws).sort((a, b) => a - b);
      if (availableTws.length > 0) {
        // Bin the current selected TWS and check if it exists
        const currentTws = selectedTWS();
        const binnedCurrentTws = binTWS(currentTws);
        if (!availableTws.includes(binnedCurrentTws)) {
          debug(`Polars: Current TWS ${currentTws} (binned to ${binnedCurrentTws}) not in data, switching to ${availableTws[0]}`);
          setSelectedTWS(availableTws[0]);
        } else {
          // Update to binned value if different
          if (binnedCurrentTws !== currentTws) {
            debug(`Polars: Binning TWS ${currentTws} to ${binnedCurrentTws}`);
            setSelectedTWS(binnedCurrentTws);
          }
        }
      }

      // Fetch scatter data
      const scatter = await fetchScatterData();
      setScatterData(scatter);

      setUpdateCharts(true);
    } catch (error: unknown) {
      logError('Error initializing polars:', error);
      const errorMsg = error instanceof Error 
        ? error.message 
        : (typeof error === 'string' 
          ? error 
          : 'Failed to initialize polars');
      setError(errorMsg);
    } finally {
      setLoading(false);
      setIsLoading(false);
      isInitializing = false;
    }
  };

  // Handle polar selection change
  const handlePolarChange = async (color: string, targetName: string) => {
    try {
      const data = await fetchPolarData(targetName);
      
      setPolarNames(prev => ({ ...prev, [color.toLowerCase()]: targetName }));
      setPolarData(prev => ({ ...prev, [color.toLowerCase()]: data }));
      
      // Save to localStorage
      localStorage.setItem(`${color.toLowerCase()}_polar_name`, targetName);
    } catch (error: unknown) {
      logError(`Error updating ${color} polar:`, error);
    }
  };

  // Handle display mode change
  const handleDisplayModeChange = (mode: number) => {
    setDisplayMode(mode);
  };

  // Handle TWS change (bin the value)
  const handleTWSChange = (tws: number) => {
    const binnedTWS = binTWS(tws);
    setSelectedTWS(binnedTWS);
  };

  // Handle polar color selection
  const handlePolarColorChange = (color: number) => {
    setSelectedPolar(color);
  };

  // Toggle edit mode
  const toggleEditMode = () => {
    setEditMode(!editMode());
  };

  // Keep draft in sync: when entering edit mode or switching polar color, init draft from polarData; when leaving edit mode, clear draft
  createEffect(() => {
    if (!editMode()) {
      setPolarDraft(null);
      return;
    }
    const key = selectedColorKey();
    setPolarDraft(convertToNewFormat(polarData()[key] || []));
  });

  // Helpers for edit panel
  const selectedColorKey = () => (selectedPolar() === 0 ? 'red' : selectedPolar() === 1 ? 'green' : 'blue');
  
  // Bin TWS values with interval of 4
  // e.g., 0-4 → 4, 4-8 → 8, 8-12 → 12, 12-16 → 16, etc.
  const binTWS = (tws: number): number => {
    if (tws <= 0) return 4;
    return Math.ceil(tws / 4) * 4;
  };
  
  // Convert old format (Row-based) to new format (column-based) with TWS binning
  // Old: Array of {Tws, Row, Cwa, Bsp, Vmg}
  // New: Array of {Tws, twaUp, bspUp, twa1, bsp1, twa2, bsp2, twa3, bsp3, twa4, bsp4, twaDn, bspDn, twa180, bsp180}
  const convertToNewFormat = (oldData: any[]): any[] => {
    const twsMap = new Map<number, any>();
    
    oldData.forEach((d: any) => {
      const tws = d.Tws ?? d.tws ?? d.TWS;
      if (tws == null) return;
      
      const twsNum = Number(tws);
      if (isNaN(twsNum)) return;
      
      // Bin the TWS value
      const binnedTWS = binTWS(twsNum);
      
      const row = d.Row ?? d.row ?? d.index ?? null;
      if (row == null) return;
      
      const rowNum = Number(row);
      if (isNaN(rowNum)) return;
      
      const cwa = d.Cwa ?? d.cwa ?? d.twa ?? d.Twa ?? d.TWA ?? 0;
      const bsp = d.Bsp ?? d.bsp ?? d.BSP ?? 0;
      
      if (!twsMap.has(binnedTWS)) {
        twsMap.set(binnedTWS, { Tws: binnedTWS });
      }
      
      const rowData = twsMap.get(binnedTWS)!;
      
      // Map Row numbers to new format columns
      // Row 0 = upwind, Row 1-4 = twa1-4, Row 5 = downwind, Row 6 = 180
      // If multiple values exist for the same bin and row, use the latest one (or average if needed)
      if (rowNum === 0) {
        rowData.twaUp = cwa;
        rowData.bspUp = bsp;
      } else if (rowNum === 1) {
        rowData.twa1 = cwa;
        rowData.bsp1 = bsp;
      } else if (rowNum === 2) {
        rowData.twa2 = cwa;
        rowData.bsp2 = bsp;
      } else if (rowNum === 3) {
        rowData.twa3 = cwa;
        rowData.bsp3 = bsp;
      } else if (rowNum === 4) {
        rowData.twa4 = cwa;
        rowData.bsp4 = bsp;
      } else if (rowNum === 5) {
        rowData.twaDn = cwa;
        rowData.bspDn = bsp;
      } else if (rowNum === 6) {
        rowData.twa180 = cwa;
        rowData.bsp180 = bsp;
      }
    });
    
    return Array.from(twsMap.values()).sort((a, b) => a.Tws - b.Tws);
  };
  
  // Convert new format (column-based) back to old format (Row-based)
  const convertToOldFormat = (newData: any[]): any[] => {
    const result: any[] = [];
    
    newData.forEach((row: any) => {
      const tws = row.Tws ?? row.tws ?? row.TWS;
      if (tws == null) return;
      
      // Map each column to a Row
      const mappings = [
        { row: 0, twa: 'twaUp', bsp: 'bspUp' },
        { row: 1, twa: 'twa1', bsp: 'bsp1' },
        { row: 2, twa: 'twa2', bsp: 'bsp2' },
        { row: 3, twa: 'twa3', bsp: 'bsp3' },
        { row: 4, twa: 'twa4', bsp: 'bsp4' },
        { row: 5, twa: 'twaDn', bsp: 'bspDn' },
        { row: 6, twa: 'twa180', bsp: 'bsp180' },
      ];
      
      mappings.forEach(({ row: rowNum, twa, bsp }) => {
        const twaVal = row[twa];
        const bspVal = row[bsp];
        const cwaNum = twaVal != null && !isNaN(Number(twaVal)) ? Number(twaVal) : null;
        const bspNum = bspVal != null && !isNaN(Number(bspVal)) ? Number(bspVal) : null;
        // Keep row if at least one value is set (use 0 for missing so partial edits persist)
        if (cwaNum != null || bspNum != null) {
          const cwa = cwaNum ?? 0;
          const bsp = bspNum ?? 0;
          const vmg = Math.abs(Math.cos(cwa * Math.PI / 180) * bsp);
          result.push({
            Tws: tws,
            Row: rowNum,
            Cwa: cwa,
            Bsp: bsp,
            Vmg: vmg,
            tws: tws,
            row: rowNum,
            cwa: cwa,
            bsp: bsp,
            vmg: vmg,
          });
        }
      });
    });
    
    return result;
  };
  
  // Column definitions for BSP/TWA variations (used for edit table columns)
  const twaBspColumns = () => [
    { twa: 'twaUp', bsp: 'bspUp' },
    { twa: 'twa1', bsp: 'bsp1' },
    { twa: 'twa2', bsp: 'bsp2' },
    { twa: 'twa3', bsp: 'bsp3' },
    { twa: 'twa4', bsp: 'bsp4' },
    { twa: 'twaDn', bsp: 'bspDn' },
    { twa: 'twa180', bsp: 'bsp180' },
  ];

  // Get data in new format for the selected TWS. In edit mode uses draft when set; otherwise polarData.
  const twsFilteredPolar = () => {
    const key = selectedColorKey();
    const draft = polarDraft();
    const newFormat = draft != null ? draft : convertToNewFormat(polarData()[key] || []);
    const binnedSelectedTWS = binTWS(Number(selectedTWS()));
    return newFormat.filter((d: any) => {
      const tws = d.Tws ?? d.tws ?? d.TWS;
      if (tws == null) return false;
      const a = Number(tws);
      return !Number.isNaN(a) && a === binnedSelectedTWS;
    });
  };

  // Edit table: two columns (TWA, BSP), one row per TWA variation for the selected TWS (reads from draft when editing)
  const editTableRows = (): { label: string; twaKey: string; bspKey: string; twaValue: number | string; bspValue: number | string }[] => {
    const cols = twaBspColumns();
    const filtered = twsFilteredPolar();
    const binnedTWS = binTWS(Number(selectedTWS()));
    const row: any = filtered.length > 0 ? filtered[0] : { Tws: binnedTWS };
    const labels = ['Up', '1', '2', '3', '4', 'Dn', '180'];
    return cols.map(({ twa, bsp }, i) => {
      const rawBsp = row[bsp];
      const bspValue =
        rawBsp != null && !isNaN(Number(rawBsp)) ? round(Number(rawBsp), 1) : (rawBsp ?? '');
      return {
        label: labels[i] ?? twa,
        twaKey: twa,
        bspKey: bsp,
        twaValue: row[twa] ?? '',
        bspValue,
      };
    });
  };

  // Get all data in new format (for export etc.)
  const allPolarData = () => {
    const key = selectedColorKey();
    const data = polarData()[key] || [];
    return convertToNewFormat(data);
  };
  
  // Update a value in the draft only (not applied to polarData until Save)
  const updatePolarValue = (twsValue: number, field: string, value: string) => {
    const draft = polarDraft();
    if (draft == null) return;

    const binnedTWS = binTWS(Number(twsValue));
    const existingIndex = draft.findIndex((d: any) => {
      const tws = d.Tws ?? d.tws ?? d.TWS;
      if (tws == null) return false;
      const a = Number(tws);
      return !Number.isNaN(a) && a === binnedTWS;
    });

    const numValue = value.trim() === '' ? undefined : parseFloat(value);
    const isClear = value.trim() === '' || (numValue !== undefined && isNaN(numValue));

    let newFormat: any[];
    if (existingIndex >= 0) {
      newFormat = draft.map((d: any, i: number) => {
        if (i !== existingIndex) return d;
        const tws = d.Tws ?? d.tws ?? d.TWS;
        if (tws == null) return d;
        const a = Number(tws);
        if (Number.isNaN(a) || a !== binnedTWS) return d;
        const updatedRow = { ...d };
        updatedRow[field] = isClear ? undefined : numValue;
        return updatedRow;
      });
    } else {
      const newRow: any = { Tws: binnedTWS };
      twaBspColumns().forEach(({ twa, bsp }) => {
        newRow[twa] = undefined;
        newRow[bsp] = undefined;
      });
      newRow[field] = isClear ? undefined : numValue;
      newFormat = [...draft, newRow].sort((a, b) => (a.Tws ?? 0) - (b.Tws ?? 0));
    }

    setPolarDraft(newFormat);
  };

  const exportSelection = () => {
    // Export in new format: TWS, twaUp, bspUp, twa1, bsp1, ... When in edit mode, export draft so table and file match.
    const key = selectedColorKey();
    const draft = polarDraft();
    const newFormat = draft != null ? draft : convertToNewFormat(polarData()[key] || []);
    
    // Build header
    const header = 'TWS\ttwaUp\tbspUp\ttwa1\tbsp1\ttwa2\tbsp2\ttwa3\tbsp3\ttwa4\tbsp4\ttwaDn\tbspDn\ttwa180\tbsp180';
    
    // Build rows
    const lines = [header];
    newFormat.forEach((row: any) => {
      const tws = row.Tws ?? row.tws ?? row.TWS ?? '';
      const values = [
        tws,
        row.twaUp ?? '',
        row.bspUp ?? '',
        row.twa1 ?? '',
        row.bsp1 ?? '',
        row.twa2 ?? '',
        row.bsp2 ?? '',
        row.twa3 ?? '',
        row.bsp3 ?? '',
        row.twa4 ?? '',
        row.bsp4 ?? '',
        row.twaDn ?? '',
        row.bspDn ?? '',
        row.twa180 ?? '',
        row.bsp180 ?? '',
      ];
      lines.push(values.join('\t'));
    });

    const content = lines.join('\n');
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    const a = document.createElement('a');
    a.download = `Polar_Selection_${key.toUpperCase()}_${dateStr}.txt`;
    a.href = 'data:text/txt;charset=utf-8,' + '\uFEFF' + encodeURIComponent(content);
    a.click();
  };

  const saveChanges = () => {
    const draft = polarDraft();
    if (draft != null) {
      const key = selectedColorKey();
      setPolarData(prev => ({ ...prev, [key]: convertToOldFormat(draft) }));
    }
    setEditMode(false);
  };

  const doUpload = (finalName: string) => {
    try {
      const key = selectedColorKey();
      const nameBase = `${polarNames()[key] || key}`.toUpperCase();
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, '0');
      const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
      const name = finalName && finalName.trim().length > 0 ? finalName.trim() : `${nameBase}_${dateStr}`;

      // Get data: use draft when in edit mode so upload matches table; otherwise use polarData
      const draft = polarDraft();
      const oldFormat = draft != null ? convertToOldFormat(draft) : convertToOldFormat(convertToNewFormat(polarData()[key] || []));
      
      // Create payload in old format (Row-based) for API compatibility
      const payload = oldFormat.map((r: any) => {
        return {
          Tws: r.Tws ?? r.tws ?? r.TWS ?? 0,
          Row: r.Row ?? r.row ?? r.index ?? 0,
          Cwa: r.Cwa ?? r.cwa ?? r.twa ?? r.Twa ?? r.TWA ?? 0,
          Bsp: r.Bsp ?? r.bsp ?? r.BSP ?? 0,
          Vmg: r.Vmg ?? r.vmg ?? r.VMG ?? Math.abs(Math.cos(((r.Cwa ?? r.cwa ?? r.twa ?? r.Twa ?? r.TWA ?? 0) * Math.PI) / 180) * (r.Bsp ?? r.bsp ?? r.BSP ?? 0)),
        };
      });

      const body = {
        class_name: selectedClassName(),
        project_id: selectedProjectId(),
        name,
        json: JSON.stringify(payload),
        isPolar: 1,
      };

      fetch(apiEndpoints.admin.targets, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCookie('csrf_token') || ''
        },
        credentials: 'include',
        body: JSON.stringify(body),
      }).then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || 'Upload failed');
        }
        setShowSaveAs(false);
        setEditMode(false);
        // Refresh data after upload
        initializePolars();
      }).catch((e) => {
        warn(e.message || 'Upload error');
      });
    } catch (e) {
      warn('Upload error');
    }
  };

  const uploadSelection = () => {
    // Open Save As modal with default name
    const key = selectedColorKey();
    const base = `${polarNames()[key] || key}`.toUpperCase();
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
    setSaveAsName(`${base}_${dateStr}`);
    setShowSaveAs(true);
  };

  onMount(async () => {
    await logPageLoad('Polars.tsx', 'Polars Analysis Report');
    initializePolars();
  });

  createEffect(() => {
    if (polarNames().red && polarNames().green && polarNames().blue) {
      initializePolars();
    }
  });

    return (
    <Show when={!loading() && !isLoading()} fallback={<Loading />}>
      <Show when={error()}>
        <div class="flex flex-col items-center justify-center h-screen min-h-[500px] text-center p-8">
          <div class="mb-6">
            <div class="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg class="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"></path>
              </svg>
            </div>
            <h3 class="text-xl font-semibold text-red-700 mb-2">Error Loading Polars Data</h3>
            <p class="text-red-600 mb-6">{error()}</p>
            <button
              onClick={() => initializePolars()}
              class="inline-flex items-center px-6 py-3 bg-red-600 text-white font-semibold rounded-md hover:bg-red-700 transition-colors duration-200"
            >
              <svg class="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
              </svg>
              Retry
            </button>
          </div>
        </div>
      </Show>
      
      <Show when={showModal()}>
        <div class={`modal ${themeStore.isDark() ? 'dark' : 'light'}`}>
          <div class="modal-dialog">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">Polar Selection</h5>
                <button type="button" class="close" onclick={() => setShowModal(false)}>
                  <span aria-hidden="true">&times;</span>
                </button>
              </div>
              <div class="modal-body centered">
                <div class="flex items-center space-x-4">
                  <div class="w-1/6 text-center">
                    <p class="text-red-500 font-bold">Red</p>
                  </div>
                  <div class="w-5/6 text-center">
                    <select
                      id="red_polars"
                      class="text-red-500"
                      onChange={(e) => handlePolarChange('red', e.target.value)}
                    >
                      <For each={availableTargets()}>
                        {(name) => (
                          <option value={name} selected={polarNames().red === name}>
                            {name}
                          </option>
                        )}
                      </For>
                    </select>
                  </div>
                </div>
                <div class="flex items-center space-x-4 mt-2">
                  <div class="w-1/6 text-center">
                    <p class="text-green-500 font-bold">Green</p>
                  </div>
                  <div class="w-5/6 text-center">
                    <select
                      id="green_polars"
                      class="text-green-500"
                      onChange={(e) => handlePolarChange('green', e.target.value)}
                    >
                      <For each={availableTargets()}>
                        {(name) => (
                          <option value={name} selected={polarNames().green === name}>
                            {name}
                          </option>
                        )}
                      </For>
                    </select>
                  </div>
                </div>
                <div class="flex items-center space-x-4 mt-2">
                  <div class="w-1/6 text-center">
                    <p class="text-blue-500 font-bold">Blue</p>
                  </div>
                  <div class="w-5/6 text-center">
                    <select
                      id="blue_polars"
                      class="text-blue-500"
                      onChange={(e) => handlePolarChange('blue', e.target.value)}
                    >
                      <For each={availableTargets()}>
                        {(name) => (
                          <option value={name} selected={polarNames().blue === name}>
                            {name}
                          </option>
                        )}
                      </For>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={showSaveAs()}>
        <div class={`modal ${themeStore.isDark() ? 'dark' : 'light'}`}>
          <div class="modal-dialog">
            <div class="modal-content">
              <div class="modal-header">
                <h1 class="modal-title">SAVE AS</h1>
                <button type="button" class="close" onclick={() => setShowSaveAs(false)}>
                  <span aria-hidden="true">&times;</span>
                </button>
              </div>
              <div class="modal-body">
                <div class="flex items-center gap-3">
                  <label class="form-label">NAME:</label>
                  <input class="form-input" type="text" value={saveAsName()} onInput={(e) => setSaveAsName(e.currentTarget.value)} />
                  <button type="button" class="polar-plot-button active" onClick={() => doUpload(saveAsName())}>UPLOAD</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={updateCharts() && !error()}>
        <div class="flex flex-col h-screen w-full">
          {/* Controls Header */}
          <div class="flex w-full mb-4 pt-2">
            <div class="w-1/6 flex gap-x-2 items-center pl-2">
              <DropDownButton
                options={displayModes()}
                defaultText={displayModes()[displayMode()]}
                handleSelection={(mode) => handleDisplayModeChange(displayModes().indexOf(mode))}
                smallLabel="Display Mode"
                size="auto"
              />
              <DropDownButton
                options={twss().map(t => t.toString())}
                defaultText={selectedTWS().toString()}
                handleSelection={(tws) => handleTWSChange(parseFloat(tws))}
                smallLabel="TWS"
                size="auto"
              />
              <Show when={isAdminOrPublisher()}>
                <button
                  class={`polar-plot-button ${editMode() ? 'active' : ''}`}
                  title="Toggle edit mode"
                  onClick={toggleEditMode}
                  style={{ height: '52px', 'line-height': '1', display: 'inline-flex', 'align-items': 'center', 'padding-left': '12px', 'padding-right': '12px' }}
                >
                  {editMode() ? 'Editing' : 'Edit'}
                </button>
              </Show>
            </div>
            <div class="w-5/6">
              <div class="polar-plot-legend pt-5">
                <div class="polar-plot-legend-item" onClick={() => setShowModal(true)}>
                  <div class="polar-plot-legend-line bg-red-500"></div>
                  <span>{polarNames().red}</span>
                </div>
                <div class="polar-plot-legend-item" onClick={() => setShowModal(true)}>
                  <div class="polar-plot-legend-line bg-green-500"></div>
                  <span>{polarNames().green}</span>
                </div>
                <div class="polar-plot-legend-item" onClick={() => setShowModal(true)}>
                  <div class="polar-plot-legend-line bg-blue-500"></div>
                  <span>{polarNames().blue}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Chart + Edit Panel: 50/50 split when editing, polar full-width centered when not */}
          <div class="flex-1 overflow-y-auto polar-chart-edit-area" style="min-height: 0;">
            <div class={editMode() ? 'polar-split-layout' : 'polar-full-layout'}>
              <div class={editMode() ? 'polar-left-half' : 'polar-center-full'}>
                <PolarPlot
                  scatterData={scatterData()}
                  polarData={polarData()}
                  polarNames={polarNames()}
                  displayMode={displayMode()}
                  selectedTWS={selectedTWS()}
                  selectedPolar={selectedPolar()}
                  editMode={editMode()}
                  onDisplayModeChange={handleDisplayModeChange}
                  onTWSChange={handleTWSChange}
                  onPolarColorChange={handlePolarColorChange}
                  onToggleEditMode={toggleEditMode}
                />
              </div>
              <Show when={editMode() && isAdminOrPublisher()}>
                <div class="polar-right-half">
                <div id="polar-table" class="polar-plot-container polar-edit-panel">
                  <div class="flex items-center justify-center gap-2 mb-2">
                    <button
                      class={`polar-plot-button ${selectedPolar() === 0 ? 'active' : ''}`}
                      onClick={() => setSelectedPolar(0)}
                      aria-pressed={selectedPolar() === 0}
                    >
                      RED
                    </button>
                    <button
                      class={`polar-plot-button ${selectedPolar() === 1 ? 'active' : ''}`}
                      onClick={() => setSelectedPolar(1)}
                      aria-pressed={selectedPolar() === 1}
                    >
                      GREEN
                    </button>
                    <button
                      class={`polar-plot-button ${selectedPolar() === 2 ? 'active' : ''}`}
                      onClick={() => setSelectedPolar(2)}
                      aria-pressed={selectedPolar() === 2}
                    >
                      BLUE
                    </button>
                  </div>
                  <div class="flex items-center justify-center mb-2">
                    <h2 id="table_title" class="text-sm font-semibold text-center">Polar Data Table</h2>
                  </div>
                  <div class="overflow-auto max-h-[60vh] modern-table-container">
                    <table class="modern-table compact w-full text-center">
                      <thead>
                        <tr>
                          <th class="text-center polar-edit-th">TWA</th>
                          <th class="text-center polar-edit-th">BSP</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={editTableRows()}>
                          {(editRow) => {
                            const tws = binTWS(Number(selectedTWS()));
                            return (
                              <tr>
                                <td class="polar-edit-td">
                                  <input
                                    type="number"
                                    step="0.001"
                                    value={editRow.twaValue}
                                    class="form-input text-center polar-edit-input"
                                    onInput={(e) => updatePolarValue(tws, editRow.twaKey, e.currentTarget.value)}
                                  />
                                </td>
                                <td class="polar-edit-td">
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={editRow.bspValue}
                                    class="form-input text-center polar-edit-input"
                                    onInput={(e) => updatePolarValue(tws, editRow.bspKey, e.currentTarget.value)}
                                  />
                                </td>
                              </tr>
                            );
                          }}
                        </For>
                      </tbody>
                    </table>
                  </div>
                  <div class="flex items-center justify-center gap-2 mt-3">
                    <button id="cancel-polar" class="polar-plot-button" onClick={() => setEditMode(false)}>CANCEL</button>
                    <button id="save-polar" class="polar-plot-button active" onClick={saveChanges}>SAVE</button>
                    <button id="export-polar" class="polar-plot-button" onClick={exportSelection}>EXPORT</button>
                    <button id="upload-polar" class="polar-plot-button" onClick={uploadSelection}>UPLOAD</button>
                  </div>
                </div>
                </div>
              </Show>
            </div>
          </div>

          {/* Tooltip */}
          <div
            id="tt"
            class="tooltip"
            style={{
              opacity: tooltip().visible ? 1 : 0,
              left: `${tooltip().x}px`,
              top: `${tooltip().y}px`,
            }}
            innerHTML={tooltip().content}
          ></div>
          </div>
      </Show>
    </Show>
    );
  }
