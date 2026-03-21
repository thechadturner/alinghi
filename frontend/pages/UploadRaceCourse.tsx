import { createSignal, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";

import BackButton from "../components/buttons/BackButton";
import WaitingModal from "../components/utilities/WaitingModal";

import { persistantStore } from "../store/persistantStore";
import { apiEndpoints } from "@config/env";
import { postData, getCookie } from "../utils/global";
import { authManager } from "../utils/authManager";
import { error as logError, debug, warn } from "../utils/console";
const { selectedClassName, selectedProjectId } = persistantStore;

export default function UploadRaceCoursePage() {
  const navigate = useNavigate();
  
  const [files, setFiles] = createSignal<File[]>([]);
  const [selectFolderMode, setSelectFolderMode] = createSignal(false);
  const [showWaiting, setShowWaiting] = createSignal(false);
  const [uploadSuccess, setUploadSuccess] = createSignal(false);
  const [uploadFailed, setUploadFailed] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal('');
  const [uploadResults, setUploadResults] = createSignal<{ 
    successful: Array<{ filename: string; date: string; savePath: string | null }>; 
    failed: Array<{ filename: string; reason: string }>; 
    skipped: Array<{ filename: string; reason: string }> 
  }>({ successful: [], failed: [], skipped: [] });
  const [currentStatus, setCurrentStatus] = createSignal('');

  // Debug: Log component mount and store values
  debug('[UploadRaceCourse] Component mounted', {
    selectedClassName: selectedClassName(),
    selectedProjectId: selectedProjectId()
  });

  const handleFileChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const selectedFiles = Array.from(input.files || []);
    if (selectFolderMode()) {
      // Folder mode: keep only .xml files from the folder (and subfolders)
      const xmlFiles = selectedFiles.filter((f) => f.name.toLowerCase().endsWith('.xml'));
      debug('[UploadRaceCourse] Folder selected: total files', selectedFiles.length, 'XML files', xmlFiles.length);
      setFiles([...files(), ...xmlFiles]);
    } else {
      setFiles([...files(), ...selectedFiles]);
    }
    input.value = ''; // Reset so the same folder/files can be re-selected
  };

  const onFolderModeChange = (checked: boolean) => {
    setSelectFolderMode(checked);
    setFiles([]);
  };

  const removeFile = (index: number) => {
    setFiles(files().filter((_, i) => i !== index));
  };

  const resetUpload = () => {
    setUploadSuccess(false);
    setUploadFailed(false);
    setErrorMessage('');
    setFiles([]);
    setUploadResults({ successful: [], failed: [], skipped: [] });
    setCurrentStatus('');
  };

  // Parse date from filename (first 6 characters as YYMMDD)
  // Example: 260116_130403R1A 275 .63_race.xml -> 260116 -> 2026-01-16
  const parseDateFromFilename = (filename: string): { date: string; formattedDate: string } | null => {
    // Extract first 6 characters before first underscore or dot
    const match = filename.match(/^(\d{6})/);
    if (!match || !match[1]) {
      return null;
    }
    
    const yymmdd = match[1];
    const yy = yymmdd.substring(0, 2);
    const mm = yymmdd.substring(2, 4);
    const dd = yymmdd.substring(4, 6);
    
    // Convert YY to YYYY (assume 20xx for years 00-99, adjust if needed)
    const year = parseInt(yy, 10);
    const fullYear = year < 50 ? 2000 + year : 1900 + year; // 00-49 = 2000-2049, 50-99 = 1950-1999
    
    // Validate month and day
    const month = parseInt(mm, 10);
    const day = parseInt(dd, 10);
    
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    
    const formattedDate = `${fullYear}-${mm}-${dd}`;
    const dateStr = `${fullYear}${mm}${dd}`; // YYYYMMDD format
    
    return { date: dateStr, formattedDate };
  };

  // Convert YYYYMMDD to YYYY-MM-DD format
  const formatDateForAPI = (dateStr: string): string | null => {
    if (dateStr.length !== 8) {
      return null;
    }
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    return `${year}-${month}-${day}`;
  };

  // Helper function to parse XML files using parseXml.py
  const parseXmlFiles = async (filePaths: string[], date: string): Promise<boolean> => {
    debug('[UploadRaceCourse] parseXmlFiles called:', {
      fileCount: filePaths.length,
      date,
      filePaths
    });
    
    try {
      const sanitizedDate = date.replace(/[-/]/g, "");
      
      // Get the folder path from the first file (all files should be in the same folder)
      const firstFilePath = filePaths[0];
      if (!firstFilePath) {
        throw new Error('No file paths provided for XML parsing');
      }
      
      // Extract directory path (remove filename)
      const lastSlash = Math.max(firstFilePath.lastIndexOf('\\'), firstFilePath.lastIndexOf('/'));
      const filePath = lastSlash > 0 ? firstFilePath.substring(0, lastSlash) : firstFilePath;
      
      debug('[UploadRaceCourse] Extracted folder path for XML parsing:', { filePath, fromPath: firstFilePath });
      
      const projectIdValue = selectedProjectId();
      const classNameValue = selectedClassName();

      if (!projectIdValue || projectIdValue === 0 || !classNameValue) {
        warn('[UploadRaceCourse] Missing project_id or class_name for XML parsing');
        return false;
      }

      const parameters = {
        project_id: projectIdValue.toString(),
        class_name: classNameValue,
        date: sanitizedDate,
        file_path: filePath
      };
      
      const payload = {
        project_id: projectIdValue.toString(),
        class_name: classNameValue,
        script_name: '1_parseXml.py',
        parameters: parameters
      };
      
      debug('[UploadRaceCourse] Parsing XML files with payload:', payload);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        warn('[UploadRaceCourse] XML parsing request timeout after 5 minutes, aborting...');
        controller.abort();
      }, 300000); // 5 minute timeout
      
      try {
        const response_json = await postData(apiEndpoints.python.execute_script, payload, controller.signal);
        clearTimeout(timeoutId);
        
        debug('[UploadRaceCourse] XML parsing response:', response_json);
        
        // Check if request was aborted (handled gracefully)
        if (response_json?.type === 'AbortError') {
          warn('[UploadRaceCourse] XML parsing request was aborted (timeout or cancellation)');
          return false;
        }
        
        if (!response_json?.success) {
          // Extract error details
          const errorMessage = response_json?.message || '';
          const data = response_json?.data || (response_json as any)?.body;
          const errorLines = response_json?.data?.error_lines || data?.error_lines || [];
          const outputLines = response_json?.data?.output_lines || data?.output_lines || [];
          
          logError('[UploadRaceCourse] XML parsing failed:', {
            response: response_json,
            message: errorMessage,
            errorLines: errorLines,
            outputLines: outputLines.slice(-10),
            filePath
          });
          
          return false;
        }
        
        return true;
      } catch (error) {
        clearTimeout(timeoutId);
        // Check if this is an AbortError that wasn't caught by postData
        if ((error as Error)?.name === 'AbortError' || (error as any)?.type === 'AbortError') {
          warn('[UploadRaceCourse] XML parsing request was aborted');
          return false;
        }
        throw error; // Re-throw to be handled by outer catch
      }
    } catch (error) {
      // Handle AbortError gracefully (request cancellation/timeout)
      if ((error as Error)?.name === 'AbortError' || (error as any)?.type === 'AbortError') {
        warn('[UploadRaceCourse] XML parsing request was aborted');
        return false;
      } else {
        logError('Error parsing XML files:', error);
      }
      return false;
    }
  };


  const handleUpload = async () => {
    setShowWaiting(true);
    setCurrentStatus('Processing files...');
    setUploadResults({ successful: [], failed: [], skipped: [] });

    const classNameValue = selectedClassName();
    const projectIdValue = selectedProjectId();

    if (!classNameValue || !projectIdValue || projectIdValue === 0) {
      setShowWaiting(false);
      setUploadFailed(true);
      setErrorMessage('Please select a class and project before uploading. Return to the dashboard and select a project first.');
      return;
    }

    const className = classNameValue.toLowerCase().replace(/[^a-zA-Z0-9_]/g, '_');
    const projectId = projectIdValue;

    // Date will be extracted from XML files by the server
    debug('Starting XML file upload:', {
      files: files().map(f => f.name),
      className,
      projectId
    });

    const results: {
      successful: Array<{ filename: string; date: string; savePath: string | null }>;
      failed: Array<{ filename: string; reason: string }>;
      skipped: Array<{ filename: string; reason: string }>;
    } = {
      successful: [],
      failed: [],
      skipped: []
    };

    const uploadAccessToken = authManager.getAccessToken();

    // Extract date from first file (all files should be from the same date)
    let extractedDate: { date: string; formattedDate: string } | null = null;
    if (files().length > 0) {
      const firstFile = files()[0];
      extractedDate = parseDateFromFilename(firstFile.name);
      if (!extractedDate) {
        setShowWaiting(false);
        setUploadFailed(true);
        setErrorMessage(`Could not parse date from filename: ${firstFile.name}. Expected format: YYMMDD_filename.xml (e.g., 260116_race.xml)`);
        return;
      }
      debug('[UploadRaceCourse] Extracted date from filename:', {
        filename: firstFile.name,
        date: extractedDate.date,
        formattedDate: extractedDate.formattedDate
      });
    }

    try {
      // Upload XML files
      for (let i = 0; i < files().length; i++) {
        const file = files()[i];
        setCurrentStatus(`Uploading ${i + 1} of ${files().length}: ${file.name}...`);

        // Validate file extension
        const fileExt = file.name.toLowerCase().endsWith('.xml') ? '.xml' : null;
        if (!fileExt) {
          results.skipped.push({
            filename: file.name,
            reason: 'File must have .xml extension'
          });
          continue;
        }

        // Validate date in filename matches the first file's date
        const fileDate = parseDateFromFilename(file.name);
        if (!fileDate) {
          results.skipped.push({
            filename: file.name,
            reason: 'Could not parse date from filename. Expected format: YYMMDD_filename.xml'
          });
          continue;
        }
        
        if (fileDate.date !== extractedDate!.date) {
          results.skipped.push({
            filename: file.name,
            reason: `Date mismatch: file date ${fileDate.formattedDate} does not match expected date ${extractedDate!.formattedDate}`
          });
          continue;
        }

        try {
          const formData = new FormData();
          formData.append('files', file);
          formData.append('class_name', className);
          formData.append('project_id', projectId.toString());
          formData.append('source_name', 'XML'); // Temporary source name for XML files
          formData.append('skip_normalization', 'true');
          
          // Note: The date will be extracted from the XML file by the server

          debug('[UploadRaceCourse] Uploading XML file:', {
            fileName: file.name,
            className,
            projectId
          });

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

          // Extract save path from response
          let savePath: string | null = null;
          if (uploadResponse.data?.results && Array.isArray(uploadResponse.data.results)) {
            const fileResult = uploadResponse.data.results.find((r: any) => r.fileName === file.name);
            if (fileResult) {
              savePath = fileResult?.savePath || null;
              
              // Check if server marked this as a duplicate/skipped file
              if (fileResult.skipped || fileResult.isDuplicate) {
                debug('[UploadRaceCourse] File was marked as duplicate by server:', {
                  fileName: file.name,
                  fileResult
                });
                results.skipped.push({
                  filename: file.name,
                  reason: fileResult.message || 'File already exists with same name and size'
                });
                continue;
              }
            }
          }

          debug('[UploadRaceCourse] XML file uploaded:', { fileName: file.name, savePath });
          results.successful.push({
            filename: file.name,
            date: fileDate.formattedDate,
            savePath: savePath
          });
        } catch (error) {
          logError(`Error uploading ${file.name}:`, error);
          results.failed.push({
            filename: file.name,
            reason: error instanceof Error ? error.message : 'Upload error'
          });
        }
      }

      setUploadResults(results);

      // If we have successfully uploaded files, execute parseXml.py
      const uploadedFiles = results.successful.filter(r => r.savePath !== null);
      if (uploadedFiles.length > 0) {
        setCurrentStatus('Parsing XML files...');
        const filePaths = uploadedFiles.map(r => r.savePath!).filter((p): p is string => p !== null);
        
        if (filePaths.length > 0 && extractedDate) {
          try {
            // Use the extracted date from filename
            const dateForParsing = extractedDate.formattedDate;
            
            const parseSuccess = await parseXmlFiles(filePaths, dateForParsing);
            if (parseSuccess) {
              debug('[UploadRaceCourse] XML parsing completed successfully');
            } else {
              warn('[UploadRaceCourse] XML parsing failed, but files were uploaded');
            }
          } catch (error) {
            warn('[UploadRaceCourse] Error during XML parsing:', error);
            // Don't fail the entire upload if parsing fails
          }
        }
      }

      // Determine overall status
      if (results.successful.length > 0 && results.failed.length === 0 && results.skipped.length === 0) {
        // All files successful
        setUploadSuccess(true);
        debug('All files uploaded successfully');
        setTimeout(() => navigate(`/dashboard`, { replace: true }), 3000);
      } else if (results.successful.length > 0) {
        // Some files successful, some failed/skipped
        setUploadSuccess(true);
        debug('Upload completed with some files skipped or failed:', results);
      } else if (results.failed.length > 0) {
        // All files failed
        setUploadFailed(true);
        setErrorMessage(`Upload failed for all files. Check details below.`);
        setTimeout(() => resetUpload(), 10000);
      } else {
        // All files skipped
        setUploadFailed(true);
        setErrorMessage(`All files were skipped. Check details below.`);
        setTimeout(() => resetUpload(), 10000);
      }

    } catch (error) {
      logError('Error during upload process:', error);
      setUploadFailed(true);
      setErrorMessage(`Upload error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setTimeout(() => resetUpload(), 5000);
    }

    setShowWaiting(false);
    setCurrentStatus('');
  };

  // Check if required store values are available
  const hasRequiredValues = () => {
    const className = selectedClassName();
    const projectId = selectedProjectId();
    return className && className.trim() !== '' && projectId && projectId > 0;
  };

  return (
    <Show when={!showWaiting()} fallback={<WaitingModal visible={true} customStatus={currentStatus() || 'Processing...'} />}>
    <div class="login-page">
      <div class="login-container" style="max-width: 800px;">
        <Show when={!hasRequiredValues()}>
          <div class="login-header">
            <div class="logo-section">
              <div class="logo-icon" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                  <line x1="12" y1="8" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                  <line x1="12" y1="16" x2="12.01" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
              </div>
              <h1 class="login-title">Configuration Required</h1>
              <p class="login-subtitle">Please select a project and class from the dashboard before uploading race course files.</p>
            </div>
          </div>
          <div class="login-footer">
            <button 
              onClick={() => navigate('/dashboard')} 
              class="login-button"
            >
              <span class="button-text">Go to Dashboard</span>
            </button>
          </div>
        </Show>
        <Show when={hasRequiredValues() && !uploadSuccess() && !uploadFailed()}>
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
              <h1 class="login-title">Upload Race Course</h1>
              <p class="login-subtitle">Upload XML race course files</p>
            </div>
          </div>
          
          <form class="login-form" onSubmit={(e) => { e.preventDefault(); handleUpload(); }}>
            <div class="form-group">
              <label for={selectFolderMode() ? 'folderInput' : 'fileInput'} class="form-label">{selectFolderMode() ? 'Select Folder' : 'Select XML Files'}</label>
              <div class="file-upload-container">
                <Show when={selectFolderMode()} fallback={
                  <input
                    id="fileInput"
                    type="file"
                    multiple
                    accept=".xml"
                    onChange={handleFileChange}
                    class="file-input"
                  />
                }>
                  <input
                    id="folderInput"
                    type="file"
                    multiple
                    webkitdirectory
                    directory
                    onChange={handleFileChange}
                    class="file-input"
                  />
                </Show>
                <label for={selectFolderMode() ? 'folderInput' : 'fileInput'} class="file-upload-label">
                  <svg class="file-upload-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <span class="file-upload-text">{selectFolderMode() ? 'Choose folder' : 'Choose files or drag and drop'}</span>
                  <span class="file-upload-subtext">{selectFolderMode() ? 'All .xml files in folder and subfolders' : 'XML race course files'}</span>
                </label>
              </div>
              <label class="form-label" style="display: flex; align-items: center; gap: 10px; margin-top: 12px;">
                <input
                  type="checkbox"
                  id="selectFolderCheckbox"
                  checked={selectFolderMode()}
                  onChange={(e) => onFolderModeChange((e.target as HTMLInputElement).checked)}
                  style="width: 18px; height: 18px; cursor: pointer;"
                />
                <span>Select folder (crawl for XML files)</span>
              </label>
            </div>
            
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
            
            <button type="submit" class="login-button" disabled={files().length === 0}>
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
              <h1 class="login-title">Upload Complete!</h1>
              <p class="login-subtitle">
                {uploadResults().successful.length > 0 && `${uploadResults().successful.length} file(s) uploaded successfully.`}
                {uploadResults().failed.length > 0 && ` ${uploadResults().failed.length} file(s) failed.`}
                {uploadResults().skipped.length > 0 && ` ${uploadResults().skipped.length} file(s) skipped.`}
              </p>
            </div>
          </div>
          
          {(uploadResults().successful.length > 0 || uploadResults().failed.length > 0 || uploadResults().skipped.length > 0) && (
            <div style="margin: 20px 0; max-height: 400px; overflow-y: auto;">
              {uploadResults().successful.length > 0 && (
                <div style="margin-bottom: 20px;">
                  <h3 style="color: #10b981; margin-bottom: 10px;">Successful ({uploadResults().successful.length})</h3>
                  <div style="background: #f0fdf4; padding: 10px; border-radius: 8px;">
                    {uploadResults().successful.map((item, idx) => (
                      <div data-key={idx} style="padding: 5px 0; border-bottom: 1px solid #bbf7d0;">
                        <div style="font-weight: 500;">{item.filename}</div>
                        <div style="font-size: 0.875rem; color: #666;">Date: {item.date}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {uploadResults().failed.length > 0 && (
                <div style="margin-bottom: 20px;">
                  <h3 style="color: #ef4444; margin-bottom: 10px;">Failed ({uploadResults().failed.length})</h3>
                  <div style="background: #fef2f2; padding: 10px; border-radius: 8px;">
                    {uploadResults().failed.map((item, idx) => (
                      <div data-key={idx} style="padding: 5px 0; border-bottom: 1px solid #fecaca;">
                        <div style="font-weight: 500;">{item.filename}</div>
                        <div style="font-size: 0.875rem; color: #666;">{item.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {uploadResults().skipped.length > 0 && (
                <div style="margin-bottom: 20px;">
                  <h3 style="color: #f59e0b; margin-bottom: 10px;">Skipped ({uploadResults().skipped.length})</h3>
                  <div style="background: #fffbeb; padding: 10px; border-radius: 8px;">
                    {uploadResults().skipped.map((item, idx) => (
                      <div data-key={idx} style="padding: 5px 0; border-bottom: 1px solid #fde68a;">
                        <div style="font-weight: 500;">{item.filename}</div>
                        <div style="font-size: 0.875rem; color: #666;">{item.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          
          <div class="login-footer">
            {uploadResults().failed.length === 0 && uploadResults().skipped.length === 0 && (
              <p class="footer-text">Redirecting to dashboard in 3 seconds...</p>
            )}
            <button 
              onClick={resetUpload} 
              class="login-button"
              style="margin-top: 16px;"
            >
              <span class="button-text">Upload More Files</span>
              <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 2H6C5.46957 2 4.96086 2.21071 4.58579 2.58579C4.21071 2.96086 4 3.46957 4 4V20C4 20.5304 4.21071 21.0391 4.58579 21.4142C4.96086 21.7893 5.46957 22 6 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V8L14 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
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
              <h1 class="login-title">Upload Failed!</h1>
              <p class="login-subtitle">{errorMessage() || 'An error occurred during upload.'}</p>
            </div>
          </div>
          
          {(uploadResults().failed.length > 0 || uploadResults().skipped.length > 0) && (
            <div style="margin: 20px 0; max-height: 400px; overflow-y: auto;">
              {uploadResults().failed.length > 0 && (
                <div style="margin-bottom: 20px;">
                  <h3 style="color: #ef4444; margin-bottom: 10px;">Failed ({uploadResults().failed.length})</h3>
                  <div style="background: #fef2f2; padding: 10px; border-radius: 8px;">
                    {uploadResults().failed.map((item, idx) => (
                      <div data-key={idx} style="padding: 5px 0; border-bottom: 1px solid #fecaca;">
                        <div style="font-weight: 500;">{item.filename}</div>
                        <div style="font-size: 0.875rem; color: #666;">{item.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {uploadResults().skipped.length > 0 && (
                <div style="margin-bottom: 20px;">
                  <h3 style="color: #f59e0b; margin-bottom: 10px;">Skipped ({uploadResults().skipped.length})</h3>
                  <div style="background: #fffbeb; padding: 10px; border-radius: 8px;">
                    {uploadResults().skipped.map((item, idx) => (
                      <div data-key={idx} style="padding: 5px 0; border-bottom: 1px solid #fde68a;">
                        <div style="font-weight: 500;">{item.filename}</div>
                        <div style="font-size: 0.875rem; color: #666;">{item.reason}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          
          <div class="login-footer">
            <p class="footer-text">Returning to upload page in 10 seconds...</p>
            <button 
              onClick={resetUpload} 
              class="login-button"
              style="margin-top: 16px; background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);"
            >
              <span class="button-text">Try Again</span>
              <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 4V10H7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M23 20V14H17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14L18.36 18.36A9 9 0 0 1 3.51 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </Show>
      </div>
      
      <BackButton />
    </div>
    </Show>
  );
};
