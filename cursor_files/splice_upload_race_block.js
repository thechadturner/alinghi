const fs = require('fs');
const p = 'c:/MyGit/Alinghi/frontend/reports/ac40/UploadDatasets.tsx';
let s = fs.readFileSync(p, 'utf8');
const start = s.indexOf(
  '      // ========== PHASE 0: Group files by date-formatted folders (Race Day) =========='
);
const endComment = s.indexOf(
  '        // All processing complete - close modal and show success',
  start
);
if (start < 0 || endComment < 0) {
  console.error('markers not found', { start, endComment });
  process.exit(1);
}
const end = s.indexOf('\n    } catch (error) {', endComment);
if (end < 0) {
  console.error('end catch not found');
  process.exit(1);
}

const lines = [
  "      // Race Day: upload .jsonl files to data/raw only (JSONL folder; source in file content)",
  "      if (!inputDate()) {",
  "        throw new Error('Date is required for race day upload');",
  "      }",
  "      if (!timezone()) {",
  "        throw new Error('Timezone is required for race day upload');",
  "      }",
  "      const jsonlFiles = files().filter((f) => isJsonlFile(f.name));",
  "      if (jsonlFiles.length === 0) {",
  "        throw new Error('At least one .jsonl file is required');",
  "      }",
  '',
  "      const formattedDateRace = inputDate().replace(/-/g, '');",
  "      const uploadAccessTokenRace = authManager.getAccessToken();",
  '      setCurrentStep(1);',
  '      setUploadProgress({ current: 0, total: jsonlFiles.length });',
  '',
  '      for (let i = 0; i < jsonlFiles.length; i++) {',
  '        const file = jsonlFiles[i];',
  '        setUploadProgress({ current: i + 1, total: jsonlFiles.length });',
  '',
  '        let isDuplicateRace = false;',
  '        try {',
  "          const checkUrlRace =",
  "            `${apiEndpoints.admin.upload}/check-file?` +",
  '            new URLSearchParams({',
  "              class_name: selectedClassName().toLowerCase(),",
  '              project_id: selectedProjectId().toString(),',
  '              source_name: AC40_RACE_JSONL_SOURCE,',
  '              date: formattedDateRace,',
  '              file_name: file.name,',
  "              file_size: file.size.toString(),",
  '            });',
  '          const checkResponseRace = await getData(checkUrlRace);',
  '          if (checkResponseRace.success && checkResponseRace.data?.isDuplicate) {',
  '            isDuplicateRace = true;',
  "            debug('[UploadDatasets] Race .jsonl duplicate skip:', file.name);",
  '          }',
  '        } catch (checkErrRace) {',
  "          debug('[UploadDatasets] check-file error (continuing with upload):', checkErrRace);",
  '        }',
  '',
  '        if (isDuplicateRace) {',
  '          setCurrentStatus(`Skipped (already exists): ${file.name}`);',
  '          continue;',
  '        }',
  '',
  '        setCurrentStatus(`Uploading ${i + 1} of ${jsonlFiles.length}: ${file.name}...`);',
  '',
  '        const formDataRace = new FormData();',
  "        formDataRace.append('files', file);",
  "        formDataRace.append('class_name', selectedClassName().toLowerCase());",
  "        formDataRace.append('project_id', selectedProjectId().toString());",
  "        formDataRace.append('source_name', AC40_RACE_JSONL_SOURCE);",
  "        formDataRace.append('skip_normalization', 'true');",
  "        formDataRace.append('upload_date', formattedDateRace);",
  "        formDataRace.append('timezone', timezone());",
  "        formDataRace.append('upload_profile', AC40_UPLOAD_PROFILE_RACE_JSONL);",
  '',
  '        const responseRace = await fetch(`${apiEndpoints.admin.upload}/data`, {',
  "          method: 'POST',",
  "          credentials: 'include',",
  '          headers: {',
  '            Authorization: `Bearer ${uploadAccessTokenRace}`,',
  "            'X-CSRF-Token': getCookie('csrf_token') || '',",
  '          },',
  '          body: formDataRace,',
  '        });',
  '',
  '        if (!responseRace.ok) {',
  '          const errorTextRace = await responseRace.text();',
  '          throw new Error(`Upload failed for ${file.name}: ${errorTextRace}`);',
  '        }',
  '',
  '        const uploadResponseRace = (await responseRace.json()) as { success?: boolean; message?: string };',
  '        if (!uploadResponseRace.success) {',
  '          throw new Error(uploadResponseRace.message || `Upload failed for ${file.name}`);',
  '        }',
  "        debug('[UploadDatasets] Race .jsonl uploaded:', file.name);",
  '      }',
  '',
  "      setCurrentStatus('All JSONL files uploaded to data/raw.');",
  '      toastStore.showToast(',
  "        'success',",
  "        'Upload complete',",
  '        `${jsonlFiles.length} file(s) saved under data/raw/.../${formattedDateRace}/JSONL/.`',
  '      );',
  '      setUploadSuccess(true);',
  '      setShowWaiting(false);',
];
const insert = lines.join('\n');

const out = s.slice(0, start) + insert + s.slice(end);
fs.writeFileSync(p, out);
console.log('spliced ok, removed bytes', end - start, 'new insert bytes', insert.length);
