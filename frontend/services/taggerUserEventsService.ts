/**
 * User events API + outbox flush for Tagger (online/offline).
 */
import { apiEndpoints } from '@config/env';
import { getData, postData, putData, deleteData } from '@utils/global';
import { warn, error as logError, debug } from '@utils/console';
import {
  taggerClearOutboxForClient,
  taggerDeleteEvent,
  taggerEnqueueOutbox,
  taggerGetEvent,
  taggerGetEventsForProject,
  taggerGetOutboxForProject,
  taggerMergeServerRows,
  taggerPutEvent,
  taggerRemoveOutboxItem,
  taggerUpsertServerRows,
  serverRowToStored,
  buildTagsPayloadForApi,
  type TaggerStoredEvent,
} from './taggerOfflineDb';

export interface UserEventApiRow {
  user_event_id: number;
  project_id: number;
  user_id: string | null;
  user_name?: string | null;
  date: string | null;
  focus_time: string | null;
  start_time: string | null;
  end_time: string | null;
  event_type: string;
  /** Derived display string; prefer mapping from `tags` via serverRowToStored. */
  comment: string;
  tags?: Record<string, unknown> | null;
  date_modified?: string | null;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

function buildWriteBody(projectId: number, row: TaggerStoredEvent): Record<string, unknown> {
  return {
    project_id: projectId,
    date: row.date || null,
    focus_time: row.focus_time || null,
    start_time: row.start_time || null,
    end_time: row.end_time || null,
    event_type: row.event_type,
    tags: buildTagsPayloadForApi(row),
  };
}

/** Serialize creates/updates/deletes per project so trySyncCreate and flushOutbox cannot POST the same row twice in parallel. */
const taggerProjectWriteChains = new Map<number, Promise<unknown>>();

function enqueueTaggerProjectWrite<T>(projectId: number, work: () => Promise<T>): Promise<T> {
  const prev = taggerProjectWriteChains.get(projectId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(work);
  taggerProjectWriteChains.set(projectId, next.then(() => undefined, () => undefined));
  return next;
}

function localTodayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localYmdDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** One date-range backfill per project per SPA load — fixes rows cached before API returned `user_name`. */
const taggerAuthorBackfillAttempted = new Set<number>();

function serverRowNeedsAuthorLabel(e: TaggerStoredEvent): boolean {
  if (e.serverId == null || e.pendingDelete) {
    return false;
  }
  const uid = e.user_id != null ? String(e.user_id).trim() : '';
  if (!uid) {
    return false;
  }
  const n = e.user_name != null ? String(e.user_name).trim() : '';
  return n === '';
}

/** API returns `{ rows, total }`; older servers may return a bare array. */
function parseUserEventsListPayload(data: unknown): { rows: UserEventApiRow[]; total: number | null } {
  if (data == null) {
    return { rows: [], total: null };
  }
  if (Array.isArray(data)) {
    return { rows: data as UserEventApiRow[], total: null };
  }
  if (typeof data === 'object' && data !== null && Array.isArray((data as { rows?: unknown }).rows)) {
    const o = data as { rows: UserEventApiRow[]; total?: unknown };
    const total = typeof o.total === 'number' && Number.isFinite(o.total) ? o.total : null;
    return { rows: o.rows, total };
  }
  return { rows: [], total: null };
}

function maxDateModifiedIso(events: TaggerStoredEvent[]): string | null {
  let maxMs = -Infinity;
  let best: string | null = null;
  for (const e of events) {
    if (e.serverId == null || e.pendingDelete) {
      continue;
    }
    const raw = e.date_modified?.trim();
    if (!raw) {
      continue;
    }
    const t = new Date(raw).getTime();
    if (!Number.isNaN(t) && t >= maxMs) {
      maxMs = t;
      best = new Date(t).toISOString();
    }
  }
  return best;
}

function localServerBackedCount(events: TaggerStoredEvent[]): number {
  return events.filter((e) => e.serverId != null && !e.pendingDelete).length;
}

function mergeDateModifiedFromApi(row: TaggerStoredEvent, data: UserEventApiRow | undefined): string | null {
  const dm = data?.date_modified;
  if (dm != null && String(dm).trim() !== '') {
    return String(dm);
  }
  return row.date_modified ?? null;
}

/**
 * Pull from API: `modified_after` incremental when local rows have `date_modified`;
 * else 14-day window on `date_modified`. Compares `total` vs local server row count and
 * runs `taggerMergeServerRows` when counts diverge (e.g. server deletes).
 */
/**
 * Latest completed CREW row from the API (for combo defaults when local store has none).
 * Upserts into local storage so the next offline session can seed from it too.
 */
export async function taggerFetchLatestClosedCrewForSeed(
  projectId: number,
  signal?: AbortSignal
): Promise<TaggerStoredEvent | null> {
  if (!isOnline()) {
    return null;
  }
  try {
    const params = new URLSearchParams();
    params.set('project_id', String(projectId));
    params.set('event_type', 'CREW');
    params.set('interval_closed', '1');
    params.set('limit', '1');
    const url = `${apiEndpoints.app.userEvents}?${params.toString()}`;
    const res = await getData(url, signal);
    if (!res.success) {
      debug('[taggerUserEventsService] Crew seed list failed', res.message);
      return null;
    }
    const { rows } = parseUserEventsListPayload(res.data);
    if (rows.length === 0) {
      return null;
    }
    const stored = serverRowToStored(projectId, rows[0] as unknown as Record<string, unknown>);
    await taggerUpsertServerRows(projectId, [stored]);
    debug('[taggerUserEventsService] Fetched latest closed CREW for seed', projectId, stored.serverId);
    return stored;
  } catch (e) {
    warn('[taggerUserEventsService] Crew seed fetch failed', e);
    return null;
  }
}

export async function taggerPullAndMergeServer(projectId: number, signal?: AbortSignal): Promise<boolean> {
  if (!isOnline()) {
    return false;
  }
  try {
    const events = await taggerGetEventsForProject(projectId);
    const localCount = localServerBackedCount(events);
    const maxIso = maxDateModifiedIso(events);

    const params = new URLSearchParams();
    params.set('project_id', String(projectId));
    let pullDesc: string;
    if (maxIso) {
      params.set('modified_after', maxIso);
      pullDesc = `modified_after=${maxIso}`;
    } else {
      params.set('date_from', localYmdDaysAgo(14));
      params.set('date_to', localTodayYmd());
      pullDesc = 'date_modified_range_14d';
    }

    const url = `${apiEndpoints.app.userEvents}?${params.toString()}`;
    const res = await getData(url, signal);
    if (!res.success) {
      logError('[taggerUserEventsService] List failed', res.message);
      return false;
    }
    const { rows: list, total } = parseUserEventsListPayload(res.data);

    if (total != null && localCount !== total) {
      // `total` is global for the project; re-fetch all server rows (no date filter) so counts align after merge.
      const mergeParams = new URLSearchParams();
      mergeParams.set('project_id', String(projectId));
      const mergeUrl = `${apiEndpoints.app.userEvents}?${mergeParams.toString()}`;
      const mergeRes = await getData(mergeUrl, signal);
      if (!mergeRes.success) {
        logError('[taggerUserEventsService] Full merge list failed', mergeRes.message);
        return false;
      }
      const { rows: mergeRows } = parseUserEventsListPayload(mergeRes.data);
      const storedMerge = mergeRows.map((r) => serverRowToStored(projectId, r as unknown as Record<string, unknown>));
      await taggerMergeServerRows(projectId, storedMerge);
      debug(
        '[taggerUserEventsService] Replaced srv rows after count mismatch',
        { localCount, total, merged: storedMerge.length },
        'project',
        projectId
      );
    } else {
      const stored = list.map((r) => serverRowToStored(projectId, r as unknown as Record<string, unknown>));
      await taggerUpsertServerRows(projectId, stored);
      debug('[taggerUserEventsService] Upserted', stored.length, 'rows (', pullDesc, ') project', projectId);
    }

    const merged = await taggerGetEventsForProject(projectId);
    const needsAuthorBackfill =
      merged.some(serverRowNeedsAuthorLabel) &&
      !taggerAuthorBackfillAttempted.has(projectId);
    if (needsAuthorBackfill) {
      taggerAuthorBackfillAttempted.add(projectId);
      const params2 = new URLSearchParams();
      params2.set('project_id', String(projectId));
      params2.set('date_from', localYmdDaysAgo(14));
      params2.set('date_to', localTodayYmd());
      const url2 = `${apiEndpoints.app.userEvents}?${params2.toString()}`;
      const res2 = await getData(url2, signal);
      if (res2.success) {
        const { rows: list2 } = parseUserEventsListPayload(res2.data);
        const stored2 = list2.map((r) => serverRowToStored(projectId, r as unknown as Record<string, unknown>));
        await taggerUpsertServerRows(projectId, stored2);
        debug(
          '[taggerUserEventsService] user_name backfill upserted',
          stored2.length,
          'rows (14d range) project',
          projectId
        );
      }
    }

    return true;
  } catch (e) {
    warn('[taggerUserEventsService] Pull failed', e);
    return false;
  }
}

export async function taggerFlushOutbox(projectId: number): Promise<void> {
  return enqueueTaggerProjectWrite(projectId, async () => {
    if (!isOnline()) {
      return;
    }

    const items = await taggerGetOutboxForProject(projectId);
  for (const it of items) {
    if (it.id == null) {
      continue;
    }
    const row = await taggerGetEvent(it.clientId);
    try {
      if (it.op === 'create') {
        if (!row || row.pendingDelete) {
          await taggerRemoveOutboxItem(it.id);
          continue;
        }
        const body = buildWriteBody(projectId, row);
        const res = await postData(apiEndpoints.app.userEvents, body);
        if (!res.success) {
          warn('[taggerUserEventsService] Create sync failed', res.message);
          break;
        }
        const data = res.data as UserEventApiRow | undefined;
        const newId = data?.user_event_id;
        if (newId == null) {
          warn('[taggerUserEventsService] Create response missing user_event_id');
          break;
        }
        const nameFromApi = data?.user_name;
        const user_name =
          nameFromApi != null && String(nameFromApi).trim() !== ''
            ? String(nameFromApi).trim()
            : row.user_name ?? null;
        const oldCid = row.clientId;
        await taggerClearOutboxForClient(projectId, oldCid);
        await taggerDeleteEvent(oldCid);
        await taggerPutEvent({
          ...row,
          serverId: newId,
          clientId: `srv-${newId}`,
          pending: false,
          pendingDelete: false,
          user_name,
          date_modified: mergeDateModifiedFromApi(row, data),
        });
        await taggerRemoveOutboxItem(it.id);
        debug('[taggerUserEventsService] Synced create', oldCid, '->', newId);
      } else if (it.op === 'update') {
        if (!row || row.serverId == null) {
          break;
        }
        if (row.pendingDelete) {
          await taggerRemoveOutboxItem(it.id);
          continue;
        }
        const url = `${apiEndpoints.app.userEvents}/${row.serverId}`;
        const res = await putData(url, buildWriteBody(projectId, row));
        if (!res.success) {
          warn('[taggerUserEventsService] Update sync failed', res.message);
          break;
        }
        const upd = res.data as UserEventApiRow | undefined;
        const nameFromApi = upd?.user_name;
        const user_name =
          nameFromApi != null && String(nameFromApi).trim() !== ''
            ? String(nameFromApi).trim()
            : row.user_name ?? null;
        await taggerPutEvent({
          ...row,
          pending: false,
          user_name,
          date_modified: mergeDateModifiedFromApi(row, upd),
        });
        await taggerRemoveOutboxItem(it.id);
        debug('[taggerUserEventsService] Synced update', row.serverId);
      } else if (it.op === 'delete') {
        if (!row) {
          await taggerRemoveOutboxItem(it.id);
          continue;
        }
        if (row.serverId == null) {
          await taggerDeleteEvent(row.clientId);
          await taggerRemoveOutboxItem(it.id);
          continue;
        }
        const delUrl = `${apiEndpoints.app.userEvents}/${row.serverId}?project_id=${encodeURIComponent(String(projectId))}`;
        const res = await deleteData(delUrl, {});
        if (!res.success) {
          // Idempotent: row already removed on server (or stale outbox) — do not block the queue.
          if (res.status === 404) {
            await taggerDeleteEvent(row.clientId);
            await taggerRemoveOutboxItem(it.id);
            debug('[taggerUserEventsService] Synced delete (404, treat as gone)', row.serverId);
            continue;
          }
          warn('[taggerUserEventsService] Delete sync failed', res.message);
          break;
        }
        await taggerDeleteEvent(row.clientId);
        await taggerRemoveOutboxItem(it.id);
        debug('[taggerUserEventsService] Synced delete', row.serverId);
      }
    } catch (e) {
      warn('[taggerUserEventsService] Outbox item error', it.op, e);
      break;
    }
  }
  });
}

/**
 * Try immediate server write; on failure enqueue outbox (caller updates IDB first).
 * @returns New `clientId` (`srv-*`) after a successful server create and local row replacement; `null` if the row stays `loc-*` or is missing.
 */
export async function taggerTrySyncCreate(projectId: number, clientId: string): Promise<string | null> {
  const row = await taggerGetEvent(clientId);
  if (!row) {
    return null;
  }
  if (!isOnline()) {
    await taggerEnqueueOutbox({ op: 'create', clientId, projectId });
    return null;
  }
  return enqueueTaggerProjectWrite(projectId, async () => {
    const r = await taggerGetEvent(clientId);
    if (!r || r.pendingDelete) {
      return null;
    }
    try {
      const res = await postData(apiEndpoints.app.userEvents, buildWriteBody(projectId, r));
      if (!res.success) {
        await taggerEnqueueOutbox({ op: 'create', clientId, projectId });
        return null;
      }
      const data = res.data as UserEventApiRow | undefined;
      const newId = data?.user_event_id;
      if (newId == null) {
        await taggerEnqueueOutbox({ op: 'create', clientId, projectId });
        return null;
      }
      const nameFromApi = data?.user_name;
      const user_name =
        nameFromApi != null && String(nameFromApi).trim() !== ''
          ? String(nameFromApi).trim()
          : r.user_name ?? null;
      const newClientId = `srv-${newId}`;
      await taggerClearOutboxForClient(projectId, clientId);
      await taggerDeleteEvent(clientId);
      await taggerPutEvent({
        ...r,
        serverId: newId,
        clientId: newClientId,
        pending: false,
        user_name,
        date_modified: mergeDateModifiedFromApi(r, data),
      });
      return newClientId;
    } catch (e) {
      warn('[taggerUserEventsService] trySyncCreate error', e);
      await taggerEnqueueOutbox({ op: 'create', clientId, projectId });
      return null;
    }
  });
}

export async function taggerTrySyncUpdate(projectId: number, clientId: string): Promise<boolean> {
  const row = await taggerGetEvent(clientId);
  if (!row || row.serverId == null) {
    return false;
  }
  if (!isOnline()) {
    await taggerEnqueueOutbox({ op: 'update', clientId, projectId });
    await taggerPutEvent({ ...row, pending: true });
    return false;
  }
  return enqueueTaggerProjectWrite(projectId, async () => {
    const r = await taggerGetEvent(clientId);
    if (!r || r.serverId == null) {
      return false;
    }
    try {
      const url = `${apiEndpoints.app.userEvents}/${r.serverId}`;
      const res = await putData(url, buildWriteBody(projectId, r));
      if (!res.success) {
        await taggerEnqueueOutbox({ op: 'update', clientId, projectId });
        await taggerPutEvent({ ...r, pending: true });
        return false;
      }
      const upd = res.data as UserEventApiRow | undefined;
      const nameFromApi = upd?.user_name;
      const user_name =
        nameFromApi != null && String(nameFromApi).trim() !== ''
          ? String(nameFromApi).trim()
          : r.user_name ?? null;
      await taggerPutEvent({
        ...r,
        pending: false,
        user_name,
        date_modified: mergeDateModifiedFromApi(r, upd),
      });
      return true;
    } catch (e) {
      warn('[taggerUserEventsService] trySyncUpdate error', e);
      await taggerEnqueueOutbox({ op: 'update', clientId, projectId });
      await taggerPutEvent({ ...r, pending: true });
      return false;
    }
  });
}

export async function taggerTrySyncDelete(projectId: number, clientId: string): Promise<boolean> {
  const row = await taggerGetEvent(clientId);
  if (!row) {
    return true;
  }
  if (row.serverId == null) {
    await taggerClearOutboxForClient(projectId, clientId);
    await taggerDeleteEvent(clientId);
    return true;
  }
  if (!isOnline()) {
    await taggerEnqueueOutbox({ op: 'delete', clientId, projectId });
    await taggerPutEvent({ ...row, pendingDelete: true, pending: true });
    return false;
  }
  return enqueueTaggerProjectWrite(projectId, async () => {
    const r = await taggerGetEvent(clientId);
    if (!r) {
      return true;
    }
    if (r.serverId == null) {
      await taggerClearOutboxForClient(projectId, clientId);
      await taggerDeleteEvent(clientId);
      return true;
    }
    try {
      const delUrl = `${apiEndpoints.app.userEvents}/${r.serverId}?project_id=${encodeURIComponent(String(projectId))}`;
      const res = await deleteData(delUrl, {});
      if (!res.success) {
        await taggerEnqueueOutbox({ op: 'delete', clientId, projectId });
        await taggerPutEvent({ ...r, pendingDelete: true, pending: true });
        return false;
      }
      await taggerDeleteEvent(clientId);
      return true;
    } catch (e) {
      warn('[taggerUserEventsService] trySyncDelete error', e);
      await taggerEnqueueOutbox({ op: 'delete', clientId, projectId });
      await taggerPutEvent({ ...r, pendingDelete: true, pending: true });
      return false;
    }
  });
}
