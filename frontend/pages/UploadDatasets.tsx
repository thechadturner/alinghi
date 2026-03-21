import { createSignal, Show, For, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { getData, postData, putData, getCookie } from "../utils/global";
import { authManager } from "../utils/authManager";
import { logActivity, logPageLoad } from "../utils/logging";
import { error as logError, debug, warn } from "../utils/console";

import BackButton from "../components/buttons/BackButton";

import { persistantStore } from "../store/persistantStore";
import { sseManager } from "../store/sseManager";
import { processStore } from "../store/processStore";
import { toastStore } from "../store/toastStore";
import { apiEndpoints } from "@config/env";
const { selectedClassName, selectedProjectId, setSelectedDatasetId, setSelectedDate, selectedSourceName } = persistantStore;

export default function UploadDatasetsPage() {
  const navigate = useNavigate();
  const [files, setFiles] = createSignal<File[]>([]);
  const [sourceName, setSourceName] = createSignal("");
  const [eventName, setEventName] = createSignal("");
  const [timezone, setTimezone] = createSignal("Europe/Madrid");
  const [timezones, setTimezones] = createSignal<string[]>([]);
  const [showWaiting, setShowWaiting] = createSignal(false);
  const [uploadSuccess, setUploadSuccess] = createSignal(false);
  const [uploadFailed, setUploadFailed] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal("");
  const [currentStatus, setCurrentStatus] = createSignal("");
  const [processId, setProcessId] = createSignal("");
  const [folderMode, setFolderMode] = createSignal(false);
  const [batchMode, setBatchMode] = createSignal(true);
  const [onlyCsvMatchingXmlFolders, setOnlyCsvMatchingXmlFolders] = createSignal(false);
  // Generic upload fields (race day, race type, dataset date for dataset_id assignment)
  const [raceDay, setRaceDay] = createSignal<'race' | 'training'>('race');
  const [raceType, setRaceType] = createSignal<'inshore' | 'coastal' | 'offshore'>('inshore');
  const [datasetDate, setDatasetDate] = createSignal<string>('');
  const [uploadProgress, setUploadProgress] = createSignal({ current: 0, total: 0 });
  const [isProcessing, setIsProcessing] = createSignal(false);
  const [processingCancelled, setProcessingCancelled] = createSignal(false);
  const [allProcessIds, setAllProcessIds] = createSignal<string[]>([]);
  const [currentStep, setCurrentStep] = createSignal(1);

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
        const tzNames = response.data.map((tz: any) => tz.name || tz).sort();
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

  // Auto-populate source name and default dataset date
  onMount(async () => {
    const currentSourceName = selectedSourceName();
    if (currentSourceName) {
      setSourceName(currentSourceName);
    }
    // Initialize batch mode (default is true)
    setBatchMode(true);
    // Automatically enable folder mode when batch mode is enabled
    setFolderMode(true);
    // Default dataset date to today (YYYY-MM-DD) for generic upload
    if (!datasetDate()) {
      const today = new Date();
      setDatasetDate(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
    }
    // Fetch timezones
    await fetchTimezones();
  });

  const handleFileChange = async (event: Event) => {
    const selectedFiles = Array.from((event.target as HTMLInputElement).files || []);
    
    // Filter for .csv files only (generic dataset upload)
    const allowedFiles = selectedFiles.filter(file => {
      const fileNameLower = file.name.toLowerCase();
      return fileNameLower.endsWith('.csv');
    });
    
    if (allowedFiles.length === 0) {
      debug('[UploadDatasets] No .csv files selected');
      return;
    }
    
    // Basic validation - full verification happens on server
    try {
      for (const file of allowedFiles) {
        await validateFileBasic(file);
      }
      
      // Apply CSV filtering by XML folders if checkbox is checked
      let filesToAdd = allowedFiles;
      let filterMessage = '';
      
      if (onlyCsvMatchingXmlFolders()) {
        const { filteredFiles, xmlFolders, csvFilteredCount } = filterCsvByXmlFolders(allowedFiles);
        filesToAdd = filteredFiles;
        
        if (xmlFolders.size === 0) {
          filterMessage = 'No XML files found - only XML files will be uploaded (no CSV files)';
          warn('[UploadDatasets] Filter enabled but no XML files found - CSV files excluded');
        } else if (csvFilteredCount > 0) {
          filterMessage = `${csvFilteredCount} CSV file(s) filtered - only folders with XML files included (${xmlFolders.size} folder(s) found)`;
          debug(`[UploadDatasets] CSV filtering applied: ${csvFilteredCount} CSV file(s) filtered out`);
        } else {
          filterMessage = `All CSV files match XML folders (${xmlFolders.size} folder(s) found)`;
        }
        
        if (filterMessage) {
          toastStore.showToast('info', 'CSV Filter Applied', filterMessage);
        }
      }
      
      setFiles([...files(), ...filesToAdd]);
      
      // Log file selection activity
      await logActivity(
        selectedProjectId() || 0, 
        0, 
        'UploadDatasets.tsx', 
        'Files Selected', 
        {
          fileCount: filesToAdd.length,
          fileNames: filesToAdd.map(f => f.name),
          totalFiles: files().length + filesToAdd.length,
          filterApplied: onlyCsvMatchingXmlFolders(),
          csvFilteredCount: onlyCsvMatchingXmlFolders() ? allowedFiles.length - filesToAdd.length : 0
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
    
    // Filter for .csv files only (generic dataset upload)
    const allowedFiles = selectedFiles.filter(file => {
      const fileNameLower = file.name.toLowerCase();
      return fileNameLower.endsWith('.csv');
    });
    
    if (allowedFiles.length === 0) {
      debug('[UploadDatasets] No .csv files found in selected folder');
      return;
    }
    
    // Basic validation - full verification happens on server
    try {
      for (const file of allowedFiles) {
        await validateFileBasic(file);
      }
      
      // Apply CSV filtering by XML folders if checkbox is checked
      let filesToAdd = allowedFiles;
      let filterMessage = '';
      
      if (onlyCsvMatchingXmlFolders()) {
        const { filteredFiles, xmlFolders, csvFilteredCount } = filterCsvByXmlFolders(allowedFiles);
        filesToAdd = filteredFiles;
        
        if (xmlFolders.size === 0) {
          filterMessage = 'No XML files found - only XML files will be uploaded (no CSV files)';
          warn('[UploadDatasets] Filter enabled but no XML files found - CSV files excluded');
        } else if (csvFilteredCount > 0) {
          filterMessage = `${csvFilteredCount} CSV file(s) filtered - only folders with XML files included (${xmlFolders.size} folder(s) found)`;
          debug(`[UploadDatasets] CSV filtering applied: ${csvFilteredCount} CSV file(s) filtered out`);
        } else {
          filterMessage = `All CSV files match XML folders (${xmlFolders.size} folder(s) found)`;
        }
        
        if (filterMessage) {
          toastStore.showToast('info', 'CSV Filter Applied', filterMessage);
        }
      }
      
      // Replace existing files with folder files (or add them)
      setFiles([...files(), ...filesToAdd]);
      
      debug('[UploadDatasets] Folder selected:', {
        totalFiles: selectedFiles.length,
        allowedFiles: allowedFiles.length,
        filesToAdd: filesToAdd.length,
        fileNames: filesToAdd.map(f => f.name),
        filterApplied: onlyCsvMatchingXmlFolders()
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
          filesToAdd: filesToAdd.length,
          fileNames: filesToAdd.map(f => f.name),
          totalFilesAfter: files().length + filesToAdd.length,
          filterApplied: onlyCsvMatchingXmlFolders(),
          csvFilteredCount: onlyCsvMatchingXmlFolders() ? allowedFiles.length - filesToAdd.length : 0
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
    setFiles(files().filter((_, i) => i !== index));
    
    // Log file removal activity
    await logActivity(
      selectedProjectId() || 0, 
      0, 
      'UploadDatasets.tsx', 
      'File Removed', 
      {
        fileName: fileToRemove.name,
        remainingFiles: files().length - 1
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
    setRaceDay('race');
    setRaceType('inshore');
    const today = new Date();
    setDatasetDate(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
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

  // Helper function to check if file is CSV
  const isCsvFile = (filename: string): boolean => {
    const fileNameLower = filename.toLowerCase();
    return fileNameLower.endsWith('.csv') || fileNameLower.endsWith('_10hz.csv');
  };

  /**
   * Filters CSV files to only include those in folders matching XML folder names.
   * Process: First collect unique folder names from XML files, then filter CSV files by matching folder names.
   * 
   * @param files - Array of files to filter
   * @returns Filtered array containing all XML files + CSV files in folders with XML files
   */
  const filterCsvByXmlFolders = (files: File[]): { filteredFiles: File[], xmlFolders: Set<string>, csvFilteredCount: number } => {
    const xmlFiles: File[] = [];
    const csvFiles: File[] = [];
    const xmlFolderNames = new Set<string>();

    // Step 1: Separate XML and CSV files
    for (const file of files) {
      if (isXmlFile(file.name)) {
        xmlFiles.push(file);
      } else if (isCsvFile(file.name)) {
        csvFiles.push(file);
      }
    }

    // Step 2: Collect unique date folder names from XML files
    for (const xmlFile of xmlFiles) {
      const dateFolder = getDateFolderFromPath(xmlFile);
      if (dateFolder) {
        xmlFolderNames.add(dateFolder);
        debug(`[UploadDatasets] Found date folder "${dateFolder}" from XML file: ${xmlFile.name}`);
      } else {
        debug(`[UploadDatasets] No date folder found in XML file path: ${xmlFile.name} (webkitRelativePath: ${(xmlFile as any).webkitRelativePath || 'N/A'})`);
      }
    }

    // Step 3: Filter CSV files to only include those in folders matching XML date folder names
    const filteredCsvFiles: File[] = [];
    for (const csvFile of csvFiles) {
      const dateFolder = getDateFolderFromPath(csvFile);
      if (dateFolder && xmlFolderNames.has(dateFolder)) {
        filteredCsvFiles.push(csvFile);
        debug(`[UploadDatasets] CSV file "${csvFile.name}" matches XML date folder "${dateFolder}"`);
      } else {
        debug(`[UploadDatasets] CSV file "${csvFile.name}" filtered out - date folder: ${dateFolder || 'not found'}, XML folders: ${Array.from(xmlFolderNames).join(', ') || 'none'}`);
      }
    }

    // Step 4: Combine all XML files + filtered CSV files
    const filteredFiles = [...xmlFiles, ...filteredCsvFiles];
    const csvFilteredCount = csvFiles.length - filteredCsvFiles.length;

    debug(`[UploadDatasets] filterCsvByXmlFolders: Found ${xmlFolderNames.size} XML folder(s), filtered ${csvFilteredCount} CSV file(s) out, ${filteredCsvFiles.length} CSV file(s) remain`, {
      xmlFolders: Array.from(xmlFolderNames),
      csvFilesBefore: csvFiles.length,
      csvFilesAfter: filteredCsvFiles.length,
      csvFilteredOut: csvFilteredCount
    });

    return {
      filteredFiles,
      xmlFolders: xmlFolderNames,
      csvFilteredCount
    };
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
    isAllMode: boolean,
    sourceNameToUse: string,
    skipNormalization: boolean = false
  ) => {
    debug('[UploadDatasets] Processing folder group:', {
      folderDate,
      fileCount: folderFiles.length,
      fileNames: folderFiles.map(f => f.name)
    });

    // Helper function to check if file is XML (doesn't need source matching)
    const isXmlFile = (filename) => {
      return filename.toLowerCase().endsWith('.xml');
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

    // Helper function to match filename to source
    const matchFileToSource = (filename) => {
      const filenameLower = filename.toLowerCase();
      return allSources.find(
        (s) => {
          if (!s.source_name) return false;
          const sourceNameLower = s.source_name.toLowerCase();
          return filenameLower.indexOf(sourceNameLower) !== -1;
        }
      );
    };

    // Group files by source
    const filesBySource = new Map(); // Map<source_id, {source: source, files: File[]}>
    const unmatchedFiles = [];
    const xmlFiles = []; // XML files that don't need source matching

    if (isAllMode) {
      // Get first available source for XML files (they don't need to match by filename)
      const firstSource = allSources.length > 0 ? allSources[0] : null;

      // Match each file to a source
      for (const file of folderFiles) {
        // XML files don't need to match a source by filename - assign to first available source
        if (isXmlFile(file.name)) {
          xmlFiles.push(file);
          if (firstSource) {
            if (!filesBySource.has(firstSource.source_id)) {
              filesBySource.set(firstSource.source_id, {
                source: firstSource,
                files: []
              });
            }
            filesBySource.get(firstSource.source_id).files.push(file);
          } else {
            // No sources available, add to unmatched (shouldn't happen normally)
            unmatchedFiles.push(file);
          }
          continue;
        }

        const matchedSource = matchFileToSource(file.name);
        if (matchedSource) {
          if (!filesBySource.has(matchedSource.source_id)) {
            filesBySource.set(matchedSource.source_id, {
              source: matchedSource,
              files: []
            });
          }
          filesBySource.get(matchedSource.source_id).files.push(file);
        } else {
          unmatchedFiles.push(file);
        }
      }

      // Log XML files that were assigned to first source
      if (xmlFiles.length > 0 && firstSource) {
        debug(`[UploadDatasets] ${xmlFiles.length} XML file(s) in folder ${folderDate} assigned to first source (${firstSource.source_name}):`, 
          xmlFiles.map(f => f.name));
      }

      if (unmatchedFiles.length > 0) {
        const unmatchedFileNames = unmatchedFiles.map(f => f.name);
        const availableSourceNames = allSources.map(s => s.source_name).filter(Boolean);
        warn(`[UploadDatasets] ${unmatchedFiles.length} file(s) in folder ${folderDate} could not be matched to any source:`, 
          unmatchedFileNames);
        warn(`[UploadDatasets] Available sources:`, availableSourceNames);
        throw new Error(
          `Could not match ${unmatchedFiles.length} file(s) in folder ${folderDate} to any source.\n` +
          `Unmatched files: ${unmatchedFileNames.join(', ')}\n` +
          `Available sources: ${availableSourceNames.join(', ')}\n` +
          `Please ensure filenames contain source names, or select a specific source instead of "ALL".`
        );
      }
    } else {
      // Single source mode - use provided source name
      const matchedSource = allSources.find(
        (s) => s.source_name && s.source_name.toLowerCase() === sourceNameToUse.toLowerCase()
      );

      if (matchedSource) {
        filesBySource.set(matchedSource.source_id, {
          source: matchedSource,
          files: folderFiles
        });
      } else {
        // Source doesn't exist, create it
        setCurrentStatus(`Creating data source for folder ${folderDate}...`);
        
        await logActivity(
          selectedProjectId() || 0, 
          0, 
          'UploadDatasets.tsx', 
          'Source Creation Attempt', 
          {
            sourceName: sourceNameToUse,
            className: selectedClassName(),
            folderDate
          }
        );
        
        let response_json = await postData(`${apiEndpoints.app.sources}`, {
            class_name: selectedClassName(),
            project_id: selectedProjectId(),
            source_name: sourceNameToUse,
            color: "#ffffff"
        });

        if (!response_json.success) {
          throw new Error('Failed to create data source');
        }

        const newSourceId = response_json.data;
        if (newSourceId <= 0) {
          throw new Error('Invalid source ID returned');
        }

        // Create a temporary source object for the new source
        filesBySource.set(newSourceId, {
          source: { source_id: newSourceId, source_name: sourceNameToUse },
          files: folderFiles
        });

        await logActivity(
          selectedProjectId() || 0, 
          0, 
          'UploadDatasets.tsx', 
          'Source Created Successfully', 
          {
            sourceId: newSourceId,
            sourceName: sourceNameToUse,
            folderDate
          }
        );
      }
    }

    // Helper function to extract date from filename (format: YYYYMMDD_* or YYYY-MM-DD_*)
    const extractDateFromFilename = (filename) => {
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

    // Use folder date if available, otherwise extract from filenames
    const folderDateFormatted = folderDate !== 'ungrouped' ? folderDate : null;

    // Upload each file individually to get accurate dates per file
    const fileUploadResults = []; // Array of {sourceId, sourceName, file, dates: []}
    const datesBySource = new Map(); // Map<source_id, Set<date>> - for tracking unique dates per source
    const accessToken = authManager.getAccessToken();

    // Upload each file individually
    let totalFiles = 0;
    let xmlFileCount = 0;
    for (const [sourceId, { source, files: sourceFiles }] of filesBySource.entries()) {
      totalFiles += sourceFiles.length;
      // Count XML files separately
      xmlFileCount += sourceFiles.filter(f => isXmlFile(f.name)).length;
    }

    // Step 1: Upload Phase - count all files (including XML)
    // Initialize progress tracking for upload phase
    setCurrentStep(1);
    setUploadProgress({ current: 0, total: totalFiles });
    let uploadedFileCount = 0;
    
    for (const [sourceId, { source, files: sourceFiles }] of filesBySource.entries()) {
      // Separate XML files from data files for this source
      const xmlFilesForSource = sourceFiles.filter(f => isXmlFile(f.name));
      const dataFilesForSource = sourceFiles.filter(f => !isXmlFile(f.name));
      
      // Extract dates from XML files
      const xmlFileDates = new Map<File, string>();
      for (const xmlFile of xmlFilesForSource) {
        const xmlDate = await extractDateFromXml(xmlFile);
        if (xmlDate) {
          xmlFileDates.set(xmlFile, xmlDate);
          debug(`[UploadDatasets] Extracted date ${xmlDate} from XML file ${xmlFile.name}`);
        } else {
          warn(`[UploadDatasets] Could not extract date from XML file ${xmlFile.name}, will use folder date`);
          if (folderDateFormatted) {
            xmlFileDates.set(xmlFile, folderDateFormatted);
          }
        }
      }
      
      // Upload ALL files together (data + XML) so they share date context
      // This ensures XML files get dates from data files even if data files are processed first
      const allFilesForSource = [...dataFilesForSource, ...xmlFilesForSource];
      
      for (const file of allFilesForSource) {
        uploadedFileCount++;
        const progressPercent = Math.round((uploadedFileCount / totalFiles) * 100);
        const isXml = isXmlFile(file.name);
        const fileType = isXml ? 'XML' : 'data';
        setUploadProgress({ current: uploadedFileCount, total: totalFiles });
        setCurrentStatus(`Checking ${fileType} file ${uploadedFileCount} of ${totalFiles} (${progressPercent}%) from folder ${folderDate}: ${file.name}...`);

        try {
          // Check if file already exists before uploading (client-side check)
          let isDuplicate = false;
          let fileResult: any = null;
          let dates: string[] = [];
          
          // Use folder date if available, otherwise try to extract from filename
          let checkDate = folderDateFormatted;
          if (!checkDate) {
            checkDate = extractDateFromFilename(file.name);
          }
          
          // Only check if we have a date to use
          if (checkDate) {
            // Format date as YYYYMMDD for API (remove dashes)
            const formattedDateForCheck = checkDate.replace(/-/g, '');
            
            try {
              const checkUrl = `${apiEndpoints.admin.upload}/check-file?` + new URLSearchParams({
                class_name: selectedClassName().toLowerCase(),
                project_id: selectedProjectId().toString(),
                source_name: source.source_name,
                date: formattedDateForCheck,
                file_name: file.name,
                file_size: file.size.toString(),
                is_xml: isXml ? 'true' : 'false'
              });
              
              const checkResponse = await getData(checkUrl);
              
              if (checkResponse.success && checkResponse.data?.isDuplicate) {
                isDuplicate = true;
                debug('[UploadDatasets] File is duplicate (client-side check):', {
                  fileName: file.name,
                  folderDate,
                  checkDate
                });
                
                // Create a mock fileResult similar to what the server would return
                fileResult = {
                  fileName: file.name,
                  success: true,
                  skipped: true,
                  message: 'File already exists with same name and size',
                  needsNormalization: skipNormalization && !isXml
                };
                
                // Use the check date for dates array
                dates = [checkDate];
                
                setCurrentStatus(`${fileType} file ${uploadedFileCount} of ${totalFiles} (${progressPercent}%) skipped from folder ${folderDate}: ${file.name} (already exists with same name and size)`);
              }
            } catch (checkError) {
              // If check fails, continue with upload (non-critical)
              warn('[UploadDatasets] Error checking file existence, continuing with upload:', {
                fileName: file.name,
                error: checkError
              });
            }
          }
          
          // Only upload if not a duplicate
          let uploadResponse = null;
          if (!isDuplicate) {
            // Capture current values for setTimeout closure
            const currentUploadedCount = uploadedFileCount;
            const currentTotalFiles = totalFiles;
            const currentFileName = file.name;
            
            setCurrentStatus(`Uploading ${fileType} file ${currentUploadedCount} of ${currentTotalFiles} (${progressPercent}%) from folder ${folderDate}: ${currentFileName}...`);
            
            const formData = new FormData();
            formData.append('files', file);
            formData.append('class_name', selectedClassName().toLowerCase());
            formData.append('project_id', selectedProjectId().toString());
            formData.append('source_name', source.source_name);
            // Dataset date is in local time; pass timezone so server uses local date for folder path when deriving date from file content
            formData.append('timezone', timezone() || 'Europe/Madrid');
            formData.append('event_name', eventName() || '');
            formData.append('race_day', raceDay().toUpperCase());
            formData.append('race_type', raceType().toUpperCase());
            if (datasetDate()) {
              formData.append('dataset_date', datasetDate());
            }
            if (skipNormalization) {
              formData.append('skip_normalization', 'true');
            }

            // Start upload - normalization happens server-side during this request (unless skipped)
            const uploadPromise = fetch(`${apiEndpoints.admin.upload}/data`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'X-CSRF-Token': getCookie('csrf_token') || ''
            },
            body: formData
          });

          // Show normalization status while waiting for response (only for data files and if not skipping)
          if (!isXml && !skipNormalization) {
            setTimeout(() => {
              const progressPercentForStatus = Math.round((currentUploadedCount / currentTotalFiles) * 100);
              setCurrentStatus(`Normalizing file ${currentUploadedCount} of ${currentTotalFiles} (${progressPercentForStatus}%) from folder ${folderDate}: ${currentFileName}...`);
            }, 500);
          }

            let response = await uploadPromise;
            
            // After upload completes, increment progress for normalization (if not skipped)
            if (!isXml && !skipNormalization) {
              // Normalization happens server-side, so we count it as complete after upload
              // Progress will be updated in the normalization phase if skipNormalization is true
            }

            if (!response.ok) {
            let errorMessage = `Upload failed for ${file.name}: ${response.status} ${response.statusText}`;
            try {
              const errorText = await response.text();
              try {
                const errorJson = JSON.parse(errorText);
                if (errorJson.message) {
                  errorMessage = `Upload failed for ${file.name}: ${errorJson.message}`;
                }
              } catch {
                if (errorText && errorText.length < 500) {
                  errorMessage = `Upload failed for ${file.name}: ${errorText}`;
                }
              }
            } catch (e) {
              debug('Could not read error response:', e);
            }
            
            // Check if this is a skippable error (e.g., "Cannot calculate median of an empty array")
            const isSkippableError = errorMessage.includes('Cannot calculate median of an empty array') ||
                                   errorMessage.includes('empty array') ||
                                   errorMessage.includes('median');
            
            if (isSkippableError) {
              warn('[UploadDatasets] Skipping file due to processing error:', {
                fileName: file.name,
                errorMessage: errorMessage,
                folderDate
              });
              setCurrentStatus(`Skipped file ${uploadedFileCount} of ${totalFiles} from folder ${folderDate}: ${file.name} (processing error)`);
              continue; // Skip this file and continue with the next one
            }
            
            logError('Upload request failed:', errorMessage);
            throw new Error(errorMessage);
          }

            // Calculate progress and status (reuse existing variables from outer scope)
            const uploadProgressPercent = Math.round((uploadedFileCount / totalFiles) * 100);
            setCurrentStatus(`${fileType} file ${uploadedFileCount} of ${totalFiles} (${uploadProgressPercent}%) uploaded from folder ${folderDate}: ${file.name}`);
            uploadResponse = await response.json();
            
            if (!uploadResponse.success) {
            const errorMsg = uploadResponse.message || 'Unknown error';
            
            // Check if this is a skippable error
            // The error message format can be: "0 file(s) succeeded, 1 file(s) failed: [{"fileName":"...","success":false,"message":"Cannot calculate median of an empty array"}]"
            let isSkippableError = false;
            
            // Check error message string
            if (errorMsg.includes('Cannot calculate median of an empty array') ||
                errorMsg.includes('empty array') ||
                errorMsg.includes('median')) {
              isSkippableError = true;
            }
            
            // Check if error data contains failed files with skippable errors
            if (!isSkippableError && uploadResponse.data) {
              try {
                // Try to parse as JSON string if it's a string
                let errorData = uploadResponse.data;
                if (typeof errorData === 'string') {
                  // Look for JSON array in the error message
                  const jsonMatch = errorData.match(/\[.*\]/);
                  if (jsonMatch) {
                    errorData = JSON.parse(jsonMatch[0]);
                  }
                }
                
                if (Array.isArray(errorData)) {
                  isSkippableError = errorData.some((item: any) => {
                    if (item && item.message) {
                      return item.message.includes('Cannot calculate median of an empty array') ||
                             item.message.includes('empty array') ||
                             item.message.includes('median');
                    }
                    return false;
                  });
                } else if (errorData && typeof errorData === 'object') {
                  // Check if it's a single error object
                  if (errorData.message) {
                    isSkippableError = errorData.message.includes('Cannot calculate median of an empty array') ||
                                      errorData.message.includes('empty array') ||
                                      errorData.message.includes('median');
                  }
                }
              } catch (e) {
                // If parsing fails, check the raw string
                const errorDataStr = String(uploadResponse.data);
                isSkippableError = errorDataStr.includes('Cannot calculate median of an empty array') ||
                                  errorDataStr.includes('empty array') ||
                                  errorDataStr.includes('median');
              }
            }
            
            if (isSkippableError) {
              warn('[UploadDatasets] Skipping file due to processing error:', {
                fileName: file.name,
                errorMsg: errorMsg,
                fullResponse: uploadResponse,
                folderDate
              });
              setCurrentStatus(`Skipped file ${uploadedFileCount} of ${totalFiles} from folder ${folderDate}: ${file.name} (processing error)`);
              continue; // Skip this file and continue with the next one
            }
            
            logError('Upload response indicates failure:', {
              fileName: file.name,
              errorMsg: errorMsg,
              fullResponse: uploadResponse
            });
            throw new Error(`Upload failed for ${file.name}: ${errorMsg}`);
          }

            // Extract response data only if uploadResponse is set (not a duplicate)
            if (uploadResponse) {
              const responseData = uploadResponse.data;
              
              // Handle response structure - can include results when skipNormalization is true OR when files are skipped
              if (responseData && typeof responseData === 'object' && !Array.isArray(responseData) && responseData.dates) {
                dates = Array.isArray(responseData.dates) ? responseData.dates : [];
                // Extract file result from results array (available when skipNormalization is true or files are skipped)
                if (responseData.results && Array.isArray(responseData.results)) {
                  fileResult = responseData.results.find(r => r.fileName === file.name);
                }
              } else {
                // Legacy response structure (just dates array)
                dates = Array.isArray(responseData) ? responseData : [];
              }
            }
          }
          
          // Check if file was skipped (duplicate) - either from client-side check or server response
          if (fileResult?.skipped || isDuplicate) {
            const progressPercent = Math.round((uploadedFileCount / totalFiles) * 100);
            const fileType = isXmlFile(file.name) ? 'XML' : 'data';
            setCurrentStatus(`${fileType} file ${uploadedFileCount} of ${totalFiles} (${progressPercent}%) skipped from folder ${folderDate}: ${file.name} (already exists with same name and size)`);
            debug('[UploadDatasets] File skipped (duplicate):', {
              fileName: file.name,
              message: fileResult?.message || 'File already exists with same name and size',
              folderDate,
              note: isDuplicate ? 'Skipped via client-side check (no upload needed - saves time!)' : 'File was still uploaded to server for duplicate check - this is why uploads take time even for duplicates'
            });
          }
          
          // If no dates returned from upload, try folder date or filename date as fallback
          if (dates.length === 0) {
            if (folderDateFormatted) {
              dates = [folderDateFormatted];
              debug('[UploadDatasets] No dates from upload, using folder date:', {
                fileName: file.name,
                folderDate: folderDateFormatted
              });
            } else {
              const filenameDate = extractDateFromFilename(file.name);
              if (filenameDate) {
                dates = [filenameDate];
                debug('[UploadDatasets] No dates from upload, using filename date:', {
                  fileName: file.name,
                  extractedDate: filenameDate
                });
              } else {
                warn('[UploadDatasets] No dates found in upload response, folder, or filename for file:', file.name);
              }
            }
          }
          
          // Store result for this file
          fileUploadResults.push({
            sourceId: sourceId,
            sourceName: source.source_name,
            file: file,
            dates: dates,
            needsNormalization: skipNormalization && !isXml && fileResult?.needsNormalization === true,
            savePath: fileResult?.savePath || null,
            skipped: fileResult?.skipped || false
          });

          // Track dates per source (using Set to avoid duplicates)
          // Only track dates from data files (not XML files) to prevent creating datasets
          // for sources that only have XML metadata files without actual data files
          if (!isXml) {
            if (!datesBySource.has(sourceId)) {
              datesBySource.set(sourceId, new Set());
            }
            dates.forEach(date => datesBySource.get(sourceId).add(date));
          }

          // Log successful file upload (skip logging for duplicate files to save time)
          if (!fileResult?.skipped) {
            await logActivity(
              selectedProjectId() || 0, 
              0, 
              'UploadDatasets.tsx', 
              'File Uploaded Successfully', 
              {
                fileName: file.name,
                dates: dates,
                sourceId: sourceId,
                sourceName: source.source_name,
                folderDate
              }
            );
          }
        } catch (error: any) {
          // Check if this is a skippable error
          const errorMessage = error?.message || String(error);
          
          // Check for skippable error patterns
          const isSkippableError = errorMessage.includes('Cannot calculate median of an empty array') ||
                                 errorMessage.includes('empty array') ||
                                 errorMessage.includes('median') ||
                                 errorMessage.includes('0 file(s) succeeded') && errorMessage.includes('failed');
          
          if (isSkippableError) {
            warn('[UploadDatasets] Skipping file due to error:', {
              fileName: file.name,
              errorMessage: errorMessage,
              folderDate
            });
            
            // Extract a short error description for status
            let shortError = 'processing error';
            if (errorMessage.includes('median')) {
              shortError = 'empty data error';
            }
            
            setCurrentStatus(`Skipped file ${uploadedFileCount} of ${totalFiles} from folder ${folderDate}: ${file.name} (${shortError})`);
            continue; // Skip this file and continue with the next one
          }
          
          // For non-skippable errors, log but continue processing
          // Only stop for truly critical errors (network failures, authentication, etc.)
          const isCriticalError = errorMessage.includes('Unauthorized') ||
                                 errorMessage.includes('Forbidden') ||
                                 errorMessage.includes('Network') ||
                                 errorMessage.includes('Failed to fetch') ||
                                 errorMessage.includes('timeout') ||
                                 (error as any)?.status === 401 ||
                                 (error as any)?.status === 403;
          
          if (isCriticalError) {
            // Only throw for critical errors that would affect all files
            logError('[UploadDatasets] Critical error during file upload - stopping processing:', {
              fileName: file.name,
              error: error,
              folderDate
            });
            throw error;
          } else {
            // For other errors, log and continue with next file
            logError('[UploadDatasets] Error during file upload - continuing with next file:', {
              fileName: file.name,
              error: error,
              folderDate
            });
            setCurrentStatus(`Error uploading file ${uploadedFileCount} of ${totalFiles} from folder ${folderDate}: ${file.name} - continuing with next file...`);
            continue; // Continue with next file instead of stopping
          }
        }
      }
      
      // XML files are now uploaded together with data files above (in allFilesForSource loop)
      // They share date context, so no separate upload needed
    }

    // Convert Sets back to Arrays for dataset creation
    const datesBySourceArray = new Map();
    for (const [sourceId, dateSet] of datesBySource.entries()) {
      datesBySourceArray.set(sourceId, Array.from(dateSet));
    }

    return { filesBySource, datesBySourceArray, fileUploadResults };
  };

  const handleUpload = async () => {
    debug('[UploadDatasets] handleUpload called - setting showWaiting to true');
    
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
        fileCount: files().length,
        fileNames: files().map(f => f.name),
        sourceName: sourceName(),
        eventName: eventName(),
        datasetDate: datasetDate(),
        raceDay: raceDay(),
        raceType: raceType(),
        className: selectedClassName()
      }
    ).catch(err => debug('[UploadDatasets] Error logging activity:', err));

    try {
      // ========== PHASE 0: Group files by date-formatted folders ==========
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
      const isAllMode = batchMode(); // Use batch mode checkbox instead of selectedSourceName check
      const sourceNameToUse = sourceName() || selectedSourceName() || '';

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
          totalFilesProcessed += folderFiles.length;
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
      
      // Calculate normalization total before processing
      const filesToNormalize = allFileUploadResults.filter(r => r.needsNormalization && r.savePath);
      const normalizationTotal = filesToNormalize.length;
      
      // Run processing in background (await to keep modal open and show progress)
      try {
        // Step 2: Normalization Phase - count only data files (exclude XML)
        if (filesToNormalize.length > 0) {
          setCurrentStep(2);
          setUploadProgress({ current: 0, total: normalizationTotal });
          debug('[UploadDatasets] Starting normalization for files:', filesToNormalize.length);
          setCurrentStatus(`Normalizing ${filesToNormalize.length} file(s)...`);
        }
          
        for (let i = 0; i < filesToNormalize.length; i++) {
          const fileResult = filesToNormalize[i];
          try {
            const normalizeProgress = i + 1;
            const normalizePercent = Math.round((normalizeProgress / normalizationTotal) * 100);
            setCurrentStatus(`Normalizing file ${normalizeProgress} of ${normalizationTotal} (${normalizePercent}%): ${fileResult.file.name}...`);
            setUploadProgress({ current: normalizeProgress, total: normalizationTotal });
            await normalizeFile(fileResult.savePath, fileResult.dates[0], fileResult.sourceName);
            debug('[UploadDatasets] Normalized file:', fileResult.file.name);
          } catch (error) {
            warn('[UploadDatasets] Error normalizing file:', { fileName: fileResult.file.name, error });
            // Still increment progress even if normalization fails
            const normalizeProgress = i + 1;
            setUploadProgress({ current: normalizeProgress, total: normalizationTotal });
            // Continue with other files even if one fails
          }
        }
        
        debug('[UploadDatasets] Normalization complete, starting dataset creation');
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

        // Create datasets for each date-source combination in this folder
        debug('[UploadDatasets] Starting dataset creation for folder:', {
          folderDate,
          datesBySourceEntries: Array.from(datesBySourceArray.entries()).map(([id, dates]) => ({
            sourceId: id,
            dates: dates,
            uniqueDates: [...new Set(dates)]
          }))
        });

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
        
        for (const [sourceId, dates] of datesBySourceArray.entries()) {
          const { source } = filesBySource.get(sourceId);
          const uniqueSourceDates = [...new Set(dates)].sort(); // Sort dates (oldest to newest)
          // When user provides dataset date (generic upload), create one dataset per source with that date only
          const uniqueSourceDatesToUse = datasetDate()
            ? [datasetDate()!]
            : uniqueSourceDates;
          
          debug('[UploadDatasets] Processing source for dataset creation:', {
            folderDate,
            sourceId: sourceId,
            sourceName: source.source_name,
            dates: dates,
            uniqueSourceDates: uniqueSourceDates,
            usingDates: uniqueSourceDatesToUse
          });
          
          for (let i = 0; i < uniqueSourceDatesToUse.length; i++) {
            const date = uniqueSourceDatesToUse[i];
            const year = new Date(date).getFullYear();

            setCurrentStatus(`Creating dataset ${allCreatedDatasetIds.length + 1} for ${source.source_name} (folder ${folderDate})...`);

            // Create dataset first - day number will be set in prepopulateDatasetInfo after dataset exists
            const currentTimezone = timezone() || 'Europe/Madrid';
            debug('[UploadDatasets] Timezone value when creating dataset:', { 
              timezoneSignal: timezone(), 
              currentTimezone, 
              willUse: currentTimezone 
            });
            
            const datasetPayload: Record<string, unknown> = {
                class_name: selectedClassName(),
                project_id: selectedProjectId(),
                source_id: sourceId,
                date: date,
                year_name: year, 
                event_name: eventName(),
                report_name: 'NA', // Will be updated in prepopulateDatasetInfo
                description: 'NA',
                timezone: currentTimezone, // Use selected timezone or default
                tags: JSON.stringify({
                  isUploaded: true,
                  ...(raceType() && { Race_type: raceType().toUpperCase() })
                }),
                ...(raceDay() && { race_day: raceDay().toUpperCase() }),
                ...(raceType() && { race_type: raceType().toUpperCase() })
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
          datasetIds: allCreatedDatasetIds
        });

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
        const uploadProcessIds = [];
        
        debug('[UploadDatasets] Script execution check:', {
          totalFilesProcessed: totalFilesProcessed,
          allCreatedDatasetIds: allCreatedDatasetIds.length,
          willExecuteScript: totalFilesProcessed > 1
        });
        
        if (totalFilesProcessed > 1) {
          debug('[UploadDatasets] Starting script execution for multi-file upload');
          
          // Step 3: Processing Phase - count only datasets (exclude XML-only datasets)
          const processingTotal = allCreatedDatasetIds.length;
          setCurrentStep(3);
          setUploadProgress({ current: 0, total: processingTotal });
          setCurrentStatus("Executing processing scripts...");
          
          // Enable batch suppression mode BEFORE executing scripts
          processStore.enableBatchSuppressMode();
          debug('[UploadDatasets] Batch suppress mode enabled for script executions');
          
          // Collect all dataset tasks for parallel processing
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
          
          // Process datasets in parallel (2 at a time to match 2 CPU cores)
          // With only 2 cores, running more processes causes CPU contention and context switching overhead
          // Consider increasing concurrency if you add more CPU cores
          const processIdsArray = await processDatasetsInParallel(datasetTasks, 2);
          
          setAllProcessIds(processIdsArray);
          
          // All processes have already completed during parallel processing
          // This section is kept for any additional cleanup or verification if needed
          if (processIdsArray.length > 0) {
            debug('[UploadDatasets] All script executions completed via parallel processing:', processIdsArray);
            setCurrentStatus(`All processing complete: ${processIdsArray.length} dataset(s) processed`);
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
        
        if (uploadProcessIds.length > 0 || totalFilesProcessed > 0) {
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
        logError('[UploadDatasets] Error in background processing:', error);
        setShowWaiting(false);
        setUploadFailed(true);
        setErrorMessage(`Processing error: ${error.message}`);
        toastStore.showToast('error', 'Processing Error', 'An error occurred during background processing. Please check the logs.');
      }

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
        const report_desc_response = await getData(
          `${apiEndpoints.app.datasets}/desc?class_name=${selectedClassName()}&project_id=${selectedProjectId()}&dataset_id=${encodeURIComponent(datasetId)}`
        );

        debug('[UploadDatasets] Description fetch response:', { 
          datasetId, 
          success: report_desc_response.success, 
          data: report_desc_response.data,
          dataLength: report_desc_response.data?.length 
        });

        if (report_desc_response.success) {
          let races = report_desc_response.data;
          let description = 'NA';

          if (races && races.length > 0) {
            // Extract race numbers from objects - matching DatasetInfo.jsx logic
            const raceNumbers = races.map(race => race.races);
            
            if (raceNumbers.length === 1) {
              description = "Race " + raceNumbers[0];
            } else if (raceNumbers.length === 2) {
              description = "Races " + raceNumbers[0] + " & " + raceNumbers[1];
            } else if (raceNumbers.length === 3) {
              description = "Races " + raceNumbers[0] + ", " + raceNumbers[1] + " & " + raceNumbers[2];
            } else if (raceNumbers.length > 3) {
              // 4 or more races
              const lastRace = raceNumbers[raceNumbers.length - 1];
              const otherRaces = raceNumbers.slice(0, -1).join(", ");
              description = "Races " + otherRaces + " & " + lastRace;
            }
            
            debug('[UploadDatasets] Description formatted:', { datasetId, description, raceNumbers });
            
            // Update the dataset with the description
            if (description !== 'NA') {
              // Fetch existing dataset to get current values
              const existingDatasetResponse = await getData(
                `${apiEndpoints.app.datasets}/id?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&dataset_id=${encodeURIComponent(datasetId)}`
              );
              
              if (existingDatasetResponse.success && existingDatasetResponse.data) {
                const existing = existingDatasetResponse.data;
                const shared_int = existing.shared ? 1 : 0;
                const datasetTimezone = existing.timezone || timezone() || 'Europe/Madrid';
                
                // Update dataset with description
                const updateResponse = await putData(`${apiEndpoints.app.datasets}`, {
                  class_name: selectedClassName(),
                  project_id: selectedProjectId(),
                  dataset_id: datasetId,
                  event_name: eventName(),
                  report_name: existing.report_name || 'NA',
                  description: description,
                  timezone: datasetTimezone,
                  tws: existing.tws || '',
                  twd: existing.twd || '',
                  shared: shared_int
                });
                
                if (updateResponse.success) {
                  debug('[UploadDatasets] Description updated successfully:', { datasetId, description });
                } else {
                  warn('[UploadDatasets] Failed to update description:', { datasetId, error: updateResponse.message });
                }
              } else {
                warn('[UploadDatasets] Failed to fetch existing dataset for description update:', { datasetId });
              }
            } else {
              debug('[UploadDatasets] No races found, description remains NA:', { datasetId });
            }
          } else {
            debug('[UploadDatasets] No race data available yet:', { datasetId });
          }
        } else {
          debug('[UploadDatasets] Description fetch failed:', { datasetId, message: report_desc_response.message });
        }
      } catch (error) {
        warn('[UploadDatasets] Error updating description:', { datasetId, error });
      }
    }
  };

  // Helper function to pre-populate dataset info
  const prepopulateDatasetInfo = async (datasetIds, datasetInfoMap) => {
    for (let i = 0; i < datasetIds.length; i++) {
      const datasetId = datasetIds[i];
      const datasetInfo = datasetInfoMap.get(datasetId);
      
      if (!datasetInfo) {
        warn(`[UploadDatasets] No dataset info found for dataset ${datasetId}`);
        continue;
      }
      
      const { date, source_name, source_id } = datasetInfo;
      
      setCurrentStatus(`Pre-populating dataset ${i + 1} of ${datasetIds.length}...`);

      try {
        // Use the day number we fetched immediately after creating the dataset
        // This ensures each dataset gets the correct sequential number
        let report_name = 'NA';
        
        if (datasetInfo.dayNumber !== null && datasetInfo.dayNumber !== undefined) {
          // Use the day number we already fetched
          report_name = 'Day ' + datasetInfo.dayNumber;
          debug('[UploadDatasets] Using pre-fetched day number:', { datasetId, dayNumber: datasetInfo.dayNumber, report_name });
        } else {
          // Fallback: query the day number if we don't have it
          // Only query if event_name is provided (required by API)
          if (eventName() && eventName().trim() !== '') {
            try {
              const dayUrl = `${apiEndpoints.app.datasets}/day?class_name=${selectedClassName()}&project_id=${selectedProjectId()}&source_id=${source_id}&event_name=${encodeURIComponent(eventName())}`;
              debug('[UploadDatasets] Day number not pre-fetched, querying now:', dayUrl);
              
              const report_name_response = await getData(dayUrl);

              debug('[UploadDatasets] Day number response:', { 
                datasetId, 
                success: report_name_response.success, 
                data: report_name_response.data,
                dataType: typeof report_name_response.data,
                message: report_name_response.message,
                source_id, 
                event_name: eventName() 
              });
              
              if (report_name_response.success && report_name_response.data !== null && report_name_response.data !== undefined) {
                // The day endpoint returns the count of datasets for this source/event
                // This is the day number (1, 2, 3, etc.)
                const dayNumber = report_name_response.data;
                
                // Handle both number and string responses
                const dayNumberValue = typeof dayNumber === 'string' ? parseInt(dayNumber, 10) : dayNumber;
                
                debug('[UploadDatasets] Day number parsed:', { datasetId, dayNumber, dayNumberValue, isValid: !isNaN(dayNumberValue) && dayNumberValue > 0 });
                
                // Only set if day number is greater than 0 (0 means no datasets found, which shouldn't happen after creation)
                if (!isNaN(dayNumberValue) && dayNumberValue > 0) {
                  report_name = 'Day ' + dayNumberValue;
                  debug('[UploadDatasets] Day number set to:', report_name);
                } else {
                  warn('[UploadDatasets] Day number is invalid or 0:', { dayNumber, dayNumberValue, datasetId });
                }
              } else {
                warn('[UploadDatasets] Day number not available for dataset:', { 
                  datasetId, 
                  success: report_name_response.success, 
                  data: report_name_response.data,
                  message: report_name_response.message 
                });
              }
            } catch (error) {
              // Silently handle errors - day number is optional, dataset will work without it
              debug('[UploadDatasets] Error fetching day number (non-critical):', { 
                datasetId, 
                error: error instanceof Error ? error.message : String(error),
                source_id,
                event_name: eventName()
              });
            }
          } else {
            debug('[UploadDatasets] Skipping day number query - event_name is empty');
          }
        }

        // Skip description fetching during initial prepopulation
        // Race events are created by the processing scripts, so descriptions won't be available yet
        // We'll update descriptions after processing completes
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
          event_name: eventName(),
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
  };

  // Helper function to normalize a single file
  const normalizeFile = async (savePath: string, date: string, source_name: string) => {
    debug('[UploadDatasets] normalizeFile called:', {
      savePath,
      date,
      source_name
    });
    
    try {
      const sanitizedDate = date.replace(/[-/]/g, "");
      
      const parameters = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName(),
        dataset_id: '0',
        date: sanitizedDate,
        source_name: source_name,
        file_name: savePath
      };
      
      const payload = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName(),
        script_name: '1_normalization_csv.py',
        parameters: parameters
      };
      
      debug('[UploadDatasets] Normalizing file with payload:', payload);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
      }, 300000); // 5 minute timeout
      
      const response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
      clearTimeout(timeoutId);
      
      debug('[UploadDatasets] Normalization response:', response_json);
      
      if (!response_json?.success) {
        logError('[UploadDatasets] Normalization failed:', {
          response: response_json,
          message: response_json?.message || 'Unknown error',
          savePath
        });
        return false;
      }
      
      return true;
    } catch (error) {
      if (error.name === 'AbortError') {
        warn('[UploadDatasets] Normalization timed out');
      } else {
        logError('Error normalizing file:', error);
      }
      return false;
    }
  };

  // Helper function to wait for a process to complete
  const waitForProcessCompletion = async (pid: string): Promise<void> => {
    return new Promise((resolve) => {
      let maxTimeout: ReturnType<typeof setTimeout> | null = null;
      
      const waitForCompletion = () => {
        const process = processStore.getProcess(pid);
        if (process) {
          if (process.status === 'complete') {
            debug('[UploadDatasets] Script execution completed:', pid);
            if (maxTimeout) clearTimeout(maxTimeout);
            resolve();
          } else if (process.status === 'error' || process.status === 'timeout') {
            warn('[UploadDatasets] Script execution failed:', { pid, status: process.status });
            if (maxTimeout) clearTimeout(maxTimeout);
            resolve(); // Resolve anyway to continue
          } else {
            // Still running, check again in 500ms
            setTimeout(waitForCompletion, 500);
          }
        } else {
          // Process not found yet, check again in 500ms
          setTimeout(waitForCompletion, 500);
        }
      };
      
      // Set a maximum timeout to prevent hanging
      maxTimeout = setTimeout(() => {
        warn('[UploadDatasets] Script execution timeout:', pid);
        resolve();
      }, 4500000); // 75 minute timeout (scripts can take up to 60 minutes: 30 min processing + 30 min execution)
      
      // Start checking for completion
      waitForCompletion();
    });
  };

  // Helper function to check for running processes
  const checkRunningProcesses = async (): Promise<{ running_count: number; processes: any[] } | null> => {
    try {
      const response = await getData(apiEndpoints.python.running_processes);
      if (response.success && response.data) {
        return response.data;
      }
      return null;
    } catch (error) {
      debug('[UploadDatasets] Error checking running processes:', error);
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

      const parameters: Record<string, string | boolean> = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName(),
        dataset_id: dataset_id.toString(),
        date: date,
        source_name: source_name,
        batch: true,
        verbose: false
      };
      if (raceDay()) {
        parameters.race_day = raceDay().toUpperCase();
      }
      if (raceType()) {
        parameters.race_type = raceType().toUpperCase();
      }

      let payload = {
        project_id: selectedProjectId().toString(),
        class_name: selectedClassName(),
        script_name: '2_process_and_execute.py',
        parameters: parameters
      };

      debug('[UploadDatasets] Executing script with payload:', payload);

      // Add a timeout to prevent hanging
      // Increased to 15 minutes to allow for server load and network latency
      // The server should return process_id quickly, but under heavy load with parallel requests it may take longer
      const startTime = Date.now();
      const timeoutId = setTimeout(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        warn('[UploadDatasets] Script start request timeout after', elapsed, 'seconds for dataset', dataset_id);
        controller.abort();
      }, 900000); // 15 minute timeout (allows time for server to start process and return process_id)
      
      let response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
      clearTimeout(timeoutId);
      
      debug('[UploadDatasets] Script execution server response:', response_json);
      
      // Check if server returned "process already running" status
      // For parallel processing, we wait for the process to complete instead of canceling
      // This allows concurrent execution without interruption
      if (response_json?.data?.process_already_running) {
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
        const retryResponse = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        if (!retryResponse?.success) {
          // Check if there's still a process running (race condition)
          if (retryResponse?.data?.process_already_running) {
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
          note: 'Script may still be running on server - check SSE messages for process_id'
        });
        // Don't return null immediately - the script might have started on the server
        // The SSE connection should pick up any process messages
        // Return null to indicate we don't have a process_id from the HTTP response
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
          note: 'Script may still be running on server - check SSE messages for process_id'
        });
      } else {
        logError('[UploadDatasets] Error executing script:', {
          error: error,
          dataset_id: dataset_id
        });
      }
      // Continue even if script execution fails
      return null; // Return null if script execution failed
    }
  };

  // Helper function to execute processing script for a single dataset (kept for backward compatibility)
  const executeProcessingScript = async (dataset_id: number, date: string, source_name: string): Promise<string | null> => {
    const pid = await startProcessingScript(dataset_id, date, source_name);
    if (pid) {
      await waitForProcessCompletion(pid);
    }
    return pid;
  };

  /**
   * Process datasets in parallel with a concurrency limit
   * @param datasetTasks - Array of tasks with { datasetId, date, source_name }
   * @param concurrency - Maximum number of concurrent processing tasks (default: 2, should match available CPU cores)
   * @returns Array of process IDs that were started
   */
  const processDatasetsInParallel = async (
    datasetTasks: Array<{ datasetId: number, date: string, source_name: string }>,
    concurrency: number = 2  // Default to 2 to match typical 2-core VMs
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
            uploadProcessIds.push(pid);
            return { datasetId: task.datasetId, pid, success: true };
          } else {
            warn('[UploadDatasets] Failed to start processing script:', { datasetId: task.datasetId, source_name: task.source_name });
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
        
        // Wait for all processes in the batch to complete
        await Promise.allSettled(batchProcessIds.map(pid => waitForProcessCompletion(pid)));
        
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
      return "Step 1 of 3: Uploading Files";
    } else if (step === 2) {
      return "Step 2 of 3: Normalizing Files";
    } else if (step === 3) {
      return "Step 3 of 3: Processing Files";
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
          <div class="form-group">
            <label class="form-label">Race Day</label>
            <div class="upload-toggle-group">
              <button
                type="button"
                class={`upload-toggle-btn ${raceDay() === 'race' ? 'active' : ''}`}
                onClick={() => {
                  setRaceDay('race');
                  debug('[UploadDatasets] Race day set to race');
                }}
              >
                RACE DAY
              </button>
              <button
                type="button"
                class={`upload-toggle-btn ${raceDay() === 'training' ? 'active' : ''}`}
                onClick={() => {
                  setRaceDay('training');
                  debug('[UploadDatasets] Race day set to training');
                }}
              >
                TRAINING DAY
              </button>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Race Type</label>
            <div class="upload-toggle-group">
              <button
                type="button"
                class={`upload-toggle-btn ${raceType() === 'inshore' ? 'active' : ''}`}
                onClick={() => {
                  setRaceType('inshore');
                  debug('[UploadDatasets] Race type set to inshore');
                }}
              >
                INSHORE
              </button>
              <button
                type="button"
                class={`upload-toggle-btn ${raceType() === 'coastal' ? 'active' : ''}`}
                onClick={() => {
                  setRaceType('coastal');
                  debug('[UploadDatasets] Race type set to coastal');
                }}
              >
                COASTAL
              </button>
              <button
                type="button"
                class={`upload-toggle-btn ${raceType() === 'offshore' ? 'active' : ''}`}
                onClick={() => {
                  setRaceType('offshore');
                  debug('[UploadDatasets] Race type set to offshore');
                }}
              >
                OFFSHORE
              </button>
            </div>
          </div>

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
            <label for="datasetDate" class="form-label">Dataset Date</label>
            <div class="input-container">
              <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" stroke="currentColor" stroke-width="2"/>
                <line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <input
                id="datasetDate"
                type="date"
                value={datasetDate()}
                onInput={(e) => {
                  const val = (e.target as HTMLInputElement).value;
                  setDatasetDate(val);
                  debug('[UploadDatasets] Dataset date set:', val);
                }}
                class="form-input"
              />
            </div>
            <p class="form-hint">Date used for dataset_id and dataset assignment</p>
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
                class="form-input form-input-select"
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
          
          <Show when={!batchMode()}>
            <div class="form-group">
              <label for="sourceName" class="form-label">Data Source Name</label>
              <div class="input-container">
                <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M21 16V8C20.9996 7.64927 20.9071 7.30481 20.7315 7.00116C20.556 6.69751 20.3037 6.44536 20 6.27L13 2.27C12.696 2.09446 12.3511 2.00205 12 2.00205C11.6489 2.00205 11.304 2.09446 11 2.27L4 6.27C3.69626 6.44536 3.44398 6.69751 3.26846 7.00116C3.09294 7.30481 3.00036 7.64927 3 8V16C3.00036 16.3507 3.09294 16.6952 3.26846 16.9988C3.44398 17.3025 3.69626 17.5546 4 17.73L11 21.73C11.304 21.9055 11.6489 21.9979 12 21.9979C12.3511 21.9979 12.696 21.9055 13 21.73L20 17.73C20.3037 17.5546 20.556 17.3025 20.7315 16.9988C20.9071 16.6952 20.9996 16.3507 21 16Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <polyline points="3.27,6.96 12,12.01 20.73,6.96" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <line x1="12" y1="22.08" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <input
                  id="sourceName"
                  type="text"
                  value={sourceName()}
                  onInput={(e) => setSourceName(e.target.value)}
                  placeholder="Enter data source name"
                  class="form-input"
                />
              </div>
            </div>
          </Show>
          
          <Show when={files().length === 0}>
            <div class="form-group">
              <div class="upload-folder-checkbox">
                <input
                  type="checkbox"
                  id="folderMode"
                  checked={folderMode()}
                  onChange={(e) => {
                    setFolderMode(e.target.checked);
                    setFiles([]);
                  }}
                  class="upload-folder-checkbox-input"
                />
                <label for="folderMode" class="upload-folder-checkbox-label">
                  Select folder (finds all .csv files)
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
                    accept=".csv"
                  />
                  <label for="fileInput" class="file-upload-label">
                    <svg class="file-upload-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    <span class="file-upload-text">Choose files or drag and drop</span>
                    <span class="file-upload-subtext">.csv files</span>
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
                    <span class="file-upload-subtext">All .csv files in folder will be selected</span>
                  </label>
                </div>
              </Show>
            </div>
          </Show>
          
          {files().length > 0 && (
            <div class="files-list">
              <h3 class="files-list-title">Selected Files ({files().length})</h3>
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
          )}
          
          {/* Batch mode and CSV filter kept in code for compatibility; hidden in generic upload UI */}
          
          <button type="submit" class="login-button" disabled={files().length === 0 || !eventName() || !datasetDate()}>
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
    </>
  );
};
