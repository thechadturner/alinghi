import { createSignal, Show } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";

import BackButton from "../components/buttons/BackButton";
import WaitingModal from "../components/utilities/WaitingModal";

import { persistantStore } from "../store/persistantStore";
import { apiEndpoints } from "@config/env";
import { getCookie } from "../utils/global";
import { authManager } from "../utils/authManager";
import { error as logError, debug } from "../utils/console";
const { selectedClassName, selectedProjectId } = persistantStore;

export default function UploadTargetsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  
  const file_type = typeof location.state === "object" && location.state !== null && "file_type" in location.state ? (location.state as { file_type: string }).file_type : undefined;

  const [files, setFiles] = createSignal<File[]>([]);
  const [showWaiting, setShowWaiting] = createSignal(false);
  const [uploadSuccess, setUploadSuccess] = createSignal(false);
  const [uploadFailed, setUploadFailed] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal('');
  const [convertToTarget, setConvertToTarget] = createSignal(false);

  const handleFileChange = (event: Event) => {
    const selectedFiles = Array.from((event.target as HTMLInputElement).files || []);
    setFiles([...files(), ...selectedFiles]);
  };

  const removeFile = (index: number) => {
    setFiles(files().filter((_, i) => i !== index));
  };

  const resetUpload = () => {
    setUploadSuccess(false);
    setUploadFailed(false);
    setErrorMessage('');
    setFiles([]);
    setConvertToTarget(false);
  };

  // Convert .plr file to target format
  const convertPlrToTarget = async (file: File): Promise<{ UPWIND: any[], DOWNWIND: any[] }> => {
    const text = await file.text();
    
    // Auto-detect delimiter
    const firstLine = text.split('\n')[0];
    const delimiter = firstLine.includes('\t') ? '\t' : (firstLine.includes(',') ? ',' : '\t');
    
    // Parse the file
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    if (lines.length < 2) {
      throw new Error('.plr file must have at least a header and one data row');
    }
    
    // Parse header row - first column is TWS (no header), rest are column headers
    const headerRow = lines[0].split(delimiter).map(col => col.trim());
    const headerRowLower = headerRow.map(col => col.toLowerCase());
    // Skip first column (TWS), parse headers from second column onwards
    const header = headerRowLower.slice(1);
    
    // Find column indices - try multiple variations
    const findColumnIndex = (variations: string[]) => {
      for (const variation of variations) {
        const index = header.findIndex(col => {
          const normalized = col.replace(/[^a-z0-9]/g, ''); // Remove special chars
          return normalized === variation || col.includes(variation);
        });
        if (index !== -1) return index;
      }
      return -1;
    };
    
    let twaUpIndex = findColumnIndex(['twaup', 'twa_up', 'upwindtwa', 'upwind_twa']);
    let bspUpIndex = findColumnIndex(['bspup', 'bsp_up', 'upwindbsp', 'upwind_bsp']);
    let twaDnIndex = findColumnIndex(['twadn', 'twa_dn', 'downwindtwa', 'downwind_twa']);
    let bspDnIndex = findColumnIndex(['bspdn', 'bsp_dn', 'downwindbsp', 'downwind_bsp']);
    
    // If not found and we have enough columns, infer from position
    // Format: TWS (empty), twaUp, bspUp, twa1, bsp1, twa2, bsp2, twa3, bsp3, twa4, bsp4, twaDn, bspDn, twa180, bsp180
    if (headerRow.length >= 11) {
      if (twaUpIndex === -1) twaUpIndex = 0; // First column after TWS
      if (bspUpIndex === -1) bspUpIndex = 1;
      // twaDn and bspDn position depends on whether twa4/bsp4 exist
      if (twaDnIndex === -1) twaDnIndex = headerRow.length >= 13 ? 10 : 8;
      if (bspDnIndex === -1) bspDnIndex = headerRow.length >= 13 ? 11 : 9;
    }
    
    // Validate required columns
    if (twaUpIndex === -1 || bspUpIndex === -1) {
      const availableColumns = headerRow.slice(1).join(', ');
      throw new Error(`Upwind target columns (twaUp, bspUp) not found in .plr file. Available columns: ${availableColumns}`);
    }
    if (twaDnIndex === -1 || bspDnIndex === -1) {
      const availableColumns = headerRow.slice(1).join(', ');
      throw new Error(`Downwind target columns (twaDn, bspDn) not found in .plr file. Available columns: ${availableColumns}`);
    }
    
    const upwindTargets: any[] = [];
    const downwindTargets: any[] = [];
    
    // Process data rows (skip header row)
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(delimiter).map(col => col.trim());
      
      // TWS is in first column (index 0), target columns start from index 1
      if (row.length < Math.max(twaUpIndex + 1, bspUpIndex + 1, twaDnIndex + 1, bspDnIndex + 1) + 1) {
        continue; // Skip incomplete rows
      }
      
      const tws = parseFloat(row[0]); // First column is TWS
      const twaUp = parseFloat(row[twaUpIndex + 1]); // +1 because TWS is at index 0
      const bspUp = parseFloat(row[bspUpIndex + 1]);
      const twaDn = parseFloat(row[twaDnIndex + 1]);
      const bspDn = parseFloat(row[bspDnIndex + 1]);
      
      // Skip rows with invalid data
      if (isNaN(tws) || isNaN(twaUp) || isNaN(bspUp) || isNaN(twaDn) || isNaN(bspDn)) {
        continue;
      }
      
      // Calculate VMG for upwind
      const vmgUpwind = Math.abs(Math.cos(twaUp * Math.PI / 180) * bspUp);
      
      // Calculate VMG for downwind
      const vmgDownwind = Math.abs(Math.cos(twaDn * Math.PI / 180) * bspDn);
      
      // Create upwind entry
      upwindTargets.push({
        tws: tws,
        bsp: bspUp,
        twa: twaUp,
        vmg: vmgUpwind,
        vmg_perc: 100
      });
      
      // Create downwind entry
      downwindTargets.push({
        tws: tws,
        bsp: bspDn,
        twa: twaDn,
        vmg: vmgDownwind,
        vmg_perc: 100
      });
    }
    
    if (upwindTargets.length === 0 || downwindTargets.length === 0) {
      throw new Error('No valid target data extracted from .plr file');
    }
    
    return {
      UPWIND: upwindTargets,
      DOWNWIND: downwindTargets
    };
  };

  // Convert polar file to target format
  const convertPolarToTarget = async (file: File): Promise<{ UPWIND: any[], DOWNWIND: any[] }> => {
    const text = await file.text();
    
    // Auto-detect delimiter
    const firstLine = text.split('\n')[0];
    const delimiter = firstLine.includes('\t') ? '\t' : (firstLine.includes(',') ? ',' : '\t');
    
    // Parse the file
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    if (lines.length < 2) {
      throw new Error('Polar file must have at least a header and one data row');
    }
    
    // Parse header
    const header = lines[0].split(delimiter).map(col => col.trim().toLowerCase());
    
    // Find column indices (header is already lowercased, check for both with and without asterisk)
    let twsIndex = header.findIndex(col => col.includes('tws'));
    const v1Index = header.findIndex(col => col === '*v1' || col === 'v1');
    const a1Index = header.findIndex(col => col === '*a1' || col === 'a1');
    const v6Index = header.findIndex(col => col === '*v6' || col === 'v6');
    const a6Index = header.findIndex(col => col === '*a6' || col === 'a6');
    
    // If TWS not found in header, assume it's the first column (no header, like PLR format)
    if (twsIndex === -1) {
      twsIndex = 0;
      debug('TWS column not found in header, assuming first column (index 0)');
    }
    if (v1Index === -1 || a1Index === -1) {
      throw new Error('Upwind target columns (*v1, *a1) not found in polar file');
    }
    if (v6Index === -1 || a6Index === -1) {
      throw new Error('Downwind target columns (*v6, *a6) not found in polar file');
    }
    
    const upwindTargets: any[] = [];
    const downwindTargets: any[] = [];
    
    // Process data rows
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(delimiter).map(col => col.trim());
      
      if (row.length < Math.max(twsIndex, v1Index, a1Index, v6Index, a6Index) + 1) {
        continue; // Skip incomplete rows
      }
      
      const tws = parseFloat(row[twsIndex]);
      const v1 = parseFloat(row[v1Index]);
      const a1 = parseFloat(row[a1Index]);
      const v6 = parseFloat(row[v6Index]);
      const a6 = parseFloat(row[a6Index]);
      
      // Skip rows with invalid data
      if (isNaN(tws) || isNaN(v1) || isNaN(a1) || isNaN(v6) || isNaN(a6)) {
        continue;
      }
      
      // Calculate VMG for upwind
      const vmgUpwind = Math.abs(Math.cos(a1 * Math.PI / 180) * v1);
      
      // Calculate VMG for downwind
      const vmgDownwind = Math.abs(Math.cos(a6 * Math.PI / 180) * v6);
      
      // Create upwind entry
      upwindTargets.push({
        tws: tws,
        bsp: v1,
        twa: a1,
        vmg: vmgUpwind,
        vmg_perc: 100
      });
      
      // Create downwind entry
      downwindTargets.push({
        tws: tws,
        bsp: v6,
        twa: a6,
        vmg: vmgDownwind,
        vmg_perc: 100
      });
    }
    
    if (upwindTargets.length === 0 || downwindTargets.length === 0) {
      throw new Error('No valid target data extracted from polar file');
    }
    
    return {
      UPWIND: upwindTargets,
      DOWNWIND: downwindTargets
    };
  };

  const handleUpload = async () => {
    setShowWaiting(true);

    // Ensure class name matches server validation regex: /^[a-zA-Z_][a-zA-Z0-9_]*$/
    const className = selectedClassName().toLowerCase().replace(/[^a-zA-Z0-9_]/g, '_');
    const projectId = selectedProjectId().toString();

    // Debug logging
    debug('Uploading files:', files().map(f => f.name));
    debug('Original class name:', selectedClassName());
    debug('Sanitized class name:', className);
    debug('Project ID:', projectId);
    debug('File type:', file_type);
    debug('Convert to target:', convertToTarget());

    try {
      const accessToken = authManager.getAccessToken();
      const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'X-CSRF-Token': getCookie('csrf_token') || ''
      };

      // Check for .plr files for target conversion (only needed when file_type === 'target' or convertToTarget is checked)
      const plrFiles = files().filter(file => file.name.toLowerCase().endsWith('.plr'));
      const allFiles = files();

      let targetUploadSuccess = false;
      let polarUploadSuccess = false;
      let uploadErrors: string[] = [];

      // When file_type === 'polar': Upload ALL files (including PLR) directly - server handles PLR parsing
      if (file_type === 'polar') {
        const formData = new FormData();
        allFiles.forEach(file => {
          formData.append('files', file);
        });

        formData.append('class_name', className);
        formData.append('project_id', projectId);

        debug('Uploading polar files to /polar endpoint (isPolar = 1):', allFiles.map(f => f.name));

        const polarResponse = await fetch(`${apiEndpoints.admin.upload}/polar`, {
          method: 'POST',
          credentials: 'include',
          headers: headers,
          body: formData
        });

        if (polarResponse.ok) {
          const response_json = await polarResponse.json();
          debug('Polar upload successful:', response_json);
          polarUploadSuccess = true;
        } else {
          const errorText = await polarResponse.text();
          logError('Failed to upload polar files:', polarResponse.status, polarResponse.statusText);
          logError('Error details:', errorText);
          
          try {
            const errorJson = JSON.parse(errorText);
            uploadErrors.push(`Polar upload failed: ${errorJson.message || polarResponse.statusText}`);
          } catch {
            uploadErrors.push(`Polar upload failed: ${polarResponse.status} ${polarResponse.statusText}`);
          }
        }

        // If convert to target is checked, also convert and upload targets
        if (convertToTarget() && polarUploadSuccess) {
          try {
            // Convert each polar file to target format and upload
            for (const file of allFiles) {
              try {
                // Check if file is PLR format - use appropriate converter
                const isPlrFile = file.name.toLowerCase().endsWith('.plr');
                debug(`Converting ${isPlrFile ? 'PLR' : 'polar'} file to target format:`, file.name);
                const targetData = isPlrFile 
                  ? await convertPlrToTarget(file)
                  : await convertPolarToTarget(file);
              
              // Create separate CSV strings for upwind and downwind
              const upwindCsvRows: string[] = [];
              const downwindCsvRows: string[] = [];
              
              // Add headers
              upwindCsvRows.push('TWS,BSP,TWA,VMG,Vmg_perc');
              downwindCsvRows.push('TWS,BSP,TWA,VMG,Vmg_perc');
              
              // Add upwind data
              targetData.UPWIND.forEach(entry => {
                upwindCsvRows.push(`${entry.tws},${entry.bsp},${entry.twa},${entry.vmg},${entry.vmg_perc || 100}`);
              });
              
              // Add downwind data
              targetData.DOWNWIND.forEach(entry => {
                downwindCsvRows.push(`${entry.tws},${entry.bsp},${entry.twa},${entry.vmg},${entry.vmg_perc || 100}`);
              });
              
              // Merge the two CSVs (upwind first, then downwind)
              // Skip header for downwind since we already have it
              const mergedCsv = [
                ...upwindCsvRows,
                ...downwindCsvRows.slice(1) // Skip header row from downwind
              ].join('\n');
              
              // Create target file name (use original name without extension + "_target" suffix to distinguish from polar)
              // This ensures polar and target can coexist with different isPolar values
              const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
              const targetFileName = `${fileNameWithoutExt}_target.csv`;

              // Create FormData for target upload
              const targetFormData = new FormData();
              const targetBlob = new Blob([mergedCsv], { type: 'text/csv' });
              targetFormData.append('files', targetBlob, targetFileName);
              targetFormData.append('class_name', className);
              targetFormData.append('project_id', projectId);

              debug('Uploading converted target:', targetFileName, '(with _target suffix to ensure isPolar = 0)');

              const targetResponse = await fetch(`${apiEndpoints.admin.upload}/target`, {
                method: 'POST',
                credentials: 'include',
                headers: headers,
                body: targetFormData
              });

              if (targetResponse.ok) {
                const targetResponseJson = await targetResponse.json();
                debug('Target upload successful:', targetResponseJson);
                targetUploadSuccess = true;
              } else {
                const errorText = await targetResponse.text();
                logError('Failed to upload target file:', targetResponse.status, targetResponse.statusText);
                logError('Error details:', errorText);
                
                try {
                  const errorJson = JSON.parse(errorText);
                  uploadErrors.push(`Target upload failed for ${file.name}: ${errorJson.message || targetResponse.statusText}`);
                } catch {
                  uploadErrors.push(`Target upload failed for ${file.name}: ${targetResponse.status} ${targetResponse.statusText}`);
                }
              }
            } catch (conversionError) {
              logError('Error converting polar to target:', conversionError);
              const errorMsg = conversionError instanceof Error ? conversionError.message : String(conversionError);
              uploadErrors.push(`Conversion failed for ${file.name}: ${errorMsg}`);
            }
          }
        } catch (error) {
          logError('Error during target conversion/upload:', error);
          const errorMsg = error instanceof Error ? error.message : String(error);
          uploadErrors.push(`Target conversion error: ${errorMsg}`);
        }
        }
      } else {
        // file_type === 'target' - handle PLR files for target conversion
        if (plrFiles.length > 0) {
          try {
            for (const file of plrFiles) {
              try {
                debug('Converting .plr to target format for:', file.name);
                const targetData = await convertPlrToTarget(file);
              
                // Create separate CSV strings for upwind and downwind
                const upwindCsvRows: string[] = [];
                const downwindCsvRows: string[] = [];
                
                // Add headers
                upwindCsvRows.push('TWS,BSP,TWA,VMG,Vmg_perc');
                downwindCsvRows.push('TWS,BSP,TWA,VMG,Vmg_perc');
                
                // Add upwind data
                targetData.UPWIND.forEach(entry => {
                  upwindCsvRows.push(`${entry.tws},${entry.bsp},${entry.twa},${entry.vmg},${entry.vmg_perc || 100}`);
                });
                
                // Add downwind data
                targetData.DOWNWIND.forEach(entry => {
                  downwindCsvRows.push(`${entry.tws},${entry.bsp},${entry.twa},${entry.vmg},${entry.vmg_perc || 100}`);
                });
                
                // Merge the two CSVs (upwind first, then downwind)
                // Skip header for downwind since we already have it
                const mergedCsv = [
                  ...upwindCsvRows,
                  ...downwindCsvRows.slice(1) // Skip header row from downwind
                ].join('\n');
                
                // Create target file name (use original name without extension + "_target" suffix to distinguish from polar)
                // This ensures polar and target can coexist with different isPolar values
                const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
                const targetFileName = `${fileNameWithoutExt}_target.csv`;

                // Create FormData for target upload
                const targetFormData = new FormData();
                const targetBlob = new Blob([mergedCsv], { type: 'text/csv' });
                targetFormData.append('files', targetBlob, targetFileName);
                targetFormData.append('class_name', className);
                targetFormData.append('project_id', projectId);

                debug('Uploading converted .plr target:', targetFileName, '(with _target suffix to ensure isPolar = 0)');

                const targetResponse = await fetch(`${apiEndpoints.admin.upload}/target`, {
                  method: 'POST',
                  credentials: 'include',
                  headers: headers,
                  body: targetFormData
                });

                if (targetResponse.ok) {
                  const targetResponseJson = await targetResponse.json();
                  debug('Target upload successful:', targetResponseJson);
                  targetUploadSuccess = true;
                } else {
                  const errorText = await targetResponse.text();
                  logError('Failed to upload target file:', targetResponse.status, targetResponse.statusText);
                  logError('Error details:', errorText);
                  
                  try {
                    const errorJson = JSON.parse(errorText);
                    uploadErrors.push(`Target upload failed for ${file.name}: ${errorJson.message || targetResponse.statusText}`);
                  } catch {
                    uploadErrors.push(`Target upload failed for ${file.name}: ${targetResponse.status} ${targetResponse.statusText}`);
                  }
                }
              } catch (conversionError) {
                logError('Error converting .plr file:', conversionError);
                const errorMsg = conversionError instanceof Error ? conversionError.message : String(conversionError);
                uploadErrors.push(`Conversion failed for ${file.name}: ${errorMsg}`);
                throw conversionError;
              }
            }
          } catch (error) {
            logError('Error during .plr target conversion/upload:', error);
            const errorMsg = error instanceof Error ? error.message : String(error);
            uploadErrors.push(`Target conversion error: ${errorMsg}`);
          }
        }

        // Handle other files (non-.plr) - upload to target endpoint
        const otherFiles = files().filter(file => !file.name.toLowerCase().endsWith('.plr'));
        if (otherFiles.length > 0) {
          const formData = new FormData();
          otherFiles.forEach(file => {
            formData.append('files', file);
          });

          formData.append('class_name', className);
          formData.append('project_id', projectId);

          debug('Uploading target files to /target endpoint (isPolar = 0):', otherFiles.map(f => f.name));

          const targetResponse = await fetch(`${apiEndpoints.admin.upload}/target`, {
            method: 'POST',
            credentials: 'include',
            headers: headers,
            body: formData
          });

          if (targetResponse.ok) {
            const response_json = await targetResponse.json();
            debug('Target upload successful:', response_json);
            targetUploadSuccess = true;
          } else {
            const errorText = await targetResponse.text();
            logError('Failed to upload target files:', targetResponse.status, targetResponse.statusText);
            logError('Error details:', errorText);
            
            try {
              const errorJson = JSON.parse(errorText);
              uploadErrors.push(`Target upload failed: ${errorJson.message || targetResponse.statusText}`);
            } catch {
              uploadErrors.push(`Target upload failed: ${targetResponse.status} ${targetResponse.statusText}`);
            }
          }
        }
      }

      // Determine overall success
      let shouldSucceed = false;
      
      if (file_type === 'polar') {
        // Polar mode: polar upload must succeed, and target upload if checkbox is checked
        const needsTarget = convertToTarget();
        shouldSucceed = polarUploadSuccess && (!needsTarget || targetUploadSuccess);
      } else if (file_type === 'target') {
        // Target mode: only target upload must succeed
        shouldSucceed = targetUploadSuccess;
      }

      if (shouldSucceed) {
        setUploadSuccess(true);
        setTimeout(() => navigate(`/dashboard`, { replace: true }), 3000);
        setFiles([]);
      } else {
        setUploadFailed(true);
        
        if (uploadErrors.length > 0) {
          setErrorMessage(uploadErrors.join('; '));
        } else {
          setErrorMessage('Upload failed: Unknown error');
        }
        
        setTimeout(() => resetUpload(), 5000);
      }
    } catch (error) {
      logError('Error uploading files:', error);
      setUploadFailed(true);
      const errorMsg = error instanceof Error ? error.message : String(error);
      setErrorMessage(`Upload error: ${errorMsg}`);
      setTimeout(() => resetUpload(), 5000);
    }

    setShowWaiting(false);
  };

  return (
    <Show when={!showWaiting()} fallback={<WaitingModal visible={true} />}>
    <div class="login-page">
      <div class="login-container" style="max-width: 800px;">
        <Show when={!uploadSuccess() && !uploadFailed()}>
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
              <h1 class="login-title">
                <Show when={file_type == 'target'}>Upload Targets</Show>
                <Show when={file_type == 'polar'}>Upload Polars</Show>
              </h1>
              <p class="login-subtitle">
                <Show when={file_type == 'target'}>Upload or replace target files for your project</Show>
                <Show when={file_type == 'polar'}>Upload or replace polar files for your project</Show>
              </p>
            </div>
          </div>
          
          <form class="login-form" onSubmit={(e) => { e.preventDefault(); handleUpload(); }}>
            <div class="form-group">
              <label for="fileInput" class="form-label">Select Files</label>
              <div class="file-upload-container">
                <input
                  id="fileInput"
                  type="file"
                  multiple
                  onChange={handleFileChange}
                  class="file-input"
                />
                <label for="fileInput" class="file-upload-label">
                  <svg class="file-upload-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                  <span class="file-upload-text">Choose files or drag and drop</span>
                  <span class="file-upload-subtext">CSV, TXT, and PLR files supported</span>
                </label>
              </div>
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
            
            <Show when={file_type == 'polar'}>
              <div class="form-group" style="margin-top: 20px;">
                <label class="form-label" style="display: flex; align-items: center; cursor: pointer; gap: 8px;">
                  <input
                    type="checkbox"
                    checked={convertToTarget()}
                    onChange={(e) => setConvertToTarget((e.target as HTMLInputElement).checked)}
                    style="width: 18px; height: 18px; cursor: pointer;"
                  />
                  <span>Convert to Target</span>
                </label>
                <p style="margin-top: 8px; font-size: 0.875rem; color: #6b7280;">
                  Extract target data from polar files and upload as targets in addition to the polar upload.
                </p>
              </div>
            </Show>
            
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
              <h1 class="login-title">Upload Successful!</h1>
              <p class="login-subtitle">
                <Show when={file_type == 'target'}>Your target files have been uploaded successfully.</Show>
                <Show when={file_type == 'polar' && !convertToTarget()}>Your polar files have been uploaded successfully.</Show>
                <Show when={file_type == 'polar' && convertToTarget()}>Your polar files and converted targets have been uploaded successfully.</Show>
              </p>
            </div>
          </div>
          
          <div class="login-footer">
            <p class="footer-text">Redirecting to dashboard in 3 seconds...</p>
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
          
          <div class="login-footer">
            <p class="footer-text">Returning to upload page in 5 seconds...</p>
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
