import type { Accessor } from 'solid-js';
import { createSignal, onMount, onCleanup, For, Show, createEffect, createMemo } from 'solid-js';
import { useNavigate, useSearchParams } from '@solidjs/router';
import { authManager } from '@utils/authManager';
import { user } from '@store/userStore';
import { FiSettings } from 'solid-icons/fi';
import { error as logError, debug, warn } from '@utils/console';
import {
  newLocalClientId,
  taggerGetEventsForProject,
  taggerGetEvent,
  taggerPutEvent,
  type TaggerStoredEvent,
} from '@services/taggerOfflineDb';
import {
  taggerPullAndMergeServer,
  taggerFlushOutbox,
  taggerTrySyncCreate,
  taggerTrySyncUpdate,
  taggerTrySyncDelete,
} from '@services/taggerUserEventsService';
import {
  loadCrewComboHistory,
  persistCrewComboHistory,
  addCrewNameToHistory,
  mergedCrewDatalistOptions,
} from '@services/taggerCrewComboHistory';
import '@styles/Tagger.css';

type PresetDef = {
  label: string;
  /** Shown instead of `label` while this preset’s active mode applies (e.g. Stop Test). */
  labelWhenActive?: string;
  eventType: string;
  btnClass: string;
  /** Save immediately; comment text is `instantComment` when set, else `label`. */
  instantSave?: boolean;
  /** First press = start, second press = end; focus_time = start_time. */
  intervalToggle?: boolean;
  /** Sails/Crew: JSON interval row + structured compose (replaces intervalToggle). */
  structuredInterval?: boolean;
  /** Stored comment body for instant-save presets when `label` is UI-only (e.g. “Comment”). */
  instantComment?: string;
  /** Tooltip when button label does not match stored event type. */
  title?: string;
};

const TAGGER_TEST_START_COMMENT = 'Test Started';
const TAGGER_TEST_END_COMMENT = 'Test Ended';

/** Elapsed mm:ss since test start (minutes not capped at 59). */
function taggerFmtElapsedMmSsSince(startMs: number): string {
  const ms = Math.max(0, Date.now() - startMs);
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

type TaggerTestSession = {
  /** Original local client id before sync (`loc-*`); row may become `srv-*` while test is open. */
  clientId: string;
  /** Canonical start instant from the client (server may return a different ISO string). */
  startTimeIso: string;
  starterUserId: string | null;
};

/** Match session to row after sync; server `start_time` can skew vs local ISO. */
const TAGGER_TEST_START_MATCH_MS = 300_000;

/** Loose match for linking session to a row after sync (server may normalize start_time). */
function taggerTestStartTimesLikelySame(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    return false;
  }
  return Math.abs(ta - tb) < TAGGER_TEST_START_MATCH_MS;
}

function taggerOpenTestMatchesSession(e: TaggerStoredEvent, sess: TaggerTestSession): boolean {
  return e.clientId === sess.clientId || taggerTestStartTimesLikelySame(e.start_time, sess.startTimeIso);
}

function taggerStarterUserIdFromRow(
  row: TaggerStoredEvent,
  me: string | null
): string | null {
  const uid = row.user_id;
  if (uid != null && String(uid).trim() !== '') {
    return String(uid);
  }
  return me;
}

const PRESETS: readonly PresetDef[] = [
  { label: 'Comment', eventType: 'COMMENT', btnClass: 'tagger-btn--comment' },
  { label: 'Job', eventType: 'JOB', btnClass: 'tagger-btn--job' },
  { label: 'Test', labelWhenActive: 'Stop Test', eventType: 'TEST', btnClass: 'tagger-btn--test' },
  { label: 'Sails', eventType: 'SAILS', btnClass: 'tagger-btn--sail', structuredInterval: true },
  { label: 'Crew', eventType: 'CREW', btnClass: 'tagger-btn--crew', structuredInterval: true },
  { label: 'Flag', eventType: 'FLAG', btnClass: 'tagger-btn--flag', instantSave: true },
  { label: 'Nice', eventType: 'NICE', btnClass: 'tagger-btn--nice', instantSave: true },
  {
    label: 'Good Moment',
    eventType: 'GOOD_BALANCE',
    btnClass: 'tagger-btn--good-balance',
    instantSave: true,
  },
  {
    label: 'Bad',
    eventType: 'BAD_MOMENT',
    btnClass: 'tagger-btn--bad-moment',
    instantSave: true,
  },
];

function hasLocalAuthCredential(): boolean {
  return !!(authManager.getAccessToken() || authManager.getRefreshToken());
}

/** Chat order: oldest at top, newest at bottom. */
function sortEventsChronoAsc(rows: TaggerStoredEvent[]): TaggerStoredEvent[] {
  return [...rows].sort((a, b) => {
    const ta = a.focus_time || a.start_time || a.date || '';
    const tb = b.focus_time || b.start_time || b.date || '';
    const da = ta ? new Date(ta).getTime() : 0;
    const db = tb ? new Date(tb).getTime() : 0;
    return da - db;
  });
}

/** RaceSight-style short label: user_name (e.g. CT), else first name, else initials, else email local-part. */
function racesightAbbrevAuthor(u: Record<string, unknown> | null | undefined): string {
  if (!u) return 'User';
  const un = u.user_name ?? u.username;
  if (un != null && String(un).trim() !== '') return String(un).trim();
  const first = u.first_name ?? u.firstName;
  const last = u.last_name ?? u.lastName;
  const firstStr = first != null ? String(first).trim() : '';
  const lastStr = last != null ? String(last).trim() : '';
  if (firstStr) {
    return firstStr;
  }
  const a = firstStr.charAt(0);
  const b = lastStr.charAt(0);
  const initials = `${a}${b}`.toUpperCase().replace(/\s/g, '');
  if (initials) {
    return initials;
  }
  const email = u.email;
  if (typeof email === 'string' && email.includes('@')) {
    return email.split('@')[0] ?? 'User';
  }
  return 'User';
}

function currentUserIdString(u: Record<string, unknown> | null | undefined): string | null {
  if (!u) return null;
  if (u.user_id != null) return String(u.user_id);
  if (u.id != null) return String(u.id);
  return null;
}

function taggerIsTestStarter(sess: TaggerTestSession | null, me: Record<string, unknown> | null | undefined): boolean {
  if (!sess) {
    return false;
  }
  const myId = currentUserIdString(me ?? null);
  if (myId == null || myId === '') {
    return true;
  }
  if (sess.starterUserId == null || sess.starterUserId === '') {
    return true;
  }
  return String(sess.starterUserId) === String(myId);
}

function TaggerQuickPresetButton(props: {
  preset: PresetDef;
  testSession: Accessor<TaggerTestSession | null>;
  user: Accessor<Record<string, unknown> | null>;
  openSailCrewRecorder: Accessor<{ eventType: string } | null>;
  onPresetClick: (p: PresetDef) => void;
}) {
  const showStopTest = createMemo(
    () =>
      props.preset.eventType === 'TEST' &&
      taggerIsTestStarter(props.testSession(), props.user() as Record<string, unknown> | null)
  );
  const showIntervalRec = createMemo(() => {
    if (!props.preset.structuredInterval) {
      return false;
    }
    const open = props.openSailCrewRecorder();
    return open?.eventType === props.preset.eventType.toUpperCase();
  });
  const buttonLabel = createMemo(() =>
    showStopTest() ? props.preset.labelWhenActive ?? 'Stop Test' : props.preset.label
  );
  return (
    <button
      type="button"
      class={`tagger-btn ${props.preset.btnClass}${
        showStopTest() || showIntervalRec() ? ' tagger-btn--recording' : ''
      }${showStopTest() ? ' tagger-btn--stop-test' : ''}`}
      title={props.preset.title}
      onClick={() => void props.onPresetClick(props.preset)}
    >
      {buttonLabel()}
    </button>
  );
}

function taggerIsTestRowComplete(row: TaggerStoredEvent): boolean {
  if (row.event_type.toUpperCase() !== 'TEST' || !row.start_time || row.end_time == null || row.end_time === '') {
    return false;
  }
  return new Date(row.end_time).getTime() > new Date(row.start_time).getTime();
}

function taggerIsTestRowOpen(row: TaggerStoredEvent): boolean {
  if (row.pendingDelete) {
    return false;
  }
  if (row.event_type.toUpperCase() !== 'TEST' || !row.start_time) {
    return false;
  }
  return row.end_time == null || row.end_time === '';
}

const TAGGER_CREW_FIELD_KEYS = [
  'Helm Port',
  'Helm Stbd',
  'Flight Port',
  'Flight Stbd',
  'Strategist',
] as const;

/**
 * SAILS/CREW intervals store an end marker in JSON (`IntervalEnd`) when closed via the app.
 * Some rows may have that set while `end_time` is still null (legacy/sync); treat them as closed
 * so Test and new intervals are not blocked incorrectly.
 */
function taggerSailCrewPayloadIndicatesIntervalEnded(comment: string): boolean {
  const parsed = taggerParseSailCrewJson(comment);
  if (!parsed) {
    return false;
  }
  return String(parsed.IntervalEnd ?? '').trim() !== '';
}

function taggerIsSailCrewRowOpen(row: TaggerStoredEvent): boolean {
  if (row.pendingDelete) {
    return false;
  }
  const et = row.event_type.trim().toUpperCase();
  if (et !== 'SAILS' && et !== 'CREW') {
    return false;
  }
  if (!row.start_time) {
    return false;
  }
  const end = row.end_time;
  if (end != null && String(end).trim() !== '') {
    return false;
  }
  if (taggerSailCrewPayloadIndicatesIntervalEnded(row.comment)) {
    return false;
  }
  return true;
}

/** True when the row would export with an empty end_time unless we close it first. */
function taggerRowMissingEndTimeForCsv(row: TaggerStoredEvent): boolean {
  if (row.pendingDelete) {
    return false;
  }
  const t = row.end_time;
  return t == null || String(t).trim() === '';
}

function taggerParseSailCrewJson(raw: string): Record<string, string> | null {
  const t = raw?.trim();
  if (!t || !t.startsWith('{')) {
    return null;
  }
  try {
    const o = JSON.parse(t) as unknown;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      return null;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      out[k] = v == null ? '' : String(v);
    }
    return out;
  } catch {
    return null;
  }
}

function taggerStringifySailCrewJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

const TAGGER_MAINSAIL_CODES = ['M1', 'M2', 'M3'] as const;
const TAGGER_HEADSAIL_CODES = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'] as const;
function taggerSailFieldForSelect(raw: string | undefined, allowed: readonly string[]): string {
  const t = (raw ?? '').trim();
  if (t === '' || t === 'NA') {
    return 'NA';
  }
  return allowed.includes(t) ? t : 'NA';
}

/** Crew combo: allow any stored text; empty → NA for the form. */
function taggerCrewFieldForInput(raw: string | undefined): string {
  const t = (raw ?? '').trim();
  if (t === '' || t === 'NA') {
    return 'NA';
  }
  return t;
}

function taggerDefaultSailsPayload(): Record<string, string> {
  return {
    Mainsail: 'NA',
    Headsail: 'NA',
    IntervalStart: 'Sail up',
  };
}

function taggerDefaultCrewPayload(): Record<string, string> {
  return {
    'Helm Port': 'NA',
    'Helm Stbd': 'NA',
    'Flight Port': 'NA',
    'Flight Stbd': 'NA',
    Strategist: 'NA',
    IntervalStart: 'Crew on',
  };
}

function taggerCloseOpenSailCrewRowComment(prevComment: string, intervalEnd: 'Sail down' | 'Crew off'): string {
  const parsed = taggerParseSailCrewJson(prevComment);
  const base = parsed ?? {};
  return taggerStringifySailCrewJson({ ...base, IntervalEnd: intervalEnd });
}

