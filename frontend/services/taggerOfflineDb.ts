/**
 * Tagger persistence: per-project JSON in localStorage (events + outbox).
 * Does not use HuniDB or IndexedDB.
 */
import { debug, warn, error as logError } from '@utils/console';

const STORAGE_PREFIX = 'racesight_tagger_v1:p:';

export type TaggerOutboxOp = 'create' | 'update' | 'delete';

export interface TaggerStoredEvent {
  clientId: string;
  serverId: number | null;
  projectId: number;
  user_id: string | null;
  /** From `admin.users.user_name` when row came from API (or create/update response). */
  user_name?: string | null;
  date: string | null;
  focus_time: string | null;
  start_time: string | null;
  end_time: string | null;
  event_type: string;
  comment: string;
  /** Server row last modification time (ISO); used for incremental sync. */
  date_modified?: string | null;
  pending: boolean;
  pendingDelete?: boolean;
  updatedAt: number;
}

export interface TaggerOutboxItem {
  id?: number;
  op: TaggerOutboxOp;
  clientId: string;
  projectId: number;
}

interface TaggerLocalSnapshot {
  events: TaggerStoredEvent[];
  outbox: TaggerOutboxItem[];
  nextOutboxId: number;
}

function storageKey(projectId: number): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

function emptySnapshot(): TaggerLocalSnapshot {
  return { events: [], outbox: [], nextOutboxId: 1 };
}

function readSnapshot(projectId: number): TaggerLocalSnapshot {
  if (typeof localStorage === 'undefined') {
    return emptySnapshot();
  }
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (raw == null || raw === '') {
      return emptySnapshot();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return emptySnapshot();
    }
    const o = parsed as Record<string, unknown>;
    const events = Array.isArray(o.events) ? (o.events as TaggerStoredEvent[]) : [];
    const outbox = Array.isArray(o.outbox) ? (o.outbox as TaggerOutboxItem[]) : [];
    const nextOutboxId =
      typeof o.nextOutboxId === 'number' && Number.isFinite(o.nextOutboxId) ? Math.max(1, o.nextOutboxId) : 1;
    return { events, outbox, nextOutboxId };
  } catch (e) {
    warn('[taggerLocalStore] Failed to parse snapshot, resetting', e);
    return emptySnapshot();
  }
}

function writeSnapshot(projectId: number, snap: TaggerLocalSnapshot): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(snap));
  } catch (e) {
    logError('[taggerLocalStore] Failed to write localStorage (quota or disabled?)', e);
  }
}

export async function taggerGetEventsForProject(projectId: number): Promise<TaggerStoredEvent[]> {
  const snap = readSnapshot(projectId);
  return snap.events.filter((e) => e.projectId === projectId);
}

/** At most one local row per (projectId, serverId) when serverId is set; keeps newest updatedAt. */
function dedupeSnapshotProjectByServerId(snap: TaggerLocalSnapshot, projectId: number): void {
  const other = snap.events.filter((e) => e.projectId !== projectId);
  const proj = snap.events.filter((e) => e.projectId === projectId);
  const pendingNoSid: TaggerStoredEvent[] = [];
  const bySid = new Map<number, TaggerStoredEvent>();
  for (const e of proj) {
    if (e.serverId == null) {
      pendingNoSid.push(e);
      continue;
    }
    const sid = e.serverId;
    const cur = bySid.get(sid);
    if (!cur || e.updatedAt >= cur.updatedAt) {
      bySid.set(sid, e);
    }
  }
  snap.events = [...other, ...pendingNoSid, ...bySid.values()];
}

export async function taggerPutEvent(row: TaggerStoredEvent): Promise<void> {
  const snap = readSnapshot(row.projectId);
  const sid = row.serverId;
  if (sid != null) {
    snap.events = snap.events.filter(
      (e) => !(e.projectId === row.projectId && e.serverId === sid)
    );
  }
  const idx = snap.events.findIndex((e) => e.clientId === row.clientId);
  const next = { ...row, updatedAt: Date.now() };
  if (idx >= 0) {
    snap.events[idx] = next;
  } else {
    snap.events.push(next);
  }
  dedupeSnapshotProjectByServerId(snap, row.projectId);
  writeSnapshot(row.projectId, snap);
}

export async function taggerGetEvent(clientId: string): Promise<TaggerStoredEvent | undefined> {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k == null || !k.startsWith(STORAGE_PREFIX)) {
      continue;
    }
    try {
      const snap = readSnapshot(Number(k.slice(STORAGE_PREFIX.length)));
      const found = snap.events.find((e) => e.clientId === clientId);
      if (found) {
        return found;
      }
    } catch {
      /* continue */
    }
  }
  return undefined;
}

export async function taggerDeleteEvent(clientId: string): Promise<void> {
  const ev = await taggerGetEvent(clientId);
  if (!ev) {
    return;
  }
  const snap = readSnapshot(ev.projectId);
  snap.events = snap.events.filter((e) => e.clientId !== clientId);
  writeSnapshot(ev.projectId, snap);
}

/** Replace server-origin rows for a project; keeps local `loc-*` rows and srv tombstones (pending delete). */
export async function taggerMergeServerRows(projectId: number, rows: TaggerStoredEvent[]): Promise<void> {
  const snap = readSnapshot(projectId);
  const allBefore = snap.events.filter((e) => e.projectId === projectId);
  const tombstoneServerIds = new Set(
    allBefore.filter((e) => e.pendingDelete && e.serverId != null).map((e) => e.serverId as number)
  );

  let events = snap.events.filter((e) => {
    if (e.projectId !== projectId) {
      return true;
    }
    if (e.clientId.startsWith('srv-') && !e.pendingDelete) {
      return false;
    }
    return true;
  });

  for (const r of rows) {
    const sid = r.serverId;
    if (sid != null && tombstoneServerIds.has(sid)) {
      continue;
    }
    events.push({ ...r, updatedAt: Date.now() });
  }

  snap.events = events;
  dedupeSnapshotProjectByServerId(snap, projectId);
  writeSnapshot(projectId, snap);
}

