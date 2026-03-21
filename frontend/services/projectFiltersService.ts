import { getData } from '../utils/global';
import { debug as logDebug } from '../utils/console';
import { apiEndpoints } from '@config/env';

const PROJECT_DEFAULT_DATE = '1970-01-01';
const OBJECT_NAME_PERFORMANCE = 'performance_filters';
const OBJECT_NAME_MANEUVER = 'maneuver_filters';
const OBJECT_NAME_VIDEO = 'video_sources';

export interface ProjectPerformanceFilters {
  grades?: string;
  state?: string;
}

export interface ProjectManeuverFilters {
  grades?: number[];
  states?: string[];
}

function normalizeDateForApi(date: string): string {
  if (!date || date.trim() === '') return PROJECT_DEFAULT_DATE;
  const d = date.trim();
  if (d.length === 8 && !d.includes('-')) {
    return `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`;
  }
  return d;
}

async function fetchProjectObject(
  className: string,
  projectId: number,
  date: string,
  objectName: string
): Promise<unknown | null> {
  if (!className || !projectId) return null;
  const dateParam = normalizeDateForApi(date);
  const classParam = String(className).trim().toLowerCase();
  try {
    const response = await getData(
      `${apiEndpoints.app.projects}/object?class_name=${encodeURIComponent(classParam)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateParam)}&object_name=${encodeURIComponent(objectName)}`
    );
    const ok = response?.success && (response as { statusCode?: number }).statusCode !== 204;
    if (!ok) return null;
    let raw = response?.data;
    if (raw == null) return null;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    }
    if (typeof raw === 'object' && raw !== null && 'value' in raw && (raw as { value?: unknown }).value != null) {
      raw = (raw as { value: unknown }).value;
    }
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    }
    return raw as unknown;
  } catch (err) {
    logDebug('projectFiltersService: Error fetching project object', { objectName, date: dateParam, err });
    return null;
  }
}

/**
 * Load performance default filters from project_objects.
 * Tries the given date first; if not found and date !== '1970-01-01', retries with project default date.
 * Callers in dataset mode must convert dataset_id to date (e.g. via datasets/info) and pass that date
 * so the page initializes with the default filters for that date.
 */
export async function getProjectPerformanceFilters(
  className: string,
  projectId: number,
  date?: string | null
): Promise<ProjectPerformanceFilters | null> {
  let obj: unknown = null;
  const dateToTry = date && date.trim() !== '' ? date : PROJECT_DEFAULT_DATE;
  obj = await fetchProjectObject(className, projectId, dateToTry, OBJECT_NAME_PERFORMANCE);
  if (obj == null && dateToTry !== PROJECT_DEFAULT_DATE) {
    obj = await fetchProjectObject(className, projectId, PROJECT_DEFAULT_DATE, OBJECT_NAME_PERFORMANCE);
  }
  if (obj == null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const grades = typeof o.grades === 'string' ? o.grades : undefined;
  const state = typeof o.state === 'string' ? o.state : undefined;
  if (grades === undefined && state === undefined) return null;
  return { grades, state };
}

/**
 * Load maneuver default filters from project_objects.
 * Tries the given date first; if not found and date !== '1970-01-01', retries with project default date.
 */
export async function getProjectManeuverFilters(
  className: string,
  projectId: number,
  date?: string | null
): Promise<ProjectManeuverFilters | null> {
  let obj: unknown = null;
  const dateToTry = date && date.trim() !== '' ? date : PROJECT_DEFAULT_DATE;
  obj = await fetchProjectObject(className, projectId, dateToTry, OBJECT_NAME_MANEUVER);
  if (obj == null && dateToTry !== PROJECT_DEFAULT_DATE) {
    obj = await fetchProjectObject(className, projectId, PROJECT_DEFAULT_DATE, OBJECT_NAME_MANEUVER);
  }
  if (obj == null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const grades = Array.isArray(o.grades) ? (o.grades as number[]) : undefined;
  const states = Array.isArray(o.states) ? (o.states as string[]) : undefined;
  if ((!grades || grades.length === 0) && (!states || states.length === 0)) return null;
  return { grades, states };
}

export interface ProjectVideoSources {
  source_names: string[];
}

/**
 * Load video default sources from project_objects.
 * Tries the given date first; if not found and date !== '1970-01-01', retries with project default date.
 */
export async function getProjectVideoSources(
  className: string,
  projectId: number,
  date?: string | null
): Promise<ProjectVideoSources | null> {
  let obj: unknown = null;
  const dateToTry = date && date.trim() !== '' ? date : PROJECT_DEFAULT_DATE;
  obj = await fetchProjectObject(className, projectId, dateToTry, OBJECT_NAME_VIDEO);
  if (obj == null && dateToTry !== PROJECT_DEFAULT_DATE) {
    obj = await fetchProjectObject(className, projectId, PROJECT_DEFAULT_DATE, OBJECT_NAME_VIDEO);
  }
  if (obj == null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const source_names = Array.isArray(o.source_names)
    ? (o.source_names as unknown[]).map((s) => String(s)).filter((s) => s.trim() !== '')
    : [];
  if (source_names.length === 0) return null;
  return { source_names };
}
