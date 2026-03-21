/**
 * Background worker for persisting timeseries data to HuniDB.
 * Timeseries are no longer cached in HuniDB (API + in-memory only).
 * No jobs are posted from unifiedDataStore for timeseries; worker kept for API compatibility.
 * Processing is a no-op: report success without calling HuniDB.
 */

import { error as logError } from '../utils/console';

interface PersistenceJob {
  id: string;
  className: string;
  datasetId: string;
  projectId: string;
  sourceId: string;
  channels: string[];
  data: Array<Record<string, any>>;
}

let jobQueue: PersistenceJob[] = [];
let isProcessing = false;

self.onmessage = async (event: MessageEvent) => {
  const { type, payload } = event.data;
  
  if (type === 'PERSIST_DATA') {
    const jobId = payload.id || `${Date.now()}-${Math.random()}`;
    jobQueue.push({
      id: jobId,
      className: payload.className,
      datasetId: payload.datasetId,
      projectId: payload.projectId,
      sourceId: payload.sourceId,
      channels: payload.channels,
      data: payload.data
    });
    if (!isProcessing) {
      processQueue();
    }
  }
};

async function processQueue() {
  isProcessing = true;
  while (jobQueue.length > 0) {
    const job = jobQueue.shift()!;
    // Timeseries: no HuniDB persistence; report success for API compatibility.
    self.postMessage({ type: 'PERSIST_SUCCESS', id: job.id });
  }
  isProcessing = false;
}

// Handle worker-level errors
self.onerror = (error: ErrorEvent) => {
  // Log the error but don't crash the worker
  logError('[HuniDB Persistence Worker] Worker error:', error.message, error.filename, error.lineno);
  
  // If there are pending jobs, notify them of the error
  if (jobQueue.length > 0) {
    const job = jobQueue.shift()!;
    self.postMessage({
      type: 'PERSIST_ERROR',
      id: job.id,
      error: `Worker error: ${error.message || 'Unknown worker error'}`
    });
  }
};