/** Merge API rows into local list without removing existing server rows (incremental sync). */
export async function taggerUpsertServerRows(projectId: number, rows: TaggerStoredEvent[]): Promise<void> {
  const snap = readSnapshot(projectId);
  const allBefore = snap.events.filter((e) => e.projectId === projectId);
  const tombstoneServerIds = new Set(
    allBefore.filter((e) => e.pendingDelete && e.serverId != null).map((e) => e.serverId as number)
  );

  for (const r of rows) {
    const sid = r.serverId;
    if (sid != null && tombstoneServerIds.has(sid)) {
      continue;
    }
    const idx = snap.events.findIndex(
      (e) =>
        e.projectId === projectId &&
        (e.clientId === r.clientId || (sid != null && e.serverId === sid))
    );
    const next = { ...r, updatedAt: Date.now() };
    if (idx >= 0) {
      const existing = snap.events[idx];
      if (existing.pendingDelete) {
        continue;
      }
      snap.events[idx] = next;
    } else {
      snap.events.push(next);
    }
  }
  dedupeSnapshotProjectByServerId(snap, projectId);
  writeSnapshot(projectId, snap);
}

export async function taggerEnqueueOutbox(item: Omit<TaggerOutboxItem, 'id'>): Promise<void> {
  const snap = readSnapshot(item.projectId);
  const id = snap.nextOutboxId;
  snap.nextOutboxId += 1;
  snap.outbox.push({ ...item, id });
  writeSnapshot(item.projectId, snap);
  debug('[taggerLocalStore] Outbox enqueued', item.op, item.clientId);
}

export async function taggerGetOutboxForProject(projectId: number): Promise<TaggerOutboxItem[]> {
  const snap = readSnapshot(projectId);
  const list = snap.outbox.filter((o) => o.projectId === projectId);
  list.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return list;
}

export async function taggerRemoveOutboxItem(id: number): Promise<void> {
  if (typeof localStorage === 'undefined') {
    return;
  }
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k == null || !k.startsWith(STORAGE_PREFIX)) {
      continue;
    }
    const pid = Number(k.slice(STORAGE_PREFIX.length));
    if (!Number.isFinite(pid)) {
      continue;
    }
    const snap = readSnapshot(pid);
    const before = snap.outbox.length;
    snap.outbox = snap.outbox.filter((o) => o.id !== id);
    if (snap.outbox.length !== before) {
      writeSnapshot(pid, snap);
      return;
    }
  }
}

export async function taggerClearOutboxForClient(projectId: number, clientId: string): Promise<void> {
  const snap = readSnapshot(projectId);
  snap.outbox = snap.outbox.filter((o) => !(o.projectId === projectId && o.clientId === clientId));
  writeSnapshot(projectId, snap);
}

export function newLocalClientId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `loc-${crypto.randomUUID()}`;
  }
  return `loc-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** POST/PUT `tags` jsonb body from local row (SAILS/CREW = full object; else `{ Comment }`). */
export function buildTagsPayloadForApi(row: TaggerStoredEvent): Record<string, unknown> {
  const et = row.event_type.trim().toUpperCase();
  if (et === 'SAILS' || et === 'CREW') {
    try {
      const o = JSON.parse(row.comment || '{}') as unknown;
      if (o != null && typeof o === 'object' && !Array.isArray(o)) {
        return o as Record<string, unknown>;
      }
    } catch {
      /* empty */
    }
    return {};
  }
  return { Comment: row.comment ?? '' };
}

/** Map API `tags` jsonb (+ optional legacy `comment`) to the string stored in TaggerStoredEvent.comment. */
export function commentStringFromServerTags(
  eventType: unknown,
  tags: unknown,
  legacyComment?: unknown
): string {
  const et = String(eventType ?? '').toUpperCase();
  if (tags != null && typeof tags === 'object' && !Array.isArray(tags)) {
    const t = tags as Record<string, unknown>;
    if (et === 'SAILS' || et === 'CREW') {
      return JSON.stringify(t);
    }
    const c = t.Comment ?? t.comment;
    return c != null ? String(c) : '';
  }
  if (legacyComment != null && String(legacyComment).trim() !== '') {
    return String(legacyComment);
  }
  return '';
}

export function serverRowToStored(projectId: number, row: Record<string, unknown>): TaggerStoredEvent {
  const id = Number(row.user_event_id);
  const un = row.user_name;
  const dm = row.date_modified;
  return {
    clientId: `srv-${id}`,
    serverId: id,
    projectId,
    user_id: row.user_id != null ? String(row.user_id) : null,
    user_name: un != null && String(un).trim() !== '' ? String(un).trim() : null,
    date: row.date != null ? String(row.date).slice(0, 10) : null,
    focus_time: row.focus_time != null ? String(row.focus_time) : null,
    start_time: row.start_time != null ? String(row.start_time) : null,
    end_time: row.end_time != null ? String(row.end_time) : null,
    event_type: String(row.event_type ?? ''),
    comment: commentStringFromServerTags(row.event_type, row.tags, row.comment),
    date_modified:
      dm != null && String(dm).trim() !== ''
        ? (dm instanceof Date ? dm.toISOString() : String(dm))
        : null,
    pending: false,
    updatedAt: Date.now(),
  };
}