function taggerBubbleBodyText(row: TaggerStoredEvent, testPhase?: 'start' | 'end'): string {
  if (testPhase === 'end') {
    return TAGGER_TEST_END_COMMENT;
  }
  if (testPhase === 'start') {
    return row.comment || TAGGER_TEST_START_COMMENT;
  }
  const et = row.event_type.toUpperCase();
  const parsed = taggerParseSailCrewJson(row.comment);
  if (et === 'SAILS' && parsed) {
    const sailVal = (raw: string | undefined): string => {
      const t = (raw ?? '').trim();
      return t === '' || t === 'NA' ? 'NA' : t;
    };
    const m = sailVal(parsed.Mainsail);
    const h = sailVal(parsed.Headsail);
    if (m === 'NA' && h === 'NA') {
      return 'Sails Undefined';
    }
    return `Mainsail: ${m}, Headsail: ${h}`;
  }
  if (et === 'CREW' && parsed) {
    const crewVal = (raw: string | undefined): string => {
      const t = (raw ?? '').trim();
      return t === '' || t === 'NA' ? 'NA' : t;
    };
    const allCrewNa = TAGGER_CREW_FIELD_KEYS.every((key) => crewVal(parsed[key]) === 'NA');
    if (allCrewNa) {
      return 'Crew Undefined';
    }
    const parts = TAGGER_CREW_FIELD_KEYS.map((key) => {
      const v = crewVal(parsed[key]);
      const label = key === 'Strategist' ? 'Strategy' : key;
      return `${label}: ${v}`;
    });
    return parts.join(', ');
  }
  return row.comment || '—';
}

/** Stable id for “who sent this” — consecutive rows with the same key form one visual group. */
function authorGroupKeyForEvent(
  row: TaggerStoredEvent,
  me: Record<string, unknown> | null | undefined
): string {
  const myId = currentUserIdString(me ?? null);
  const rowUid = row.user_id != null ? String(row.user_id) : null;
  if (row.pending && rowUid == null && myId) {
    return `u:${myId}`;
  }
  if (rowUid) {
    return `u:${rowUid}`;
  }
  if (myId) {
    return `u:${myId}`;
  }
  return 'u:unknown';
}

function authorLabelForEvent(row: TaggerStoredEvent, me: Record<string, unknown> | null | undefined): string {
  const fromUsersTable = row.user_name?.trim();
  if (fromUsersTable) {
    return fromUsersTable;
  }
  const myId = currentUserIdString(me ?? null);
  const rowUid = row.user_id != null ? String(row.user_id) : null;
  if (row.pending && rowUid == null && myId) {
    return racesightAbbrevAuthor(me);
  }
  if (rowUid && myId && rowUid === myId) {
    return racesightAbbrevAuthor(me);
  }
  if (rowUid) {
    return `User ${rowUid}`;
  }
  return racesightAbbrevAuthor(me);
}

/** FNV-1a-ish 32-bit hash for stable index per string. */
function taggerHashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Distinct pill fills: blues, reds, purples, greens only (dark-UI friendly). */
const TAGGER_AUTHOR_PILL_PALETTE: ReadonlyArray<{ background: string; borderColor: string }> = [
  // blue family
  { background: 'hsla(210, 52%, 30%, 0.9)', borderColor: 'hsla(210, 55%, 46%, 0.55)' },
  { background: 'hsla(200, 48%, 27%, 0.9)', borderColor: 'hsla(200, 52%, 42%, 0.52)' },
  { background: 'hsla(218, 54%, 33%, 0.88)', borderColor: 'hsla(218, 58%, 50%, 0.52)' },
  { background: 'hsla(195, 50%, 29%, 0.9)', borderColor: 'hsla(195, 54%, 44%, 0.5)' },
  { background: 'hsla(225, 46%, 28%, 0.9)', borderColor: 'hsla(225, 50%, 42%, 0.5)' },
  { background: 'hsla(205, 56%, 31%, 0.88)', borderColor: 'hsla(205, 58%, 48%, 0.52)' },
  { background: 'hsla(230, 48%, 26%, 0.9)', borderColor: 'hsla(230, 52%, 40%, 0.48)' },
  { background: 'hsla(190, 52%, 32%, 0.88)', borderColor: 'hsla(190, 55%, 46%, 0.5)' },
  // red family
  { background: 'hsla(355, 52%, 31%, 0.9)', borderColor: 'hsla(355, 56%, 46%, 0.52)' },
  { background: 'hsla(0, 48%, 28%, 0.9)', borderColor: 'hsla(0, 52%, 44%, 0.5)' },
  { background: 'hsla(8, 50%, 30%, 0.88)', borderColor: 'hsla(8, 54%, 45%, 0.52)' },
  { background: 'hsla(348, 54%, 27%, 0.9)', borderColor: 'hsla(348, 58%, 42%, 0.5)' },
  { background: 'hsla(15, 46%, 29%, 0.9)', borderColor: 'hsla(15, 50%, 43%, 0.48)' },
  { background: 'hsla(2, 55%, 32%, 0.88)', borderColor: 'hsla(2, 58%, 48%, 0.52)' },
  { background: 'hsla(340, 48%, 30%, 0.9)', borderColor: 'hsla(340, 52%, 44%, 0.5)' },
  { background: 'hsla(20, 52%, 28%, 0.88)', borderColor: 'hsla(20, 55%, 42%, 0.5)' },
  // purple family
  { background: 'hsla(270, 48%, 31%, 0.9)', borderColor: 'hsla(270, 52%, 46%, 0.52)' },
  { background: 'hsla(285, 46%, 29%, 0.9)', borderColor: 'hsla(285, 50%, 44%, 0.5)' },
  { background: 'hsla(258, 50%, 28%, 0.88)', borderColor: 'hsla(258, 54%, 42%, 0.52)' },
  { background: 'hsla(275, 52%, 32%, 0.9)', borderColor: 'hsla(275, 56%, 48%, 0.52)' },
  { background: 'hsla(265, 44%, 27%, 0.9)', borderColor: 'hsla(265, 48%, 40%, 0.48)' },
  { background: 'hsla(292, 48%, 30%, 0.88)', borderColor: 'hsla(292, 52%, 45%, 0.5)' },
  { background: 'hsla(252, 50%, 32%, 0.9)', borderColor: 'hsla(252, 54%, 46%, 0.52)' },
  { background: 'hsla(280, 54%, 29%, 0.88)', borderColor: 'hsla(280, 58%, 44%, 0.5)' },
  // green family
  { background: 'hsla(142, 45%, 28%, 0.9)', borderColor: 'hsla(142, 48%, 42%, 0.52)' },
  { background: 'hsla(125, 48%, 27%, 0.9)', borderColor: 'hsla(125, 52%, 40%, 0.5)' },
  { background: 'hsla(155, 46%, 29%, 0.88)', borderColor: 'hsla(155, 50%, 43%, 0.5)' },
  { background: 'hsla(108, 44%, 30%, 0.9)', borderColor: 'hsla(108, 48%, 44%, 0.48)' },
  { background: 'hsla(160, 50%, 26%, 0.88)', borderColor: 'hsla(160, 54%, 40%, 0.52)' },
  { background: 'hsla(135, 52%, 31%, 0.9)', borderColor: 'hsla(135, 55%, 45%, 0.52)' },
  { background: 'hsla(118, 46%, 28%, 0.9)', borderColor: 'hsla(118, 50%, 42%, 0.5)' },
  { background: 'hsla(148, 48%, 32%, 0.88)', borderColor: 'hsla(148, 52%, 46%, 0.52)' },
];

/** One consistent pill per distinct author label (case-insensitive); palette cycles if names exceed palette size. */
function taggerAuthorPillStylesFromLabel(label: string): { background: string; borderColor: string } {
  const key = label.trim().toLowerCase() || 'unknown';
  const i = taggerHashString(key) % TAGGER_AUTHOR_PILL_PALETTE.length;
  return TAGGER_AUTHOR_PILL_PALETTE[i]!;
}

function fmtTimeOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

