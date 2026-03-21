import { createSignal, Show, For, onMount, createEffect } from "solid-js";
import { Portal } from "solid-js/web";
import { useNavigate } from "@solidjs/router";
import { getData, postData, putData, getCookie, getTimezoneForDate } from "../../utils/global";
import { authManager } from "../../utils/authManager";
import { logActivity, logPageLoad } from "../../utils/logging";
import { error as logError, debug, warn, info } from "../../utils/console";

import BackButton from "../../components/buttons/BackButton";

import { persistantStore } from "../../store/persistantStore";
import { unifiedDataStore } from "../../store/unifiedDataStore";
import { sseManager } from "../../store/sseManager";
import { processStore } from "../../store/processStore";
import { toastStore } from "../../store/toastStore";
import { sourcesStore } from "../../store/sourcesStore";
import { apiEndpoints } from "@config/env";
import { parseTargetFilename } from "../../utils/targetConfig";
const { selectedClassName, selectedProjectId, setSelectedDatasetId, setSelectedDate, selectedSourceName } = persistantStore;

export default function UploadDatasetsPage() {
  const navigate = useNavigate();
  const [files, setFiles] = createSignal<File[]>([]);
  const [sourceName, setSourceName] = createSignal("");
  const [eventName, setEventName] = createSignal("");
  const [inputDate, setInputDate] = createSignal("");
  const [timezone, setTimezone] = createSignal("Europe/Madrid");
  const [timezones, setTimezones] = createSignal<string[]>([]);
  const [showWaiting, setShowWaiting] = createSignal(false);
  const [uploadSuccess, setUploadSuccess] = createSignal(false);
  const [uploadFailed, setUploadFailed] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal("");
  const [currentStatus, setCurrentStatus] = createSignal("");
  const [processId, setProcessId] = createSignal("");
  const [folderMode, setFolderMode] = createSignal(false);
  const [uploadProgress, setUploadProgress] = createSignal({ current: 0, total: 0 });
  const [isProcessing, setIsProcessing] = createSignal(false);
  const [processingCancelled, setProcessingCancelled] = createSignal(false);
  const [allProcessIds, setAllProcessIds] = createSignal<string[]>([]);
  const [currentStep, setCurrentStep] = createSignal(1);
  const [extractedDates, setExtractedDates] = createSignal<Set<string>>(new Set());
  const [showDateInput, setShowDateInput] = createSignal(false);
  const [datesFromXml, setDatesFromXml] = createSignal<string[]>([]);
  const [selectedSources, setSelectedSources] = createSignal<Set<string>>(new Set());
  const [sourcesInitialized, setSourcesInitialized] = createSignal(false);
  const [isTrainingDay, setIsTrainingDay] = createSignal(false);
  const [wingCode, setWingCode] = createSignal("");
  const [dbCode, setDbCode] = createSignal("");
  const [rudCode, setRudCode] = createSignal("");
  const [crewCount, setCrewCount] = createSignal("");
  const [headsailCode, setHeadsailCode] = createSignal("");
  const [name, setName] = createSignal("");
  const [availableTargets, setAvailableTargets] = createSignal<Array<{ name: string }>>([]);
  const [selectedTarget, setSelectedTarget] = createSignal<string>("");
  const [showProcessConflictModal, setShowProcessConflictModal] = createSignal(false);
  const [runningProcessesInfo, setRunningProcessesInfo] = createSignal<{ running_count: number; processes: any[] } | null>(null);

  // Log page load
  logPageLoad('UploadDatasets.tsx', 'Upload Datasets Page', 'Page loaded');

  /**
   * Basic file validation - quick check that file appears valid.
   * Full verification happens on the server side.
   * 
   * @param file - The File object to validate
   * @returns Promise that resolves if file appears valid
   */
  const validateFileBasic = async (file: File): Promise<void> => {
    // Basic checks: file exists, has size, and is readable
    if (!file || file.size === 0) {
      throw new Error(`File ${file.name} appears to be empty or invalid`);
    }

    // Quick read test to ensure file is accessible
    try {
      const slice = file.slice(0, Math.min(1024, file.size));
      const reader = new FileReader();
      
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('File read timeout'));
        }, 2000);
        
        reader.onload = () => {
          clearTimeout(timeout);
          resolve();
        };
        
        reader.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('File read error'));
        };
        
        reader.readAsArrayBuffer(slice);
      });
    } catch (readError: unknown) {
      const errorMessage = readError instanceof Error ? readError.message : 'Unknown error';
      throw new Error(`File ${file.name} is not accessible: ${errorMessage}`);
    }
  };

  // Fetch timezones
  const fetchTimezones = async () => {
    const controller = new AbortController();
    try {
      const response = await getData(`${apiEndpoints.app.admin.timezones}?project_id=${encodeURIComponent(selectedProjectId())}`, controller.signal);
      if (response.success && response.data) {
        // Extract timezone names from the response (array of objects with 'name' property)
        const tzNames = response.data.map((tz: { name?: string } | string) => (typeof tz === 'object' && tz.name ? tz.name : tz)).sort();
        setTimezones(tzNames);
        debug('[UploadDatasets] Loaded timezones:', tzNames.length);
        // Set default timezone if available
        const defaultTz = tzNames.find(tz => tz.toLowerCase() === "europe/madrid".toLowerCase());
        if (defaultTz) {
          setTimezone(defaultTz);
        }
      } else {
        logError('[UploadDatasets] Failed to fetch timezones:', response.message);
        setTimezones([]);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logError('[UploadDatasets] Error fetching timezones:', error);
      }
      setTimezones([]);
    }
  };

  // Fetch available targets
  const fetchTargets = async () => {
    const controller = new AbortController();
    try {
      const response = await getData(
        `${apiEndpoints.app.targets}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&isPolar=0`,
        controller.signal
      );
      if (response.success && response.data && Array.isArray(response.data)) {
        const targets = response.data.map((t: { name?: string } | string) => 
          typeof t === 'object' && t.name ? { name: t.name } : { name: String(t) }
        ).sort((a, b) => a.name.localeCompare(b.name));
        setAvailableTargets(targets);
        debug('[UploadDatasets] Loaded targets:', targets.length);
      } else {
        logError('[UploadDatasets] Failed to fetch targets:', response.message);
        setAvailableTargets([]);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        logError('[UploadDatasets] Error fetching targets:', error);
      }
      setAvailableTargets([]);
    }
  };

  // Auto-populate source name and initialize selected sources
  onMount(async () => {
    const currentSourceName = selectedSourceName();
    if (currentSourceName) {
      setSourceName(currentSourceName);
    }
    // Automatically enable folder mode
    setFolderMode(true);
    // Fetch timezones
    await fetchTimezones();
    // Fetch targets
    await fetchTargets();
    
    // Initialize selected sources - wait for sourcesStore to be ready, then select all
    const initializeSelectedSources = () => {
      if (sourcesStore.isReady()) {
        const sources = sourcesStore.sources();
        const sourceNames = sources
          .map(s => s.source_name)
          .filter((name): name is string => !!name && name.trim() !== '')
          .sort();
        
        // Only initialize if we haven't initialized yet and we don't have any sources selected
        if (!sourcesInitialized() && selectedSources().size === 0 && sourceNames.length > 0) {
          // Select all sources by default
          setSelectedSources(new Set(sourceNames));
          setSourcesInitialized(true);
          debug('[UploadDatasets] Initialized selected sources:', {
            count: sourceNames.length,
            sources: sourceNames
          });
        }
      } else {
        // Wait a bit and retry if sources aren't ready yet
        setTimeout(initializeSelectedSources, 500);
      }
    };
    
    initializeSelectedSources();
  });

  // Watch for sourcesStore to become ready and initialize sources if needed
  createEffect(() => {
    // Access sourcesStore to create reactive dependency
    const isReady = sourcesStore.isReady();
    const sources = sourcesStore.sources();
    
    // When sources become available and we haven't initialized yet, initialize them
    // Only auto-select on initial load, not when user manually deselects all
    if (isReady && sources.length > 0 && !sourcesInitialized() && selectedSources().size === 0) {
      const sourceNames = sources
        .map(s => s.source_name)
        .filter((name): name is string => !!name && name.trim() !== '')
        .sort();
      
      if (sourceNames.length > 0) {
        setSelectedSources(new Set(sourceNames));
        setSourcesInitialized(true);
        debug('[UploadDatasets] Auto-selected sources via createEffect:', {
          count: sourceNames.length,
          sources: sourceNames
        });
      }
    }
  });
  
  // Helper functions for source selection
  const handleSourceToggle = (sourceName: string) => {
    const current = selectedSources();
    const updated = new Set(current);
    if (updated.has(sourceName)) {
      updated.delete(sourceName);
    } else {
      updated.add(sourceName);
    }
    setSelectedSources(updated);
    debug('[UploadDatasets] Source selection toggled:', {
      sourceName,
      selected: updated.has(sourceName),
      totalSelected: updated.size
    });
  };
  
  const handleSelectAll = () => {
    if (sourcesStore.isReady()) {
      const sources = sourcesStore.sources();
      const sourceNames = sources
        .map(s => s.source_name)
        .filter((name): name is string => !!name && name.trim() !== '')
        .sort();
      setSelectedSources(new Set(sourceNames));
      debug('[UploadDatasets] Selected all sources:', sourceNames);
    }
  };
  
  const handleSelectNone = () => {
    setSelectedSources(new Set());
    debug('[UploadDatasets] Deselected all sources');
  };

  // Helper function for target selection
  const handleTargetChange = (targetName: string) => {
    setSelectedTarget(targetName);
    debug('[UploadDatasets] Target selected:', targetName);
    
    // Parse target filename and auto-fill configuration fields
    if (targetName && targetName.trim() !== '') {
      const parsed = parseTargetFilename(targetName);
      if (parsed) {
        setName(parsed.name);
        setWingCode(parsed.wingCode);
        setDbCode(parsed.dbCode);
        setRudCode(parsed.rudCode);
        debug('[UploadDatasets] Auto-filled configuration from target:', parsed);
      } else {
        debug('[UploadDatasets] Could not parse target filename, configuration not auto-filled');
      }
    }
  };

  const handleFileChange = async (event: Event) => {
    const selectedFiles = Array.from((event.target as HTMLInputElement).files || []);
    
    // Filter for .xml files only
    const allowedFiles = selectedFiles.filter(file => {
      const fileNameLower = file.name.toLowerCase();
      return fileNameLower.endsWith('.xml');
    });
    
    if (allowedFiles.length === 0) {
      debug('[UploadDatasets] No .xml files selected');
      return;
    }
    
    // Basic validation - full verification happens on server
    try {
      for (const file of allowedFiles) {
        await validateFileBasic(file);
      }
      
      setFiles([...files(), ...allowedFiles]);
      
      // Extract dates from XML files
      const datesSet = new Set<string>();
      const xmlFiles = allowedFiles.filter(f => isXmlFile(f.name));
      
      for (const xmlFile of xmlFiles) {
        try {
          const date = await extractDateFromXml(xmlFile);
          if (date) {
            datesSet.add(date);
            debug(`[UploadDatasets] Extracted date ${date} from XML file ${xmlFile.name}`);
          }
        } catch (error) {
          warn(`[UploadDatasets] Error extracting date from ${xmlFile.name}:`, error);
        }
      }
      
      // Update date extraction state
      if (datesSet.size > 0) {
        const sortedDates = Array.from(datesSet).sort();
        setExtractedDates(datesSet);
        setDatesFromXml(sortedDates);
        setShowDateInput(false);
        debug('[UploadDatasets] Dates extracted from XML files:', sortedDates);
      } else {
        setExtractedDates(new Set());
        setDatesFromXml([]);
        setShowDateInput(true);
        debug('[UploadDatasets] No dates found in XML files, showing date input');
      }
      
      // Log file selection activity
      await logActivity(
        selectedProjectId() || 0, 
        0, 
        'UploadDatasets.tsx', 
        'Files Selected', 
        {
          fileCount: allowedFiles.length,
          fileNames: allowedFiles.map(f => f.name),
          totalFiles: files().length + allowedFiles.length,
          datesFound: datesSet.size > 0,
          dates: datesSet.size > 0 ? Array.from(datesSet) : []
        }
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logError('[UploadDatasets] Error validating files:', error);
      setUploadFailed(true);
      setErrorMessage(`File validation failed: ${errorMessage}. Please ensure files are accessible.`);
      toastStore.showToast('error', 'File Validation Failed', errorMessage);
    }
  };

  const handleFolderChange = async (event: Event) => {
    const selectedFiles = Array.from((event.target as HTMLInputElement).files || []);
    
    // Filter for .xml files only
    const allowedFiles = selectedFiles.filter(file => {
      const fileNameLower = file.name.toLowerCase();
      return fileNameLower.endsWith('.xml');
    });
    
    if (allowedFiles.length === 0) {
      debug('[UploadDatasets] No .xml files found in selected folder');
      return;
    }
    
    // Basic validation - full verification happens on server
    try {
      for (const file of allowedFiles) {
        await validateFileBasic(file);
      }
      
      // Replace existing files with folder files (or add them)
      setFiles([...files(), ...allowedFiles]);
      
      // Extract dates from XML files
      const datesSet = new Set<string>();
      const xmlFiles = allowedFiles.filter(f => isXmlFile(f.name));
      
      for (const xmlFile of xmlFiles) {
        try {
          const date = await extractDateFromXml(xmlFile);
          if (date) {
            datesSet.add(date);
            debug(`[UploadDatasets] Extracted date ${date} from XML file ${xmlFile.name}`);
          }
        } catch (error) {
          warn(`[UploadDatasets] Error extracting date from ${xmlFile.name}:`, error);
        }
      }
      
      // Update date extraction state
      if (datesSet.size > 0) {
        const sortedDates = Array.from(datesSet).sort();
        setExtractedDates(datesSet);
        setDatesFromXml(sortedDates);
        setShowDateInput(false);
        debug('[UploadDatasets] Dates extracted from XML files:', sortedDates);
      } else {
        setExtractedDates(new Set());
        setDatesFromXml([]);
        setShowDateInput(true);
        debug('[UploadDatasets] No dates found in XML files, showing date input');
      }
      
      debug('[UploadDatasets] Folder selected:', {
        totalFiles: selectedFiles.length,
        allowedFiles: allowedFiles.length,
        fileNames: allowedFiles.map(f => f.name)
      });
      
      // Log folder selection activity
      await logActivity(
        selectedProjectId() || 0, 
        0, 
        'UploadDatasets.tsx', 
        'Folder Selected', 
        {
          totalFiles: selectedFiles.length,
          allowedFiles: allowedFiles.length,
          fileNames: allowedFiles.map(f => f.name),
          totalFilesAfter: files().length + allowedFiles.length,
          datesFound: datesSet.size > 0,
          dates: datesSet.size > 0 ? Array.from(datesSet) : []
        }
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logError('[UploadDatasets] Error validating folder files:', error);
      setUploadFailed(true);
      setErrorMessage(`File validation failed: ${errorMessage}. Please ensure files are accessible.`);
      toastStore.showToast('error', 'File Validation Failed', errorMessage);
    }
  };

  const removeFile = async (index: number) => {
    const fileToRemove = files()[index];
    const updatedFiles = files().filter((_, i) => i !== index);
    setFiles(updatedFiles);
    
    // Re-extract dates from remaining XML files
    const datesSet = new Set<string>();
    const xmlFiles = updatedFiles.filter(f => isXmlFile(f.name));
    
    for (const xmlFile of xmlFiles) {
      try {
        const date = await extractDateFromXml(xmlFile);
        if (date) {
          datesSet.add(date);
        }
      } catch (error) {
        warn(`[UploadDatasets] Error extracting date from ${xmlFile.name}:`, error);
      }
    }
    
    // Update date extraction state
    if (datesSet.size > 0) {
      const sortedDates = Array.from(datesSet).sort();
      setExtractedDates(new Set<string>(datesSet));
      setDatesFromXml(sortedDates);
      setShowDateInput(false);
    } else {
      setExtractedDates(new Set<string>());
      setDatesFromXml([]);
      setShowDateInput(true);
    }
    
    // Log file removal activity
    await logActivity(
      selectedProjectId() || 0, 
      0, 
      'UploadDatasets.tsx', 
      'File Removed', 
      {
        fileName: fileToRemove.name,
        remainingFiles: updatedFiles.length
      }
    );
  };

  const resetUpload = () => {
    setUploadSuccess(false);
    setUploadFailed(false);
    setErrorMessage("");
    setFiles([]);
    setSourceName("");
    setEventName("");
    setInputDate("");
    setExtractedDates(new Set());
    setDatesFromXml([]);
    setShowDateInput(false);
    // Reset timezone to default
    const defaultTz = timezones().find(tz => tz.toLowerCase() === "europe/madrid".toLowerCase());
    if (defaultTz) {
      setTimezone(defaultTz);
    } else {
      setTimezone("Europe/Madrid");
    }
  };

  // Helper function to extract date from folder name (format: YYYYMMDD)
  const extractDateFromFolderName = (folderName: string): string | null => {
    // Try YYYYMMDD format (8 digits)
    const compactMatch = folderName.match(/^(\d{4})(\d{2})(\d{2})/);
    if (compactMatch) {
      const [, year, month, day] = compactMatch;
      // Validate date
      const date = new Date(`${year}-${month}-${day}`);
      if (!isNaN(date.getTime()) && date.getFullYear().toString() === year) {
        return `${year}-${month}-${day}`;
      }
    }
    return null;
  };

  // Helper function to get folder name from file path
  const getFolderNameFromPath = (file: File): string | null => {
    // Check if file has webkitRelativePath (from folder selection)
    if ('webkitRelativePath' in file && file.webkitRelativePath) {
      const path = file.webkitRelativePath;
      // Extract first folder name from path (e.g., "20240829/file.parquet" -> "20240829")
      const parts = path.split('/');
      if (parts.length > 1) {
        return parts[0];
      }
    }
    return null;
  };

  /**
   * Extracts the date folder from a file path by searching through all folders.
   * Looks for folders matching YYYY-MM-DD or YYYYMMDD date formats.
   * 
   * @param file - The File object to extract date folder from
   * @returns The date folder name (normalized to YYYY-MM-DD format) or null if not found
   */
  const getDateFolderFromPath = (file: File): string | null => {
    // Check if file has webkitRelativePath (from folder selection)
    if ('webkitRelativePath' in file && file.webkitRelativePath) {
      const pathParts = file.webkitRelativePath.split('/');
      
      // Search through all folders in the path (excluding the filename)
      for (let i = 0; i < pathParts.length - 1; i++) {
        const folder = pathParts[i];
        
        // Try YYYY-MM-DD format (e.g., "2025-03-15")
        const dashMatch = folder.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (dashMatch) {
          const [, year, month, day] = dashMatch;
          const date = new Date(`${year}-${month}-${day}`);
          if (!isNaN(date.getTime()) && date.getFullYear().toString() === year) {
            // Validate month and day are reasonable
            const monthNum = parseInt(month, 10);
            const dayNum = parseInt(day, 10);
            if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
              return folder; // Return the date folder name as-is for matching
            }
          }
        }
        
        // Try YYYYMMDD format (e.g., "20250315")
        const compactMatch = folder.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (compactMatch) {
          const [, year, month, day] = compactMatch;
          const date = new Date(`${year}-${month}-${day}`);
          if (!isNaN(date.getTime()) && date.getFullYear().toString() === year) {
            // Validate month and day are reasonable
            const monthNum = parseInt(month, 10);
            const dayNum = parseInt(day, 10);
            if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
              // Convert to YYYY-MM-DD format for consistent matching
              return `${year}-${month}-${day}`;
            }
          }
        }
      }
    }
    return null;
  };

  // Helper function to check if file is XML
  const isXmlFile = (filename: string): boolean => {
    return filename.toLowerCase().endsWith('.xml');
  };

  // Helper function to count XML files
  const getXmlFileCount = (): number => {
    return files().filter(f => isXmlFile(f.name)).length;
  };

  // Helper function to check if upload button should be disabled and log missing fields
  const isUploadDisabled = (): boolean => {
    if (isTrainingDay()) {
      const missing: string[] = [];
      if (!inputDate()) missing.push('inputDate');
      if (!name()) missing.push('name');
      if (!wingCode()) missing.push('wingCode');
      if (!dbCode()) missing.push('dbCode');
      if (!rudCode()) missing.push('rudCode');
      if (!crewCount()) missing.push('crewCount');
      if (!headsailCode()) missing.push('headsailCode');
      if (!eventName()) missing.push('eventName');
      if (!timezone()) missing.push('timezone');
      if (selectedSources().size === 0) missing.push('selectedSources');
      if (availableTargets().length > 0 && (!selectedTarget() || selectedTarget().trim() === '')) missing.push('selectedTarget');
      
      if (missing.length > 0) {
        debug('[UploadDatasets] Upload button disabled - missing fields:', missing);
      }
      
      return missing.length > 0;
    } else {
      const missing: string[] = [];
      if (getXmlFileCount() === 0) missing.push('XML files');
      if (!eventName()) missing.push('eventName');
      if (!timezone()) missing.push('timezone');
      if (showDateInput() ? !inputDate() : extractedDates().size === 0) missing.push('date');
      if (selectedSources().size === 0) missing.push('selectedSources');
      if (availableTargets().length > 0 && (!selectedTarget() || selectedTarget().trim() === '')) missing.push('selectedTarget');
      
      if (missing.length > 0) {
        debug('[UploadDatasets] Upload button disabled - missing fields:', missing, {
          xmlFileCount: getXmlFileCount(),
          eventName: eventName(),
          timezone: timezone(),
          showDateInput: showDateInput(),
          inputDate: inputDate(),
          extractedDatesSize: extractedDates().size,
          selectedSourcesSize: selectedSources().size,
          availableTargetsLength: availableTargets().length,
          selectedTarget: selectedTarget()
        });
      }
      
      return missing.length > 0;
    }
  };

  // Helper function to extract date from filename (format: YYYYMMDD_* or YYYY-MM-DD_*)
  const extractDateFromFilename = (filename: string): string | null => {
    // Try YYYYMMDD format (8 digits at start)
    const compactMatch = filename.match(/^(\d{4})(\d{2})(\d{2})/);
    if (compactMatch) {
      const [, year, month, day] = compactMatch;
      return `${year}-${month}-${day}`;
    }
    // Try YYYY-MM-DD format
    const dashMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dashMatch) {
      return dashMatch[1];
    }
    return null;
  };

  // Helper function to extract date from XML file
  const extractDateFromXml = async (file: File): Promise<string | null> => {
    try {
      const text = await file.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, 'text/xml');
      
      // Check for parsing errors
      const parserError = xmlDoc.querySelector('parsererror');
      if (parserError) {
        warn(`[UploadDatasets] XML parsing error for ${file.name}:`, parserError.textContent);
        return null;
      }
      
      // Extract CreationTimeDate
      const creationTimeElement = xmlDoc.querySelector('CreationTimeDate');
      if (creationTimeElement && creationTimeElement.textContent) {
        const creationTime = creationTimeElement.textContent.trim();
        // Parse the date - format might be ISO string or other format
        const date = new Date(creationTime);
        if (!isNaN(date.getTime())) {
          // Return in YYYY-MM-DD format
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return `${year}-${month}-${day}`;
        }
      }
      
      // Fallback: try to extract date from filename (format: YYYYMMDD_*)
      const filenameDate = extractDateFromFilename(file.name);
      if (filenameDate) {
        return filenameDate;
      }
      
      return null;
    } catch (error) {
      warn(`[UploadDatasets] Error extracting date from XML file ${file.name}:`, error);
      // Fallback to filename date extraction
      return extractDateFromFilename(file.name);
    }
  };



  // Helper function to group files by date-formatted folders
  const groupFilesByDateFolders = (files: File[]): Map<string, File[]> => {
    const folderGroups = new Map<string, File[]>(); // Map<date, File[]>
    const ungroupedFiles: File[] = [];

    for (const file of files) {
      const folderName = getFolderNameFromPath(file);
      
      if (folderName) {
        const date = extractDateFromFolderName(folderName);
        if (date) {
          if (!folderGroups.has(date)) {
            folderGroups.set(date, []);
          }
          folderGroups.get(date)!.push(file);
        } else {
          // Folder doesn't match date format, add to ungrouped
          ungroupedFiles.push(file);
        }
      } else {
        // No folder path (single file mode), add to ungrouped
        ungroupedFiles.push(file);
      }
    }

    // If there are ungrouped files, add them as a single group with null date
    if (ungroupedFiles.length > 0) {
      folderGroups.set('ungrouped', ungroupedFiles);
    }

    return folderGroups;
  };

  // Process a single folder group through the upload workflow
  const processFolderGroup = async (
    folderDate: string,
    folderFiles: File[],
    allSources: any[],
    _isAllMode: boolean,
    _sourceNameToUse: string,
    _skipNormalization: boolean = false,
    isTrainingDay: boolean = false
  ) => {
    debug('[UploadDatasets] Processing folder group:', {
      folderDate,
      fileCount: folderFiles.length,
      fileNames: folderFiles.map(f => f.name)
    });

    // Helper function to check if file is XML
    const isXmlFile = (filename: string) => {
      return filename.toLowerCase().endsWith('.xml');
    };

    // Use selected sources from the UI - trust the source names from sourcesStore
    const selectedSourcesSet = selectedSources();
    const influxSources = Array.from(selectedSourcesSet)
      .filter(name => name && name.trim() !== '')
      .sort(); // Sort alphabetically for consistent processing
    
    if (influxSources.length === 0) {
      throw new Error('No sources selected. Please select at least one source to normalize.');
    }
    
    debug('[UploadDatasets] Using selected sources for normalization:', {
      selectedCount: influxSources.length,
      sources: influxSources
    });
    
    // Determine which dates to use: extracted dates from XML or manual input
    // For training day, always use inputDate
    const datesToProcess = isTrainingDay
      ? (inputDate() ? [inputDate()] : [])
      : (extractedDates().size > 0 
          ? Array.from(extractedDates()).sort() 
          : (inputDate() ? [inputDate()] : []));
    
    if (datesToProcess.length === 0) {
      throw new Error('Date is required for InfluxDB normalization');
    }
    
    debug('[UploadDatasets] Processing dates for normalization:', datesToProcess);
    
    // Step 1: Upload XML files only (skip for training day)
    const xmlFilesToUpload = isTrainingDay ? [] : folderFiles.filter(f => isXmlFile(f.name));
    if (!isTrainingDay && xmlFilesToUpload.length === 0) {
      throw new Error('No XML files found in folder');
    }
    
    const xmlFileUploadResults: any[] = [];
    
    if (!isTrainingDay && xmlFilesToUpload.length > 0) {
      setCurrentStatus(`Uploading ${xmlFilesToUpload.length} XML file(s)...`);
      setCurrentStep(1);
      setUploadProgress({ current: 0, total: xmlFilesToUpload.length });
      
      // Ensure step 1 is visible by adding a small delay for UI update
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const uploadAccessToken = authManager.getAccessToken();
      
      // Upload XML files
      for (let i = 0; i < xmlFilesToUpload.length; i++) {
        const file = xmlFilesToUpload[i];
        setUploadProgress({ current: i + 1, total: xmlFilesToUpload.length });
        
        // Check if file already exists before uploading
        // For XML files, check by filename only - check all dates we're processing
        let isDuplicate = false;
        let savePath: string | null = null;
        
        // Check all dates - if file exists in any date folder, it's a duplicate
        for (const date of datesToProcess) {
        const formattedDate = date.replace(/-/g, '');
        
        try {
          const checkUrl = `${apiEndpoints.admin.upload}/check-file?` + new URLSearchParams({
            class_name: selectedClassName().toLowerCase(),
            project_id: selectedProjectId().toString(),
            source_name: 'XML',
            date: formattedDate,
            file_name: file.name,
            file_size: file.size.toString(),
            is_xml: 'true'
          });
          
          debug('[UploadDatasets] Checking XML file for duplicates (by filename):', {
            fileName: file.name,
            date: formattedDate,
            fileSize: file.size
          });
          
          const checkResponse = await getData(checkUrl);
          
          if (checkResponse.success && checkResponse.data?.isDuplicate) {
            isDuplicate = true;
            savePath = checkResponse.data?.savePath || null;
            debug('[UploadDatasets] XML file is duplicate (found by filename):', {
              fileName: file.name,
              date: formattedDate,
              savePath
            });
            break; // Found it, no need to check more dates
          }
        } catch (checkError) {
          // Continue checking other dates if one fails
          debug('[UploadDatasets] Error checking XML file for date:', {
            fileName: file.name,
            date: formattedDate,
            error: checkError
          });
        }
        }
        
        if (isDuplicate) {
          setCurrentStatus(`XML file ${i + 1} of ${xmlFilesToUpload.length} skipped: ${file.name} (already exists)`);
        } else {
          debug('[UploadDatasets] XML file is NOT duplicate, will upload:', {
            fileName: file.name
          });
        }
        
        // Only upload if not a duplicate
        if (!isDuplicate) {
          setCurrentStatus(`Uploading XML file ${i + 1} of ${xmlFilesToUpload.length}: ${file.name}...`);
          
          try {
            const formData = new FormData();
            formData.append('files', file);
            formData.append('class_name', selectedClassName().toLowerCase());
            formData.append('project_id', selectedProjectId().toString());
            formData.append('source_name', 'XML'); // Temporary source name for XML files
            formData.append('skip_normalization', 'true');
            
            const response = await fetch(`${apiEndpoints.admin.upload}/data`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Authorization': `Bearer ${uploadAccessToken}`,
                'X-CSRF-Token': getCookie('csrf_token') || ''
              },
              body: formData
            });
            
            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`Upload failed for ${file.name}: ${errorText}`);
            }
            
            const uploadResponse = await response.json();
            if (!uploadResponse.success) {
              throw new Error(`Upload failed for ${file.name}: ${uploadResponse.message || 'Unknown error'}`);
            }
            
            // Extract save path from response and check if server marked it as duplicate
            if (uploadResponse.data?.results && Array.isArray(uploadResponse.data.results)) {
              const fileResult = uploadResponse.data.results.find((r: any) => r.fileName === file.name);
              if (fileResult) {
                savePath = fileResult?.savePath || null;
                
                // Check if server marked this as a duplicate/skipped file
                if (fileResult.skipped || fileResult.isDuplicate) {
                  warn('[UploadDatasets] Server marked XML file as duplicate after upload attempt:', {
                    fileName: file.name,
                    fileResult
                  });
                  // Update isDuplicate flag for tracking
                  isDuplicate = true;
                }
              }
            }
            
            if (isDuplicate) {
              debug('[UploadDatasets] XML file was duplicate (server-side check):', {
                fileName: file.name,
                savePath
              });
            } else {
              debug('[UploadDatasets] XML file uploaded:', { fileName: file.name, savePath });
            }
          } catch (error: any) {
            logError('[UploadDatasets] Error uploading XML file:', { fileName: file.name, error });
            // Continue with other files even if one fails
          }
        } else {
          debug('[UploadDatasets] XML file skipped (duplicate):', {
            fileName: file.name,
            message: 'File already exists with same name and size'
          });
        }
        
        // Add to results regardless of whether it was uploaded or skipped
        xmlFileUploadResults.push({
          file: file,
          savePath: savePath,
          dates: datesToProcess,
          skipped: isDuplicate
        });
        
        // Log summary for this file
        if (isDuplicate) {
          debug(`[UploadDatasets] XML file ${i + 1}/${xmlFilesToUpload.length} SKIPPED (duplicate): ${file.name}`);
        } else {
          debug(`[UploadDatasets] XML file ${i + 1}/${xmlFilesToUpload.length} UPLOADED: ${file.name}`);
        }
      }
    
    // Ensure step 1 completes visibly before moving to step 2
    if (xmlFileUploadResults.length > 0) {
      const uploadedCount = xmlFileUploadResults.filter(r => !r.skipped).length;
      const skippedCount = xmlFileUploadResults.filter(r => r.skipped).length;
      setCurrentStatus(`Upload complete: ${uploadedCount} uploaded, ${skippedCount} skipped`);
      // Small delay to ensure UI updates
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    }
    
    // Step 2: Normalize - Parse XML files and normalize InfluxDB data
    // Only set step 2 if we're not already in step 3 (processing phase)
    // This prevents step from being reset to 2 if normalization happens during dataset creation
    if (currentStep() < 3) {
      setCurrentStep(2);
    }
    
    // Parse XML files for each date (part of normalization step) - Skip for training day
    // Use Promise.race to add a timeout so we don't get stuck
    if (!isTrainingDay && xmlFileUploadResults.length > 0) {
      const filePaths = xmlFileUploadResults.map(r => r.savePath).filter((p): p is string => p !== null);
      if (filePaths.length > 0) {
        setCurrentStatus('Parsing XML files...');
        debug(`[UploadDatasets] Starting XML parsing for ${datesToProcess.length} date(s) with ${filePaths.length} file(s)`);
        
        // Parse XML files for each date with timeout protection
        for (const date of datesToProcess) {
          try {
            debug(`[UploadDatasets] Parsing XML files for date ${date}...`);
            
            // Add a timeout wrapper to prevent hanging
            const parsePromise = parseXmlFiles(filePaths, date);
            const timeoutPromise = new Promise<boolean>((resolve) => {
              setTimeout(() => {
                warn(`[UploadDatasets] XML parsing timeout for date ${date} after 6 minutes, continuing...`);
                resolve(false);
              }, 360000); // 6 minute timeout (longer than script timeout)
            });
            
            const result = await Promise.race([parsePromise, timeoutPromise]);
            
            if (result) {
              debug(`[UploadDatasets] XML files parsed successfully for date ${date}`);
            } else {
              warn(`[UploadDatasets] XML parsing failed or timed out for date ${date}, continuing with normalization`);
            }
          } catch (error) {
            warn(`[UploadDatasets] Error parsing XML files for date ${date}, continuing with normalization:`, error);
            // Continue even if XML parsing fails
          }
        }
        
        debug(`[UploadDatasets] XML parsing phase completed, moving to InfluxDB normalization`);
      } else {
        warn('[UploadDatasets] No valid file paths for XML parsing, skipping XML parse step');
      }
    } else {
      debug('[UploadDatasets] No XML files to parse, skipping XML parse step');
    }
    
    // Normalize InfluxDB data for each source and each date
    const totalNormalizations = influxSources.length * datesToProcess.length;
    setUploadProgress({ current: 0, total: totalNormalizations });
    setCurrentStatus('Normalizing InfluxDB data...');
    
    const normalizedSources: string[] = [];
    const sourceFilesMap = new Map();
    const sourceDatesMap = new Map();
    
    let normalizationCount = 0;
    
    // Loop through each date
    for (const currentDate of datesToProcess) {
      debug(`[UploadDatasets] Processing date ${currentDate} for normalization`);
      
      // Loop through each source for this date
      // Only process sources that were discovered from InfluxDB
      for (let i = 0; i < influxSources.length; i++) {
        const sourceName = influxSources[i];
        
        // Safety check: skip if source name is invalid
        if (!sourceName || sourceName.trim() === '') {
          warn(`[UploadDatasets] Skipping invalid source name at index ${i}`);
          continue;
        }
        
        normalizationCount++;
        setUploadProgress({ current: normalizationCount, total: totalNormalizations });
        setCurrentStatus(`Normalizing ${sourceName} for ${currentDate} (${normalizationCount} of ${totalNormalizations})...`);
        
        try {
          const success = await normalizeInfluxSource(sourceName, currentDate);
          debug(`[UploadDatasets] Normalization result for ${sourceName} on ${currentDate}:`, {
            success,
            sourceName,
            currentDate
          });
          
          // CRITICAL: Only add to sourceDatesMap if normalization actually succeeded AND data was saved
          if (success) {
            // Track normalized sources (avoid duplicates)
            if (!normalizedSources.includes(sourceName)) {
              normalizedSources.push(sourceName);
            }
            
            // Find or create source in allSources
            let source = allSources.find(s => s.source_name === sourceName);
            if (!source) {
              debug(`[UploadDatasets] Source ${sourceName} not found, creating new source...`);
              // Create source if it doesn't exist
              const createResponse = await postData(`${apiEndpoints.app.sources}`, {
                class_name: selectedClassName(),
                project_id: selectedProjectId(),
                source_name: sourceName,
                color: "#ffffff"
              });
              
              if (createResponse.success && createResponse.data > 0) {
                source = { source_id: createResponse.data, source_name: sourceName };
                allSources.push(source);
                debug(`[UploadDatasets] Created new source:`, { source_id: source.source_id, source_name: source.source_name });
              } else {
                warn(`[UploadDatasets] Failed to create source ${sourceName}, skipping...`, {
                  response: createResponse
                });
                continue;
              }
            } else {
              debug(`[UploadDatasets] Found existing source:`, { source_id: source.source_id, source_name: source.source_name });
            }
            
            // Track this source for dataset creation
            if (!sourceFilesMap.has(source.source_id)) {
              sourceFilesMap.set(source.source_id, { source: source, files: [] });
              debug(`[UploadDatasets] Added source to sourceFilesMap:`, { source_id: source.source_id, source_name: source.source_name });
            }
            
            if (!sourceDatesMap.has(source.source_id)) {
              sourceDatesMap.set(source.source_id, new Set());
              debug(`[UploadDatasets] Created new dateSet for source:`, { source_id: source.source_id, source_name: source.source_name });
            }
            
            const dateSet = sourceDatesMap.get(source.source_id);
            dateSet.add(currentDate);
            debug(`[UploadDatasets] Added date to sourceDatesMap:`, {
              source_id: source.source_id,
              source_name: source.source_name,
              date: currentDate,
              dateSetSize: dateSet.size,
              dateSetContents: Array.from(dateSet)
            });
            
            debug(`[UploadDatasets] Successfully normalized source ${sourceName} for date ${currentDate} and added to sourceDatesMap`);
          } else {
            debug(`[UploadDatasets] No data found for source ${sourceName} on date ${currentDate}, skipping...`);
          }
        } catch (error) {
          warn(`[UploadDatasets] Error normalizing source ${sourceName} for date ${currentDate}, continuing with next source:`, error);
          // Continue with next source even if one fails
        }
      }
    }
    
    // Convert Sets back to Arrays for dataset creation
    const sourceDatesArray = new Map();
    for (const [sourceId, dateSet] of sourceDatesMap.entries()) {
      const datesArray = Array.from(dateSet);
      if (datesArray.length > 0) {
        sourceDatesArray.set(sourceId, datesArray);
        debug('[UploadDatasets] Added to sourceDatesArray:', {
          sourceId,
          dates: datesArray,
          sourceName: sourceFilesMap.get(sourceId)?.source?.source_name || 'unknown'
        });
      } else {
        warn('[UploadDatasets] Skipping source with empty dateSet:', {
          sourceId,
          sourceName: sourceFilesMap.get(sourceId)?.source?.source_name || 'unknown'
        });
      }
    }
    
    // Log which sources will have datasets created (for debugging source mismatch issues)
    const sourcesWithDatasets = Array.from(sourceDatesMap.entries()).map(([sourceId, dateSet]) => {
      const sourceInfo = sourceFilesMap.get(sourceId);
      return {
        sourceId,
        sourceName: sourceInfo?.source?.source_name || 'unknown',
        dates: Array.from(dateSet)
      };
    });
    
    debug('[UploadDatasets] Folder group processing complete:', {
      folderDate,
      normalizedSources,
      totalSources: normalizedSources.length,
      sourceDatesMapSize: sourceDatesMap.size,
      sourceDatesArraySize: sourceDatesArray.size,
      sourcesWithDatasets: sourcesWithDatasets,
      note: 'Only sources with successfully normalized InfluxDB data will have datasets created'
    });

    // CRITICAL: Validate that sourceDatesArray is not empty
    if (sourceDatesArray.size === 0) {
      warn('[UploadDatasets] WARNING: sourceDatesArray is EMPTY after normalization!', {
        folderDate,
        normalizedSourcesCount: normalizedSources.length,
        sourceDatesMapSize: sourceDatesMap.size,
        sourceFilesMapSize: sourceFilesMap.size,
        normalizedSources: normalizedSources,
        sourceDatesMapEntries: Array.from(sourceDatesMap.entries()).map(([id, dateSet]) => ({
          sourceId: id,
          sourceName: sourceFilesMap.get(id)?.source?.source_name || 'unknown',
          dateSetSize: dateSet.size,
          dates: Array.from(dateSet)
        })),
        note: 'This will prevent datasets from being created. Check if normalization actually saved data.'
      });
    }
    
    return { filesBySource: sourceFilesMap, datesBySourceArray: sourceDatesArray, fileUploadResults: xmlFileUploadResults };
  };

  // Save targets to project object
  const saveTargetsToProject = async (date: string): Promise<boolean> => {
    try {
      const selectedTargetName = selectedTarget();
      if (!selectedTargetName || selectedTargetName.trim() === '') {
        debug('[UploadDatasets] No target selected, skipping target save');
        return true; // Not an error, just no target to save
      }

      // Remove '_target' suffix from target name if present
      let targetNameToSave = selectedTargetName.trim();
      if (targetNameToSave.endsWith('_target')) {
        targetNameToSave = targetNameToSave.slice(0, -7); // Remove '_target' (7 characters)
      }

      // Build targets JSON array in the required format
      const targetsJson = [{
        name: targetNameToSave
      }];

      const dateStr = date.replace(/-/g, '');

      debug('[UploadDatasets] Saving target object:', {
        class_name: selectedClassName(),
        project_id: selectedProjectId(),
        date: dateStr,
        object_name: 'target',
        target: targetsJson
      });

      const response = await postData(
        `${apiEndpoints.app.projects}/object`,
        {
          class_name: selectedClassName(),
          project_id: selectedProjectId(),
          date: dateStr,
          object_name: 'target',
          json: JSON.stringify(targetsJson)
        }
      );

      if (response.success) {
        debug('[UploadDatasets] Targets object saved successfully');
        return true;
      } else {
        logError('[UploadDatasets] Failed to save targets object:', response.message);
        return false;
      }
    } catch (error: any) {
      logError('[UploadDatasets] Error saving targets object:', error);
      return false;
    }
  };

  // Save configuration to project object for training day and race day
  const saveConfigurationToProject = async (date: string): Promise<boolean> => {
    try {
      if (!name() || !wingCode() || !dbCode() || !rudCode() || !crewCount() || !headsailCode()) {
        logError('[UploadDatasets] Missing configuration fields');
        return false;
      }

      // Build config string: name-headsail-crew (e.g., "M2-HW2-C6"). Normalize crew to numeric only so we never get -CC6 when user enters "C6".
      const crewNum = String(crewCount()).replace(/^C/i, '').trim();
      const configString = `${name().toUpperCase()}-${headsailCode()}-C${crewNum}`;

      // Build configuration JSON in the required format
      // For training day, we create one entry per date with the configuration
      // The time should be set to 10:00:00 local time in the selected timezone
      const dateStr = date.replace(/-/g, '');
      const configJson = [{
        time: `${date}T10:00:00${getTimezoneOffset(timezone())}`,
        configuration: {
          name: name(),
          headsail: headsailCode(),
          crew: crewNum,
          wing: wingCode(),
          config: configString,
          rudder: rudCode(),
          daggerboard: dbCode()
        }
      }];

      debug('[UploadDatasets] Saving configuration object:', {
        class_name: selectedClassName(),
        project_id: selectedProjectId(),
        date: dateStr,
        config: configJson
      });

      const response = await postData(
        `${apiEndpoints.app.projects}/object`,
        {
          class_name: selectedClassName(),
          project_id: selectedProjectId(),
          date: dateStr,
          object_name: 'configurations',
          json: JSON.stringify(configJson)
        }
      );

      if (response.success) {
        debug('[UploadDatasets] Configuration object saved successfully');
        return true;
      } else {
        logError('[UploadDatasets] Failed to save configuration object:', response.message);
        return false;
      }
    } catch (error: any) {
      logError('[UploadDatasets] Error saving configuration object:', error);
      return false;
    }
  };

  // Helper function to get timezone offset
  const getTimezoneOffset = (tz: string): string => {
    try {
      const now = new Date();
      const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
      const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
      const offset = (local.getTime() - utc.getTime()) / (1000 * 60); // offset in minutes
      const hours = Math.floor(Math.abs(offset) / 60);
      const minutes = Math.abs(offset) % 60;
      const sign = offset >= 0 ? '+' : '-';
      return `${sign}${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    } catch {
      return '-07:00'; // Default fallback
    }
  };

  const handleUpload = async () => {
    debug('[UploadDatasets] handleUpload called - checking for running processes first');
    
    // Check for running processes before starting upload
    const runningInfo = await checkRunningProcesses();
    if (runningInfo && runningInfo.running_count > 0) {
      // Show modal to let user choose
      setRunningProcessesInfo(runningInfo);
      setShowProcessConflictModal(true);
      return; // Exit early - the modal will call handleUploadWithProcessDecision
    }
    
    // No running processes, proceed with upload
    await handleUploadWithProcessDecision(false);
    
    // This function is called after user makes a decision about running processes
    // or directly if there are no running processes
  };

  const handleUploadWithProcessDecision = async (cancelRunning: boolean) => {
    // If user chose to cancel running processes, do that first
    if (cancelRunning && runningProcessesInfo()) {
      debug('[UploadDatasets] User chose to cancel running processes');
      const processes = runningProcessesInfo()!.processes;
      for (const proc of processes) {
        const cancelled = await cancelRunningProcess(proc.process_id);
        if (cancelled) {
          debug('[UploadDatasets] Cancelled process:', proc.process_id);
        } else {
          warn('[UploadDatasets] Failed to cancel process:', proc.process_id);
        }
      }
      
      // Wait a moment for processes to cancel
      await new Promise(resolve => setTimeout(resolve, 1000));
    } else if (!cancelRunning) {
      // User chose to add to queue - continue with upload (it will wait for processes)
      debug('[UploadDatasets] User chose to add to queue - continuing with upload');
    }
    
    // Close the conflict modal
    setShowProcessConflictModal(false);
    setRunningProcessesInfo(null);
    
    debug('[UploadDatasets] Starting upload - setting showWaiting to true');
    
    // Set status and show modal FIRST, before any async operations
    setCurrentStatus("Initializing...");
    setShowWaiting(true);
    setUploadSuccess(false);
    setUploadFailed(false);
    setErrorMessage("");
    
    // Force a render cycle to ensure modal is visible
    await new Promise(resolve => setTimeout(resolve, 50));
    debug('[UploadDatasets] Modal should be visible now, showWaiting:', showWaiting());

    // Log upload attempt start (don't await - let it run in background)
    logActivity(
      selectedProjectId() || 0, 
      0, 
      'UploadDatasets.tsx', 
      'Upload Attempt Started', 
      {
        fileCount: getXmlFileCount(),
        fileNames: files().map(f => f.name),
        sourceName: sourceName(),
        eventName: eventName(),
        className: selectedClassName()
      }
    ).catch(err => debug('[UploadDatasets] Error logging activity:', err));

    try {
      // Handle Training Day mode differently
      if (isTrainingDay()) {
        // For training day, we don't upload XML files
        // We just save configuration and normalize InfluxDB data
        
        if (!inputDate()) {
          throw new Error('Date is required for training day upload');
        }

        // Save configuration to project object
        setCurrentStatus("Saving configuration...");
        const configSaved = await saveConfigurationToProject(inputDate());
        if (!configSaved) {
          throw new Error('Failed to save configuration');
        }

        // Save targets to project object
        setCurrentStatus("Saving targets...");
        const targetsSaved = await saveTargetsToProject(inputDate());
        if (!targetsSaved) {
          warn('[UploadDatasets] Failed to save targets, continuing with upload');
        }

        // Continue with normalization and dataset creation
        // We'll create a fake folder entry for the date
        const folderEntries: Array<[string, File[]]> = [[inputDate(), []]];
        
        // Get all sources
        setCurrentStatus("Loading available sources...");
        const sourcesResponse = await getData(
          `${apiEndpoints.app.sources}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}`
        );

        if (!sourcesResponse.success || !sourcesResponse.data || !Array.isArray(sourcesResponse.data)) {
          throw new Error('Failed to load sources');
        }

        const allSources = sourcesResponse.data;
        const isAllMode = true;
        const sourceNameToUse = '';

        // Skip file upload phase, go directly to normalization
        const allFileUploadResults: any[] = [];
        const allFilesBySourceMaps: Map<any, any>[] = [new Map()];
        const allDatesBySourceArrays: Map<any, any[]>[] = [];

        // Process normalization for training day
        setCurrentStatus("Normalizing InfluxDB data...");
        const { filesBySource, datesBySourceArray } = await processFolderGroup(
          inputDate(),
          [], // No files for training day
          allSources,
          isAllMode,
          sourceNameToUse,
          false, // skipNormalization = false, we want to normalize
          true  // isTrainingDay = true
        );

        allFilesBySourceMaps[0] = filesBySource;
        allDatesBySourceArrays.push(datesBySourceArray);

        // Continue with dataset creation (same as race day)
        setCurrentStatus("Files uploaded successfully. Processing will continue in the background...");
        setIsProcessing(true);
        setCurrentStatus("Creating datasets...");

        // Create datasets and run scripts (reuse existing logic)
        const allCreatedDatasetIds = [];
        const allDatasetInfoMaps: Map<number, any>[] = [];
        // Track date and source_id for each dataset for channel population
        const datasetDateSourceMap = new Map<number, {date: string, source_id: number}>();

        // Process the single date for training day
        const [folderDate, folderFiles] = folderEntries[0];
        const filesBySourceForDate = allFilesBySourceMaps[0];
        const datesBySourceArrayForDate = allDatesBySourceArrays[0];

        // Store dataset info for script execution
        const datasetInfoMap = new Map();

        // Create datasets for each date-source combination
        const sourcesToCreateDatasets = Array.from(datesBySourceArrayForDate.entries()).map(([id, dates]) => {
          const sourceInfo = filesBySourceForDate.get(id);
          return {
            sourceId: id,
            sourceName: sourceInfo?.source?.source_name || 'unknown',
            dates: dates,
            uniqueDates: [...new Set(dates)]
          };
        });

        // Retrieve latest target_id for non-polar targets
        let latestTargetId = null;
        try {
          debug('[UploadDatasets] Retrieving latest targets...');
          const targetResponse = await getData(
            `${apiEndpoints.app.targets}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&isPolar=0`
          );
          if (targetResponse.success && targetResponse.data && targetResponse.data.length > 0) {
            latestTargetId = Math.max(...targetResponse.data.map((t: any) => t.target_id));
            debug('[UploadDatasets] Latest target_id:', latestTargetId);
          }
        } catch (error) {
          warn('[UploadDatasets] Error retrieving targets:', error);
        }

        // Create datasets for each source-date combination
        for (const { sourceId, sourceName, uniqueDates } of sourcesToCreateDatasets) {
          for (const date of uniqueDates) {
            try {
              const year = new Date(date).getFullYear();
              const currentTimezone = timezone() || 'Europe/Madrid';
              
              const createDatasetResponse = await postData(`${apiEndpoints.app.datasets}`, {
                class_name: selectedClassName(),
                project_id: selectedProjectId(),
                source_id: sourceId,
                date: date.replace(/-/g, ''),
                year_name: year,
                event_name: eventName() || '',
                report_name: 'NA', // Will be updated in prepopulateDatasetInfo
                description: 'NA',
                timezone: currentTimezone,
                tags: JSON.stringify({ isUploaded: true, Race_type: 'INSHORE' }),
              });

              if (createDatasetResponse.success && createDatasetResponse.data) {
                const datasetId = createDatasetResponse.data;
                allCreatedDatasetIds.push(datasetId);
                // Track date and source_id for channel population
                // Get source_id from source object
                const source = allSources.find((s: any) => s.source_name === sourceName);
                if (source && source.source_id) {
                  datasetDateSourceMap.set(datasetId, { date, source_id: source.source_id });
                }
                datasetInfoMap.set(datasetId, { date, source_name: sourceName });
                debug('[UploadDatasets] Dataset created:', { datasetId, date, sourceName });
              }
            } catch (error) {
              warn('[UploadDatasets] Error creating dataset:', { sourceName, date, error });
            }
          }
        }

        allDatasetInfoMaps.push(datasetInfoMap);

        // Run 5_markwind.py for each unique date (training day path) so markwind is available for prestart/map
        processStore.enableBatchSuppressMode();
        if (selectedClassName() === 'gp50' && allCreatedDatasetIds.length > 0) {
          const uniqueDatesTraining = [...new Set(
            [...datasetInfoMap.values()].map((d: { date: string }) => (d.date || '').replace(/[-/]/g, '').slice(0, 8))
          )].filter(Boolean);
          debug('[UploadDatasets] Training day: markwind check', { uniqueDates: uniqueDatesTraining, datasetCount: allCreatedDatasetIds.length });
          if (uniqueDatesTraining.length > 0) {
            for (let i = 0; i < uniqueDatesTraining.length; i++) {
              const dateNorm = uniqueDatesTraining[i];
              setCurrentStatus(`Building markwind (${i + 1}/${uniqueDatesTraining.length}): ${dateNorm}...`);
              let timezoneVal = 'Europe/Madrid';
              try {
                const tz = await getTimezoneForDate(selectedClassName(), selectedProjectId(), dateNorm);
                if (tz) timezoneVal = tz;
              } catch (tzErr) {
                warn('[UploadDatasets] Markwind: timezone fetch failed for', dateNorm, tzErr);
              }
              try {
                const payload = {
                  project_id: selectedProjectId()!.toString(),
                  class_name: selectedClassName(),
                  script_name: '5_markwind.py',
                  parameters: {
                    class_name: selectedClassName(),
                    project_id: selectedProjectId()!,
                    date: dateNorm,
                    timezone: timezoneVal
                  }
                };
                let response_json = await postData(apiEndpoints.python.execute_script, payload) as { success?: boolean; status?: number; data?: { process_already_running?: boolean; running_processes?: Array<{ process_id: string; script_name?: string; class_name?: string; started_at?: string }>; process_id?: string }; process_id?: string };

                if (response_json?.data?.process_already_running || response_json?.status === 409) {
                  const runningProcesses = response_json?.data?.running_processes || [];
                  if (runningProcesses.length > 0) {
                    debug('[UploadDatasets] Markwind (training): process already running, waiting then retrying for date', dateNorm);
                    const maxWaitTime = 3600000;
                    const pollInterval = 5000;
                    const startWaitTime = Date.now();
                    let allProcessesCompleted = false;
                    while (!allProcessesCompleted && (Date.now() - startWaitTime) < maxWaitTime) {
                      await new Promise(resolve => setTimeout(resolve, pollInterval));
                      try {
                        const runningCheck = await getData(apiEndpoints.python.running_processes);
                        if (runningCheck?.success && runningCheck?.data) {
                          const stillRunning = (runningCheck.data as { processes?: Array<{ process_id: string }> }).processes || [];
                          const stillRunningIds = new Set(stillRunning.map((p: { process_id: string }) => p.process_id));
                          const waitingForProcesses = runningProcesses.map((p: { process_id: string }) => p.process_id);
                          allProcessesCompleted = !waitingForProcesses.some((pid: string) => stillRunningIds.has(pid));
                          if (!allProcessesCompleted) {
                            const elapsed = Math.round((Date.now() - startWaitTime) / 1000);
                            debug('[UploadDatasets] Markwind (training): still waiting...', dateNorm, `${elapsed}s`);
                          }
                        } else {
                          allProcessesCompleted = true;
                        }
                      } catch (pollErr) {
                        warn('[UploadDatasets] Markwind (training): error checking running processes', dateNorm, pollErr);
                      }
                    }
                    if (!allProcessesCompleted) {
                      warn('[UploadDatasets] Markwind (training): timeout waiting, skipping date', dateNorm);
                    } else {
                      response_json = await postData(apiEndpoints.python.execute_script, payload) as typeof response_json;
                      if (response_json?.data?.process_already_running || response_json?.status === 409) {
                        warn('[UploadDatasets] Markwind (training): still 409 after wait, skipping date', dateNorm);
                        response_json = { success: false };
                      }
                    }
                  } else {
                    response_json = { success: false };
                  }
                }

                if (!response_json?.success) {
                  warn('[UploadDatasets] Markwind (training): script start failed or skipped for date', dateNorm, (response_json as { message?: string })?.message);
                } else {
                  const pid = (response_json as { process_id?: string }).process_id ?? response_json?.data?.process_id;
                  if (pid) {
                    processStore.startProcess(pid, 'script_execution');
                    processStore.setShowToast(pid, false);
                    await waitForProcessCompletion(pid);
                    const dateStr = `${dateNorm.slice(0, 4)}-${dateNorm.slice(4, 6)}-${dateNorm.slice(6, 8)}`;
                    const cn = selectedClassName();
                    if (cn) {
                      unifiedDataStore.storeObject(`markwind_${cn}_${dateStr}`, null).catch(() => {});
                    }
                  } else {
                    warn('[UploadDatasets] Markwind (training): no process_id for date', dateNorm);
                  }
                }
              } catch (err) {
                warn('[UploadDatasets] Markwind (training) failed for date', dateNorm, err);
              }
              if (i < uniqueDatesTraining.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
          }
        }

        // Execute processing scripts
        if (allCreatedDatasetIds.length > 0) {
          setCurrentStep(3);
          setUploadProgress({ current: 0, total: allCreatedDatasetIds.length });
          setCurrentStatus(`Processing ${allCreatedDatasetIds.length} dataset(s)...`);
          const datasetTasks = Array.from(datasetInfoMap.entries()).map(([datasetId, info]: [number, any]) => ({
            datasetId,
            date: info.date,
            source_name: info.source_name
          }));

          const processIds = await processDatasetsInParallel(datasetTasks, 2);
          setAllProcessIds(processIds);
          
          if (processIds.length === 0 && datasetTasks.length > 0) {
            // Some or all scripts may have timed out during start, but they may still be running
            warn('[UploadDatasets] No process IDs returned for single-file upload, but scripts may still be running:', {
              totalTasks: datasetTasks.length,
              note: 'Upload will continue - check server logs or wait for completion'
            });
          }
        }

        setUploadSuccess(true);
        setShowWaiting(false);
        return;
      }

      // ========== PHASE 0: Group files by date-formatted folders (Race Day) ==========
      setCurrentStatus("Analyzing folder structure...");
      // Force status update to be visible
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const folderGroups = groupFilesByDateFolders(files());
      let folderEntries = Array.from(folderGroups.entries());
      
      // Sort folder entries by date (oldest to newest)
      // Date-formatted folders first (sorted by date), then "ungrouped" at the end
      folderEntries.sort(([dateA, filesA], [dateB, filesB]) => {
        // Put "ungrouped" at the end
        if (dateA === 'ungrouped' && dateB !== 'ungrouped') return 1;
        if (dateB === 'ungrouped' && dateA !== 'ungrouped') return -1;
        if (dateA === 'ungrouped' && dateB === 'ungrouped') return 0;
        
        // Sort dates (YYYY-MM-DD format sorts correctly as strings)
        return dateA.localeCompare(dateB);
      });
      
      debug('[UploadDatasets] Files grouped by date folders (sorted oldest to newest):', {
        totalFolders: folderGroups.size,
        folderGroups: folderEntries.map(([date, files]) => ({
          date,
          fileCount: files.length,
          fileNames: files.map(f => f.name)
        }))
      });

      if (folderGroups.size === 0) {
        throw new Error('No files to upload');
      }

      // ========== PHASE 1: Load sources ==========
      setCurrentStatus("Loading available sources...");
      
      // Get all sources for matching filenames
      const sourcesResponse = await getData(
        `${apiEndpoints.app.sources}?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}`
      );

      if (!sourcesResponse.success || !sourcesResponse.data || !Array.isArray(sourcesResponse.data)) {
        throw new Error('Failed to load sources');
      }

      const allSources = sourcesResponse.data;
      const isAllMode = true; // Always use "ALL" mode for InfluxDB uploads
      const sourceNameToUse = '';

      // ========== PHASE 1: Upload Files Only ==========
      setCurrentStatus("Files are uploading, please be patient...");
      
      // Process each folder group separately - UPLOAD ONLY (skip normalization)
      const allFileUploadResults: any[] = []; // Collect all file upload results
      const allFilesBySourceMaps: Map<any, any>[] = []; // Store filesBySource for each folder
      const allDatesBySourceArrays: Map<any, any[]>[] = []; // Store datesBySourceArray for each folder
      let totalFilesProcessed = 0;

      for (let folderIndex = 0; folderIndex < folderEntries.length; folderIndex++) {
        const [folderDate, folderFiles] = folderEntries[folderIndex];
        
        const progressPercent = Math.round(((folderIndex + 1) / folderEntries.length) * 100);
        setCurrentStatus(`Uploading files from folder ${folderIndex + 1} of ${folderEntries.length} (${progressPercent}%)...`);

        try {
          // Process this folder group with skipNormalization=true
          const { filesBySource, datesBySourceArray, fileUploadResults } = await processFolderGroup(
            folderDate,
            folderFiles,
            allSources,
            isAllMode,
            sourceNameToUse,
            true // skipNormalization = true
          );

          // Collect file upload results
          allFileUploadResults.push(...fileUploadResults);
          allFilesBySourceMaps.push(filesBySource);
          allDatesBySourceArrays.push(datesBySourceArray);
          // Only count XML files
          totalFilesProcessed += folderFiles.filter(f => isXmlFile(f.name)).length;
        } catch (error: any) {
          // Log error but continue with next folder
          const errorMessage = error?.message || String(error);
          const isCriticalError = errorMessage.includes('Unauthorized') ||
                                 errorMessage.includes('Forbidden') ||
                                 errorMessage.includes('Network') ||
                                 errorMessage.includes('Failed to fetch') ||
                                 error?.status === 401 ||
                                 error?.status === 403;
          
          if (isCriticalError) {
            // Re-throw critical errors that would affect all folders
            logError('[UploadDatasets] Critical error processing folder - stopping upload:', {
              folderDate,
              error: error
            });
            throw error;
          } else {
            // Log error but continue with next folder
            logError('[UploadDatasets] Error processing folder - continuing with next folder:', {
              folderDate,
              error: error
            });
            setCurrentStatus(`Error processing folder ${folderDate} - continuing with next folder...`);
            // Continue with next folder - initialize empty results for this folder
            allFilesBySourceMaps.push(new Map());
            allDatesBySourceArrays.push(new Map());
            // Don't increment totalFilesProcessed since this folder failed
          }
        }

      }

      // ========== PHASE 2: Processing (Background) ==========
      // All files uploaded - show message and continue processing with modal open
      setCurrentStatus("Files uploaded successfully. Processing will continue in the background...");
      
      // Mark that processing has started - show exit buttons
      setIsProcessing(true);
      
      // Save targets for each unique date that will have datasets created
      const uniqueDates = new Set<string>();
      for (const datesBySourceArray of allDatesBySourceArrays) {
        for (const dates of datesBySourceArray.values()) {
          if (Array.isArray(dates)) {
            dates.forEach(date => uniqueDates.add(date));
          }
        }
      }
      
      // Also collect dates from extracted dates and input date
      if (extractedDates().size > 0) {
        extractedDates().forEach(date => uniqueDates.add(date));
      }
      if (inputDate()) {
        uniqueDates.add(inputDate());
      }
      
      // Save targets for each unique date
      if (uniqueDates.size > 0 && selectedTarget()) {
        setCurrentStatus("Saving targets...");
        const datesArray = Array.from(uniqueDates).sort();
        for (const date of datesArray) {
          try {
            await saveTargetsToProject(date);
            debug(`[UploadDatasets] Target saved for date ${date}`);
          } catch (error) {
            warn(`[UploadDatasets] Failed to save target for date ${date}, continuing:`, error);
          }
        }
      }
      
      // Save configuration for each unique date (race day mode)
      if (uniqueDates.size > 0 && name() && wingCode() && dbCode() && rudCode() && crewCount() && headsailCode()) {
        setCurrentStatus("Saving configuration...");
        const datesArray = Array.from(uniqueDates).sort();
        for (const date of datesArray) {
          try {
            const configSaved = await saveConfigurationToProject(date);
            if (configSaved) {
              debug(`[UploadDatasets] Configuration saved for date ${date}`);
            } else {
              warn(`[UploadDatasets] Failed to save configuration for date ${date}, continuing`);
            }
          } catch (error) {
            warn(`[UploadDatasets] Error saving configuration for date ${date}, continuing:`, error);
          }
        }
      }
      
      // Normalization is now handled in processFolderGroup, so we can proceed directly to dataset creation
      // Note: Normalization happens in processFolderGroup and sets step 2, but we're past that phase now
      // We'll set step 3 when processing starts, but for now we're in dataset creation (between step 2 and 3)
      debug('[UploadDatasets] Starting dataset creation');
      setCurrentStatus("Creating datasets...");
          
        // Now create datasets and run scripts (reuse existing logic)
        const allCreatedDatasetIds = [];
        const allDatasetInfoMaps: Map<number, any>[] = [];
        // Track date and source_id for each dataset for channel population
        const datasetDateSourceMap = new Map<number, {date: string, source_id: number}>();
        
        // Process each folder group for dataset creation
        for (let folderIndex = 0; folderIndex < folderEntries.length; folderIndex++) {
            const [folderDate, folderFiles] = folderEntries[folderIndex];
            const filesBySource = allFilesBySourceMaps[folderIndex];
            const datesBySourceArray = allDatesBySourceArrays[folderIndex];

        // Store dataset info for script execution: Map<dataset_id, {date, source_name}>
        const datasetInfoMap = new Map();

        // CRITICAL: Validate datesBySourceArray before proceeding
        if (!datesBySourceArray || datesBySourceArray.size === 0) {
          warn('[UploadDatasets] WARNING: datesBySourceArray is empty or undefined for folder:', {
            folderDate,
            folderIndex,
            datesBySourceArrayType: typeof datesBySourceArray,
            datesBySourceArraySize: datesBySourceArray?.size,
            filesBySourceSize: filesBySource?.size,
            note: 'This means no datasets will be created for this folder. Check if normalization succeeded.'
          });
          
          // Log what sources were available in filesBySource
          if (filesBySource && filesBySource.size > 0) {
            const availableSources = Array.from(filesBySource.entries()).map(([id, info]) => ({
              sourceId: id,
              sourceName: info?.source?.source_name || 'unknown'
            }));
            warn('[UploadDatasets] Available sources in filesBySource (but not in datesBySourceArray):', availableSources);
          }
          
          // Continue to next folder instead of skipping dataset creation entirely
          // This allows other folders to still create datasets
          continue;
        }

        // Create datasets for each date-source combination in this folder
        // IMPORTANT: Only sources that successfully normalized InfluxDB data should be in datesBySourceArray
        const sourcesToCreateDatasets = Array.from(datesBySourceArray.entries()).map(([id, dates]) => {
          const sourceInfo = filesBySource.get(id);
          return {
            sourceId: id,
            sourceName: sourceInfo?.source?.source_name || 'unknown',
            dates: dates,
            uniqueDates: [...new Set(dates)]
          };
        });
        
        debug('[UploadDatasets] Starting dataset creation for folder:', {
          folderDate,
          datesBySourceArraySize: datesBySourceArray.size,
          sourcesToCreateDatasets: sourcesToCreateDatasets,
          warning: 'Only sources with successfully normalized InfluxDB data should appear here'
        });
        
        // Final validation: Log if any unexpected sources are about to get datasets
        for (const { sourceId, sourceName } of sourcesToCreateDatasets) {
          if (!sourceName || sourceName === 'unknown') {
            warn('[UploadDatasets] WARNING: About to create dataset for source with unknown name:', {
              sourceId,
              folderDate
            });
          }
        }

        // Retrieve latest target_id for non-polar targets (isPolar=0)
        let latestTargetId = null;
        try {
          debug('[UploadDatasets] Retrieving latest targets...');
          const targetResponse = await getData(
            `${apiEndpoints.app.targets}/latest?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&isPolar=0`
          );
          
          if (targetResponse.success && targetResponse.data && Array.isArray(targetResponse.data) && targetResponse.data.length > 0) {
            latestTargetId = targetResponse.data[0].target_id;
            debug('[UploadDatasets] Retrieved latest target_id:', latestTargetId);
          } else {
            debug('[UploadDatasets] No latest targets found');
          }
        } catch (error) {
          logError('[UploadDatasets] Error retrieving latest targets:', error);
          // Continue without target_id if retrieval fails
        }
        
        // Validate that we have entries to process
        if (datesBySourceArray.size === 0) {
          warn('[UploadDatasets] datesBySourceArray is empty, skipping dataset creation for folder:', {
            folderDate,
            folderIndex
          });
          continue;
        }

        for (const [sourceId, dates] of datesBySourceArray.entries()) {
          // Validate sourceId and dates
          if (!sourceId || !dates || !Array.isArray(dates) || dates.length === 0) {
            warn('[UploadDatasets] Invalid entry in datesBySourceArray, skipping:', {
              folderDate,
              sourceId,
              dates,
              datesType: typeof dates,
              isArray: Array.isArray(dates)
            });
            continue;
          }

          const sourceInfo = filesBySource.get(sourceId);
          if (!sourceInfo || !sourceInfo.source) {
            warn('[UploadDatasets] Source not found in filesBySource, skipping dataset creation:', {
              folderDate,
              sourceId,
              availableSourceIds: Array.from(filesBySource.keys())
            });
            continue;
          }

          const { source } = sourceInfo;
          const uniqueSourceDates = [...new Set(dates)].sort(); // Sort dates (oldest to newest)
          
          debug('[UploadDatasets] Processing source for dataset creation:', {
            folderDate,
            sourceId: sourceId,
            sourceName: source.source_name,
            dates: dates,
            uniqueSourceDates: uniqueSourceDates
          });
          
          for (let i = 0; i < uniqueSourceDates.length; i++) {
            const date = uniqueSourceDates[i];
            const year = new Date(date).getFullYear();

            setCurrentStatus(`Creating dataset ${allCreatedDatasetIds.length + 1} for ${source.source_name} (folder ${folderDate})...`);

            // Create dataset first - day number will be set in prepopulateDatasetInfo after dataset exists
            const currentTimezone = timezone() || 'Europe/Madrid';
            debug('[UploadDatasets] Timezone value when creating dataset:', { 
              timezoneSignal: timezone(), 
              currentTimezone, 
              willUse: currentTimezone 
            });
            
            const datasetPayload = {
                class_name: selectedClassName(),
                project_id: selectedProjectId(),
                source_id: sourceId,
                date: date,
                year_name: year, 
                event_name: eventName(),
                report_name: 'NA', // Will be updated in prepopulateDatasetInfo
                description: 'NA',
                timezone: currentTimezone, // Use selected timezone or default
                tags: JSON.stringify({ isUploaded: true, Race_type: 'INSHORE' }),
            };
            
            debug('[UploadDatasets] Creating dataset with payload:', datasetPayload);
            
            const response = await postData(`${apiEndpoints.app.datasets}`, datasetPayload);

            if (!response.success) {
              logError('Dataset creation failed:', response);
              throw new Error(`Failed to add dataset: ${response.message || response.error || 'Unknown error'}`);
            }

            const datasetId = response.data;
            debug('[UploadDatasets] Dataset created successfully:', { datasetId, sourceId, sourceName: source.source_name, date, folderDate });
            
            // Update dataset date_modified since normalization may have run before dataset creation
            // This ensures the dataset reflects when the data was actually processed
            // Use admin endpoint since date-modified is only available in admin server
            try {
              await putData(`${apiEndpoints.admin.datasets}/date-modified`, {
                class_name: selectedClassName(),
                project_id: selectedProjectId(),
                dataset_id: datasetId
              });
              debug('[UploadDatasets] Dataset date_modified updated after creation:', { datasetId });
            } catch (error) {
              warn('[UploadDatasets] Failed to update dataset date_modified after creation (non-critical):', { datasetId, error });
            }
            
            if (datasetId > 0 && latestTargetId != null) {
              await postData(
                `${apiEndpoints.app.datasets}/target`,
                {
                  class_name: selectedClassName(),
                  project_id: selectedProjectId(),
                  dataset_id: datasetId,
                  target_id: latestTargetId,
                  tack: 'BOTH'
                }
              );
            }

            allCreatedDatasetIds.push(datasetId);
            // Track date and source_id for channel population
            datasetDateSourceMap.set(datasetId, { date, source_id: sourceId });
            setSelectedDatasetId(datasetId);
            
            // Query day number immediately after creating this dataset (before creating the next one)
            // This ensures each dataset gets the correct sequential day number
            let dayNumber = null;
            try {
              const dayUrl = `${apiEndpoints.app.datasets}/day?class_name=${selectedClassName()}&project_id=${selectedProjectId()}&source_id=${sourceId}&event_name=${encodeURIComponent(eventName())}`;
              debug('[UploadDatasets] Fetching day number immediately after dataset creation:', dayUrl);
              
              const dayResponse = await getData(dayUrl);
              debug('[UploadDatasets] Day number response after creation:', { 
                datasetId, 
                success: dayResponse.success, 
                data: dayResponse.data,
                dataType: typeof dayResponse.data
              });
              
              if (dayResponse.success && dayResponse.data !== null && dayResponse.data !== undefined) {
                const dayNumberRaw = dayResponse.data;
                dayNumber = typeof dayNumberRaw === 'string' ? parseInt(dayNumberRaw, 10) : dayNumberRaw;
                if (isNaN(dayNumber) || dayNumber <= 0) {
                  dayNumber = null;
                  warn('[UploadDatasets] Invalid day number after creation:', { datasetId, dayNumberRaw });
                }
              }
            } catch (error) {
              warn('[UploadDatasets] Error fetching day number after dataset creation:', error);
            }
            
            // Store dataset info for later script execution and prepopulation
            datasetInfoMap.set(datasetId, {
              date: date,
              source_name: source.source_name,
              source_id: sourceId,
              dayNumber: dayNumber // Store the day number we just fetched
            });
            
            await logActivity(
              selectedProjectId() || 0, 
              datasetId, 
              'UploadDatasets.tsx', 
              'Dataset Created Successfully', 
              {
                date: date,
                year: year,
                eventName: eventName(),
                sourceId: sourceId,
                sourceName: source.source_name,
                folderDate
              }
            );
          }
        }
        
        debug('[UploadDatasets] Dataset creation complete for folder:', {
          folderDate,
          totalDatasetsCreated: datasetInfoMap.size,
          datasetIds: Array.from(datasetInfoMap.keys())
        });

          // Store dataset info map for this folder
          allDatasetInfoMaps.push(datasetInfoMap);

          // Pre-populate Dataset Info for this folder
          setCurrentStatus(`Pre-populating dataset information for folder ${folderIndex + 1} of ${folderEntries.length}...`);
          const folderDatasetIds = Array.from(datasetInfoMap.keys());
          await prepopulateDatasetInfo(folderDatasetIds, datasetInfoMap);
        }

        debug('[UploadDatasets] All folders processed:', {
          totalFolders: folderEntries.length,
          totalDatasetsCreated: allCreatedDatasetIds.length,
          totalFilesProcessed: totalFilesProcessed,
          datasetIds: allCreatedDatasetIds,
          allDatesBySourceArraysSizes: allDatesBySourceArrays.map((arr, idx) => ({
            folderIndex: idx,
            folderDate: folderEntries[idx]?.[0] || 'unknown',
            size: arr?.size || 0,
            entries: arr ? Array.from(arr.entries()).map(([id, dates]) => ({
              sourceId: id,
              dates: dates,
              datesCount: Array.isArray(dates) ? dates.length : 0
            })) : []
          }))
        });

        // CRITICAL: Warn if no datasets were created despite normalization
        if (allCreatedDatasetIds.length === 0 && totalFilesProcessed > 0) {
          warn('[UploadDatasets] CRITICAL: No datasets were created despite processing files!', {
            totalFilesProcessed,
            totalFolders: folderEntries.length,
            allDatesBySourceArraysSizes: allDatesBySourceArrays.map((arr, idx) => ({
              folderIndex: idx,
              folderDate: folderEntries[idx]?.[0] || 'unknown',
              size: arr?.size || 0
            })),
            note: 'This indicates normalization may have succeeded but datesBySourceArray was empty. Check normalization logs.'
          });
        }

        // Log successful completion of all datasets
        if (allCreatedDatasetIds.length > 0) {
          await logActivity(
            selectedProjectId() || 0, 
            allCreatedDatasetIds[allCreatedDatasetIds.length - 1] || 0, 
            'UploadDatasets.tsx', 
            'All Datasets Created Successfully', 
            {
              datasetCount: allCreatedDatasetIds.length,
              folderCount: folderEntries.length,
              createdDatasetIds: allCreatedDatasetIds,
              eventName: eventName()
            }
          );
        }

        // Combine all dataset info maps into one for processing
        const combinedDatasetInfoMap = new Map();
        for (const map of allDatasetInfoMaps) {
          for (const [datasetId, info] of map.entries()) {
            combinedDatasetInfoMap.set(datasetId, info);
          }
        }

        // Execute Processing Script (only for multi-file uploads)
        debug('[UploadDatasets] Script execution check:', {
          totalFilesProcessed: totalFilesProcessed,
          allCreatedDatasetIds: allCreatedDatasetIds.length,
          willExecuteScript: allCreatedDatasetIds.length > 0
        });
        
        if (allCreatedDatasetIds.length > 0) {
          debug('[UploadDatasets] Starting script execution for multi-file upload');
          
          // Step 3: Processing Phase - count only datasets (exclude XML-only datasets)
          // IMPORTANT: Set step 3 BEFORE starting processing to ensure UI shows correct step
          // This must happen before processDatasetsInParallel is called
          const processingTotal = allCreatedDatasetIds.length;
          setCurrentStep(3);
          setUploadProgress({ current: 0, total: processingTotal });
          setCurrentStatus("Executing processing scripts...");
          
          // Force UI update to show step 3 before processing starts
          await new Promise(resolve => setTimeout(resolve, 150));
          
          // Enable batch suppression mode BEFORE executing scripts
          processStore.enableBatchSuppressMode();
          debug('[UploadDatasets] Batch suppress mode enabled for script executions');
          
          // Collect all dataset tasks and sort by source name, then by date
          const datasetTasks: Array<{ datasetId: number, date: string, source_name: string }> = [];
          
          for (const datasetId of allCreatedDatasetIds) {
            const datasetInfo = combinedDatasetInfoMap.get(datasetId);
            if (datasetInfo) {
              datasetTasks.push({
                datasetId,
                date: datasetInfo.date,
                source_name: datasetInfo.source_name
              });
            }
          }
          
          // Sort tasks by source name, then by date to maintain order within batches
          datasetTasks.sort((a, b) => {
            // First sort by source name
            const sourceCompare = a.source_name.localeCompare(b.source_name);
            if (sourceCompare !== 0) return sourceCompare;
            // Then sort by date (oldest first)
            return a.date.localeCompare(b.date);
          });
          
          // Run 5_markwind.py for each unique date (before process/execute) so markwind is available for prestart/map
          if (selectedClassName() === 'gp50' && allCreatedDatasetIds.length > 0) {
            const uniqueDates = [...new Set(
              [...combinedDatasetInfoMap.values()].map((d: { date: string }) => (d.date || '').replace(/[-/]/g, '').slice(0, 8))
            )].filter(Boolean);
            debug('[UploadDatasets] Race day: markwind check', { uniqueDates, datasetCount: allCreatedDatasetIds.length, class: selectedClassName() });
            if (uniqueDates.length === 0) {
              warn('[UploadDatasets] Markwind skipped: no unique dates from combinedDatasetInfoMap (dates may be missing from dataset info)');
            }
            if (uniqueDates.length > 0) {
              for (let i = 0; i < uniqueDates.length; i++) {
                const dateNorm = uniqueDates[i];
                setCurrentStatus(`Building markwind (${i + 1}/${uniqueDates.length}): ${dateNorm}...`);
                let timezone = 'Europe/Madrid';
                try {
                  const tz = await getTimezoneForDate(selectedClassName(), selectedProjectId(), dateNorm);
                  if (tz) timezone = tz;
                } catch (tzErr) {
                  warn('[UploadDatasets] Markwind: timezone fetch failed for', dateNorm, tzErr);
                }
                try {
                  const payload = {
                    project_id: selectedProjectId()!.toString(),
                    class_name: selectedClassName(),
                    script_name: '5_markwind.py',
                    parameters: {
                      class_name: selectedClassName(),
                      project_id: selectedProjectId()!,
                      date: dateNorm,
                      timezone
                    }
                  };
                  let response_json = await postData(apiEndpoints.python.execute_script, payload) as { success?: boolean; status?: number; data?: { process_already_running?: boolean; running_processes?: Array<{ process_id: string; script_name?: string; class_name?: string; started_at?: string }>; process_id?: string }; process_id?: string };

                  // Handle 409 "process already running": wait for running process(es) then retry once (match Admin)
                  if (response_json?.data?.process_already_running || response_json?.status === 409) {
                    const runningProcesses = response_json?.data?.running_processes || [];
                    if (runningProcesses.length > 0) {
                      debug('[UploadDatasets] Markwind: process already running, waiting then retrying for date', dateNorm);
                      const maxWaitTime = 3600000; // 1 hour
                      const pollInterval = 5000; // 5 seconds
                      const startWaitTime = Date.now();
                      let allProcessesCompleted = false;
                      while (!allProcessesCompleted && (Date.now() - startWaitTime) < maxWaitTime) {
                        await new Promise(resolve => setTimeout(resolve, pollInterval));
                        try {
                          const runningCheck = await getData(apiEndpoints.python.running_processes);
                          if (runningCheck?.success && runningCheck?.data) {
                            const stillRunning = (runningCheck.data as { processes?: Array<{ process_id: string }> }).processes || [];
                            const stillRunningIds = new Set(stillRunning.map((p: { process_id: string }) => p.process_id));
                            const waitingForProcesses = runningProcesses.map((p: { process_id: string }) => p.process_id);
                            allProcessesCompleted = !waitingForProcesses.some((pid: string) => stillRunningIds.has(pid));
                            if (!allProcessesCompleted) {
                              const elapsed = Math.round((Date.now() - startWaitTime) / 1000);
                              debug('[UploadDatasets] Markwind: still waiting for processes...', dateNorm, `${elapsed}s`);
                            }
                          } else {
                            allProcessesCompleted = true;
                          }
                        } catch (pollErr) {
                          warn('[UploadDatasets] Markwind: error checking running processes', dateNorm, pollErr);
                        }
                      }
                      if (!allProcessesCompleted) {
                        warn('[UploadDatasets] Markwind: timeout waiting for running processes, skipping date', dateNorm);
                      } else {
                        response_json = await postData(apiEndpoints.python.execute_script, payload) as typeof response_json;
                        if (response_json?.data?.process_already_running || response_json?.status === 409) {
                          warn('[UploadDatasets] Markwind: still 409 after wait, skipping date', dateNorm);
                          response_json = { success: false };
                        }
                      }
                    } else {
                      response_json = { success: false };
                    }
                  }

                  if (!response_json?.success) {
                    warn('[UploadDatasets] Markwind: script start failed or skipped for date', dateNorm, (response_json as { message?: string })?.message);
                    continue;
                  }
                  const pid = (response_json as { process_id?: string }).process_id ?? response_json?.data?.process_id;
                  if (!pid) {
                    warn('[UploadDatasets] Markwind: no process_id returned for date', dateNorm);
                    continue;
                  }
                  processStore.startProcess(pid, 'script_execution');
                  processStore.setShowToast(pid, false);
                  await waitForProcessCompletion(pid);
                  // Invalidate markwind cache only when we actually ran and completed (match Admin)
                  const dateStr = `${dateNorm.slice(0, 4)}-${dateNorm.slice(4, 6)}-${dateNorm.slice(6, 8)}`;
                  const cn = selectedClassName();
                  if (cn) {
                    unifiedDataStore.storeObject(`markwind_${cn}_${dateStr}`, null).catch(() => {});
                  }
                } catch (err) {
                  warn('[UploadDatasets] Markwind failed for date', dateNorm, err);
                }
                if (i < uniqueDates.length - 1) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                }
              }
            }
          }
          
          // Process datasets in parallel batches to prevent interruptions
          const processIdsArray = await processDatasetsInParallel(datasetTasks, 2);
          
          setAllProcessIds(processIdsArray);
          
          if (processIdsArray.length > 0) {
            debug('[UploadDatasets] Script executions started:', processIdsArray);
            setCurrentStatus(`Processing started for ${processIdsArray.length} dataset(s) - scripts running in background`);
          } else if (datasetTasks.length > 0) {
            // Some or all scripts may have timed out during start, but they may still be running
            warn('[UploadDatasets] No process IDs returned, but scripts may still be running on server:', {
              totalTasks: datasetTasks.length,
              note: 'Upload will continue - check server logs or wait for completion'
            });
            setCurrentStatus(`Processing may be running in background - check server for status`);
          }
          
          // Wait for database to commit race events before updating descriptions
          // Race events are created by the processing scripts and need time to be committed
          if (allCreatedDatasetIds.length > 0) {
            debug('[UploadDatasets] Waiting for race events to be committed to database...');
            setCurrentStatus("Waiting for database to finalize race events...");
            await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay for database commits
          }
          
          // Update descriptions after processing
          if (allCreatedDatasetIds.length > 0) {
            debug('[UploadDatasets] Updating descriptions after processing complete...');
            setCurrentStatus("Updating dataset descriptions...");
            try {
              await updateDescriptionsAfterProcessing(allCreatedDatasetIds, combinedDatasetInfoMap);
              debug('[UploadDatasets] Description update complete');
            } catch (error) {
              warn('[UploadDatasets] Error during description update:', error);
            }
          }
          
          // Wait for late-arriving messages
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Step 4: Wrapping up - run 4_cleanup.py for each unique date (day-level VMG + race position)
          if (selectedClassName() === 'gp50' && allCreatedDatasetIds.length > 0) {
            const uniqueDates = [...new Set(
              [...combinedDatasetInfoMap.values()].map((d: { date: string }) => (d.date || '').replace(/[-/]/g, '').slice(0, 8))
            )].filter(Boolean);
            if (uniqueDates.length > 0) {
              setCurrentStep(4);
              setCurrentStatus("Wrapping up...");
              await new Promise(resolve => setTimeout(resolve, 150));
              for (let i = 0; i < uniqueDates.length; i++) {
                const dateNorm = uniqueDates[i];
                setCurrentStatus(`Wrapping up (${i + 1}/${uniqueDates.length}): day ${dateNorm}...`);
                try {
                  const payload = {
                    project_id: selectedProjectId()!.toString(),
                    class_name: selectedClassName(),
                    script_name: '4_cleanup.py',
                    parameters: {
                      class_name: selectedClassName(),
                      project_id: selectedProjectId()!.toString(),
                      date: dateNorm,
                      verbose: false
                    }
                  };
                  const response_json = await postData(apiEndpoints.python.execute_script, payload);
                  const pid = (response_json as { process_id?: string; data?: { process_id?: string } })?.process_id
                    ?? (response_json as { data?: { process_id?: string } })?.data?.process_id;
                  if (pid) {
                    processStore.startProcess(pid, 'script_execution');
                    processStore.setShowToast(pid, false);
                    await waitForProcessCompletion(pid);
                  }
                } catch (err) {
                  warn('[UploadDatasets] 4_cleanup failed for date', dateNorm, err);
                }
              }
            }
          }
        }
        
        // Clear suppressed process IDs
        processStore.clearSuppressedProcessIds();
        
        // Verify datasets are visible and show completion toast
        setCurrentStatus("Verifying datasets...");
        const visibleDatasets = await verifyDatasetsVisible(allCreatedDatasetIds);
        
        // Populate channels for unique dates after upload completes (only for gp50)
        // Uses actual uploaded sources and dates from datasetDateSourceMap (not hardcoded values)
        if (selectedClassName() === 'gp50' && allCreatedDatasetIds.length > 0 && datasetDateSourceMap.size > 0) {
          try {
            setCurrentStatus("Populating channels...");
            debug('[UploadDatasets] Starting channel population for uploaded datasets');
            
            // Extract unique date+source_id combinations from tracked datasets
            // These are the actual sources and dates that were uploaded, not hardcoded values
            const datesToPopulate: Array<{date: string, source_id: number}> = [];
            const processedDateKeys = new Set<string>();
            
            for (const [datasetId, {date, source_id}] of datasetDateSourceMap.entries()) {
              // Normalize date format (remove dashes)
              const normalizedDate = date.replace(/[-/]/g, '');
              const dateKey = `${normalizedDate}_${source_id}`;
              
              // Only add unique date+source_id combinations
              if (!processedDateKeys.has(dateKey)) {
                processedDateKeys.add(dateKey);
                datesToPopulate.push({ date: normalizedDate, source_id });
              }
            }
            
            // Call populate channels endpoint for unique dates
            // The backend will use these actual source_ids and dates to discover channels
            if (datesToPopulate.length > 0) {
              debug(`[UploadDatasets] Populating channels for ${datesToPopulate.length} unique date+source combinations:`, datesToPopulate);
              const populateResponse = await postData(
                `${apiEndpoints.app.datasets}/channels/populate`,
                {
                  class_name: selectedClassName(),
                  project_id: selectedProjectId(),
                  dates: datesToPopulate
                }
              );
              
              if (populateResponse.success) {
                debug('[UploadDatasets] Channel population completed:', populateResponse.data);
              } else {
                warn('[UploadDatasets] Channel population failed:', populateResponse.message);
              }
            }
          } catch (error) {
            // Log error but don't fail upload - channel population is non-critical
            warn('[UploadDatasets] Error during channel population (non-blocking):', error);
          }
        }
        
        if (allCreatedDatasetIds.length > 0 || totalFilesProcessed > 0) {
          if (visibleDatasets.length === allCreatedDatasetIds.length) {
            const toastMessage = totalFilesProcessed > 1 
              ? `Upload complete: ${totalFilesProcessed} files processed, ${allCreatedDatasetIds.length} dataset(s) created`
              : `Upload complete: ${totalFilesProcessed} file processed, ${allCreatedDatasetIds.length} dataset(s) created`;
            
            toastStore.showToast('success', toastMessage, 'All files have been uploaded and processed successfully');
          } else {
            const missingCount = allCreatedDatasetIds.length - visibleDatasets.length;
            const toastMessage = `Upload processing complete, but ${missingCount} dataset(s) not yet visible. Please refresh the page.`;
            toastStore.showToast('warning', 'Processing Complete', toastMessage);
          }
        }
        
        // All processing complete - close modal and show success
        setCurrentStatus("Processing complete!");
        setUploadSuccess(true);
        setShowWaiting(false);
        
    } catch (error) {
      logError('Error uploading files:', error);
      setShowWaiting(false);
      setUploadFailed(true);
      setErrorMessage(`Upload error: ${error.message}`);
      // Stay on UploadDatasets page - don't navigate on error
      // Files are preserved so user can retry
    }
  };

  // Helper function to verify datasets are visible by fetching them
  const verifyDatasetsVisible = async (datasetIds) => {
    const visibleDatasets = [];
    
    debug('[UploadDatasets] verifyDatasetsVisible called:', { datasetCount: datasetIds.length });
    
    // Check each dataset with retries (datasets may take a moment to become visible)
    for (let i = 0; i < datasetIds.length; i++) {
      const datasetId = datasetIds[i];
      let isVisible = false;
      const maxRetries = 5;
      const retryDelay = 1000; // 1 second
      
      for (let retry = 0; retry < maxRetries; retry++) {
        try {
          const datasetResponse = await getData(
            `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
          );
          
          if (datasetResponse.success && datasetResponse.data) {
            isVisible = true;
            debug('[UploadDatasets] Dataset is visible:', { datasetId, retry });
            break;
          }
        } catch (error) {
          debug('[UploadDatasets] Error checking dataset visibility:', { datasetId, retry, error });
        }
        
        // Wait before retrying (except on last retry)
        if (retry < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
      
      if (isVisible) {
        visibleDatasets.push(datasetId);
      } else {
        warn('[UploadDatasets] Dataset not visible after retries:', { datasetId, maxRetries });
      }
    }
    
    debug('[UploadDatasets] verifyDatasetsVisible complete:', {
      total: datasetIds.length,
      visible: visibleDatasets.length,
      visibleIds: visibleDatasets
    });
    
    return visibleDatasets;
  };

  // Helper function to update descriptions after processing completes
  // Race events are created by the processing scripts, so descriptions are only available after processing
  const updateDescriptionsAfterProcessing = async (datasetIds, datasetInfoMap) => {
    debug('[UploadDatasets] updateDescriptionsAfterProcessing called:', { 
      datasetCount: datasetIds.length, 
      datasetIds: datasetIds 
    });
    
    for (let i = 0; i < datasetIds.length; i++) {
      const datasetId = datasetIds[i];
      const datasetInfo = datasetInfoMap.get(datasetId);
      
      if (!datasetInfo) {
        warn(`[UploadDatasets] No dataset info found for dataset ${datasetId}`);
        continue;
      }
      
      try {
        // Fetch description (race numbers) - matching DatasetInfo.jsx logic exactly
        // Retry logic: race events may not be immediately available after processing completes
        let report_desc_response: any = null;
        let races: any[] = [];
        const maxRetries = 5;
        const retryDelay = 2000; // 2 seconds between retries
        
        for (let retry = 0; retry < maxRetries; retry++) {
          report_desc_response = await getData(
            `${apiEndpoints.app.datasets}/desc?class_name=${selectedClassName()}&project_id=${selectedProjectId()}&dataset_id=${encodeURIComponent(datasetId)}`
          );

          debug('[UploadDatasets] Description fetch response:', { 
            datasetId, 
            retry: retry + 1,
            maxRetries,
            success: report_desc_response.success, 
            data: report_desc_response.data,
            dataLength: report_desc_response.data?.length 
          });

          if (report_desc_response.success && report_desc_response.data && Array.isArray(report_desc_response.data) && report_desc_response.data.length > 0) {
            races = report_desc_response.data;
            debug('[UploadDatasets] Race events found on retry', retry + 1);
            break; // Found races, exit retry loop
          }
          
          // If no races found and not last retry, wait before retrying
          if (retry < maxRetries - 1) {
            debug('[UploadDatasets] No race events found yet, retrying in', retryDelay, 'ms...');
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
        }

        if (report_desc_response && report_desc_response.success) {
          // RACING when at least one race with Race_number > 0 (strictly)
          const hasRealRaces = races.length > 0 && races.some((r: { races: unknown }) => {
            const n = r.races;
            const num = typeof n === 'number' ? n : parseInt(String(n), 10);
            return !isNaN(num) && num > 0;
          });
          const datasetType = hasRealRaces ? 'RACING' : 'TRAINING';
          const race_day = hasRealRaces ? 'RACE' : 'TRAINING';

          let description = 'NA';
          if (races.length > 0) {
            // Extract race numbers from objects - matching DatasetInfo.jsx logic
            const raceNumbers = races.map((race: { races: unknown }) => race.races);
            if (raceNumbers.length === 1) {
              description = "Race " + raceNumbers[0];
            } else if (raceNumbers.length === 2) {
              description = "Races " + raceNumbers[0] + " & " + raceNumbers[1];
            } else if (raceNumbers.length === 3) {
              description = "Races " + raceNumbers[0] + ", " + raceNumbers[1] + " & " + raceNumbers[2];
            } else if (raceNumbers.length > 3) {
              const lastRace = raceNumbers[raceNumbers.length - 1];
              const otherRaces = raceNumbers.slice(0, -1).join(", ");
              description = "Races " + otherRaces + " & " + lastRace;
            }
            debug('[UploadDatasets] Description formatted:', { datasetId, description, raceNumbers });
          }

          // Fetch existing dataset tags once (for Race_type and for merge)
          let existingTags: Record<string, unknown> = {};
          try {
            const tagsRes = await getData(
              `${apiEndpoints.app.datasets}/tags?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
            );
            if (tagsRes?.success && tagsRes?.data != null && typeof tagsRes.data === 'object') {
              existingTags = tagsRes.data as Record<string, unknown>;
            }
          } catch {
            // use empty, Race_type will default to INSHORE
          }
          const raceTypeTag = hasRealRaces
            ? ((existingTags.Race_type as string) ||
                (existingTags.RACE_TYPE as string) ||
                (existingTags.raceType as string) ||
                'INSHORE')
            : undefined;

          const existingDatasetResponse = await getData(
            `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
          );

          if (existingDatasetResponse.success && existingDatasetResponse.data) {
            const existing = existingDatasetResponse.data;
            const shared_int = existing.shared ? 1 : 0;
            const datasetTimezone = existing.timezone || timezone() || 'Europe/Madrid';
            const descriptionToSet = description !== 'NA' ? description : (existing.description || 'NA');

            const updateResponse = await putData(`${apiEndpoints.app.datasets}`, {
              class_name: selectedClassName(),
              project_id: selectedProjectId(),
              dataset_id: datasetId,
              event_name: eventName(),
              report_name: existing.report_name || 'NA',
              description: descriptionToSet,
              timezone: datasetTimezone,
              tws: existing.tws || '',
              twd: existing.twd || '',
              shared: shared_int,
              race_day
            });

            if (updateResponse.success) {
              debug('[UploadDatasets] Dataset updated:', { datasetId, description: descriptionToSet, race_day });
            } else {
              warn('[UploadDatasets] Failed to update dataset:', { datasetId, error: (updateResponse as { message?: string }).message });
            }
          } else {
            warn('[UploadDatasets] Failed to fetch existing dataset for update:', { datasetId });
          }

          // Merge Dataset_type and Race_type (when RACING) into dataset tags
          try {
            const currentTags = { ...existingTags };
            delete currentTags.DATASET_TYPE;
            delete currentTags.RACE_TYPE;
            delete currentTags.raceType;
            currentTags.Dataset_type = datasetType;
            if (hasRealRaces && raceTypeTag) currentTags.Race_type = raceTypeTag;
            const putTagsRes = await putData(`${apiEndpoints.app.datasets}/tags`, {
              class_name: selectedClassName(),
              project_id: selectedProjectId(),
              dataset_id: datasetId,
              tags: JSON.stringify(currentTags)
            });
            if (putTagsRes?.success) {
              debug('[UploadDatasets] Dataset tags updated:', { datasetId, Dataset_type: datasetType, Race_type: hasRealRaces ? raceTypeTag : undefined });
            } else {
              warn('[UploadDatasets] Failed to update dataset tags:', { datasetId });
            }
          } catch (tagsErr) {
            warn('[UploadDatasets] Error updating dataset tags:', { datasetId, tagsErr });
          }

          // Merge Dataset_type and Race_type into DATASET event tags
          try {
            const eventTagsToMerge: Record<string, string> = { Dataset_type: datasetType };
            if (hasRealRaces && raceTypeTag) eventTagsToMerge.Race_type = raceTypeTag;
            const putEventTagsRes = await putData(`${apiEndpoints.admin.events}/dataset-event-tags`, {
              class_name: selectedClassName(),
              project_id: selectedProjectId(),
              dataset_id: datasetId,
              tags: eventTagsToMerge
            });
            if (putEventTagsRes?.success) {
              debug('[UploadDatasets] DATASET event tags updated:', { datasetId, Dataset_type: datasetType, Race_type: hasRealRaces ? raceTypeTag : undefined });
            } else {
              warn('[UploadDatasets] Failed to update DATASET event tags:', { datasetId });
            }
          } catch (eventTagsErr) {
            warn('[UploadDatasets] Error updating DATASET event tags:', { datasetId, eventTagsErr });
          }
        } else {
          debug('[UploadDatasets] Description fetch failed:', { datasetId, message: (report_desc_response as { message?: string })?.message });
        }
      } catch (error) {
        warn('[UploadDatasets] Error updating description:', { datasetId, error });
      }
    }
  };

  // Helper function to normalize date format (YYYYMMDD -> YYYY-MM-DD)
  const normalizeDate = (date: string): string => {
    if (date.includes('-')) {
      return date; // Already in YYYY-MM-DD format
    }
    // Convert YYYYMMDD to YYYY-MM-DD
    if (date.length === 8) {
      return `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`;
    }
    return date; // Return as-is if format is unexpected
  };

  // Helper function to check if boundaries exist for a date
  const checkBoundariesExist = async (date: string): Promise<boolean> => {
    try {
      const className = selectedClassName();
      const projectId = selectedProjectId();
      const dateStr = normalizeDate(date);
      
      const response = await getData(
        `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateStr)}&object_name=boundaries`
      );
      
      return response.success && response.data && 
             (Object.keys(response.data).length > 0 || (Array.isArray(response.data) && response.data.length > 0));
    } catch (error) {
      debug('[UploadDatasets] Error checking boundaries (assuming no boundaries):', error);
      return false;
    }
  };

  // Helper function to check if a dataset has races
  const checkDatasetHasRaces = async (datasetId: number): Promise<boolean> => {
    try {
      const report_desc_response = await getData(
        `${apiEndpoints.app.datasets}/desc?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
      );

      if (report_desc_response.success) {
        const races = report_desc_response.data;
        return races && races.length > 0 && races.some((race: any) => {
          const raceNum = race.races;
          // Exclude training races (race number -1 or 'TRAINING')
          return raceNum !== -1 && raceNum !== '-1' && raceNum !== 'TRAINING' && raceNum !== 'training';
        });
      }
      return false;
    } catch (error) {
      debug('[UploadDatasets] Error checking races (assuming no races):', error);
      return false;
    }
  };

  // Helper function to parse date string consistently
  const parseDate = (dateString: string): Date => {
    // Handle YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
      const [year, month, day] = dateString.split('-').map(Number);
      return new Date(year, month - 1, day);
    }
    // Handle YYYYMMDD format
    if (/^\d{8}$/.test(dateString)) {
      const year = parseInt(dateString.substring(0, 4), 10);
      const month = parseInt(dateString.substring(4, 6), 10);
      const day = parseInt(dateString.substring(6, 8), 10);
      return new Date(year, month - 1, day);
    }
    // Fallback to standard Date parsing
    return new Date(dateString);
  };

  // Helper function to pre-populate dataset info
  const prepopulateDatasetInfo = async (datasetIds, datasetInfoMap) => {
    if (datasetIds.length === 0) {
      return;
    }

    // Only proceed if event_name is provided
    if (!eventName() || eventName().trim() === '') {
      debug('[UploadDatasets] Skipping report name assignment - event_name is empty');
      // Still update datasets with NA report_name
      for (let i = 0; i < datasetIds.length; i++) {
        const datasetId = datasetIds[i];
        const datasetInfo = datasetInfoMap.get(datasetId);
        if (!datasetInfo) continue;

        try {
          const className = selectedClassName();
          const existingDatasetResponse = await getData(
            `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
          );
          
          let location = '';
          let tws = '';
          let twd = '';
          let shared = 0;
          let datasetTimezone = timezone() || 'Europe/Madrid';
          
          if (existingDatasetResponse.success && existingDatasetResponse.data) {
            location = existingDatasetResponse.data.location || '';
            tws = existingDatasetResponse.data.tws || '';
            twd = existingDatasetResponse.data.twd || '';
            shared = existingDatasetResponse.data.shared ? 1 : 0;
            if (existingDatasetResponse.data.timezone) {
              datasetTimezone = existingDatasetResponse.data.timezone;
            }
          }
          
          await putData(`${apiEndpoints.app.datasets}`, {
            class_name: className,
            project_id: selectedProjectId(),
            dataset_id: datasetId,
            event_name: eventName() || '',
            report_name: 'NA',
            description: 'NA',
            timezone: datasetTimezone,
            location: location,
            tws: tws,
            twd: twd,
            shared: shared
          });
        } catch (error) {
          warn(`[UploadDatasets] Failed to update dataset ${datasetId}:`, error);
        }
      }
      return;
    }

    // Group datasets by event_name (all should have the same event_name, but handle edge cases)
    const datasetsByEvent = new Map<string, Array<{ datasetId: number; date: string; source_id: number }>>();
    
    for (const datasetId of datasetIds) {
      const datasetInfo = datasetInfoMap.get(datasetId);
      if (!datasetInfo) continue;
      
      const eventNameValue = eventName() || 'UNKNOWN';
      if (!datasetsByEvent.has(eventNameValue)) {
        datasetsByEvent.set(eventNameValue, []);
      }
      datasetsByEvent.get(eventNameValue)!.push({
        datasetId,
        date: datasetInfo.date,
        source_id: datasetInfo.source_id
      });
    }

    info(`[UploadDatasets] Processing ${datasetsByEvent.size} event(s) for report name assignment`);

    // Process each event
    for (const [eventNameValue, eventDatasets] of datasetsByEvent.entries()) {
      debug(`[UploadDatasets] Processing event: ${eventNameValue} with ${eventDatasets.length} dataset(s)`);

      // Get unique dates and check for races and boundaries
      const uniqueDates = Array.from(new Set(eventDatasets.map(d => d.date)))
        .sort((a, b) => parseDate(a).getTime() - parseDate(b).getTime());

      // Categorize dates into three groups
      const practiceDates: string[] = [];
      const officialPracticeDates: string[] = [];
      const raceDates: string[] = [];

      for (const date of uniqueDates) {
        setCurrentStatus(`Checking races and boundaries for date ${date}...`);
        
        // Check if any dataset on this date has races
        const datasetsForDate = eventDatasets.filter(d => d.date === date);
        let hasRaces = false;
        
        for (const { datasetId } of datasetsForDate) {
          const hasRacesResult = await checkDatasetHasRaces(datasetId);
          if (hasRacesResult) {
            hasRaces = true;
            break; // Found at least one dataset with races, no need to check others
          }
        }

        if (!hasRaces) {
          practiceDates.push(date);
        } else {
          // Check for boundaries
          const hasBoundaries = await checkBoundariesExist(date);
          if (hasBoundaries) {
            raceDates.push(date);
          } else {
            officialPracticeDates.push(date);
          }
        }
      }

      // Create mappings from date to sequential number for each category
      const dateToPracticeNumber = new Map<string, number>();
      practiceDates.forEach((date, index) => {
        dateToPracticeNumber.set(date, index + 1);
      });

      const dateToOfficialPracticeNumber = new Map<string, number>();
      officialPracticeDates.forEach((date, index) => {
        dateToOfficialPracticeNumber.set(date, index + 1);
      });

      const dateToRaceNumber = new Map<string, number>();
      raceDates.forEach((date, index) => {
        dateToRaceNumber.set(date, index + 1);
      });

      debug(`[UploadDatasets] Event ${eventNameValue}: ${practiceDates.length} practice date(s), ${officialPracticeDates.length} official practice date(s), ${raceDates.length} race date(s)`);

      // Update all datasets with appropriate report names
      for (let i = 0; i < eventDatasets.length; i++) {
        const { datasetId, date } = eventDatasets[i];
        const datasetInfo = datasetInfoMap.get(datasetId);
        
        if (!datasetInfo) {
          warn(`[UploadDatasets] No dataset info found for dataset ${datasetId}`);
          continue;
        }
        
        setCurrentStatus(`Pre-populating dataset ${i + 1} of ${eventDatasets.length}...`);

        try {
          let report_name = 'NA';
          
          // Determine report name based on category
          if (dateToPracticeNumber.has(date)) {
            report_name = `Practice ${dateToPracticeNumber.get(date)}`;
          } else if (dateToOfficialPracticeNumber.has(date)) {
            report_name = `Official Practice ${dateToOfficialPracticeNumber.get(date)}`;
          } else if (dateToRaceNumber.has(date)) {
            report_name = `Race ${dateToRaceNumber.get(date)}`;
          }

          debug('[UploadDatasets] Assigning report name:', { datasetId, date, report_name });

          // Skip description fetching during initial prepopulation
          // Race events are created by the processing scripts, so descriptions won't be available yet
          let description = 'NA';
          debug('[UploadDatasets] Skipping description fetch during prepopulation (race events not created yet)');

          // Fetch existing dataset to get location, tws, twd, and shared values
          const className = selectedClassName();
          const existingDatasetResponse = await getData(
            `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
          );
          
          let location = '';
          let tws = '';
          let twd = '';
          let shared = 0;
          let datasetTimezone = timezone() || 'Europe/Madrid';
          
          if (existingDatasetResponse.success && existingDatasetResponse.data) {
            location = existingDatasetResponse.data.location || '';
            tws = existingDatasetResponse.data.tws || '';
            twd = existingDatasetResponse.data.twd || '';
            shared = existingDatasetResponse.data.shared ? 1 : 0;
            // Use timezone from dataset if available, otherwise use signal value
            if (existingDatasetResponse.data.timezone) {
              datasetTimezone = existingDatasetResponse.data.timezone;
            }
          }
          
          // Update dataset with pre-populated info using PUT (required fields: timezone, location, tws, twd, shared)
          const updateResponse = await putData(`${apiEndpoints.app.datasets}`, {
            class_name: className,
            project_id: selectedProjectId(),
            dataset_id: datasetId,
            event_name: eventNameValue,
            report_name: report_name,
            description: description,
            timezone: datasetTimezone,
            location: location,
            tws: tws,
            twd: twd,
            shared: shared
          });
          
          if (!updateResponse.success) {
            warn(`[UploadDatasets] Failed to update dataset ${datasetId} with pre-populated info:`, updateResponse.message);
          } else {
            debug(`[UploadDatasets] Successfully updated dataset ${datasetId} with report_name: ${report_name}, description: ${description}`);
          }

          debug(`Pre-populated dataset ${datasetId} with report_name: ${report_name}, description: ${description}`);
        } catch (error) {
          warn(`Failed to pre-populate dataset ${datasetId}:`, error);
          // Continue with other datasets even if one fails
        }
      }
    }
  };

  // Helper function to parse XML files
  const parseXmlFiles = async (filePaths: string[], date: string): Promise<boolean> => {
    debug('[UploadDatasets] parseXmlFiles called:', {
      fileCount: filePaths.length,
      date,
      filePaths
    });
    
    try {
      const sanitizedDate = date.replace(/[-/]/g, "");
      
      // Get the folder path from the first file (all files should be in the same folder)
      // savePath format: C:\MyApps\Hunico\Uploads\Data\Raw\{project_id}\{class_name}\{date}\{source_name}\{filename}
      const firstFilePath = filePaths[0];
      if (!firstFilePath) {
        throw new Error('No file paths provided for XML parsing');
      }
      
      // Extract directory path (remove filename)
      const lastSlash = Math.max(firstFilePath.lastIndexOf('\\'), firstFilePath.lastIndexOf('/'));
      const filePath = lastSlash > 0 ? firstFilePath.substring(0, lastSlash) : firstFilePath;
      
      debug('[UploadDatasets] Extracted folder path for XML parsing:', { filePath, fromPath: firstFilePath });
      
      const parameters = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName(),
        date: sanitizedDate,
        file_path: filePath
      };
      
      const payload = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName(),
        script_name: '1_parseXml.py',
        parameters: parameters
      };
      
      debug('[UploadDatasets] Parsing XML files with payload:', payload);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        warn('[UploadDatasets] XML parsing request timeout after 5 minutes, aborting...');
        controller.abort();
      }, 300000); // 5 minute timeout
      
      try {
        const response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        clearTimeout(timeoutId);
        
        debug('[UploadDatasets] XML parsing response:', response_json);
        
        // Check if request was aborted (handled gracefully)
        if (response_json?.type === 'AbortError') {
          warn('[UploadDatasets] XML parsing request was aborted (timeout or cancellation)');
          return false;
        }
        
        if (!response_json?.success) {
          // Extract error details
          const errorMessage = response_json?.message || '';
          const body = response_json?.body || response_json?.data;
          const errorLines = response_json?.data?.error_lines || body?.error_lines || [];
          const outputLines = response_json?.data?.output_lines || body?.output_lines || [];
          
          logError('[UploadDatasets] XML parsing failed:', {
            response: response_json,
            message: errorMessage,
            errorLines: errorLines,
            outputLines: outputLines.slice(-10),
            filePath
          });
          
          // Log error details if available
          if (errorLines.length > 0) {
            logError('[UploadDatasets] XML parsing error lines:', errorLines);
          }
          if (outputLines.length > 0) {
            logError('[UploadDatasets] XML parsing output (last 10 lines):', outputLines.slice(-10));
          }
          
          return false;
        }
        
        return true;
      } catch (error) {
        clearTimeout(timeoutId);
        // Check if this is an AbortError that wasn't caught by postData
        if ((error as Error)?.name === 'AbortError' || (error as any)?.type === 'AbortError') {
          warn('[UploadDatasets] XML parsing request was aborted');
          return false;
        }
        throw error; // Re-throw to be handled by outer catch
      }
      
      // Response handling moved to try block above
    } catch (error) {
      // Handle AbortError gracefully (request cancellation/timeout)
      if ((error as Error)?.name === 'AbortError' || (error as any)?.type === 'AbortError') {
        warn('[UploadDatasets] XML parsing request was aborted');
        return false;
      } else {
        logError('Error parsing XML files:', error);
      }
      return false;
    }
  };

  // Helper function to normalize InfluxDB data for a single source
  const normalizeInfluxSource = async (sourceName: string, date: string): Promise<boolean> => {
    debug('[UploadDatasets] normalizeInfluxSource called:', {
      sourceName,
      date
    });
    
    try {
      // Normalize date to YYYYMMDD for backend (full-day normalization; do not send start_time/end_time)
      const sanitizedDate = (typeof date === 'string' ? date : String(date)).replace(/[-/]/g, '');
      if (sanitizedDate.length !== 8 || !/^\d{8}$/.test(sanitizedDate)) {
        warn('[UploadDatasets] Invalid date format for normalization, expected YYYYMMDD or YYYY-MM-DD:', { date, sanitizedDate });
        return false;
      }

      const parameters: Record<string, string | number> = {
        project_id: selectedProjectId(),
        class_name: selectedClassName(),
        date: sanitizedDate,
        source_name: sourceName,
        timezone: timezone() || 'Europe/Madrid'
      };
      // Do not send start_time/end_time — backend uses full-day chunking when they are omitted

      const payload = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName(),
        script_name: '1_normalization_influx.py',
        parameters
      };
      
      debug('[UploadDatasets] Normalizing InfluxDB source with payload:', payload);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 600000); // 10 minute timeout (InfluxDB queries can take longer)
      
      let response_json;
      try {
        response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        clearTimeout(timeoutId);
      } catch (error) {
        clearTimeout(timeoutId);
        // Check if this is an AbortError that wasn't caught by postData
        if ((error as Error)?.name === 'AbortError' || (error as any)?.type === 'AbortError') {
          warn('[UploadDatasets] InfluxDB normalization request was aborted');
          return false;
        }
        throw error; // Re-throw to be handled by outer catch
      }
      
      debug('[UploadDatasets] InfluxDB normalization response:', response_json);
      
      // Check if request was aborted (handled gracefully)
      if (response_json?.type === 'AbortError') {
        warn('[UploadDatasets] InfluxDB normalization request was aborted (timeout or cancellation)');
        return false;
      }
      
      // Extract output lines and error lines from response (check both success and failure cases)
      const body = response_json?.body || response_json?.data;
      const errorLines = response_json?.data?.error_lines || body?.error_lines || body?.data?.error_lines || [];
      const outputLines = response_json?.data?.output_lines || body?.output_lines || body?.data?.output_lines || [];
      const returnCode = response_json?.data?.return_code || body?.return_code;
      
      // Check for "no data" message - the Python script exits with code 0 (success) even when there's no data
      // It prints: "No data found for source {source_name} on date {date}, skipping..."
      // We need to filter this out since sys.exit(0) means success=true but there's no actual data
      const allOutputText = (outputLines.join('\n') + '\n' + errorLines.join('\n')).toLowerCase();
      const sourceNameLower = sourceName.toLowerCase();
      
      const hasNoDataMessage = allOutputText.includes(`no data found for source ${sourceNameLower}`) || 
                               allOutputText.includes(`no data found for source`) || 
                               (allOutputText.includes('no data found') && allOutputText.includes('skipping'));
      
      if (hasNoDataMessage) {
        debug(`[UploadDatasets] No data found for source ${sourceName} on date ${date}, skipping...`);
        return false; // Return false even if server returned success=true (script exits with 0 for no data)
      }
      
      // Trust response_json.success - it's based on sys.exit(0) for success, sys.exit(1) for failure
      if (!response_json?.success) {
        // Extract detailed error information from response - now includes body and data
        const errorMessage = response_json?.message || '';
        
        // Log the full response structure for debugging
        logError('[UploadDatasets] Full error response structure:', {
          response_json,
          body,
          hasData: !!response_json?.data,
          hasBody: !!response_json?.body,
          errorMessage,
          errorLinesCount: errorLines.length,
          outputLinesCount: outputLines.length
        });
        
        // Log detailed error information
        logError('[UploadDatasets] InfluxDB normalization failed:', {
          response: response_json,
          message: errorMessage,
          returnCode: returnCode,
          errorLines: errorLines,
          outputLines: outputLines.slice(-20), // Last 20 lines of output
          body: body,
          sourceName,
          date
        });
        
        // Check if this is a "no data" error (should skip silently)
        const errorText = (errorLines.join(' ') + ' ' + errorMessage).toLowerCase();
        if (errorText.includes('no data') || errorText.includes('empty') || errorText.includes('no data found') || errorText.includes('skipping')) {
          warn(`[UploadDatasets] No data found for source ${sourceName} on date ${date}, skipping...`);
          return false; // Return false but don't log as error
        }
        
        // Log the actual error lines for debugging
        if (errorLines.length > 0) {
          logError('[UploadDatasets] Script error lines:', errorLines);
        } else {
          logError('[UploadDatasets] No error lines found in response. Full response:', JSON.stringify(response_json, null, 2));
        }
        if (outputLines.length > 0) {
          logError('[UploadDatasets] Script output (last 20 lines):', outputLines.slice(-20));
        } else {
          logError('[UploadDatasets] No output lines found in response');
        }
        
        return false;
      }
      
      return true;
    } catch (error) {
      // Handle AbortError gracefully (request cancellation/timeout)
      if ((error as Error)?.name === 'AbortError' || (error as any)?.type === 'AbortError') {
        warn('[UploadDatasets] InfluxDB normalization request was aborted');
        return false;
      } else {
        logError('Error normalizing InfluxDB source:', error);
      }
      return false;
    }
  };

  // Helper function to wait for a process to complete
  // Returns an object with success status and process details
  const waitForProcessCompletion = async (pid: string): Promise<{ success: boolean; pid: string; status?: string; error?: string }> => {
    return new Promise((resolve) => {
      let maxTimeout: ReturnType<typeof setTimeout> | null = null;
      let lastRunningCheck = 0;
      let lastSSEUpdate = Date.now(); // Track when we last received an SSE update
      let checkCount = 0;
      const runningCheckInterval = 10000; // Check running processes endpoint every 10 seconds normally
      const fastRunningCheckInterval = 2000; // Check every 2 seconds when SSE hasn't updated
      const sseStaleThreshold = 30000; // If SSE hasn't updated in 30 seconds, use fast polling
      const startTime = Date.now();
      
      const waitForCompletion = async () => {
        checkCount++;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const process = processStore.getProcess(pid);
        
        // Update last SSE update time if process status or messages changed
        if (process) {
          const currentTimestamp = process.timestamp || 0;
          if (currentTimestamp > lastSSEUpdate) {
            lastSSEUpdate = currentTimestamp;
          }
          
          if (process.status === 'complete') {
            debug('[UploadDatasets] Script execution completed:', { pid, elapsed: `${elapsed}s`, checks: checkCount });
            if (maxTimeout) clearTimeout(maxTimeout);
            resolve({ success: true, pid, status: 'complete' });
            return;
          } else if (process.status === 'error' || process.status === 'timeout') {
            const errorMsg = process.latestMessage || `Process ${process.status}`;
            warn('[UploadDatasets] Script execution failed:', { pid, status: process.status, elapsed: `${elapsed}s`, checks: checkCount, error: errorMsg });
            if (maxTimeout) clearTimeout(maxTimeout);
            resolve({ success: false, pid, status: process.status, error: errorMsg });
            return;
          }
        }
        
        // Determine if SSE is stale (hasn't updated recently)
        const timeSinceLastSSEUpdate = Date.now() - lastSSEUpdate;
        const sseIsStale = timeSinceLastSSEUpdate > sseStaleThreshold;
        
        // Use faster polling if SSE is stale or process not found
        const currentCheckInterval = (sseIsStale || !process) ? fastRunningCheckInterval : runningCheckInterval;
        
        // Fallback: If SSE isn't updating, check the running processes endpoint more frequently
        // This handles cases where SSE connection is lost or messages are delayed
        const now = Date.now();
        if (now - lastRunningCheck >= currentCheckInterval) {
          lastRunningCheck = now;
          try {
            const runningCheck = await getData(apiEndpoints.python.running_processes);
            if (runningCheck?.success && runningCheck?.data) {
              const runningProcesses = runningCheck.data.processes || [];
              const isStillRunning = runningProcesses.some((p: any) => p.process_id === pid);
              
              if (!isStillRunning) {
                // Process is not in running list - check final status
                // If process exists in store, use its status; otherwise assume completion
                const finalProcess = processStore.getProcess(pid);
                if (finalProcess && (finalProcess.status === 'error' || finalProcess.status === 'timeout')) {
                  const errorMsg = finalProcess.latestMessage || `Process ${finalProcess.status}`;
                  debug('[UploadDatasets] Process not found in running list and has error status:', { pid, status: finalProcess.status, elapsed: `${elapsed}s` });
                  if (maxTimeout) clearTimeout(maxTimeout);
                  resolve({ success: false, pid, status: finalProcess.status, error: errorMsg });
                  return;
                } else {
                  // Assume completion if not in running list and no error status
                  debug('[UploadDatasets] Process not found in running processes list, assuming completion:', { pid, elapsed: `${elapsed}s`, checks: checkCount, sseStale: sseIsStale });
                  processStore.completeProcess(pid, 'complete');
                  if (maxTimeout) clearTimeout(maxTimeout);
                  resolve({ success: true, pid, status: 'complete' });
                  return;
                }
              } else {
                // Process is still running - log periodically or if SSE is stale
                if (sseIsStale || checkCount % 20 === 0) {
                  debug('[UploadDatasets] Process still running (checked via API):', { 
                    pid, 
                    elapsed: `${elapsed}s`, 
                    checks: checkCount,
                    sseStale: sseIsStale,
                    timeSinceLastSSEUpdate: `${(timeSinceLastSSEUpdate / 1000).toFixed(1)}s`
                  });
                }
              }
            }
          } catch (error) {
            warn('[UploadDatasets] Error checking running processes:', { pid, error, elapsed: `${elapsed}s` });
            // Continue with normal polling
          }
        }
        
        // Log warning if process has been waiting for a long time without status updates
        if (checkCount === 100) { // After 50 seconds (100 * 500ms)
          warn('[UploadDatasets] Process has been waiting for status update:', { 
            pid, 
            elapsed: `${elapsed}s`, 
            processStatus: process?.status || 'not found in store',
            sseStale: sseIsStale,
            timeSinceLastSSEUpdate: `${(timeSinceLastSSEUpdate / 1000).toFixed(1)}s`
          });
        }
        
        // Still running, check again in 500ms
        setTimeout(waitForCompletion, 500);
      };
      
      // Set a maximum timeout to prevent hanging
      maxTimeout = setTimeout(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        warn('[UploadDatasets] Script execution timeout:', { pid, elapsed: `${elapsed}s`, checks: checkCount });
        resolve({ success: false, pid, status: 'timeout', error: `Process timed out after ${elapsed}s` });
      }, 4500000); // 75 minute timeout (scripts can take up to 60 minutes: 30 min processing + 30 min execution)
      
      // Start checking for completion
      waitForCompletion();
    });
  };

  // Helper function to check for running processes
  // Uses a 10s timeout to avoid indefinite hang if Python server is unreachable
  const CHECK_RUNNING_PROCESSES_TIMEOUT_MS = 10000;
  const checkRunningProcesses = async (): Promise<{ running_count: number; processes: any[] } | null> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CHECK_RUNNING_PROCESSES_TIMEOUT_MS);
    try {
      const response = await getData(apiEndpoints.python.running_processes, controller.signal);
      clearTimeout(timeoutId);
      if (response.success && response.data) {
        return response.data;
      }
      return null;
    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as Error)?.name === 'AbortError') {
        warn('[UploadDatasets] checkRunningProcesses timed out - Python server may be unreachable. Proceeding with upload.');
      } else {
        debug('[UploadDatasets] Error checking running processes:', error);
      }
      return null;
    }
  };

  // Helper function to cancel a running process
  const cancelRunningProcess = async (processId: string): Promise<boolean> => {
    try {
      const response = await postData(apiEndpoints.python.cancel_process(processId), {});
      return response.success === true;
    } catch (error) {
      warn('[UploadDatasets] Error cancelling process:', error);
      return false;
    }
  };

  // Helper function to start processing script for a single dataset (returns process_id immediately)
  const startProcessingScript = async (dataset_id: number, date: string, source_name: string): Promise<string | null> => {
    debug('[UploadDatasets] startProcessingScript called:', {
      dataset_id: dataset_id,
      date: date,
      source_name: source_name
    });
    
    try {
      // Note: We don't check for running processes before starting anymore
      // This allows parallel processing. If the backend returns "process already running",
      // we'll handle it in the response handler below by waiting for completion.

      // Pre-establish SSE connection for script execution
      await sseManager.connectToServer(8049);
      debug('[UploadDatasets] SSE connection established for script execution');

      const controller = new AbortController();

      let parameters = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName(),
        dataset_id: dataset_id.toString(),
        date: date,
        source_name: source_name,
        batch: true,
        verbose: false,
        day_type: isTrainingDay() ? ['TRAINING'] : ['RACING'],
        race_type: ['INSHORE']
      };

      let payload = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName(),
        script_name: '2_process_and_execute.py',
        parameters: parameters
      };

      debug('[UploadDatasets] Executing script with payload:', payload);

      // Add a timeout to prevent hanging
      // Reduced to 5 minutes since backend now returns immediately after starting the process
      // This is still generous but prevents unnecessary waiting
      const startTime = Date.now();
      const timeoutId = setTimeout(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        warn('[UploadDatasets] Script start request timeout after', elapsed, 'seconds for dataset', dataset_id, '- script may still be running on server');
        controller.abort();
      }, 300000); // 5 minute timeout (backend returns immediately, so this is generous)
      
      let response_json: any;
      try {
        response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        clearTimeout(timeoutId);
      } catch (error: any) {
        clearTimeout(timeoutId);
        // Handle AbortError gracefully (request cancellation/timeout)
        if ((error as Error)?.name === 'AbortError' || error?.type === 'AbortError') {
          warn('[UploadDatasets] Script start request was aborted (timeout). Attempting to recover process...');
          
          // The server might have started the process even though the HTTP request timed out
          // Be persistent: check multiple times with short delays
          const maxRecoveryAttempts = 5;
          const recoveryDelay = 2000; // 2 seconds between attempts
          const requestStartTime = startTime;
          
          for (let attempt = 1; attempt <= maxRecoveryAttempts; attempt++) {
            try {
              await new Promise(resolve => setTimeout(resolve, recoveryDelay));
              
              const runningCheck = await getData(apiEndpoints.python.running_processes);
              if (runningCheck?.success && runningCheck?.data?.processes) {
                const runningProcesses = runningCheck.data.processes || [];
                
                // Find a process matching our request
                // Match by script_name, class_name, and check if started within last 2 minutes
                const now = Date.now();
                const twoMinutesAgo = now - (2 * 60 * 1000);
                
                const matchingProcess = runningProcesses.find((p: any) => {
                  if (p.script_name !== payload.script_name || p.class_name !== payload.class_name) {
                    return false;
                  }
                  
                  // Check if process was started recently (within last 2 minutes)
                  if (p.started_at) {
                    try {
                      const startedAt = new Date(p.started_at).getTime();
                      if (startedAt >= requestStartTime - 60000) { // Started within 1 minute before or after request
                        return true;
                      }
                    } catch (e) {
                      // If we can't parse the date, still consider it if it exists
                      return true;
                    }
                  }
                  
                  return false;
                });
                
                if (matchingProcess) {
                  debug('[UploadDatasets] Found matching running process after timeout (attempt', attempt, '):', matchingProcess);
                  
                  // Start tracking this process in the store
                  const pid = matchingProcess.process_id;
                  processStore.startProcess(pid, 'script_execution');
                  processStore.setShowToast(pid, false);
                  
                  warn('[UploadDatasets] Recovered process_id', pid, 'after timeout - upload will continue tracking this process');
                  return pid;
                }
              }
              
              if (attempt < maxRecoveryAttempts) {
                debug(`[UploadDatasets] Recovery attempt ${attempt}/${maxRecoveryAttempts} - no matching process found, retrying...`);
              }
            } catch (checkError) {
              debug('[UploadDatasets] Error during recovery attempt', attempt, ':', checkError);
              // Continue to next attempt
            }
          }
          
          // No matching process found after all attempts
          warn('[UploadDatasets] Could not recover process after', maxRecoveryAttempts, 'attempts. Script may still be running - upload will continue and SSE will track if process exists.');
          // Return null but don't fail - the upload will continue and SSE might pick up the process
          return null;
        }
        // Handle 409 "Process already running" error
        // The error body contains the process information
        if (error?.status === 409 && error?.body?.data?.process_already_running) {
          debug('[UploadDatasets] Caught 409 error - process already running:', error.body);
          // Convert error response to normal response format for processing
          response_json = {
            success: false,
            status: 409,
            data: error.body.data,
            message: error.body.message || 'Process already running'
          };
        } else {
          // Re-throw other errors
          throw error;
        }
      }
      
      debug('[UploadDatasets] Script execution server response:', response_json);
      
      // Check if server returned "process already running" status (either in response or error)
      // For parallel processing, we wait for the process to complete instead of canceling
      // This allows concurrent execution without interruption
      if (response_json?.status === 409 || response_json?.data?.process_already_running) {
        const runningProcesses = response_json.data.running_processes || [];
        const processList = runningProcesses.map((p: any) => 
          `- ${p.script_name} (${p.class_name}) - Started: ${p.started_at || 'unknown'}`
        ).join('\n');
        
        debug(`[UploadDatasets] Process already running for dataset ${dataset_id}. Waiting for completion...\n${processList}`);
        
        // Wait for running processes to complete by polling the running processes endpoint
        const maxWaitTime = 3600000; // 1 hour max wait
        const pollInterval = 5000; // Check every 5 seconds
        const startWaitTime = Date.now();
        let allProcessesCompleted = false;
        
        while (!allProcessesCompleted && (Date.now() - startWaitTime) < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, pollInterval));
          
          try {
            const runningCheck = await getData(apiEndpoints.python.running_processes);
            if (runningCheck?.success && runningCheck?.data) {
              const stillRunning = runningCheck.data.processes || [];
              const stillRunningIds = new Set(stillRunning.map((p: any) => p.process_id));
              
              // Check if any of the processes we're waiting for are still running
              const waitingForProcesses = runningProcesses.map((p: any) => p.process_id);
              allProcessesCompleted = !waitingForProcesses.some((pid: string) => stillRunningIds.has(pid));
              
              if (!allProcessesCompleted) {
                const elapsed = Math.round((Date.now() - startWaitTime) / 1000);
                debug(`[UploadDatasets] Still waiting for processes to complete... (${elapsed}s elapsed)`);
              }
            } else {
              // If we can't check, assume processes completed
              allProcessesCompleted = true;
            }
          } catch (error) {
            warn('[UploadDatasets] Error checking running processes:', error);
            // Continue waiting
          }
        }
        
        if (!allProcessesCompleted) {
          warn(`[UploadDatasets] Timeout waiting for running processes to complete for dataset ${dataset_id}`);
          return null;
        }
        
        debug(`[UploadDatasets] Running processes completed, retrying dataset ${dataset_id}...`);
        
        // Retry the script execution after processes completed
        let retryResponse: any;
        try {
          retryResponse = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        } catch (retryError: any) {
          // Handle AbortError gracefully (request cancellation/timeout)
          if ((retryError as Error)?.name === 'AbortError' || retryError?.type === 'AbortError') {
            warn('[UploadDatasets] Script start retry request was aborted');
            return null;
          }
          // Handle 409 "Process already running" error on retry
          if (retryError?.status === 409 && retryError?.body?.data?.process_already_running) {
            debug('[UploadDatasets] Retry also got 409 error - process still running:', retryError.body);
            retryResponse = {
              success: false,
              status: 409,
              data: retryError.body.data,
              message: retryError.body.message || 'Process already running'
            };
          } else {
            // Re-throw other errors
            throw retryError;
          }
        }
        
        if (!retryResponse?.success) {
          // Check if there's still a process running (race condition)
          if (retryResponse?.status === 409 || retryResponse?.data?.process_already_running) {
            warn(`[UploadDatasets] Process still running after wait for dataset ${dataset_id} - may need manual intervention`);
            return null;
          } else {
            logError('[UploadDatasets] Script start failed after retry:', {
              response: retryResponse,
              message: retryResponse?.message || 'Unknown error',
              dataset_id: dataset_id
            });
            return null;
          }
        }
        // Use the retry response as the new response_json
        response_json = retryResponse;
      }
      
      // Check if this is an AbortError (request cancelled/timeout)
      // Check both type and message to be defensive
      const isAbortError = response_json?.type === 'AbortError' || 
                          response_json?.message === 'Request cancelled' ||
                          (response_json?.status === 0 && !response_json?.success);
      
      if (isAbortError) {
        warn('[UploadDatasets] Script start request was cancelled/timed out:', {
          dataset_id: dataset_id,
          response: response_json,
          note: 'Script may still be running on server - upload will continue and SSE will track if process exists'
        });
        // Don't return null immediately - the script might have started on the server
        // The SSE connection should pick up any process messages
        // Return null to indicate we don't have a process_id from the HTTP response
        // This is NOT a fatal error - the upload will continue processing other datasets
        return null;
      }
      
      if (!response_json?.success) {
        logError('[UploadDatasets] Script start failed:', {
          response: response_json,
          message: response_json?.message || 'Unknown error',
          dataset_id: dataset_id
        });
        return null; // Return null if script start failed
      }

      // Extract process_id
      let pid: string | null = null;
      if ((response_json as any).process_id) {
        pid = (response_json as any).process_id;
      } else if ((response_json as any)?.data?.process_id) {
        pid = (response_json as any).data.process_id;
      }

      if (!pid) {
        warn('[UploadDatasets] No process_id in successful server response');
        return null; // Return null if no process_id
      }

      debug('[UploadDatasets] Using process_id:', pid);
      
      setProcessId(pid);
      
      // Start the process in the store to trigger SSE connection
      processStore.startProcess(pid, 'script_execution');
      
      // Explicitly disable toast for this process (part of batch upload)
      // Do this AFTER starting the process so the process exists in the store
      // Scripts won't have toast: true by default, but this ensures it's explicitly disabled
      processStore.setShowToast(pid, false);
      debug('[UploadDatasets] Toast disabled for process:', pid);
      
      // Clear custom status so SSE messages from the script will show in WaitingModal
      setCurrentStatus("");
      
      // Return the process_id immediately (don't wait for completion)
      return pid;

    } catch (error: any) {
      if (error?.name === 'AbortError' || error?.type === 'AbortError') {
        warn('[UploadDatasets] Script start request was cancelled/timed out:', {
          dataset_id: dataset_id,
          note: 'Script may still be running on server - upload will continue and SSE will track if process exists'
        });
      } else {
        logError('[UploadDatasets] Error executing script:', {
          error: error,
          dataset_id: dataset_id,
          note: 'Upload will continue processing other datasets'
        });
      }
      // Continue even if script execution fails - this is NOT a fatal error
      // The upload process will continue with other datasets
      // If the script actually started, SSE will track it
      return null; // Return null if script execution failed
    }
  };

  // Helper function to execute processing script for a single dataset (kept for backward compatibility)
  const executeProcessingScript = async (dataset_id: number, date: string, source_name: string): Promise<string | null> => {
    const pid = await startProcessingScript(dataset_id, date, source_name);
    if (pid) {
      const result = await waitForProcessCompletion(pid);
      if (!result.success) {
        logError('[UploadDatasets] Processing script failed:', {
          dataset_id,
          pid,
          status: result.status,
          error: result.error
        });
      }
    }
    return pid;
  };

  /**
   * Process datasets in parallel with a concurrency limit
   * @param datasetTasks - Array of tasks with { datasetId, date, source_name }
   * @param concurrency - Maximum number of concurrent processing tasks (default: 2, optimized for 4-CPU server)
   * @returns Array of process IDs that were started
   */
  const processDatasetsInParallel = async (
    datasetTasks: Array<{ datasetId: number, date: string, source_name: string }>,
    concurrency: number = 2  // Default to 2 to leave resources for system on 4-CPU server
  ): Promise<string[]> => {
    const allProcessIds: string[] = [];
    const totalTasks = datasetTasks.length;
    let completedTasks = 0;

    debug('[UploadDatasets] processDatasetsInParallel called:', {
      totalTasks,
      concurrency
    });

    // Process in batches
    for (let i = 0; i < totalTasks; i += concurrency) {
      const batch = datasetTasks.slice(i, i + concurrency);
      const batchNumber = Math.floor(i / concurrency) + 1;
      const totalBatches = Math.ceil(totalTasks / concurrency);
      
      debug('[UploadDatasets] Processing batch:', {
        batchNumber,
        totalBatches,
        batchSize: batch.length,
        datasets: batch.map(t => ({ datasetId: t.datasetId, source_name: t.source_name }))
      });

      // Update progress for batch start
      const batchProgress = Math.round((i / totalTasks) * 100);
      setCurrentStatus(`Processing batch ${batchNumber} of ${totalBatches} (${batchProgress}%): ${batch.map(t => t.source_name).join(', ')}...`);
      setUploadProgress({ current: i, total: totalTasks });

      // Start all scripts in the batch without waiting
      const batchPromises = batch.map(async (task) => {
        try {
          const pid = await startProcessingScript(task.datasetId, task.date, task.source_name);
          if (pid) {
            allProcessIds.push(pid);
            return { datasetId: task.datasetId, pid, success: true };
          } else {
            warn('[UploadDatasets] Could not start processing script (timeout or error):', { 
              datasetId: task.datasetId, 
              source_name: task.source_name,
              note: 'Script may still be running on server - upload will continue with other datasets'
            });
            return { datasetId: task.datasetId, pid: null, success: false };
          }
        } catch (error) {
          logError('[UploadDatasets] Error starting processing script:', {
            datasetId: task.datasetId,
            source_name: task.source_name,
            error: error instanceof Error ? error.message : String(error)
          });
          return { datasetId: task.datasetId, pid: null, success: false };
        }
      });

      // Wait for all scripts in the batch to start
      const batchResults = await Promise.allSettled(batchPromises);
      
      // Log batch start results
      batchResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          const taskResult = result.value;
          if (taskResult.success && taskResult.pid) {
            debug('[UploadDatasets] Processing script started:', { datasetId: taskResult.datasetId, pid: taskResult.pid });
          }
        } else {
          warn('[UploadDatasets] Unexpected error starting script:', { error: result.reason, datasetId: batch[index].datasetId });
        }
      });

      // Wait for all processes in the batch to complete
      const batchProcessIds = batchResults
        .filter((r): r is PromiseFulfilledResult<{ datasetId: number, pid: string | null, success: boolean }> => 
          r.status === 'fulfilled' && r.value.success && r.value.pid !== null
        )
        .map(r => r.value.pid!);

      if (batchProcessIds.length > 0) {
        debug('[UploadDatasets] Waiting for batch to complete:', { batchNumber, processIds: batchProcessIds });
        
        // Wait for all processes in the batch to complete and check results
        const completionResults = await Promise.allSettled(batchProcessIds.map(pid => waitForProcessCompletion(pid)));
        
        // Check for failures
        const failedProcesses: Array<{ pid: string; error?: string; status?: string }> = [];
        const successfulProcesses: string[] = [];
        
        completionResults.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            const processResult = result.value;
            if (processResult.success) {
              successfulProcesses.push(processResult.pid);
            } else {
              failedProcesses.push({
                pid: processResult.pid,
                error: processResult.error,
                status: processResult.status
              });
              logError('[UploadDatasets] Process failed in batch:', {
                batchNumber,
                pid: processResult.pid,
                status: processResult.status,
                error: processResult.error
              });
            }
          } else {
            // Promise rejected (shouldn't happen, but handle it)
            const pid = batchProcessIds[index];
            failedProcesses.push({
              pid,
              error: result.reason?.message || 'Unknown error',
              status: 'error'
            });
            logError('[UploadDatasets] Process completion promise rejected:', {
              batchNumber,
              pid,
              error: result.reason
            });
          }
        });
        
        // Report failures to user
        if (failedProcesses.length > 0) {
          const failedCount = failedProcesses.length;
          const successCount = successfulProcesses.length;
          const errorSummary = failedProcesses.map(p => `Process ${p.pid}: ${p.error || p.status || 'unknown error'}`).join('; ');
          
          warn(`[UploadDatasets] Batch ${batchNumber} completed with ${failedCount} failure(s) out of ${batchProcessIds.length} processes:`, {
            failedProcesses,
            successfulProcesses
          });
          
          // Update status to show failures
          setCurrentStatus(`Batch ${batchNumber} completed: ${successCount} succeeded, ${failedCount} failed`);
          
          // Show error toast for failures
          toastStore.showToast(
            'error',
            'Processing Failed',
            `${failedCount} dataset(s) failed to process in batch ${batchNumber}. ${errorSummary.substring(0, 200)}${errorSummary.length > 200 ? '...' : ''}`
          );
        } else {
          // All succeeded
          debug(`[UploadDatasets] Batch ${batchNumber} completed successfully:`, { successfulProcesses });
        }
        
        completedTasks += batchProcessIds.length;
        const completedProgress = Math.round((completedTasks / totalTasks) * 100);
        setCurrentStatus(`Completed batch ${batchNumber} of ${totalBatches} (${completedProgress}%): ${completedTasks}/${totalTasks} datasets processed`);
        setUploadProgress({ current: completedTasks, total: totalTasks });
      }
    }

    debug('[UploadDatasets] processDatasetsInParallel completed:', {
      totalTasks,
      processIdsStarted: allProcessIds.length,
      completedTasks
    });

    return allProcessIds;
  };

  // Handle stopping all processing
  const handleStopProcessing = async () => {
    debug('[UploadDatasets] handleStopProcessing called');
    
    try {
      setProcessingCancelled(true);
      setCurrentStatus("Stopping processing...");
      
      // Cancel all tracked process IDs
      const processIds = allProcessIds();
      debug('[UploadDatasets] Cancelling processes:', processIds);
      
      for (const pid of processIds) {
        try {
          const response = await postData(
            `${apiEndpoints.python.execute_script.replace('/execute_script/', '')}/api/scripts/cancel/${pid}`,
            {}
          );
          
          if (response.success) {
            debug(`[UploadDatasets] Successfully cancelled process ${pid}`);
          } else {
            warn(`[UploadDatasets] Failed to cancel process ${pid}:`, response.message);
          }
        } catch (error) {
          warn(`[UploadDatasets] Error cancelling process ${pid}:`, error);
        }
      }
      
      // Clean up batch suppression mode
      processStore.clearSuppressedProcessIds();
      processStore.disableBatchSuppressMode();
      
      // Close modal and navigate
      setShowWaiting(false);
      setIsProcessing(false);
      navigate('/dashboard');
      
    } catch (error) {
      logError('[UploadDatasets] Error in handleStopProcessing:', error);
      // Still navigate away even if cancellation had errors
      setShowWaiting(false);
      setIsProcessing(false);
      navigate('/dashboard');
    }
  };

  // Handle exiting while processing continues
  const handleExit = () => {
    debug('[UploadDatasets] handleExit called - processing will continue in background');
    
    // Just close modal and navigate - processing continues
    setShowWaiting(false);
    setIsProcessing(false);
    navigate('/dashboard');
  };

  // Determine step title based on current step
  const getStepTitle = () => {
    const step = currentStep();
    if (step === 1) {
      return "Step 1 of 4: Uploading Files";
    } else if (step === 2) {
      return "Step 2 of 4: Normalizing Files";
    } else if (step === 3) {
      return "Step 3 of 4: Processing Files";
    } else if (step === 4) {
      return "Step 4 of 4: Wrapping up";
    } else {
      return "Processing...";
    }
  };

  // Determine modal title based on current phase (kept for backward compatibility)
  const getModalTitle = () => {
    return getStepTitle();
  };

  return (
    <>
      <div class="login-page">
        <div class="login-page-scroll-container">
          <div class="login-container" style="max-width: 800px;">
            <Show when={showWaiting()}>
              {/* Upload Progress View */}
              <div class="login-header">
                <div class="logo-section">
                  <div class="logo-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="animation: spin 1s linear infinite;">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="31.416" stroke-dashoffset="15.708" opacity="0.3"/>
                      <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="31.416" stroke-dashoffset="15.708">
                        <animateTransform attributeName="transform" type="rotate" dur="1s" repeatCount="indefinite" values="0 12 12;360 12 12"/>
                      </circle>
                    </svg>
                  </div>
                  <h1 class="login-title">{getStepTitle()}</h1>
                  <p class="login-subtitle" style="min-height: 24px;">{currentStatus() || "Processing your data files..."}</p>
                </div>
              </div>
              <div style="text-align: center; padding: 20px;">
                <Show when={uploadProgress().total > 0}>
                  <div style="margin-bottom: 20px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; color: var(--color-text-secondary);">
                      <span>File {uploadProgress().current} of {uploadProgress().total}</span>
                      <span>{Math.round((uploadProgress().current / uploadProgress().total) * 100)}%</span>
                    </div>
                    <div style="width: 100%; height: 8px; background: var(--color-bg-secondary, #e5e7eb); border-radius: 4px; overflow: hidden;">
                      <div style={`width: ${(uploadProgress().current / uploadProgress().total) * 100}%; height: 100%; background: linear-gradient(90deg, #3b82f6 0%, #2563eb 100%); transition: width 0.3s ease; border-radius: 4px;`}></div>
                    </div>
                  </div>
                </Show>
                <Show when={isProcessing()}>
                  <div style="color: var(--color-text-secondary); font-size: 14px; margin-top: 20px;">
                    Processing will continue in the background. If you wish to exit this page, you will be notified when the processing is completed.
                  </div>
                </Show>
                <Show when={isProcessing()}>
                  <div style="display: flex; gap: 12px; justify-content: center; margin-top: 20px;">
                    <button
                      onClick={async () => {
                        const confirmed = window.confirm(
                          "Are you sure you want to stop all processing? This will cancel all running scripts and may leave datasets in an incomplete state. This action cannot be undone."
                        );
                        if (confirmed) {
                          await handleStopProcessing();
                        }
                      }}
                      style="padding: 10px 24px; background: #dc2626; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s;"
                      onMouseOver={(e) => e.currentTarget.style.background = '#b91c1c'}
                      onMouseOut={(e) => e.currentTarget.style.background = '#dc2626'}
                    >
                      Stop Processing
                    </button>
                    <button
                      onClick={async () => {
                        const confirmed = window.confirm(
                          "Are you sure you want to exit? Processing will continue in the background. You can check progress later."
                        );
                        if (confirmed) {
                          handleExit();
                        }
                      }}
                      style="padding: 10px 24px; background: var(--color-bg-button, #6b7280); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s;"
                      onMouseOver={(e) => e.currentTarget.style.background = '#4b5563'}
                      onMouseOut={(e) => e.currentTarget.style.background = 'var(--color-bg-button, #6b7280)'}
                    >
                      Exit
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
            <Show when={!showWaiting() && !uploadSuccess() && !uploadFailed()}>
          <div class="login-header">
            <div class="logo-section">
              <div class="logo-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <polyline points="10,9 9,9 8,9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <h1 class="login-title">Upload Datasets</h1>
              <p class="login-subtitle">Upload your data files to start analyzing</p>
            </div>
          </div>
        
        <form class="login-form" onSubmit={(e) => { 
          e.preventDefault(); 
          e.stopPropagation();
          handleUpload(); 
        }}>
          {/* Day Type Toggle */}
          <div class="form-group">
            <label class="form-label">Day Type</label>
            <div style="display: flex; gap: 12px; align-items: center;">
              <button
                type="button"
                onClick={() => {
                  setIsTrainingDay(false);
                  setFiles([]);
                  setExtractedDates(new Set());
                  setDatesFromXml([]);
                }}
                style={`padding: 10px 24px; border: 2px solid ${!isTrainingDay() ? '#3b82f6' : '#e5e7eb'}; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; background: ${!isTrainingDay() ? '#3b82f6' : 'transparent'}; color: ${!isTrainingDay() ? 'white' : 'var(--color-text-primary)'};`}
                onMouseOver={(e) => {
                  if (isTrainingDay()) {
                    e.currentTarget.style.borderColor = '#3b82f6';
                    e.currentTarget.style.color = '#3b82f6';
                  }
                }}
                onMouseOut={(e) => {
                  if (isTrainingDay()) {
                    e.currentTarget.style.borderColor = '#e5e7eb';
                    e.currentTarget.style.color = 'var(--color-text-primary)';
                  }
                }}
              >
                Race Day
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsTrainingDay(true);
                  setFiles([]);
                  setExtractedDates(new Set());
                  setDatesFromXml([]);
                }}
                style={`padding: 10px 24px; border: 2px solid ${isTrainingDay() ? '#3b82f6' : '#e5e7eb'}; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; background: ${isTrainingDay() ? '#3b82f6' : 'transparent'}; color: ${isTrainingDay() ? 'white' : 'var(--color-text-primary)'};`}
                onMouseOver={(e) => {
                  if (!isTrainingDay()) {
                    e.currentTarget.style.borderColor = '#3b82f6';
                    e.currentTarget.style.color = '#3b82f6';
                  }
                }}
                onMouseOut={(e) => {
                  if (!isTrainingDay()) {
                    e.currentTarget.style.borderColor = '#e5e7eb';
                    e.currentTarget.style.color = 'var(--color-text-primary)';
                  }
                }}
              >
                Training Day
              </button>
            </div>
          </div>

          {/* Source Selection */}
          <Show when={sourcesStore.isReady() && sourcesStore.sources().length > 0}>
            <div class="form-group">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <label class="form-label" style="margin-bottom: 0;">Data Sources</label>
                <div style="display: flex; gap: 8px;">
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    style="padding: 6px 12px; background: var(--color-bg-button, #6b7280); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; transition: background 0.2s;"
                    onMouseOver={(e) => e.currentTarget.style.background = '#4b5563'}
                    onMouseOut={(e) => e.currentTarget.style.background = 'var(--color-bg-button, #6b7280)'}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    onClick={handleSelectNone}
                    style="padding: 6px 12px; background: var(--color-bg-button, #6b7280); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; transition: background 0.2s;"
                    onMouseOver={(e) => e.currentTarget.style.background = '#4b5563'}
                    onMouseOut={(e) => e.currentTarget.style.background = 'var(--color-bg-button, #6b7280)'}
                  >
                    None
                  </button>
                </div>
              </div>
              <div style="padding: 16px; background: var(--color-bg-secondary, #f3f4f6); border-radius: 6px; border: 1px solid var(--color-border, #e5e7eb);">
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; max-height: 200px; overflow-y: auto;">
                  <For each={sourcesStore.sources().filter(s => s.source_name && s.source_name.trim() !== '').sort((a, b) => (a.source_name || '').localeCompare(b.source_name || ''))}>
                    {(source) => {
                      const isSelected = () => selectedSources().has(source.source_name || '');
                      const sourceColor = source.color || '#ffffff';
                      
                      return (
                        <label
                          style="display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 8px; border-radius: 4px; transition: background 0.2s;"
                          onMouseOver={(e) => e.currentTarget.style.background = 'rgba(0,0,0,0.05)'}
                          onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected()}
                            onChange={() => handleSourceToggle(source.source_name || '')}
                            style="width: 18px; height: 18px; cursor: pointer; accent-color: #3b82f6;"
                          />
                          <div style="display: flex; align-items: center; gap: 6px; flex: 1;">
                            <div
                              style={`width: 12px; height: 12px; border-radius: 2px; background: ${sourceColor}; border: 1px solid rgba(0,0,0,0.1); flex-shrink: 0;`}
                            />
                            <span style="font-size: 14px; color: var(--color-text-primary);">{source.source_name}</span>
                          </div>
                        </label>
                      );
                    }}
                  </For>
                </div>
                <p style="margin-top: 12px; color: var(--color-text-secondary); font-size: 12px;">
                  {selectedSources().size} of {sourcesStore.sources().filter(s => s.source_name && s.source_name.trim() !== '').length} source(s) selected
                </p>
              </div>
            </div>
          </Show>
          
          {/* Date Input - Show when training day OR when showDateInput is true for race day */}
          <Show when={isTrainingDay() || showDateInput()}>
            <div class="form-group">
              <label for="inputDate" class="form-label">Date</label>
              <div class="input-container">
                <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" stroke="currentColor" stroke-width="2"/>
                  <line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <input
                  id="inputDate"
                  type="date"
                  value={inputDate()}
                  onInput={(e) => setInputDate((e.target as HTMLInputElement).value)}
                  placeholder="YYYY-MM-DD"
                  class="form-input"
                  required
                />
              </div>
              <p style="margin-top: 4px; color: var(--color-text-secondary); font-size: 12px;">
                Date format: YYYY-MM-DD (used for InfluxDB data download)
              </p>
            </div>
          </Show>
          <Show when={!isTrainingDay() && !showDateInput() && datesFromXml().length > 0}>
            <div class="form-group">
              <label class="form-label">Dates Found in XML Files</label>
              <div class="upload-dates-found-container">
                <div class="upload-dates-chips">
                  <For each={datesFromXml()}>
                    {(date) => (
                      <span class="upload-date-chip">
                        {date}
                        <button
                          type="button"
                          class="upload-date-remove"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const newDates = datesFromXml().filter((d) => d !== date);
                            setDatesFromXml(newDates);
                            setExtractedDates(new Set(newDates));
                            if (newDates.length === 0) {
                              setShowDateInput(true);
                            }
                          }}
                          title="Remove this date from upload"
                          aria-label={`Remove date ${date}`}
                        >
                          ×
                        </button>
                      </span>
                    )}
                  </For>
                </div>
                <p class="upload-dates-count">
                  {datesFromXml().length} unique date(s) extracted from XML files
                </p>
              </div>
            </div>
          </Show>
          
          <div class="form-group">
            <label for="eventName" class="form-label">Event Name</label>
            <div class="input-container">
              <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" stroke="currentColor" stroke-width="2"/>
                <line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <input
                id="eventName"
                type="text"
                value={eventName()}
                onInput={(e) => setEventName(e.target.value)}
                placeholder="Enter event name"
                class="form-input"
              />
            </div>
          </div>
          
          <div class="form-group">
            <label for="timezone" class="form-label">Timezone</label>
            <div class="input-container">
              <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                <polyline points="12,6 12,12 16,14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <select
                id="timezone"
                value={timezone()}
                onInput={(e) => {
                  const newTimezone = (e.target as HTMLSelectElement).value;
                  debug('[UploadDatasets] Timezone changed:', { old: timezone(), new: newTimezone });
                  setTimezone(newTimezone);
                }}
                class="form-input"
              >
                <option value="">-- Select Timezone --</option>
                <For each={timezones()}>
                  {(tz) => (
                    <option value={tz}>{tz}</option>
                  )}
                </For>
              </select>
            </div>
          </div>

          {/* Target Selection */}
          <Show when={availableTargets().length > 0}>
            <div class="form-group">
              <label for="targetSelect" class="form-label">Target</label>
              <div class="input-container">
                <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                  <polyline points="12,6 12,12 16,14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <select
                  id="targetSelect"
                  value={selectedTarget()}
                  onInput={(e) => {
                    const newTarget = (e.target as HTMLSelectElement).value;
                    debug('[UploadDatasets] Target changed:', { old: selectedTarget(), new: newTarget });
                    handleTargetChange(newTarget);
                  }}
                  class="form-input"
                >
                  <option value="">-- Select Target --</option>
                  <For each={availableTargets()}>
                    {(target) => (
                      <option value={target.name}>{target.name}</option>
                    )}
                  </For>
                </select>
              </div>
            </div>
          </Show>

          {/* Configuration Fields - Show for both Race Day and Training Day */}
          <div class="form-group">
            <label class="form-label">Configuration</label>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
                <div>
                  <label for="name" class="form-label" style="font-size: 13px; margin-bottom: 6px;">Name</label>
                  <div class="input-container">
                    <input
                      id="name"
                      type="text"
                      value={name()}
                      onInput={(e) => setName((e.target as HTMLInputElement).value)}
                      placeholder="e.g., m2"
                      class="form-input"
                    />
                  </div>
                </div>
                <div>
                  <label for="wingCode" class="form-label" style="font-size: 13px; margin-bottom: 6px;">Wing Code</label>
                  <div class="input-container">
                    <input
                      id="wingCode"
                      type="text"
                      value={wingCode()}
                      onInput={(e) => setWingCode((e.target as HTMLInputElement).value)}
                      placeholder="e.g., AP"
                      class="form-input"
                    />
                  </div>
                </div>
                <div>
                  <label for="dbCode" class="form-label" style="font-size: 13px; margin-bottom: 6px;">Daggerboard Code</label>
                  <div class="input-container">
                    <input
                      id="dbCode"
                      type="text"
                      value={dbCode()}
                      onInput={(e) => setDbCode((e.target as HTMLInputElement).value)}
                      placeholder="e.g., HSB2"
                      class="form-input"
                    />
                  </div>
                </div>
                <div>
                  <label for="rudCode" class="form-label" style="font-size: 13px; margin-bottom: 6px;">Rudder Code</label>
                  <div class="input-container">
                    <input
                      id="rudCode"
                      type="text"
                      value={rudCode()}
                      onInput={(e) => setRudCode((e.target as HTMLInputElement).value)}
                      placeholder="e.g., HSRW"
                      class="form-input"
                    />
                  </div>
                </div>
                <div>
                  <label for="crewCount" class="form-label" style="font-size: 13px; margin-bottom: 6px;">Crew Count</label>
                  <div class="input-container">
                    <input
                      id="crewCount"
                      type="text"
                      value={crewCount()}
                      onInput={(e) => setCrewCount((e.target as HTMLInputElement).value)}
                      placeholder="e.g., 6"
                      class="form-input"
                    />
                  </div>
                </div>
                <div>
                  <label for="headsailCode" class="form-label" style="font-size: 13px; margin-bottom: 6px;">Headsail Code</label>
                  <div class="input-container">
                    <input
                      id="headsailCode"
                      type="text"
                      value={headsailCode()}
                      onInput={(e) => setHeadsailCode((e.target as HTMLInputElement).value)}
                      placeholder="e.g., HW1"
                      class="form-input"
                    />
                  </div>
                </div>
              </div>
            </div>
          
          {/* File Selection - Hide for Training Day */}
          <Show when={!isTrainingDay() && files().length === 0}>
            <div class="form-group">
              <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                <input
                  type="checkbox"
                  id="folderMode"
                  checked={folderMode()}
                  onChange={(e) => {
                    setFolderMode(e.target.checked);
                    // Clear files when switching modes
                    setFiles([]);
                  }}
                  style="width: 18px; height: 18px; cursor: pointer;"
                />
                <label for="folderMode" style="cursor: pointer; color: var(--color-text-primary); font-size: 14px;">
                  Select folder (finds all .xml files)
                </label>
              </div>
              
              <label for={folderMode() ? "folderInput" : "fileInput"} class="form-label">
                {folderMode() ? "Select Folder" : "Select Files"}
              </label>
              
              <Show when={!folderMode()}>
                <div class="file-upload-container">
                  <input
                    id="fileInput"
                    type="file"
                    multiple
                    onChange={handleFileChange}
                    class="file-input"
                    accept=".xml"
                  />
                  <label for="fileInput" class="file-upload-label">
                    <svg class="file-upload-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="file-upload-text">Choose files or drag and drop</span>
                    <span class="file-upload-subtext">XML files only</span>
                  </label>
                </div>
              </Show>
              
              <Show when={folderMode()}>
                <div class="file-upload-container">
                  <input
                    id="folderInput"
                    type="file"
                    webkitdirectory=""
                    directory=""
                    multiple
                    onChange={handleFolderChange}
                    class="file-input"
                  />
                  <label for="folderInput" class="file-upload-label">
                    <svg class="file-upload-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M3 7V5C3 4.46957 3.21071 3.96086 3.58579 3.58579C3.96086 3.21071 4.46957 3 5 3H9.586C9.85119 3 10.1055 3.10536 10.293 3.29289L12.707 5.70711C12.8945 5.89464 13.1488 6 13.414 6H19C19.5304 6 20.0391 6.21071 20.4142 6.58579C20.7893 6.96086 21 7.46957 21 8V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      <path d="M7 13H17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      <path d="M7 17H13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="file-upload-text">Choose folder</span>
                    <span class="file-upload-subtext">All .xml files in folder will be selected</span>
                  </label>
                </div>
              </Show>
            </div>
          </Show>
          
          <Show when={!isTrainingDay() && files().length > 0}>
            <div class="files-list">
              <h3 class="files-list-title">Selected Files ({getXmlFileCount()})</h3>
              <div class="files-table">
                {files().map((file, index) => (
                  <div class="file-item" data-key={index}>
                    <div class="file-info">
                      <svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                      <span class="file-name">{file.name}</span>
                      <span class="file-size">({(file.size / 1024 / 1024).toFixed(2)} MB)</span>
                    </div>
                    <button 
                      type="button"
                      onClick={() => removeFile(index)} 
                      class="remove-file-btn"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </Show>
          
          <button type="submit" class="login-button" disabled={isUploadDisabled()}>
            <span class="button-text">Upload Files</span>
            <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </form>
        </Show>

        <Show when={uploadSuccess()}>
          <div class="login-header">
            <div class="logo-section">
              <div class="logo-icon" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 12L11 14L15 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </div>
              <h1 class="login-title">Datasets Uploaded!</h1>
              <p class="login-subtitle">
                Your data files have been successfully processed and uploaded.
              </p>
            </div>
          </div>
          
          <div class="login-footer">
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top: 8px;">
              <button 
                onClick={() => { resetUpload(); }} 
                class="login-button"
              >
                <span class="button-text">Upload More Files</span>
                <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button 
                onClick={() => {
                  // Clear dataset selection so user returns to datasets page
                  setSelectedDatasetId(0);
                  setSelectedDate("");
                  navigate('/dashboard');
                }}
                class="login-button"
                style="background:#2563eb"
              >
                <span class="button-text">Go to Dashboard</span>
              </button>
            </div>
          </div>
        </Show>

        <Show when={uploadFailed()}>
          <div class="login-header">
            <div class="logo-section">
              <div class="logo-icon" style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                  <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2"/>
                  <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2"/>
                </svg>
              </div>
              <h1 class="login-title">Upload Failed</h1>
              <p class="login-subtitle">
                {errorMessage() || 'There was an error uploading your files.'}
              </p>
            </div>
          </div>
          
          <div class="login-footer">
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top: 8px;">
              <button 
                onClick={() => { resetUpload(); }} 
                class="login-button"
              >
                <span class="button-text">Try Again</span>
                <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1 4v6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M23 20v-6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </div>
        </Show>
        </div>
      </div>

      <BackButton />
    </div>

    {/* Process Conflict Modal */}
    <Show when={showProcessConflictModal()}>
      <Portal>
        <div
          class="pagesettings-overlay"
          onClick={() => {
            // Don't close on overlay click - user must make a choice
          }}
          style={{
            display: 'flex',
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            'background-color': 'rgba(0, 0, 0, 0.5)',
            'z-index': 10000,
            'align-items': 'center',
            'justify-content': 'center'
          }}
        >
          <div
            class="pagesettings-modal"
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative',
              'z-index': 10001,
              'max-width': '600px',
              width: '90%'
            }}
          >
            <div class="flex justify-between items-center p-4 border-b" style="border-color: var(--color-border-primary);">
              <h2 class="text-lg font-semibold" style="color: var(--color-text-primary);">
                Processes Already Running
              </h2>
              <button
                onClick={() => {
                  setShowProcessConflictModal(false);
                  setRunningProcessesInfo(null);
                }}
                class="text-gray-500 hover:text-gray-700 transition-colors"
                style="color: var(--color-text-secondary);"
              >
                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                </svg>
              </button>
            </div>

            <div class="p-6">
              <p style="color: var(--color-text-primary); margin-bottom: 1rem;">
                There {runningProcessesInfo()?.running_count === 1 ? 'is' : 'are'} {runningProcessesInfo()?.running_count || 0} process{runningProcessesInfo()?.running_count !== 1 ? 'es' : ''} already running:
              </p>
              
              <div style="background-color: var(--color-bg-secondary); padding: 1rem; border-radius: 4px; margin-bottom: 1.5rem; max-height: 200px; overflow-y: auto;">
                <For each={runningProcessesInfo()?.processes || []}>
                  {(proc: any) => (
                    <div style="margin-bottom: 0.5rem; color: var(--color-text-primary);">
                      <strong>{proc.script_name}</strong> ({proc.class_name})
                      <br />
                      <span style="font-size: 0.875rem; color: var(--color-text-secondary);">
                        Started: {new Date(proc.started_at).toLocaleString() || 'unknown'}
                      </span>
                    </div>
                  )}
                </For>
              </div>

              <p style="color: var(--color-text-primary); margin-bottom: 1.5rem;">
                Would you like to:
              </p>
              <ul style="color: var(--color-text-primary); margin-bottom: 1.5rem; padding-left: 1.5rem;">
                <li>Cancel the running process{runningProcessesInfo()?.running_count !== 1 ? 'es' : ''} and start the upload</li>
                <li>Add this upload to the queue (wait for processes to complete)</li>
              </ul>

              <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '0.5rem' }}>
                <button
                  onClick={() => {
                    setShowProcessConflictModal(false);
                    setRunningProcessesInfo(null);
                  }}
                  class="px-4 py-2 text-sm rounded-md transition-colors"
                  style="background-color: var(--color-bg-button-secondary); color: var(--color-text-button-secondary);"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleUploadWithProcessDecision(false)}
                  class="px-4 py-2 text-sm rounded-md transition-colors font-medium"
                  style="background-color: var(--color-bg-button); color: var(--color-text-inverse);"
                >
                  Add to Queue
                </button>
                <button
                  onClick={() => handleUploadWithProcessDecision(true)}
                  class="px-4 py-2 text-sm rounded-md transition-colors font-medium"
                  style="background-color: #dc2626; color: white;"
                >
                  Cancel Processes & Upload
                </button>
              </div>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
    </>
  );
};