/** `datetime-local` value in local timezone (includes seconds when supported). */
function isoToDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso || iso.trim() === '') {
    return '';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function datetimeLocalValueToIso(value: string): string | null {
  const v = value?.trim();
  if (!v) {
    return null;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString();
}

/** Sail/Crew structured form: map datetime-local inputs to row interval fields. */
function mergeIntervalRowTimesFromDatetimeLocal(
  row: TaggerStoredEvent,
  startLocal: string,
  endLocal: string
): Pick<TaggerStoredEvent, 'start_time' | 'end_time' | 'focus_time' | 'date'> {
  const startIso =
    datetimeLocalValueToIso(startLocal.trim()) ??
    (row.start_time && row.start_time.trim() !== '' ? row.start_time : null) ??
    new Date().toISOString();
  const endTrim = endLocal.trim();
  let endIso: string | null;
  if (endTrim === '') {
    endIso = null;
  } else {
    const parsed = datetimeLocalValueToIso(endTrim);
    endIso =
      parsed ?? (row.end_time && row.end_time.trim() !== '' ? row.end_time : null);
  }
  const focus = startIso;
  const d = new Date(startIso);
  const date = Number.isNaN(d.getTime()) ? row.date : localDateYmd(d);
  return { start_time: startIso, end_time: endIso, focus_time: focus, date };
}

function bubbleClassForEventType(eventType: string): string {
  const x = eventType.toLowerCase().replace(/_/g, ' ');
  if (x.includes('comment')) return 'tagger-msg__bubble--comment';
  if (x.includes('test')) return 'tagger-msg__bubble--test';
  if (x.includes('sail')) return 'tagger-msg__bubble--sail';
  if (x.includes('crew')) return 'tagger-msg__bubble--crew';
  if (x === 'job' || x.includes('job')) return 'tagger-msg__bubble--job';
  if (x === 'flag' || x.includes('flag')) return 'tagger-msg__bubble--flag';
  if (x === 'nice' || x.includes('nice')) return 'tagger-msg__bubble--nice';
  if (x.includes('good balance') || x.includes('good_balance')) return 'tagger-msg__bubble--good-balance';
  if (x.includes('bad moment') || x.includes('bad_moment')) return 'tagger-msg__bubble--bad-moment';
  return 'tagger-msg__bubble--default';
}

/** Calendar date in local timezone (for DB `date`); independent of RaceSight playback/selection time. */
function localDateYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Comment / flag / nice / good moment / job: press time T → focus = T−5s, start = focus−5s, end = focus+5s.
 */
function timestampsPointWindowFromPress(press: Date): {
  focus_time: string;
  start_time: string;
  end_time: string;
  date: string;
} {
  const pressMs = press.getTime();
  const focusMs = pressMs - 5000;
  const startMs = focusMs - 5000;
  const endMs = focusMs + 5000;
  const focusDate = new Date(focusMs);
  return {
    focus_time: focusDate.toISOString(),
    start_time: new Date(startMs).toISOString(),
    end_time: new Date(endMs).toISOString(),
    date: localDateYmd(focusDate),
  };
}

/** Event types that use a single focus time → point window (Comment, Job, Flag, Nice, Good moment, Bad). */
const TAGGER_FOCUS_TIME_EVENT_TYPES = new Set([
  'COMMENT',
  'JOB',
  'FLAG',
  'NICE',
  'GOOD_BALANCE',
  'BAD_MOMENT',
]);

function taggerEventTypeUsesFocusTime(et: string): boolean {
  return TAGGER_FOCUS_TIME_EVENT_TYPES.has(et.trim().toUpperCase());
}

type NewTagTimes = {
  focus_time: string;
  start_time: string | null;
  end_time: string | null;
  date: string;
};

/** Times for a new row from the same fields as edit (focus-driven point window for comment-like types). */
function buildTimesForNewFromForm(
  typeStr: string,
  focusLocalValue: string,
  startLocalValue: string,
  endLocalValue: string
): NewTagTimes {
  const et = typeStr.trim().toUpperCase();
  if (taggerEventTypeUsesFocusTime(et)) {
    const iso = datetimeLocalValueToIso(focusLocalValue.trim());
    const base =
      iso && !Number.isNaN(new Date(iso).getTime()) ? new Date(iso) : new Date();
    return timestampsPointWindowFromPress(base);
  }
  if (et === 'TEST' || et === 'SAILS' || et === 'CREW') {
    const startIso =
      datetimeLocalValueToIso(startLocalValue.trim()) ?? new Date().toISOString();
    const d = new Date(startIso);
    const date = Number.isNaN(d.getTime()) ? localDateYmd(new Date()) : localDateYmd(d);
    const endTrim = endLocalValue.trim();
    let endIso: string | null;
    if (endTrim === '') {
      endIso = null;
    } else {
      endIso = datetimeLocalValueToIso(endLocalValue) ?? null;
    }
    return {
      focus_time: startIso,
      start_time: startIso,
      end_time: endIso,
      date,
    };
  }
  return timestampsPointWindowFromPress(new Date());
}

const TAGGER_MOBILE_SWIPE_MQ = '(max-width: 899px)';
/** Matches CSS: two-column Quick tag + Session Tags (not stacked compose-only). */
const TAGGER_DESKTOP_TWO_COL_MQ = '(min-width: 900px)';
const TAGGER_SWIPE_MIN_DX = 56;
const TAGGER_LONG_PRESS_MS = 2000;
const TAGGER_LONG_PRESS_MOVE_PX = 12;

function taggerMobileSwipeEnabled(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(TAGGER_MOBILE_SWIPE_MQ).matches;
}

/** Narrow layout: Session Tags feed should stay pinned to the latest message. */
function taggerIsMobileFeedLayout(): boolean {
  return taggerMobileSwipeEnabled();
}

function taggerScrollSessionFeedToBottom(el: HTMLDivElement | undefined): void {
  if (!el) {
    return;
  }
  const apply = () => {
    el.scrollTop = el.scrollHeight;
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(apply);
  });
}

type TaggerMessageBubbleProps = {
  row: TaggerStoredEvent;
  onEdit: (row: TaggerStoredEvent) => void;
  /** False when the previous message in the feed is from the same author (WhatsApp-style stack). */
  isGroupStart: boolean;
  /** One DB row → two bubbles when a test has finished (start + end). */
  testPhase?: 'start' | 'end';
};

/** Isolated so `user()` is tracked and names refresh when the RaceSight profile loads. */
function TaggerMessageBubble(props: TaggerMessageBubbleProps) {
  let touchStartX = 0;
  let touchStartY = 0;

  let longPressTimer: number | undefined;
  let longPressGestureActive = false;
  let longPressPid = -1;
  let longPressStartX = 0;
  let longPressStartY = 0;
  let longPressMoveHandler: ((ev: PointerEvent) => void) | undefined;
  let longPressUpHandler: ((ev: PointerEvent) => void) | undefined;

  const clearLongPressTimer = () => {
    if (longPressTimer !== undefined) {
      clearTimeout(longPressTimer);
      longPressTimer = undefined;
    }
  };

  const detachLongPressWindowListeners = () => {
    if (longPressMoveHandler && longPressUpHandler) {
      window.removeEventListener('pointermove', longPressMoveHandler);
      window.removeEventListener('pointerup', longPressUpHandler);
      window.removeEventListener('pointercancel', longPressUpHandler);
    }
    longPressMoveHandler = undefined;
    longPressUpHandler = undefined;
  };

  const cancelLongPressGesture = () => {
    if (!longPressGestureActive) {
      return;
    }
    longPressGestureActive = false;
    longPressPid = -1;
    clearLongPressTimer();
    detachLongPressWindowListeners();
  };

  const onBubblePointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) {
      return;
    }
    const el = e.target as HTMLElement | null;
    if (el?.closest?.('button, a[href], input, textarea, select, label')) {
      return;
    }

    cancelLongPressGesture();

    const capturedPid = e.pointerId;
    longPressGestureActive = true;
    longPressPid = capturedPid;
    longPressStartX = e.clientX;
    longPressStartY = e.clientY;

    const onWindowPointerMove = (ev: PointerEvent) => {
      if (!longPressGestureActive || ev.pointerId !== longPressPid) {
        return;
      }
      const dx = ev.clientX - longPressStartX;
      const dy = ev.clientY - longPressStartY;
      if (dx * dx + dy * dy > TAGGER_LONG_PRESS_MOVE_PX * TAGGER_LONG_PRESS_MOVE_PX) {
        cancelLongPressGesture();
      }
    };

    const onWindowPointerUp = (ev: PointerEvent) => {
      if (!longPressGestureActive || ev.pointerId !== longPressPid) {
        return;
      }
      cancelLongPressGesture();
    };

    longPressMoveHandler = onWindowPointerMove;
    longPressUpHandler = onWindowPointerUp;

    longPressTimer = window.setTimeout(() => {
      longPressTimer = undefined;
      if (!longPressGestureActive || longPressPid !== capturedPid) {
        return;
      }
      longPressGestureActive = false;
      longPressPid = -1;
      detachLongPressWindowListeners();
      props.onEdit(props.row);
    }, TAGGER_LONG_PRESS_MS);

    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
  };

  onCleanup(() => {
    cancelLongPressGesture();
  });

  const [testElapsedTick, setTestElapsedTick] = createSignal(0);

  createEffect(() => {
    const row = props.row;
    const phase = props.testPhase;
    const showTimer =
      row.event_type.toUpperCase() === 'TEST' &&
      taggerIsTestRowOpen(row) &&
      phase !== 'end';
    if (!showTimer) {
      return;
    }
    const id = window.setInterval(() => {
      setTestElapsedTick((n) => n + 1);
    }, 1000);
    onCleanup(() => clearInterval(id));
  });

  const testElapsedLabel = createMemo(() => {
    testElapsedTick();
    const row = props.row;
    if (row.event_type.toUpperCase() !== 'TEST' || !taggerIsTestRowOpen(row) || props.testPhase === 'end') {
      return null;
    }
    const st = row.start_time;
    if (!st) {
      return null;
    }
    const t = new Date(st).getTime();
    if (Number.isNaN(t)) {
      return null;
    }
    return taggerFmtElapsedMmSsSince(t);
  });

  const onTouchStart = (e: TouchEvent) => {
    if (!taggerMobileSwipeEnabled()) {
      return;
    }
    if (e.touches.length !== 1) {
      return;
    }
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!taggerMobileSwipeEnabled()) {
      return;
    }
    const t = e.changedTouches[0];
    if (!t) {
      return;
    }
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (dx > TAGGER_SWIPE_MIN_DX && dx > Math.abs(dy) * 1.2) {
      props.onEdit(props.row);
    }
  };

  const me = () => user() as Record<string, unknown> | null;
  const author = () => authorLabelForEvent(props.row, me());
  const authorPillStyle = createMemo(() => taggerAuthorPillStylesFromLabel(author()));
  const timeLabel = () => {
    if (props.testPhase === 'end') {
      return fmtTimeOnly(props.row.end_time);
    }
    if (props.testPhase === 'start') {
      return fmtTimeOnly(props.row.start_time);
    }
    return fmtTimeOnly(props.row.focus_time ?? props.row.start_time);
  };
  const bubbleText = () => taggerBubbleBodyText(props.row, props.testPhase);
  const bubbleClass = () => bubbleClassForEventType(props.row.event_type);
  const showTail = () => props.isGroupStart && props.testPhase !== 'end';
  const groupClass = () =>
    props.isGroupStart ? 'tagger-msg--group-start' : 'tagger-msg--group-cont';
  return (
    <article class={`tagger-msg ${groupClass()}`}>
      <div
        class="tagger-msg__swipe-wrap"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div class="tagger-msg__grid">
          <div class="tagger-msg__name-col">
            <Show when={props.isGroupStart}>
              <span class="tagger-msg__name-pill" style={authorPillStyle()}>
                {author()}
              </span>
            </Show>
          </div>
          <div class="tagger-msg__bubble-row">
            <div
              class={`tagger-msg__bubble ${bubbleClass()}${
                showTail() ? ' tagger-msg__bubble--tail' : ''
              }`}
              onPointerDown={onBubblePointerDown}
            >
              <div class="tagger-msg__bubble-meta tagger-msg__bubble-meta--time-only">
                <span class="tagger-msg__time">{timeLabel()}</span>
                <Show when={props.row.pending}>
                  <span class="tagger-msg__pending" title="Pending sync">
                    {' '}
                    · …
                  </span>
                </Show>
              </div>
              <p class="tagger-msg__text">{bubbleText()}</p>
              <Show when={testElapsedLabel()}>
                <p class="tagger-msg__elapsed" aria-live="polite">
                  {testElapsedLabel()}
                </p>
              </Show>
              <div class="tagger-msg__actions tagger-msg__actions--mobile">
                <button type="button" class="tagger-msg__action" onClick={() => props.onEdit(props.row)}>
                  Edit
                </button>
              </div>
            </div>
            <div class="tagger-msg__edit-desktop">
              <button
                type="button"
                class="tagger-msg__action tagger-msg__action--outside"
                onClick={() => props.onEdit(props.row)}
              >
                Edit
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function TaggerNoteAndEventFields(props: {
  comment: Accessor<string>;
  setComment: (v: string) => void;
  eventType: Accessor<string>;
  setEventType: (v: string) => void;
  showEventType: Accessor<boolean>;
  setCommentTextAreaRef: (el: HTMLTextAreaElement | undefined) => void;
}) {
  return (
    <>
      <div class="tagger-field tagger-field--full">
        <label for="tagger-comment">Comment / note</label>
        <textarea
          id="tagger-comment"
          class="tagger-comment-note"
          ref={(el) => props.setCommentTextAreaRef(el ?? undefined)}
          value={props.comment()}
          onInput={(e) => props.setComment(e.currentTarget.value)}
          placeholder="Enter details…"
        />
      </div>
      <Show when={props.showEventType()}>
        <div class="tagger-field">
          <label for="tagger-event-type">Event type</label>
          <input
            id="tagger-event-type"
            type="text"
            value={props.eventType()}
            onInput={(e) => props.setEventType(e.currentTarget.value)}
            autocomplete="off"
          />
        </div>
      </Show>
    </>
  );
}

function TaggerEditTimeFields(props: {
  eventTypeUpper: Accessor<string>;
  focusLocal: Accessor<string>;
  setFocusLocal: (v: string) => void;
  startLocal: Accessor<string>;
  setStartLocal: (v: string) => void;
  endLocal: Accessor<string>;
  setEndLocal: (v: string) => void;
}) {
  const showFocus = createMemo(() => taggerEventTypeUsesFocusTime(props.eventTypeUpper()));
  const showRange = createMemo(() => {
    const u = props.eventTypeUpper();
    return u === 'TEST' || u === 'CREW' || u === 'SAILS';
  });
  return (
    <>
      <Show when={showFocus()}>
        <div class="tagger-field tagger-field--full">
          <label for="tagger-edit-focus-time">Focus time</label>
          <input
            id="tagger-edit-focus-time"
            type="datetime-local"
            step={1}
            class="tagger-datetime-input"
            value={props.focusLocal()}
            onInput={(e) => props.setFocusLocal(e.currentTarget.value)}
          />
        </div>
      </Show>
      <Show when={showRange()}>
        <div class="tagger-field tagger-field--full">
          <label for="tagger-edit-start-time">Start time</label>
          <input
            id="tagger-edit-start-time"
            type="datetime-local"
            step={1}
            class="tagger-datetime-input"
            value={props.startLocal()}
            onInput={(e) => props.setStartLocal(e.currentTarget.value)}
          />
        </div>
        <div class="tagger-field tagger-field--full">
          <label for="tagger-edit-end-time">End time</label>
          <input
            id="tagger-edit-end-time"
            type="datetime-local"
            step={1}
            class="tagger-datetime-input"
            value={props.endLocal()}
            onInput={(e) => props.setEndLocal(e.currentTarget.value)}
          />
          <span class="tagger-field__hint">Leave empty while interval is still open.</span>
        </div>
      </Show>
    </>
  );
}

const TAGGER_CREW_DATALIST_ID = 'tagger-crew-datalist-shared';

function TaggerCrewComboInput(props: {
  id: string;
  label: string;
  value: Accessor<string>;
  setValue: (v: string) => void;
  schedulePersist: () => void;
  onBlurRemember: (value: string) => void;
}) {
  return (
    <div class="tagger-field tagger-field--full tagger-field--interval-select">
      <label for={props.id}>{props.label}</label>
      <input
        type="text"
        id={props.id}
        class="tagger-interval-select tagger-crew-combo"
        list={TAGGER_CREW_DATALIST_ID}
        autocomplete="off"
        value={props.value()}
        onInput={(e) => {
          props.setValue(e.currentTarget.value);
          props.schedulePersist();
        }}
        onBlur={(e) => props.onBlurRemember(e.currentTarget.value)}
      />
    </div>
  );
}

function TaggerStructuredIntervalFormFields(props: {
  schedulePersist: () => void;
  kind: Accessor<'sails' | 'crew' | undefined>;
  structuredStartLocal: Accessor<string>;
  setStructuredStartLocal: (v: string) => void;
  structuredEndLocal: Accessor<string>;
  setStructuredEndLocal: (v: string) => void;
  sailsMainsail: Accessor<string>;
  setSailsMainsail: (v: string) => void;
  sailsHeadsail: Accessor<string>;
  setSailsHeadsail: (v: string) => void;
  crewHelmPort: Accessor<string>;
  setCrewHelmPort: (v: string) => void;
  crewHelmStbd: Accessor<string>;
  setCrewHelmStbd: (v: string) => void;
  crewFlightPort: Accessor<string>;
  setCrewFlightPort: (v: string) => void;
  crewFlightStbd: Accessor<string>;
  setCrewFlightStbd: (v: string) => void;
  crewStrategist: Accessor<string>;
  setCrewStrategist: (v: string) => void;
  crewNameHistory: Accessor<string[]>;
  onCrewNameBlur: (value: string) => void;
}) {
  const crewDatalistOptions = createMemo(() => mergedCrewDatalistOptions(props.crewNameHistory()));
  return (
    <>
      <div class="tagger-interval-fields tagger-interval-fields--times">
        <div class="tagger-field tagger-field--full">
          <label for="tagger-structured-start-time">Start time</label>
          <input
            id="tagger-structured-start-time"
            type="datetime-local"
            step={1}
            class="tagger-datetime-input"
            value={props.structuredStartLocal()}
            onInput={(e) => {
              props.setStructuredStartLocal(e.currentTarget.value);
              props.schedulePersist();
            }}
          />
        </div>
        <div class="tagger-field tagger-field--full">
          <label for="tagger-structured-end-time">End time</label>
          <input
            id="tagger-structured-end-time"
            type="datetime-local"
            step={1}
            class="tagger-datetime-input"
            value={props.structuredEndLocal()}
            onInput={(e) => {
              props.setStructuredEndLocal(e.currentTarget.value);
              props.schedulePersist();
            }}
          />
          <span class="tagger-field__hint">Leave empty while interval is still open.</span>
        </div>
      </div>
      <Show when={props.kind() === 'sails'}>
        <div class="tagger-interval-fields">
          <div class="tagger-field tagger-field--full tagger-field--interval-select">
            <label for="tagger-mainsail">Mainsail</label>
            <select
              id="tagger-mainsail"
              class="tagger-interval-select"
              value={props.sailsMainsail()}
              onChange={(e) => {
                props.setSailsMainsail(e.currentTarget.value);
                props.schedulePersist();
              }}
            >
              <option value="NA">NA</option>
              <option value="M1">M1</option>
              <option value="M2">M2</option>
              <option value="M3">M3</option>
            </select>
          </div>
          <div class="tagger-field tagger-field--full tagger-field--interval-select">
            <label for="tagger-headsail">Headsail</label>
            <select
              id="tagger-headsail"
              class="tagger-interval-select"
              value={props.sailsHeadsail()}
              onChange={(e) => {
                props.setSailsHeadsail(e.currentTarget.value);
                props.schedulePersist();
              }}
            >
              <option value="NA">NA</option>
              <option value="J1">J1</option>
              <option value="J2">J2</option>
              <option value="J3">J3</option>
              <option value="J4">J4</option>
              <option value="J5">J5</option>
              <option value="J6">J6</option>
            </select>
          </div>
        </div>
      </Show>
      <Show when={props.kind() === 'crew'}>
        <datalist id={TAGGER_CREW_DATALIST_ID}>
          <For each={crewDatalistOptions()}>{(opt) => <option value={opt} />}</For>
        </datalist>
        <div class="tagger-interval-fields">
          <TaggerCrewComboInput
            id="tagger-crew-helm-port"
            label="Helm Port"
            value={props.crewHelmPort}
            setValue={props.setCrewHelmPort}
            schedulePersist={props.schedulePersist}
            onBlurRemember={props.onCrewNameBlur}
          />
          <TaggerCrewComboInput
            id="tagger-crew-helm-stbd"
            label="Helm Stbd"
            value={props.crewHelmStbd}
            setValue={props.setCrewHelmStbd}
            schedulePersist={props.schedulePersist}
            onBlurRemember={props.onCrewNameBlur}
          />
          <TaggerCrewComboInput
            id="tagger-crew-flight-port"
            label="Flight Port"
            value={props.crewFlightPort}
            setValue={props.setCrewFlightPort}
            schedulePersist={props.schedulePersist}
            onBlurRemember={props.onCrewNameBlur}
          />
          <TaggerCrewComboInput
            id="tagger-crew-flight-stbd"
            label="Flight Stbd"
            value={props.crewFlightStbd}
            setValue={props.setCrewFlightStbd}
            schedulePersist={props.schedulePersist}
            onBlurRemember={props.onCrewNameBlur}
          />
          <TaggerCrewComboInput
            id="tagger-crew-strategist"
            label="Strategist"
            value={props.crewStrategist}
            setValue={props.setCrewStrategist}
            schedulePersist={props.schedulePersist}
            onBlurRemember={props.onCrewNameBlur}
          />
        </div>
      </Show>
    </>
  );
}

function taggerCsvEscapeField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const TAGGER_CSV_HEADERS = [
  'client_id',
  'server_id',
  'project_id',
  'user_id',
  'user_name',
  'date',
  'focus_time',
  'start_time',
  'end_time',
  'event_type',
  'comment',
  'date_modified',
  'pending',
  'pending_delete',
  'updated_at',
] as const;

function taggerBuildEventsCsv(rows: TaggerStoredEvent[]): string {
  const visible = rows.filter((r) => !r.pendingDelete);
  const sorted = sortEventsChronoAsc(visible);
  const lines: string[] = [TAGGER_CSV_HEADERS.join(',')];
  for (const e of sorted) {
    const cells = [
      e.clientId,
      e.serverId == null ? '' : String(e.serverId),
      String(e.projectId),
      e.user_id ?? '',
      e.user_name ?? '',
      e.date ?? '',
      e.focus_time ?? '',
      e.start_time ?? '',
      e.end_time ?? '',
      e.event_type,
      e.comment,
      e.date_modified ?? '',
      e.pending ? 'true' : 'false',
      e.pendingDelete ? 'true' : 'false',
      String(e.updatedAt),
    ].map((c) => taggerCsvEscapeField(String(c)));
    lines.push(cells.join(','));
  }
  return lines.join('\r\n');
}

type TaggerSaveFilePickerOptions = {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
};

async function taggerSaveCsvBlob(blob: Blob, suggestedName: string): Promise<void> {
  const w = window as Window & {
    showSaveFilePicker?: (options?: TaggerSaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  };
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'CSV spreadsheet', accept: { 'text/csv': ['.csv'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err: unknown) {
      const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
      if (name === 'AbortError') {
        return;
      }
      warn('[Tagger] Save file picker failed, using download fallback', err);
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function Tagger() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [projectId, setProjectId] = createSignal<number | null>(null);
  const [events, setEvents] = createSignal<TaggerStoredEvent[]>([]);
  const [eventType, setEventType] = createSignal<string>('COMMENT');
  const [comment, setComment] = createSignal<string>('');
  const [editingClientId, setEditingClientId] = createSignal<string | null>(null);
  /** After a quick-tag preset, table hides and the compose area uses the space. */
  const [composeAfterPreset, setComposeAfterPreset] = createSignal(false);
  let commentTextAreaRef: HTMLTextAreaElement | undefined;
  const [banner, setBanner] = createSignal<{ kind: 'warn' | 'error'; text: string } | undefined>(undefined);
  const [feedSettingsOpen, setFeedSettingsOpen] = createSignal(false);
  const [online, setOnline] = createSignal(typeof navigator !== 'undefined' ? navigator.onLine : true);
  /** Local test in progress; server row has `end_time` null until Stop test. */
  const [testSession, setTestSession] = createSignal<TaggerTestSession | null>(null);

  /** `clientId: null` = new sail/crew interval not persisted until Add entry / Save. */
  type StructuredComposeState = { kind: 'sails' | 'crew'; clientId: string | null };
  const [structuredCompose, setStructuredCompose] = createSignal<StructuredComposeState | null>(null);
  const [sailsMainsail, setSailsMainsail] = createSignal('');
  const [sailsHeadsail, setSailsHeadsail] = createSignal('');
  const [crewHelmPort, setCrewHelmPort] = createSignal('');
  const [crewHelmStbd, setCrewHelmStbd] = createSignal('');
  const [crewFlightPort, setCrewFlightPort] = createSignal('');
  const [crewFlightStbd, setCrewFlightStbd] = createSignal('');
  const [crewStrategist, setCrewStrategist] = createSignal('');
  const [crewNameHistory, setCrewNameHistory] = createSignal<string[]>(
    typeof window !== 'undefined' ? loadCrewComboHistory() : []
  );

  const handleCrewNameBlur = (value: string) => {
    setCrewNameHistory((prev) => {
      const next = addCrewNameToHistory(prev, value);
      persistCrewComboHistory(next);
      return next;
    });
  };

  const [editFocusTimeLocal, setEditFocusTimeLocal] = createSignal('');
  const [editStartTimeLocal, setEditStartTimeLocal] = createSignal('');
  const [editEndTimeLocal, setEditEndTimeLocal] = createSignal('');
  const [structuredStartLocal, setStructuredStartLocal] = createSignal('');
  const [structuredEndLocal, setStructuredEndLocal] = createSignal('');
  const [taggerDesktopTwoCol, setTaggerDesktopTwoCol] = createSignal(
    typeof window !== 'undefined' && window.matchMedia(TAGGER_DESKTOP_TWO_COL_MQ).matches
  );

  type PlainEditBaseline = {
    comment: string;
    eventType: string;
    focus: string;
    start: string;
    end: string;
  };
  const [plainEditBaseline, setPlainEditBaseline] = createSignal<PlainEditBaseline | null>(null);
  const [structuredEditBaseline, setStructuredEditBaseline] = createSignal<string | null>(null);

  let structuredSaveTimer: number | undefined;
  const flushStructuredSaveTimer = () => {
    if (structuredSaveTimer !== undefined) {
      window.clearTimeout(structuredSaveTimer);
      structuredSaveTimer = undefined;
    }
  };

  const resetStructuredFormFields = () => {
    setSailsMainsail('NA');
    setSailsHeadsail('NA');
    setCrewHelmPort('NA');
    setCrewHelmStbd('NA');
    setCrewFlightPort('NA');
    setCrewFlightStbd('NA');
    setCrewStrategist('NA');
    setStructuredStartLocal('');
    setStructuredEndLocal('');
  };

  const resetEditTimeFields = () => {
    setEditFocusTimeLocal('');
    setEditStartTimeLocal('');
    setEditEndTimeLocal('');
  };

  /** Wide + Sails/Crew (new interval or edit): form in Session Tags, Quick tag stays sidebar — same as plain edit. */
  const taggerStructuredFormInFeed = createMemo(
    () => structuredCompose() !== null && taggerDesktopTwoCol()
  );

  /** Hide Session Tags only for structured compose on narrow view (form stays under Quick tag). */
  const taggerHideSessionFeed = createMemo(() => {
    if (structuredCompose() === null) {
      return false;
    }
    if (taggerStructuredFormInFeed()) {
      return false;
    }
    return true;
  });

  /** Edit COMMENT/JOB/etc. in Session Tags column; Sails/Crew wide layout uses taggerStructuredFormInFeed. */
  const taggerPlainEditInFeed = createMemo(
    () => editingClientId() !== null && structuredCompose() === null
  );

  /** New note after a preset: same Session Tags layout as edit (not in Quick tag). */
  const taggerPlainComposeInFeed = createMemo(
    () => composeAfterPreset() && structuredCompose() === null && editingClientId() === null
  );

  const openSailCrewRecorder = createMemo((): { eventType: string } | null => {
    const pid = projectId();
    if (pid == null) {
      return null;
    }
    const sc = structuredCompose();
    if (sc && sc.clientId === null) {
      return { eventType: sc.kind === 'sails' ? 'SAILS' : 'CREW' };
    }
    const list = events().filter((e) => e.projectId === pid && taggerIsSailCrewRowOpen(e));
    if (list.length !== 1) {
      return null;
    }
    return { eventType: list[0].event_type.toUpperCase() };
  });

  const taggerFormGridComposeInterval = createMemo(() => structuredCompose() !== null);

  const taggerShowEventTypeField = createMemo(() => {
    if (structuredCompose() || editingClientId()) {
      return false;
    }
    const et = eventType().trim().toUpperCase();
    return !taggerEventTypeUsesFocusTime(et);
  });

  type FeedDisplayItem = {
    key: string;
    row: TaggerStoredEvent;
    isGroupStart: boolean;
    testPhase?: 'start' | 'end';
  };

  /** Expand completed TEST rows to two bubbles; WhatsApp-style author grouping. */
  const feedDisplayItems = createMemo((): FeedDisplayItem[] => {
    const list = events();
    const me = user() as Record<string, unknown> | null;
    const sorted = sortEventsChronoAsc(list);
    const expanded: Omit<FeedDisplayItem, 'isGroupStart'>[] = [];
    for (const row of sorted) {
      if (taggerIsTestRowComplete(row)) {
        expanded.push({ key: `${row.clientId}-test-start`, row, testPhase: 'start' });
        expanded.push({ key: `${row.clientId}-test-end`, row, testPhase: 'end' });
      } else {
        expanded.push({ key: row.clientId, row });
      }
    }
    let prevKey: string | null = null;
    const out: FeedDisplayItem[] = [];
    for (const item of expanded) {
      const key = authorGroupKeyForEvent(item.row, me);
      const isGroupStart = prevKey === null || prevKey !== key;
      out.push({ ...item, isGroupStart });
      prevKey = key;
    }
    return out;
  });

  let lastProjectForInterval: number | null = null;
  createEffect(() => {
    const pid = projectId();
    if (lastProjectForInterval !== null && pid !== lastProjectForInterval) {
      flushStructuredSaveTimer();
      setStructuredCompose(null);
      resetStructuredFormFields();
      resetEditTimeFields();
      setTestSession(null);
    }
    lastProjectForInterval = pid;
  });

  const refreshFromDb = async (pid: number) => {
    try {
      const rows = await taggerGetEventsForProject(pid);
      const visible = rows.filter((r) => !r.pendingDelete);
      setEvents(sortEventsChronoAsc(visible));
      const eid = editingClientId();
      if (eid) {
        const still = await taggerGetEvent(eid);
        if (!still) {
          setEditingClientId(null);
        }
      }
    } catch (e) {
      logError('[Tagger] refreshFromDb failed', e);
    }
  };

  const syncAll = async (pid: number, signal?: AbortSignal) => {
    await taggerFlushOutbox(pid);
    await taggerPullAndMergeServer(pid, signal);
    await refreshFromDb(pid);
  };

  const startTestSession = async (pid: number): Promise<void> => {
    const existing = await taggerGetEventsForProject(pid);
    const openTests = existing.filter(taggerIsTestRowOpen);
    if (openTests.length > 1) {
      setBanner({
        kind: 'warn',
        text: `${openTests.length} unfinished tests are in Session Tags. Edit each to set an end time or delete them before starting a new test.`,
      } as const);
      return;
    }
    if (openTests.length === 1) {
      const r = openTests[0];
      if (r.start_time) {
        await refreshFromDb(pid);
        const me = currentUserIdString(user() as Record<string, unknown> | null);
        setTestSession({
          clientId: r.clientId,
          startTimeIso: r.start_time,
          starterUserId: taggerStarterUserIdFromRow(r, me),
        });
        setBanner({
          kind: 'warn',
          text: 'A test is already in progress. Tap Stop Test when you are done.',
        } as const);
      }
      return;
    }

    const clientId = newLocalClientId();
    const now = new Date();
    const startIso = now.toISOString();
    const starterUserId = currentUserIdString(user() as Record<string, unknown> | null);
    const row: TaggerStoredEvent = {
      clientId,
      serverId: null,
      projectId: pid,
      user_id: null,
      date: localDateYmd(now),
      focus_time: startIso,
      start_time: startIso,
      end_time: null,
      event_type: 'TEST',
      comment: TAGGER_TEST_START_COMMENT,
      pending: true,
      updatedAt: Date.now(),
    };
    await taggerPutEvent(row);
    await refreshFromDb(pid);
    setTestSession({ clientId, startTimeIso: startIso, starterUserId });
    setBanner(undefined);
    queueMicrotask(() => {
      requestAnimationFrame(() => {
        taggerScrollSessionFeedToBottom(taggerFeedScrollEl);
      });
    });
    try {
      const migratedCid = await taggerTrySyncCreate(pid, clientId);
      await taggerFlushOutbox(pid);
      await syncAll(pid);
      const rowsAfter = await taggerGetEventsForProject(pid);
      const cidResolved = migratedCid ?? clientId;
      const resolved = rowsAfter.find((e) => e.clientId === cidResolved);
      if (resolved && taggerIsTestRowOpen(resolved)) {
        const me = currentUserIdString(user() as Record<string, unknown> | null);
        setTestSession({
          clientId: resolved.clientId,
          startTimeIso: resolved.start_time ?? startIso,
          starterUserId: taggerStarterUserIdFromRow(resolved, me),
        });
      }
      queueMicrotask(() => {
        requestAnimationFrame(() => {
          taggerScrollSessionFeedToBottom(taggerFeedScrollEl);
        });
      });
    } catch (e) {
      logError('[Tagger] Test sync after start failed', e);
      setBanner({
        kind: 'warn',
        text: 'Test started locally. Sync will retry when the connection is available.',
      } as const);
    }
    debug('[Tagger] Test started', startIso);
  };

  const stopTestSession = async (pid: number, sess: TaggerTestSession): Promise<void> => {
    const rows = await taggerGetEventsForProject(pid);
    const row = rows.find(
      (e) =>
        e.event_type.toUpperCase() === 'TEST' &&
        taggerIsTestRowOpen(e) &&
        taggerOpenTestMatchesSession(e, sess)
    );
    if (!row) {
      warn('[Tagger] Could not find open test row to stop; clearing session');
      setTestSession(null);
      return;
    }
    const endIso = new Date().toISOString();
    const updated: TaggerStoredEvent = {
      ...row,
      end_time: endIso,
      pending: true,
      updatedAt: Date.now(),
    };
    await taggerPutEvent(updated);
    if (updated.serverId != null) {
      await taggerTrySyncUpdate(pid, row.clientId);
    } else {
      await taggerFlushOutbox(pid);
    }
    await syncAll(pid);
    setTestSession(null);
    setBanner(undefined);
    debug('[Tagger] Test stopped', row.clientId);
  };

  /** Clear stale session when the open row disappears; re-link Stop test after refresh when exactly one matching open test exists. */
  createEffect(() => {
    const pid = projectId();
    const sess = testSession();
    const list = pid != null ? events().filter((e) => e.projectId === pid) : [];
    const me = currentUserIdString(user() as Record<string, unknown> | null);

    if (sess) {
      const row = list.find(
        (e) =>
          e.event_type.toUpperCase() === 'TEST' &&
          taggerIsTestRowOpen(e) &&
          taggerOpenTestMatchesSession(e, sess)
      );
      if (!row || !taggerIsTestRowOpen(row)) {
        setTestSession(null);
        return;
      }
      if (row.clientId !== sess.clientId) {
        setTestSession({ ...sess, clientId: row.clientId });
      }
      return;
    }

    const openForMe = list.filter(
      (e) =>
        e.event_type.toUpperCase() === 'TEST' &&
        taggerIsTestRowOpen(e) &&
        e.start_time &&
        (me == null ||
          me === '' ||
          e.user_id == null ||
          String(e.user_id) === String(me))
    );
    if (openForMe.length !== 1) {
      return;
    }
    const only = openForMe[0];
    const st = only.start_time;
    if (!st) {
      return;
    }
    setTestSession({
      clientId: only.clientId,
      startTimeIso: st,
      starterUserId: taggerStarterUserIdFromRow(only, me),
    });
  });

  let taggerFeedScrollEl: HTMLDivElement | undefined;

  createEffect(() => {
    events();
    taggerHideSessionFeed();
    if (taggerHideSessionFeed()) {
      return;
    }
    if (editingClientId()) {
      return;
    }
    if (!taggerIsMobileFeedLayout()) {
      return;
    }
    taggerScrollSessionFeedToBottom(taggerFeedScrollEl);
  });

  onMount(() => {
    const scrollFeedIfMobile = () => {
      if (!taggerIsMobileFeedLayout()) {
        return;
      }
      taggerScrollSessionFeedToBottom(taggerFeedScrollEl);
    };
    window.addEventListener('resize', scrollFeedIfMobile);
    window.addEventListener('orientationchange', scrollFeedIfMobile);
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
    vv?.addEventListener('resize', scrollFeedIfMobile);
    onCleanup(() => {
      window.removeEventListener('resize', scrollFeedIfMobile);
      window.removeEventListener('orientationchange', scrollFeedIfMobile);
      vv?.removeEventListener('resize', scrollFeedIfMobile);
    });

    if (!hasLocalAuthCredential()) {
      navigate('/login', { replace: true });
      return;
    }

    const raw = searchParams.pid ?? searchParams.project_id;
    if (raw == null || raw === '') {
      setBanner({ kind: 'error', text: 'Missing project id. Use /tagger?pid=1' } as const);
      return;
    }
    const n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) {
      setBanner({ kind: 'error', text: 'Invalid project id.' } as const);
      return;
    }
    setProjectId(n);

    const ac = new AbortController();
    void (async () => {
      await refreshFromDb(n);
      try {
        await syncAll(n, ac.signal);
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        warn('[Tagger] Initial sync failed', e);
        setBanner({
          kind: 'warn',
          text: 'Working offline or server unavailable — changes are saved locally until connection returns.',
        } as const);
      }
    })();

    const onOnline = () => {
      setOnline(true);
      void syncAll(n).catch((e) => warn('[Tagger] Online sync failed', e));
    };
    const onOffline = () => {
      setOnline(false);
      setBanner({ kind: 'warn', text: 'You are offline. Entries are queued and will sync when back online.' } as const);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    const desktopMq = window.matchMedia(TAGGER_DESKTOP_TWO_COL_MQ);
    const onDesktopMq = () => setTaggerDesktopTwoCol(desktopMq.matches);
    onDesktopMq();
    desktopMq.addEventListener('change', onDesktopMq);

    onCleanup(() => {
      ac.abort();
      flushStructuredSaveTimer();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      desktopMq.removeEventListener('change', onDesktopMq);
    });
  });

  const clearForm = () => {
    flushStructuredSaveTimer();
    setStructuredCompose(null);
    resetStructuredFormFields();
    resetEditTimeFields();
    setComment('');
    setEditingClientId(null);
    setComposeAfterPreset(false);
    setPlainEditBaseline(null);
    setStructuredEditBaseline(null);
  };

  const exitComposeNewOnly = () => {
    setComposeAfterPreset(false);
    setComment('');
    resetEditTimeFields();
  };

  const exitStructuredNewCompose = () => {
    flushStructuredSaveTimer();
    setStructuredCompose(null);
    resetStructuredFormFields();
    setStructuredEditBaseline(null);
  };

  createEffect(() => {
    if (!composeAfterPreset() && !editingClientId() && !structuredCompose()) {
      return;
    }
    if (structuredCompose()) {
      return;
    }
    requestAnimationFrame(() => {
      commentTextAreaRef?.focus();
    });
  });

  /**
   * While Tagger is open with a project and online, pull server + flush outbox every 5s so other
   * browsers/devices see new entries without composing or editing.
   */
  createEffect(() => {
    const pid = projectId();
    if (!online() || pid == null) {
      return;
    }
    const tick = () => {
      void syncAll(pid).catch((e) => warn('[Tagger] Periodic sync failed', e));
    };
    void tick();
    const id = window.setInterval(tick, 5000);
    onCleanup(() => window.clearInterval(id));
  });

  const buildRowForNew = (
    pid: number,
    clientId: string,
    typeStr: string,
    commentText: string,
    times: {
      focus_time: string;
      start_time: string | null;
      end_time: string | null;
      date: string;
    }
  ): TaggerStoredEvent => ({
    clientId,
    serverId: null,
    projectId: pid,
    user_id: null,
    date: times.date,
    focus_time: times.focus_time,
    start_time: times.start_time,
    end_time: times.end_time,
    event_type: typeStr.trim() || 'COMMENT',
    comment: commentText.trim(),
    pending: true,
    updatedAt: Date.now(),
  });

  const persistNewRow = async (pid: number, row: TaggerStoredEvent): Promise<boolean> => {
    try {
      await taggerPutEvent(row);
      await taggerTrySyncCreate(pid, row.clientId);
      await taggerFlushOutbox(pid);
      await syncAll(pid);
      setBanner(undefined);
      debug('[Tagger] Created', row.clientId);
      return true;
    } catch (e) {
      logError('[Tagger] persistNewRow failed', e);
      setBanner({ kind: 'error', text: 'Could not save entry. Try again when online if needed.' } as const);
      return false;
    }
  };

  /** Create a new tag (Add entry, instant-save presets). Optional `times` matches edit form when adding from Session Tags. */
  const submitNewTag = async (
    pid: number,
    typeStr: string,
    commentText: string,
    times?: NewTagTimes
  ): Promise<boolean> => {
    const text = commentText.trim();
    if (!text) {
      setBanner({ kind: 'warn', text: 'Please enter a comment or note.' } as const);
      return false;
    }
    const clientId = newLocalClientId();
    const resolved = times ?? timestampsPointWindowFromPress(new Date());
    const row = buildRowForNew(pid, clientId, typeStr, text, resolved);
    return persistNewRow(pid, row);
  };

  const buildSailsCommentFromForm = (existingRaw: string | undefined): string => {
    const prev = existingRaw ? taggerParseSailCrewJson(existingRaw) : null;
    const merged: Record<string, string> = { ...taggerDefaultSailsPayload(), ...(prev ?? {}) };
    const ms = sailsMainsail().trim();
    const hs = sailsHeadsail().trim();
    merged.Mainsail = ms === '' ? 'NA' : ms;
    merged.Headsail = hs === '' ? 'NA' : hs;
    return taggerStringifySailCrewJson(merged);
  };

  const buildCrewCommentFromForm = (existingRaw: string | undefined): string => {
    const prev = existingRaw ? taggerParseSailCrewJson(existingRaw) : null;
    const merged: Record<string, string> = { ...taggerDefaultCrewPayload(), ...(prev ?? {}) };
    const nz = (s: string) => (s.trim() === '' ? 'NA' : s.trim());
    merged['Helm Port'] = nz(crewHelmPort());
    merged['Helm Stbd'] = nz(crewHelmStbd());
    merged['Flight Port'] = nz(crewFlightPort());
    merged['Flight Stbd'] = nz(crewFlightStbd());
    merged.Strategist = nz(crewStrategist());
    return taggerStringifySailCrewJson(merged);
  };

  const loadStructuredFormFromRow = (row: TaggerStoredEvent) => {
    const parsed = taggerParseSailCrewJson(row.comment);
    const et = row.event_type.toUpperCase();
    if (et === 'SAILS') {
      const d = { ...taggerDefaultSailsPayload(), ...(parsed ?? {}) };
      setSailsMainsail(taggerSailFieldForSelect(d.Mainsail, TAGGER_MAINSAIL_CODES));
      setSailsHeadsail(taggerSailFieldForSelect(d.Headsail, TAGGER_HEADSAIL_CODES));
    } else {
      const d = { ...taggerDefaultCrewPayload(), ...(parsed ?? {}) };
      setCrewHelmPort(taggerCrewFieldForInput(d['Helm Port']));
      setCrewHelmStbd(taggerCrewFieldForInput(d['Helm Stbd']));
      setCrewFlightPort(taggerCrewFieldForInput(d['Flight Port']));
      setCrewFlightStbd(taggerCrewFieldForInput(d['Flight Stbd']));
      setCrewStrategist(taggerCrewFieldForInput(d.Strategist));
    }
    setStructuredStartLocal(isoToDatetimeLocalValue(row.start_time));
    setStructuredEndLocal(row.end_time ? isoToDatetimeLocalValue(row.end_time) : '');
  };

  const structuredFormSnapshot = (): string => {
    const kind = structuredCompose()?.kind;
    const base = {
      start: structuredStartLocal().trim(),
      end: structuredEndLocal().trim(),
      kind,
    };
    if (kind === 'sails') {
      return JSON.stringify({
        ...base,
        mainsail: sailsMainsail().trim(),
        headsail: sailsHeadsail().trim(),
      });
    }
    if (kind === 'crew') {
      return JSON.stringify({
        ...base,
        hp: crewHelmPort().trim(),
        hs: crewHelmStbd().trim(),
        fp: crewFlightPort().trim(),
        fs: crewFlightStbd().trim(),
        st: crewStrategist().trim(),
      });
    }
    return JSON.stringify(base);
  };

  /** After loc→srv migration, `structuredCompose.clientId` may be stale; find the open row for this kind. */
  const resolveStructuredComposeClientId = async (
    pid: number,
    sc: { kind: 'sails' | 'crew'; clientId: string | null }
  ): Promise<string | null> => {
    if (sc.clientId == null) {
      return null;
    }
    const direct = await taggerGetEvent(sc.clientId);
    if (direct) {
      return sc.clientId;
    }
    const et = sc.kind === 'sails' ? 'SAILS' : 'CREW';
    const all = await taggerGetEventsForProject(pid);
    const open = all.filter(
      (e) =>
        e.projectId === pid &&
        e.event_type.toUpperCase() === et &&
        taggerIsSailCrewRowOpen(e)
    );
    if (open.length !== 1) {
      return null;
    }
    return open[0].clientId;
  };

  const persistStructuredRowFromForm = async (pid: number, clientId: string, commentJson: string) => {
    const row = await taggerGetEvent(clientId);
    if (!row) {
      warn('[Tagger] Structured row missing for persist', clientId);
      return;
    }
    const times = mergeIntervalRowTimesFromDatetimeLocal(row, structuredStartLocal(), structuredEndLocal());
    const updated: TaggerStoredEvent = {
      ...row,
      ...times,
      comment: commentJson,
      pending: true,
      updatedAt: Date.now(),
    };
    await taggerPutEvent(updated);
    if (updated.serverId != null) {
      await taggerTrySyncUpdate(pid, clientId);
    } else {
      await taggerFlushOutbox(pid);
    }
    await syncAll(pid);
  };

  const scheduleStructuredPersistForCurrentForm = () => {
    const pid = projectId();
    const sc = structuredCompose();
    if (pid == null || !sc || sc.clientId === null) {
      return;
    }
    flushStructuredSaveTimer();
    structuredSaveTimer = window.setTimeout(() => {
      structuredSaveTimer = undefined;
      void (async () => {
        try {
          const sc2 = structuredCompose();
          if (pid !== projectId() || !sc2 || sc2.clientId === null) {
            return;
          }
          let cid = sc2.clientId;
          let row = await taggerGetEvent(cid);
          if (!row) {
            const alt = await resolveStructuredComposeClientId(pid, sc2);
            if (alt != null) {
              cid = alt;
              setStructuredCompose({ kind: sc2.kind, clientId: alt });
              row = await taggerGetEvent(cid);
            }
          }
          if (!row) {
            return;
          }
          const raw = row.comment;
          const json =
            sc2.kind === 'sails' ? buildSailsCommentFromForm(raw) : buildCrewCommentFromForm(raw);
          await persistStructuredRowFromForm(pid, cid, json);
        } catch (e) {
          logError('[Tagger] Structured persist failed', e);
        }
      })();
    }, 320);
  };

  const flushStructuredSaveNow = async () => {
    const pid = projectId();
    const sc = structuredCompose();
    if (pid == null || !sc) {
      return;
    }
    flushStructuredSaveTimer();
    try {
      if (sc.clientId === null) {
        const eventTypeU = sc.kind === 'sails' ? 'SAILS' : 'CREW';
        const draftTemplate: TaggerStoredEvent = {
          clientId: '__draft__',
          serverId: null,
          projectId: pid,
          user_id: null,
          date: null,
          focus_time: null,
          start_time: null,
          end_time: null,
          event_type: eventTypeU,
          comment: '',
          pending: true,
          updatedAt: Date.now(),
        };
        const times = mergeIntervalRowTimesFromDatetimeLocal(
          draftTemplate,
          structuredStartLocal(),
          structuredEndLocal()
        );
        const commentJson =
          sc.kind === 'sails' ? buildSailsCommentFromForm(undefined) : buildCrewCommentFromForm(undefined);
        const clientId = newLocalClientId();
        const row: TaggerStoredEvent = {
          clientId,
          serverId: null,
          projectId: pid,
          user_id: null,
          ...times,
          event_type: eventTypeU,
          comment: commentJson,
          pending: true,
          updatedAt: Date.now(),
        };
        const ok = await persistNewRow(pid, row);
        if (ok) {
          exitStructuredNewCompose();
        }
        return;
      }

      let clientId = sc.clientId;
      let row = await taggerGetEvent(clientId);
      if (!row) {
        const alt = await resolveStructuredComposeClientId(pid, sc);
        if (alt != null) {
          clientId = alt;
          setStructuredCompose({ kind: sc.kind, clientId: alt });
          row = await taggerGetEvent(clientId);
        }
      }
      if (!row) {
        warn('[Tagger] flushStructuredSaveNow: no row for structured compose', sc.clientId);
        setBanner({
          kind: 'error',
          text: 'Could not find this interval to save. Try again or refresh the page.',
        } as const);
        return;
      }
      const raw = row.comment;
      const json =
        sc.kind === 'sails' ? buildSailsCommentFromForm(raw) : buildCrewCommentFromForm(raw);
      await persistStructuredRowFromForm(pid, clientId, json);
      setBanner(undefined);
      const wasEditingExisting = editingClientId() != null;
      if (wasEditingExisting) {
        clearForm();
      } else {
        exitStructuredNewCompose();
      }
    } catch (e) {
      logError('[Tagger] flushStructuredSaveNow failed', e);
      setBanner({ kind: 'error', text: 'Could not save changes. Try again.' } as const);
    }
  };

  const taggerPlainEditDirty = createMemo(() => {
    const b = plainEditBaseline();
    if (b == null || editingClientId() == null || structuredCompose() !== null) {
      return false;
    }
    const et = eventType().trim().toUpperCase();
    if (comment().trim() !== (b.comment || '').trim()) {
      return true;
    }
    if (eventType().trim() !== b.eventType.trim()) {
      return true;
    }
    if (taggerEventTypeUsesFocusTime(et) && editFocusTimeLocal() !== b.focus) {
      return true;
    }
    if (
      (et === 'TEST' || et === 'SAILS' || et === 'CREW') &&
      (editStartTimeLocal() !== b.start || editEndTimeLocal() !== b.end)
    ) {
      return true;
    }
    return false;
  });

  const taggerStructuredEditDirty = createMemo(() => {
    const b = structuredEditBaseline();
    if (b == null || structuredCompose() == null) {
      return false;
    }
    return structuredFormSnapshot() !== b;
  });

  /** New draft sail/crew: always offer Add entry; editing: only when dirty. */
  const taggerStructuredShowPrimarySave = createMemo(() => {
    const sc = structuredCompose();
    if (!sc) {
      return false;
    }
    if (editingClientId()) {
      return taggerStructuredEditDirty();
    }
    return sc.clientId === null;
  });

  const taggerStructuredPrimarySaveLabel = createMemo(() =>
    editingClientId() ? 'Save changes' : 'Add entry'
  );

  const startStructuredInterval = async (kind: 'sails' | 'crew') => {
    const pid = projectId();
    if (pid == null) {
      return;
    }
    if (testSession()) {
      setBanner({
        kind: 'warn',
        text: 'Stop the test first before starting a sail or crew interval.',
      } as const);
      return;
    }
    setComposeAfterPreset(false);
    setComment('');
    setEditingClientId(null);
    const rows = await taggerGetEventsForProject(pid);
    const open = rows.filter(taggerIsSailCrewRowOpen);
    if (open.length > 1) {
      setBanner({
        kind: 'warn',
        text: `${open.length} open sail or crew intervals are in Session Tags. Edit or resolve them before starting another.`,
      } as const);
      return;
    }
    if (open.length === 1) {
      const r = open[0];
      const endNote = r.event_type.toUpperCase() === 'SAILS' ? 'Sail down' : 'Crew off';
      const endIso = new Date().toISOString();
      const updated: TaggerStoredEvent = {
        ...r,
        end_time: endIso,
        comment: taggerCloseOpenSailCrewRowComment(r.comment, endNote),
        pending: true,
        updatedAt: Date.now(),
      };
      await taggerPutEvent(updated);
      if (updated.serverId != null) {
        await taggerTrySyncUpdate(pid, r.clientId);
      } else {
        await taggerFlushOutbox(pid);
      }
      await syncAll(pid);
    }
    resetStructuredFormFields();
    const now = new Date();
    setStructuredStartLocal(isoToDatetimeLocalValue(now.toISOString()));
    setStructuredEndLocal('');
    setStructuredCompose({ kind, clientId: null });
    setStructuredEditBaseline(structuredFormSnapshot());
    setBanner(undefined);
    debug('[Tagger] Structured compose opened (draft)', kind);
  };

  const handleAddOrUpdate = async () => {
    const pid = projectId();
    if (pid == null) return;
    if (structuredCompose()) {
      return;
    }
    const text = comment().trim();
    if (!text) {
      setBanner({ kind: 'warn', text: 'Please enter a comment or note.' } as const);
      return;
    }

    const editId = editingClientId();
    if (editId) {
      const existing = await taggerGetEvent(editId);
      if (!existing) {
        setBanner({ kind: 'error', text: 'Could not find entry to update.' } as const);
        return;
      }
      const etExisting = existing.event_type.trim().toUpperCase();
      const updated: TaggerStoredEvent = {
        ...existing,
        comment: text,
        pending: true,
        updatedAt: Date.now(),
      };
      if (taggerEventTypeUsesFocusTime(etExisting)) {
        const iso = datetimeLocalValueToIso(editFocusTimeLocal());
        if (iso) {
          updated.focus_time = iso;
          const d = new Date(iso);
          if (!Number.isNaN(d.getTime())) {
            updated.date = localDateYmd(d);
          }
        }
      } else if (etExisting === 'TEST' || etExisting === 'CREW' || etExisting === 'SAILS') {
        const startIso = datetimeLocalValueToIso(editStartTimeLocal()) ?? existing.start_time;
        if (startIso) {
          updated.start_time = startIso;
          updated.focus_time = startIso;
          const d = new Date(startIso);
          if (!Number.isNaN(d.getTime())) {
            updated.date = localDateYmd(d);
          }
        }
        const endTrim = editEndTimeLocal().trim();
        if (endTrim === '') {
          updated.end_time = null;
        } else {
          const endParsed = datetimeLocalValueToIso(editEndTimeLocal());
          if (endParsed != null) {
            updated.end_time = endParsed;
          }
        }
      }
      await taggerPutEvent(updated);
      if (updated.serverId != null) {
        await taggerTrySyncUpdate(pid, editId);
      } else {
        await taggerFlushOutbox(pid);
      }
      await syncAll(pid);
      clearForm();
      setBanner(undefined);
      debug('[Tagger] Updated', editId);
      return;
    }

    const typeStr = eventType().trim() || 'COMMENT';
    const ok = await submitNewTag(
      pid,
      typeStr,
      text,
      buildTimesForNewFromForm(typeStr, editFocusTimeLocal(), editStartTimeLocal(), editEndTimeLocal())
    );
    if (ok) {
      clearForm();
    }
  };

  const handleEdit = (row: TaggerStoredEvent) => {
    setComposeAfterPreset(false);
    setComment('');
    resetEditTimeFields();
    const et = row.event_type.toUpperCase();
    if (et === 'SAILS' || et === 'CREW') {
      setPlainEditBaseline(null);
      setEditingClientId(row.clientId);
      setStructuredCompose({ kind: et === 'SAILS' ? 'sails' : 'crew', clientId: row.clientId });
      loadStructuredFormFromRow(row);
      setStructuredEditBaseline(structuredFormSnapshot());
    } else {
      setStructuredCompose(null);
      resetStructuredFormFields();
      setStructuredEditBaseline(null);
      setEditingClientId(row.clientId);
      setEventType(row.event_type || 'COMMENT');
      setComment(row.comment || '');
      setEditFocusTimeLocal(isoToDatetimeLocalValue(row.focus_time));
      setEditStartTimeLocal(isoToDatetimeLocalValue(row.start_time));
      setEditEndTimeLocal(row.end_time ? isoToDatetimeLocalValue(row.end_time) : '');
      setPlainEditBaseline({
        comment: row.comment || '',
        eventType: row.event_type || 'COMMENT',
        focus: isoToDatetimeLocalValue(row.focus_time),
        start: isoToDatetimeLocalValue(row.start_time),
        end: row.end_time ? isoToDatetimeLocalValue(row.end_time) : '',
      });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handlePresetClick = async (p: PresetDef) => {
    const pid = projectId();
    if (pid == null) {
      setBanner({
        kind: 'error',
        text: 'No project loaded. Open Tagger with a project id in the URL (for example ?pid=1).',
      } as const);
      return;
    }

    if (p.eventType === 'TEST') {
      try {
        if (structuredCompose()?.clientId === null) {
          setBanner({
            kind: 'warn',
            text: 'Save or discard (BACK) the sail or crew draft before starting a test.',
          } as const);
          return;
        }
        flushStructuredSaveTimer();
        setStructuredCompose(null);
        resetStructuredFormFields();
        setComposeAfterPreset(false);
        setEditingClientId(null);
        setComment('');
        const rowsNow = await taggerGetEventsForProject(pid);
        const me = user() as Record<string, unknown> | null;
        let sess = testSession();
        if (sess) {
          const sessionRef = sess;
          const matchRow = rowsNow.find(
            (e) =>
              e.event_type.toUpperCase() === 'TEST' &&
              taggerIsTestRowOpen(e) &&
              taggerOpenTestMatchesSession(e, sessionRef)
          );
          if (!matchRow) {
            setTestSession(null);
            sess = null;
          } else if (taggerIsTestStarter(sess, me)) {
            await stopTestSession(pid, sess);
            return;
          } else {
            setBanner({
              kind: 'warn',
              text: 'A test is already open in Session Tags. Only the person who started it can press Stop Test here.',
            } as const);
            return;
          }
        }
        // Do not block Test when a SAILS/CREW row is still "open" in Session Tags. Those intervals are
        // created as soon as you tap Sails/Crew; BACK only closes the form and often leaves end_time
        // unset, which would block Tests forever. Tests can run while a sail/crew row is open.
        await startTestSession(pid);
      } catch (e) {
        logError('[Tagger] Test preset failed', e);
        setBanner({ kind: 'error', text: 'Could not start or stop the test. Try again.' } as const);
      }
      return;
    }

    if (p.structuredInterval) {
      const kind = p.eventType.toUpperCase() === 'SAILS' ? 'sails' : 'crew';
      await startStructuredInterval(kind);
      return;
    }

    if (p.instantSave) {
      flushStructuredSaveTimer();
      setStructuredCompose(null);
      resetStructuredFormFields();
      setComposeAfterPreset(false);
      setEditingClientId(null);
      setComment('');
      const body = p.instantComment ?? p.label;
      await submitNewTag(pid, p.eventType, body);
      return;
    }
    flushStructuredSaveTimer();
    setStructuredCompose(null);
    resetStructuredFormFields();
    setEventType(p.eventType);
    setComposeAfterPreset(true);
    setEditingClientId(null);
    const seed = timestampsPointWindowFromPress(new Date());
    setEditFocusTimeLocal(isoToDatetimeLocalValue(seed.focus_time));
    setEditStartTimeLocal(isoToDatetimeLocalValue(seed.start_time));
    setEditEndTimeLocal(isoToDatetimeLocalValue(seed.end_time));
  };

  const handleDelete = async (row: TaggerStoredEvent): Promise<boolean> => {
    const pid = projectId();
    if (pid == null) return false;
    if (!window.confirm('Remove this entry?')) return false;
    try {
      await taggerTrySyncDelete(pid, row.clientId);
      await taggerFlushOutbox(pid);
      await syncAll(pid);
      return true;
    } catch (e) {
      logError('[Tagger] Delete failed', e);
      setBanner({ kind: 'error', text: 'Delete failed. It may sync when you are back online.' } as const);
      return false;
    }
  };

  const handleDeleteEditing = async () => {
    const id = editingClientId();
    if (id == null) return;
    const row = await taggerGetEvent(id);
    if (!row) {
      setBanner({ kind: 'error', text: 'Could not find entry to delete.' } as const);
      return;
    }
    const ok = await handleDelete(row);
    if (ok) {
      clearForm();
    }
  };

  const handleExportEventsCsv = async () => {
    const pid = projectId();
    if (pid == null) {
      setBanner({ kind: 'error', text: 'No project loaded. Cannot export events.' } as const);
      return;
    }
    const endIso = new Date().toISOString();
    const snapshot = events().filter((e) => e.projectId === pid);
    const needCloseEnd = snapshot.filter(taggerRowMissingEndTimeForCsv);
    try {
      if (needCloseEnd.length > 0) {
        debug('[Tagger] CSV export: setting end_time on open rows', { projectId: pid, count: needCloseEnd.length });
        for (const row of needCloseEnd) {
          const updated: TaggerStoredEvent = { ...row, end_time: endIso, pending: true };
          await taggerPutEvent(updated);
          if (updated.serverId != null) {
            await taggerTrySyncUpdate(pid, updated.clientId);
          }
        }
        await syncAll(pid);
      }
      const rows = await taggerGetEventsForProject(pid);
      const csv = taggerBuildEventsCsv(rows);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const suggestedName = `tagger-events-project-${pid}-${stamp}.csv`;
      await taggerSaveCsvBlob(blob, suggestedName);
      debug('[Tagger] CSV export finished', {
        projectId: pid,
        rowCount: rows.filter((r) => !r.pendingDelete).length,
        closedOpenIntervals: needCloseEnd.length,
      });
    } catch (e) {
      logError('[Tagger] CSV export failed', e);
      setBanner({ kind: 'error', text: 'Could not save the CSV file.' } as const);
    }
  };

  return (
    <div class="tagger-page">
      <header class="tagger-page__header">
        <h1 class="tagger-page__title">Tagger</h1>
        <div class="tagger-page__meta">
          <span
            classList={{
              'tagger-status': true,
              'tagger-status--online': online(),
              'tagger-status--offline': !online(),
            }}
          >
            {online() ? 'Online' : 'Offline'}
          </span>
        </div>
      </header>

      <Show when={banner} keyed fallback={null}>
        {(b) => {
          const msg = b();
          if (!msg) {
            return null;
          }
          return (
            <div class={`tagger-banner tagger-banner--${msg.kind === 'error' ? 'error' : 'warn'}`}>{msg.text}</div>
          );
        }}
      </Show>

      <div
        classList={{
          'tagger-layout': true,
          'tagger-layout--compose': taggerHideSessionFeed(),
          'tagger-layout--editing': !!editingClientId(),
        }}
      >
        <section
          classList={{
            'tagger-panel': true,
            'tagger-panel--actions': true,
            'tagger-panel--compose-wide': taggerHideSessionFeed(),
          }}
        >
          <h2 class="tagger-panel__title">Quick tag</h2>
          <div class="tagger-quick-row">
            <For each={PRESETS}>
              {(preset) => (
                <TaggerQuickPresetButton
                  preset={preset}
                  testSession={testSession}
                  user={user}
                  openSailCrewRecorder={openSailCrewRecorder}
                  onPresetClick={handlePresetClick}
                />
              )}
            </For>
          </div>

          <Show when={structuredCompose() !== null && !taggerStructuredFormInFeed()}>
            <div
              classList={{
                'tagger-form-grid': true,
                'tagger-form-grid--compose': true,
                'tagger-form-grid--compose-interval': taggerFormGridComposeInterval(),
              }}
            >
              <TaggerStructuredIntervalFormFields
                schedulePersist={scheduleStructuredPersistForCurrentForm}
                kind={() => structuredCompose()?.kind}
                structuredStartLocal={structuredStartLocal}
                setStructuredStartLocal={setStructuredStartLocal}
                structuredEndLocal={structuredEndLocal}
                setStructuredEndLocal={setStructuredEndLocal}
                sailsMainsail={sailsMainsail}
                setSailsMainsail={setSailsMainsail}
                sailsHeadsail={sailsHeadsail}
                setSailsHeadsail={setSailsHeadsail}
                crewHelmPort={crewHelmPort}
                setCrewHelmPort={setCrewHelmPort}
                crewHelmStbd={crewHelmStbd}
                setCrewHelmStbd={setCrewHelmStbd}
                crewFlightPort={crewFlightPort}
                setCrewFlightPort={setCrewFlightPort}
                crewFlightStbd={crewFlightStbd}
                setCrewFlightStbd={setCrewFlightStbd}
                crewStrategist={crewStrategist}
                setCrewStrategist={setCrewStrategist}
                crewNameHistory={crewNameHistory}
                onCrewNameBlur={handleCrewNameBlur}
              />
            </div>
          </Show>

          <Show when={structuredCompose() !== null && !taggerStructuredFormInFeed()}>
            <div class="tagger-form-actions">
              <div class="tagger-form-actions__start">
                <Show when={taggerStructuredShowPrimarySave()}>
                  <button
                    type="button"
                    class="tagger-btn tagger-btn--primary"
                    onClick={() => void flushStructuredSaveNow()}
                  >
                    {taggerStructuredPrimarySaveLabel()}
                  </button>
                </Show>
                <Show when={editingClientId() && structuredCompose() !== null}>
                  <button type="button" class="tagger-btn tagger-btn--secondary" onClick={() => clearForm()}>
                    Cancel edit
                  </button>
                </Show>
              </div>
              <Show when={editingClientId() && structuredCompose() !== null}>
                <div class="tagger-form-actions__end">
                  <button
                    type="button"
                    class="tagger-btn tagger-btn--secondary tagger-btn--danger"
                    onClick={() => void handleDeleteEditing()}
                  >
                    Delete entry
                  </button>
                </div>
              </Show>
              <Show when={structuredCompose() !== null && !editingClientId()}>
                <div class="tagger-form-actions__end">
                  <button
                    type="button"
                    class="tagger-btn tagger-btn--back"
                    onClick={() => {
                      exitStructuredNewCompose();
                    }}
                  >
                    BACK
                  </button>
                </div>
              </Show>
            </div>
          </Show>
        </section>

        <Show when={!taggerHideSessionFeed()}>
          <section
            classList={{
              'tagger-panel': true,
              'tagger-panel--feed': true,
              'tagger-panel--feed-editing':
                taggerPlainComposeInFeed() ||
                taggerPlainEditInFeed() ||
                taggerStructuredFormInFeed(),
            }}
          >
            <h2 class="tagger-panel__title">Session Tags</h2>
            <Show when={taggerPlainComposeInFeed()}>
              <div class="tagger-feed-edit-wrap">
                <p class="tagger-feed-edit__hint">
                  Add your note below, then tap Add entry, or BACK to return to the list without saving.
                </p>
                <div class="tagger-form-grid tagger-form-grid--feed-edit">
                  <TaggerNoteAndEventFields
                    comment={comment}
                    setComment={setComment}
                    eventType={eventType}
                    setEventType={setEventType}
                    showEventType={taggerShowEventTypeField}
                    setCommentTextAreaRef={(el) => {
                      commentTextAreaRef = el;
                    }}
                  />
                  <TaggerEditTimeFields
                    eventTypeUpper={() => eventType().trim().toUpperCase()}
                    focusLocal={editFocusTimeLocal}
                    setFocusLocal={setEditFocusTimeLocal}
                    startLocal={editStartTimeLocal}
                    setStartLocal={setEditStartTimeLocal}
                    endLocal={editEndTimeLocal}
                    setEndLocal={setEditEndTimeLocal}
                  />
                </div>
                <div class="tagger-form-actions tagger-form-actions--feed-edit">
                  <div class="tagger-form-actions__start">
                    <button type="button" class="tagger-btn tagger-btn--primary" onClick={() => void handleAddOrUpdate()}>
                      Add entry
                    </button>
                  </div>
                  <div class="tagger-form-actions__end">
                    <button
                      type="button"
                      class="tagger-btn tagger-btn--back"
                      onClick={() => {
                        exitComposeNewOnly();
                      }}
                    >
                      BACK
                    </button>
                  </div>
                </div>
              </div>
            </Show>
            <Show when={taggerStructuredFormInFeed()}>
              <div class="tagger-feed-edit-wrap tagger-feed-edit-wrap--interval">
                <Show
                  when={editingClientId()}
                  fallback={
                    <p class="tagger-feed-edit__hint">
                      Set times and selections below, then tap Add entry to create the interval, or BACK to discard
                      without saving.
                    </p>
                  }
                >
                  <p class="tagger-feed-edit__hint">Edit this entry below, or cancel to return to the list.</p>
                </Show>
                <Show when={editingClientId()}>
                  <p class="tagger-feed-edit__hint tagger-feed-edit__hint--secondary">
                    Changes save automatically after a short delay, or use Save changes. Use Cancel to close without
                    deleting.
                  </p>
                </Show>
                <div
                  classList={{
                    'tagger-form-grid': true,
                    'tagger-form-grid--feed-edit': true,
                    'tagger-form-grid--feed-edit-interval': true,
                  }}
                >
                  <TaggerStructuredIntervalFormFields
                    schedulePersist={scheduleStructuredPersistForCurrentForm}
                    kind={() => structuredCompose()?.kind}
                    structuredStartLocal={structuredStartLocal}
                    setStructuredStartLocal={setStructuredStartLocal}
                    structuredEndLocal={structuredEndLocal}
                    setStructuredEndLocal={setStructuredEndLocal}
                    sailsMainsail={sailsMainsail}
                    setSailsMainsail={setSailsMainsail}
                    sailsHeadsail={sailsHeadsail}
                    setSailsHeadsail={setSailsHeadsail}
                    crewHelmPort={crewHelmPort}
                    setCrewHelmPort={setCrewHelmPort}
                    crewHelmStbd={crewHelmStbd}
                    setCrewHelmStbd={setCrewHelmStbd}
                    crewFlightPort={crewFlightPort}
                    setCrewFlightPort={setCrewFlightPort}
                    crewFlightStbd={crewFlightStbd}
                    setCrewFlightStbd={setCrewFlightStbd}
                    crewStrategist={crewStrategist}
                    setCrewStrategist={setCrewStrategist}
                    crewNameHistory={crewNameHistory}
                    onCrewNameBlur={handleCrewNameBlur}
                  />
                </div>
                <div class="tagger-form-actions tagger-form-actions--feed-edit">
                  <div class="tagger-form-actions__start">
                    <Show when={taggerStructuredShowPrimarySave()}>
                      <button
                        type="button"
                        class="tagger-btn tagger-btn--primary"
                        onClick={() => void flushStructuredSaveNow()}
                      >
                        {taggerStructuredPrimarySaveLabel()}
                      </button>
                    </Show>
                    <Show when={editingClientId()}>
                      <button type="button" class="tagger-btn tagger-btn--secondary" onClick={() => clearForm()}>
                        Cancel edit
                      </button>
                    </Show>
                  </div>
                  <div class="tagger-form-actions__end">
                    <Show when={editingClientId()}>
                      <button
                        type="button"
                        class="tagger-btn tagger-btn--secondary tagger-btn--danger"
                        onClick={() => void handleDeleteEditing()}
                      >
                        Delete entry
                      </button>
                    </Show>
                    <Show when={!editingClientId() && structuredCompose() !== null}>
                      <button
                        type="button"
                        class="tagger-btn tagger-btn--back"
                        onClick={() => {
                          exitStructuredNewCompose();
                        }}
                      >
                        BACK
                      </button>
                    </Show>
                  </div>
                </div>
              </div>
            </Show>
            <Show when={taggerPlainEditInFeed()}>
              <div class="tagger-feed-edit-wrap">
                <p class="tagger-feed-edit__hint">Edit this entry below, or cancel to return to the list.</p>
                <div class="tagger-form-grid tagger-form-grid--feed-edit">
                  <TaggerNoteAndEventFields
                    comment={comment}
                    setComment={setComment}
                    eventType={eventType}
                    setEventType={setEventType}
                    showEventType={taggerShowEventTypeField}
                    setCommentTextAreaRef={(el) => {
                      commentTextAreaRef = el;
                    }}
                  />
                  <TaggerEditTimeFields
                    eventTypeUpper={() => eventType().trim().toUpperCase()}
                    focusLocal={editFocusTimeLocal}
                    setFocusLocal={setEditFocusTimeLocal}
                    startLocal={editStartTimeLocal}
                    setStartLocal={setEditStartTimeLocal}
                    endLocal={editEndTimeLocal}
                    setEndLocal={setEditEndTimeLocal}
                  />
                </div>
                <div class="tagger-form-actions tagger-form-actions--feed-edit">
                  <div class="tagger-form-actions__start">
                    <Show when={taggerPlainEditDirty()}>
                      <button type="button" class="tagger-btn tagger-btn--primary" onClick={() => void handleAddOrUpdate()}>
                        Save changes
                      </button>
                    </Show>
                    <button type="button" class="tagger-btn tagger-btn--secondary" onClick={() => clearForm()}>
                      Cancel edit
                    </button>
                  </div>
                  <div class="tagger-form-actions__end">
                    <button
                      type="button"
                      class="tagger-btn tagger-btn--secondary tagger-btn--danger"
                      onClick={() => void handleDeleteEditing()}
                    >
                      Delete entry
                    </button>
                  </div>
                </div>
              </div>
            </Show>
            <Show
              when={
                !taggerPlainComposeInFeed() && !taggerPlainEditInFeed() && !taggerStructuredFormInFeed()
              }
            >
              <Show
                when={events().length > 0}
                fallback={
                  <div class="tagger-empty">No entries yet. Tap a colored tag above to write a note.</div>
                }
              >
                <div
                  class="tagger-feed-scroll"
                  ref={(el) => {
                    taggerFeedScrollEl = el ?? undefined;
                  }}
                >
                  <For each={feedDisplayItems()}>
                    {(item) => (
                      <TaggerMessageBubble
                        row={item.row}
                        isGroupStart={item.isGroupStart}
                        testPhase={item.testPhase}
                        onEdit={handleEdit}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </section>
        </Show>
      </div>

      <Show when={feedSettingsOpen()}>
        <div
          class="tagger-settings-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tagger-settings-heading"
        >
          <button
            type="button"
            class="tagger-settings-overlay__backdrop"
            aria-label="Close settings"
            onClick={() => setFeedSettingsOpen(false)}
          />
          <div class="tagger-settings-overlay__panel">
            <h3 id="tagger-settings-heading" class="tagger-settings-overlay__title">
              Tagger settings
            </h3>
            <p class="tagger-settings-overlay__hint">
              Export session events for this project (same rows as Session Tags, excluding items pending delete). Your
              browser will ask where to save the file when supported; otherwise the file downloads with the suggested
              name.
            </p>
            <div class="tagger-settings-overlay__actions">
              <button type="button" class="tagger-btn tagger-btn--primary" onClick={() => void handleExportEventsCsv()}>
                Save events to CSV…
              </button>
              <button type="button" class="tagger-btn tagger-btn--secondary" onClick={() => setFeedSettingsOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      </Show>

      <button
        type="button"
        class="tagger-settings-fab"
        aria-label={feedSettingsOpen() ? 'Close settings' : 'Open settings'}
        aria-expanded={feedSettingsOpen()}
        onClick={() => setFeedSettingsOpen((o) => !o)}
      >
        <FiSettings size={24} />
      </button>
    </div>
  );
}
