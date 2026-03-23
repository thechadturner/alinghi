import { config } from "@config/env";
import { handleError, AppError, ValidationError, AuthError, NotFoundError, NetworkError } from './errorHandler';
import { getColorByIndex, DEFAULT_COLOR } from './colorScale';
import { log, warn, debug, error as logError } from './console';

import * as arrow from 'apache-arrow';

/** Paths that are allowed without auth; do not redirect to login on 401 when user is on these. */
const PUBLIC_AUTH_PATHS = ['/', '/login', '/register', '/verify', '/forgot-password', '/reset-password'];

/** Max length for any stringified value in error log context to avoid huge DB payloads. */
const ERROR_LOG_CONTEXT_MAX_LENGTH = 500;

/**
 * Build a safe summary of an error response for logging. Omits the full errorResponse body
 * so we never log huge payloads (e.g. accidental data-as-error) to the database.
 */
function buildErrorResponseLogSummary(
	errorResponse: { message?: string; error?: string; detail?: unknown; data?: Record<string, unknown> },
	status: number,
	serverErrorMessage: string | null
): Record<string, unknown> {
	const errorLines = errorResponse.data?.error_lines;
	const outputLines = errorResponse.data?.output_lines;
	return {
		status,
		hasData: !!errorResponse.data,
		hasDetail: !!errorResponse.detail,
		message: serverErrorMessage,
		errorLines: Array.isArray(errorLines)
			? errorLines.slice(-5).map((line: unknown) =>
				typeof line === 'string' && line.length > 300 ? line.substring(0, 300) + '...' : line
			)
			: null,
		outputLines: Array.isArray(outputLines) ? outputLines.slice(-10) : null,
		returnCode: errorResponse.data?.return_code ?? null
	};
}

function parseBinary(buffer: ArrayBuffer): any[] {
    const table = arrow.tableFromIPC(buffer);
    return table.toArray();
}

export function setCookie(cname: string, cvalue: string, exdays: number): void {
	try {
		const d = new Date();
		d.setTime(d.getTime() + (exdays * 24 * 60 * 60 * 1000));
		let expires = "expires=" + d.toUTCString();
		document.cookie = cname + "=" + cvalue + ";" + expires + ";path=/";
	} catch (err) {
		// Silent fail
	}
}
  
export function getCookie(cname: string): string {
	try {
		let name = cname + "=";
		let ca = document.cookie.split(';');
		for (let i = 0; i < ca.length; i++) {
			let c = ca[i];
			while (c.charAt(0) === ' ') {
				c = c.substring(1);
			}
			if (c.indexOf(name) === 0) {
				return c.substring(name.length, c.length);
			}
		}
		return "";
	} catch (err) {
		return "";
	}
}

export function deleteCookie(cname: string): void {
	try {
		document.cookie = cname + "=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
	} catch (err) {
		// Silent fail
	}
}

export const round = (value: number | string, decimals: number): number => {
	try {
		let val = Number(Math.round(Number(value + 'e' + decimals)) + 'e-' + decimals);

		if (isNaN(val)) {
			return 0;
		}

		return val;
	} catch {
		return 0;
	}
}

export const removeLastChar = (input: string, char: string): string => {
    if (input.endsWith(char)) {
        return input.slice(0, -1);
    }

    return input;
}

/**
 * Clean quotes from a string value
 * Removes leading and trailing double quotes (") and single quotes (')
 * This is useful when loading values from persistent storage or sessionStorage
 * that may have been incorrectly serialized with quotes
 */
export const cleanQuotes = (value: string | null | undefined): string => {
    if (!value || typeof value !== 'string') {
        return value || '';
    }
    // Remove leading and trailing quotes (both single and double)
    return value.replace(/^["']|["']$/g, '').trim();
}

// Lazy-loaded d3 format functions for myTickFormat
let formatCache: {
	".1f": (d: number) => string;
	".2f": (d: number) => string;
	".3f": (d: number) => string;
	".4f": (d: number) => string;
	".5f": (d: number) => string;
} | null = null;

// Pre-load d3 format functions in the background
import('d3').then(d3 => {
	formatCache = {
		".1f": d3.format(".1f"),
		".2f": d3.format(".2f"),
		".3f": d3.format(".3f"),
		".4f": d3.format(".4f"),
		".5f": d3.format(".5f")
	};
}).catch(() => {
	// Fallback if d3 fails to load
	formatCache = {
		".1f": (d: number) => d.toFixed(1),
		".2f": (d: number) => d.toFixed(2),
		".3f": (d: number) => d.toFixed(3),
		".4f": (d: number) => d.toFixed(4),
		".5f": (d: number) => d.toFixed(5)
	};
});

export const myTickFormat = function (d: number): string {
	var limits = [1000000000000000, 1000000000000, 1000000000, 1000000, 1000];
	var shorteners = ['Q', 'T', 'B', 'M', 'K'];
	var sign = d < 0 ? -1 : 1;
	var absD = Math.abs(d);
	
	for (var i in limits) {
		if (absD >= limits[i]) {
			return (sign * (absD / limits[i])).toFixed() + shorteners[i];
		}
	}

	// Use cached format functions if available, otherwise use fallback
	if (formatCache) {
		if (absD <= 0.000001) {
			return formatCache[".1f"](d);
		} else if (absD <= 0.00001) {
			return formatCache[".5f"](d);
		} else if (absD <= 0.0001) {
			return formatCache[".4f"](d);
		} else if (absD <= 0.001) {
			return formatCache[".3f"](d);
		} else if (absD <= 0.01) {
			return formatCache[".2f"](d);
		} else {
			return formatCache[".1f"](d);
		}
	} else {
		// Fallback until d3 loads
		if (absD <= 0.000001) {
			return d.toFixed(1);
		} else if (absD <= 0.00001) {
			return d.toFixed(5);
		} else if (absD <= 0.0001) {
			return d.toFixed(4);
		} else if (absD <= 0.001) {
			return d.toFixed(3);
		} else if (absD <= 0.01) {
			return d.toFixed(2);
		} else {
			return d.toFixed(1);
		}
	}
};

export function itemExists(list: any[], value: any): boolean {
    return list.some(item => item === value);
}

export function addItem(list: any[], value: any): any[] {
    if (typeof value === "number" && value > 0 && !list.some(item => item === value)) {
        return [...list, value]; 
    }
    return list;
}

export function replaceItem(list: any[], value: any): any[] {
    let filteredList = list.filter(item => item !== value);
    if (!list.some(item => item === value)) {
        filteredList.push(value);
    }
    return filteredList;
}

export function removeItem(list: any[], value: any): any[] {
    return list.filter(item => item !== value);
}

// Safe toNodeList helper which works in browser contexts and no-ops in Node/test environments.
// The previous implementation referenced document at module load, which crashed in non-DOM
// environments (e.g. server-side logging or tests). We now guard against that.
export const toNodeList = (function () {
  if (typeof document === 'undefined') {
    // In non-browser environments, just normalize to an empty NodeList-like object.
    // Callers in those environments should not rely on actual DOM behavior.
    return function (_nodeArray: any): NodeList {
      return {
        length: 0,
        item: () => null,
        [Symbol.iterator]: function* () { /* empty */ },
      } as unknown as NodeList;
    };
  }

  const emptyNL = document.createDocumentFragment().childNodes;

  return function (nodeArray: any): NodeList {
    if (nodeArray instanceof NodeList) return nodeArray;

    if (!Array.isArray(nodeArray)) nodeArray = [nodeArray];

    const mockNL = Object.create(emptyNL, {
      length: {
        value: nodeArray.length,
        enumerable: false,
      },
      item: {
        value: function (i: number) {
          return (this as any)[+i || 0];
        },
        enumerable: false,
      },
    });

    nodeArray.forEach((v: any, i: number) => (mockNL as any)[i] = v);

    return mockNL as NodeList;
  };
})();

export function groupBy(collection: any[], key?: string | number): any[] {
	let result: any[] = [];
	if (key !== undefined) {
		let keyvalues = collection.map(d => ({
			val: d[key]
		}));
	
		keyvalues.forEach(d => {
			let val = d.val;
	
			let exists = false;
			result.forEach(function(r) {
				if (r === val) {
					exists = true;
				}
			});
	
			if (exists === false) {
				if (val !== undefined) {
					result.push(val);
				}
			}
		});
	} else {
		collection.forEach(val => {
			let exists = false;
			result.forEach(function(r) {
				if (r === val) {
					exists = true;
				}
			});
	
			if (exists === false) {
				if (val !== undefined) {
					result.push(val);
				}
			}
		});
	}

    return result.sort();
}

/**
 * Format datetime with optional timezone
 * @param input - Date input (string, Date, or number)
 * @param timezone - Optional timezone string (e.g., 'Europe/Madrid', 'UTC'). If not provided, uses browser local timezone.
 * @returns Formatted datetime string or undefined
 */
export function formatDateTime(input: any, timezone?: string | null): string | undefined {
	if (input === undefined || input === null) {
		return undefined;
	}

	try {
		let date: Date;
		if (input instanceof Date) {
			date = input;
		} else {
			const date_str = input.toString();
			if (date_str.indexOf("Z") === 0) {
				date = new Date(date_str + "Z");
			} else {
				date = new Date(date_str);
			}
		}

		if (isNaN(date.getTime())) {
			return undefined;
		}

		// If timezone is provided, use Intl.DateTimeFormat
		if (timezone) {
			try {
				const formatter = new Intl.DateTimeFormat('en-US', {
					timeZone: timezone,
					year: 'numeric',
					month: '2-digit',
					day: '2-digit',
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
					hour12: false
				});
				const parts = formatter.formatToParts(date);
				const year = parts.find(p => p.type === 'year')?.value || '';
				const month = parts.find(p => p.type === 'month')?.value || '';
				const day = parts.find(p => p.type === 'day')?.value || '';
				const hour = parts.find(p => p.type === 'hour')?.value || '';
				const minute = parts.find(p => p.type === 'minute')?.value || '';
				const second = parts.find(p => p.type === 'second')?.value || '';
				return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
			} catch (tzError) {
				// Fall back to browser timezone if timezone is invalid
				warn('Invalid timezone:', timezone, tzError);
			}
		}

		// Fallback to original behavior (browser local timezone)
		function twoDigits(num: number): string {
			return ('0' + num).slice(-2);
		}

		return date.getFullYear() + "-" +
			twoDigits(date.getMonth() + 1) + "-" +
			twoDigits(date.getDate()) + " " +
			twoDigits(date.getHours()) + ":" +
			twoDigits(date.getMinutes()) + ":" +
			twoDigits(date.getSeconds());
	} catch (error) {
		return undefined;
	}
}

/**
 * Format date with optional timezone
 * @param input - Date input (string, Date, or number)
 * @param timezone - Optional timezone string (e.g., 'Europe/Madrid', 'UTC'). If not provided, uses browser local timezone.
 * @returns Formatted date string or undefined
 */
export function formatDate(input: any, timezone?: string | null): string | undefined {
	if (input === undefined || input === null) {
		return undefined;
	}

	try {
		let date: Date;
		if (input instanceof Date) {
			date = input;
		} else {
			const date_str = input.toString();
			if (date_str.indexOf("Z") === 0) {
				date = new Date(date_str + "Z");
			} else {
				date = new Date(date_str);
			}
		}

		if (isNaN(date.getTime())) {
			return undefined;
		}

		// If timezone is provided, use Intl.DateTimeFormat
		if (timezone) {
			try {
				const formatter = new Intl.DateTimeFormat('en-US', {
					timeZone: timezone,
					year: 'numeric',
					month: '2-digit',
					day: '2-digit'
				});
				const parts = formatter.formatToParts(date);
				const year = parts.find(p => p.type === 'year')?.value || '';
				const month = parts.find(p => p.type === 'month')?.value || '';
				const day = parts.find(p => p.type === 'day')?.value || '';
				return `${year}-${month}-${day}`;
			} catch (tzError) {
				// Fall back to browser timezone if timezone is invalid
				warn('Invalid timezone:', timezone, tzError);
			}
		}

		// Fallback to original behavior (browser local timezone)
		function twoDigits(num: number): string {
			return ('0' + num).slice(-2);
		}

		return date.getFullYear() + "-" +
			twoDigits(date.getMonth() + 1) + "-" +
			twoDigits(date.getDate());
	} catch (error) {
		return undefined;
	}
}

/**
 * Return UTC milliseconds for the start and end of a calendar day in a given timezone.
 * Used for querying events/races by "day" in the dataset's local timezone.
 * @param dateStr - YYYY-MM-DD
 * @param timezone - IANA timezone (e.g. 'Australia/Sydney'). Falls back to UTC if invalid.
 * @returns { startMs, endMs } for start of day 00:00:00.000 and end of day 23:59:59.999 in that timezone
 */
export function getDayBoundsInTimezone(dateStr: string, timezone: string | null): { startMs: number; endMs: number } {
	const dayUtcStart = new Date(dateStr + 'T00:00:00.000Z').getTime();
	const dayUtcEnd = new Date(dateStr + 'T23:59:59.999Z').getTime();
	// Range that could cover this local day in any timezone (±26h to handle DST)
	const searchStart = dayUtcStart - 26 * 60 * 60 * 1000;
	const searchEnd = dayUtcEnd + 26 * 60 * 60 * 1000;
	const step = 60 * 1000; // 1 minute
	let startMs = dayUtcStart;
	let endMs = dayUtcEnd;
	if (timezone) {
		try {
			for (let ts = searchStart; ts <= searchEnd; ts += step) {
				const formatted = formatDate(new Date(ts), timezone);
				if (formatted === dateStr) {
					startMs = ts;
					break;
				}
			}
			for (let ts = searchEnd; ts >= searchStart; ts -= step) {
				const formatted = formatDate(new Date(ts), timezone);
				if (formatted === dateStr) {
					endMs = Math.min(ts + 59 * 1000 + 999, searchEnd);
					break;
				}
			}
		} catch {
			// fall through to UTC day
		}
	}
	return { startMs, endMs };
}

/**
 * Convert a local date + time in a given timezone to a UTC Date.
 * Used when the user edits event times in dataset local time; we need the UTC instant for the API.
 * @param dateStr - YYYY-MM-DD
 * @param timeStr - HH:mm or HH:mm:ss
 * @param timezone - IANA timezone (e.g. 'Europe/Madrid'). If null, parses as browser local.
 * @returns UTC Date or null if not found/invalid
 */
export function localTimeInTimezoneToUtcDate(
	dateStr: string,
	timeStr: string,
	timezone: string | null
): Date | null {
	const normalized = timeStr.trim();
	const parts = normalized.split(':');
	let timeNormalized = normalized;
	if (parts.length === 2) {
		timeNormalized = `${parts[0]}:${parts[1]}:00`;
	} else if (parts.length === 1) {
		timeNormalized = `${parts[0]}:00:00`;
	}

	if (!timezone || timezone.trim() === '') {
		try {
			const d = new Date(dateStr + 'T' + timeNormalized);
			return isNaN(d.getTime()) ? null : d;
		} catch {
			return null;
		}
	}

	const target = `${dateStr} ${timeNormalized}`.trim();
	const { startMs, endMs } = getDayBoundsInTimezone(dateStr, timezone);
	const step = 60 * 1000;
	for (let ms = startMs; ms <= endMs; ms += step) {
		const formatted = formatDateTime(new Date(ms), timezone);
		if (formatted === target) return new Date(ms);
	}
	return null;
}

/**
 * Fetch timezone for a given class/project/date from the date/timezone API.
 * Used so day-based APIs (date/dataset_id, date/races) and day-range queries use local date.
 */
export async function getTimezoneForDate(
	className: string,
	projectId: number,
	date: string
): Promise<string | null> {
	const dateNorm = String(date).replace(/[-/]/g, '');
	const dateDisplay = dateNorm.length === 8
		? `${dateNorm.slice(0, 4)}-${dateNorm.slice(4, 6)}-${dateNorm.slice(6, 8)}`
		: String(date);
	try {
		const { apiEndpoints } = await import('../config/env.js');
		const url = `${apiEndpoints.app.datasets}/date/timezone?class_name=${encodeURIComponent(className)}&project_id=${encodeURIComponent(projectId)}&date=${encodeURIComponent(dateDisplay)}`;
		const resp = await getData(url);
		const data = (resp && (resp as any).data) ?? resp;
		if (data?.timezone) return String(data.timezone).trim();
	} catch {
		// ignore
	}
	return null;
}

/**
 * Format time with optional timezone
 * @param input - Date input (string, Date, or number)
 * @param timezone - Optional timezone string (e.g., 'Europe/Madrid', 'UTC'). If not provided, uses browser local timezone.
 * @returns Formatted time string or undefined
 */
export function formatTime(input: any, timezone?: string | null): string | undefined {
	if (input === undefined || input === null) {
		return undefined;
	}

	try {
		let date: Date;
		if (input instanceof Date) {
			date = input;
		} else {
			const date_str = input.toString();
			if (date_str.indexOf("Z") === 0) {
				date = new Date(date_str + "Z");
			} else {
				date = new Date(date_str);
			}
		}

		if (isNaN(date.getTime())) {
			return undefined;
		}

		// If timezone is provided, use Intl.DateTimeFormat
		if (timezone) {
			try {
				const formatter = new Intl.DateTimeFormat('en-US', {
					timeZone: timezone,
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
					hour12: false
				});
				const parts = formatter.formatToParts(date);
				const hour = parts.find(p => p.type === 'hour')?.value || '';
				const minute = parts.find(p => p.type === 'minute')?.value || '';
				const second = parts.find(p => p.type === 'second')?.value || '';
				const result = `${hour}:${minute}:${second}`;
				// Debug first few conversions to verify timezone is working
				if (Math.random() < 0.001) {
					debug(`[formatTime] UTC: ${date.toISOString()}, TZ: ${timezone}, Result: ${result}`);
				}
				return result;
			} catch (tzError) {
				// Fall back to browser timezone if timezone is invalid
				warn('Invalid timezone:', timezone, tzError);
			}
		}

		// Fallback to original behavior (browser local timezone)
		function twoDigits(num: number): string {
			return ('0' + num).slice(-2);
		}
	
		return twoDigits(date.getHours()) + ":" +
			twoDigits(date.getMinutes()) + ":" +
			twoDigits(date.getSeconds());
	} catch (error) {
		return undefined;
	}
}

export const formatSeconds = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
};

export const getIndexColor = (list: any[], id: any): string | undefined => {
	if (list.length > 0) {
		const index = list.findIndex(item => item === id);
	
		if (index > -1) {
			// If more than 8 events are selected, all selected events should be blue
			if (list.length > 8) {
				return DEFAULT_COLOR; // Blue for all when more than 8 selected
			}
			// Use global color scale for consistent colors across all components
			return getColorByIndex(index);
		} else {
			return 'lightgray';
		}
	} else {
		return 'lightgray';
	}
}

export const checkSelection = (list: any[], id: any): boolean => {
	if (list.length > 0) {
		const index = list.findIndex(item => item === id);
	
		if (index > -1) {
			return true;
		} else {
			return false;
		}
	} else {
		return false;
	}
}

// Generate a unique ID for charts
export function generateUniqueId(): string {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function AngleSubtract180(first: number | string, second: number | string): number {
    try {
        first = parseFloat(first.toString());
        second = parseFloat(second.toString());

        if (first > 720 || second > 720 || first < -720 || second < -720) {
            return 0;
        }

        let subtract = first - second;

		while (subtract > 180) {
			subtract -= 360;
		}

		while (subtract < -180) {
			subtract += 360;
		}

        return subtract;
    } catch (error) {
        return 0;
    }
}

export function AngleSubtract(first: number | string, second: number | string): number {
    let result = 0;
    try {
        first = parseFloat(first.toString());
        second = parseFloat(second.toString());
        
        let subtract = first - second;
        
        result = (subtract + 180) % 360 - 180;
        
        if (result === -180) {
            return 180;
        } else {
            return result;
        }
    } catch (error) {
        return 0;
    }
}

export function AngleBetween(first: number | string, second: number | string): number {
    try {
        first = parseFloat(first.toString());
        second = parseFloat(second.toString());

        if (first >= 0 || second >= 0 || first <= 0 || second <= 0) {
            if (first > 720 || second > 720 || first < -720 || second < -720) {
                return 0;
            }

            let between = first - second;

            while (between > 180) {
                between -= 360;
            }

            while (between < -180) {
                between += 360;
            }

            return Math.abs(between);
        } else {
            if (first < 0) {
                first = Math.abs(first) + 180;
            } else {
                second = Math.abs(second) + 180;
            }

            if (first > 720 || second > 720 || first < -720 || second < -720) {
                return 0;
            }

            let between = first - second;

            while (between > 180) {
                between -= 360;
            }

            while (between < -180) {
                between += 360;
            }

            return Math.abs(between);
        }
    } catch (error) {
        return 0;
    }
}

interface ApiResponse {
    success: boolean;
    data?: any;
    error?: string;
    status?: number;
    message?: string;
    type?: string;
}

export async function getData(url: string, signal?: AbortSignal): Promise<ApiResponse> {
	try {
		// Import authManager dynamically to avoid circular dependencies
		const { authManager } = await import('./authManager');
		
		// Construct full URL
		// If URL is already absolute (starts with http), use as-is
		// If URL starts with /api, use as-is (already a relative URL for nginx)
		// Otherwise, prepend API_BASE_URL
		let fullUrl: string;
		if (url.startsWith('http')) {
			fullUrl = url;
		} else if (url.startsWith('/api')) {
			// URL already starts with /api, use as-is
			fullUrl = url;
		} else {
			// Prepend API_BASE_URL for relative URLs
			fullUrl = config.API_BASE_URL + url;
		}
		
		log(`[getData] Making GET request to: ${fullUrl}`);
		
		const response = await authManager.makeAuthenticatedRequest(fullUrl, {
			method: "GET",
			headers: { "Content-Type": "application/json" },
			signal: signal
		});
		
		log(`[getData] Response status: ${response.status} ${response.statusText} for ${fullUrl}`);

		// Let backend sendResponse handle logging with proper source information
		if (response.ok) {
			// Handle 204 No Content responses (empty body)
			if (response.status === 204) {
				log(`[getData] 204 No Content for ${fullUrl}`);
				return { success: true, data: null, message: 'No content' };
			}
			
			// Check if response has content before parsing JSON
			const contentType = response.headers.get('content-type');
			if (!contentType || !contentType.includes('application/json')) {
				// Non-JSON response or empty
				logError(`[getData] Invalid content-type: ${contentType} for ${fullUrl}`);
				const error = new AppError('Invalid JSON response from server', 502);
				return handleError(error, 'global.ts', { url: fullUrl, status: response.status, contentType });
			}
			
			// Check if response body is empty
			const text = await response.text();
			if (!text || text.trim() === '') {
				logError(`[getData] Empty response body for ${fullUrl}`);
				const error = new AppError('Empty response from server', 502);
				return handleError(error, 'global.ts', { url: fullUrl, status: response.status });
			}
			
			try {
				const response_json: ApiResponse = JSON.parse(text);
				if (!response_json.success) {
					logError(`[getData] API returned error for ${fullUrl}:`, response_json);
				} else {
					log(`[getData] Success for ${fullUrl}`);
				}
				return response_json;
			} catch (jsonError) {
				logError(`[getData] JSON parse error for ${fullUrl}:`, jsonError);
				const error = new AppError('Invalid JSON response from server', 502);
				return handleError(error, 'global.ts', { url: fullUrl, status: response.status, jsonError: (jsonError as Error).message });
			}
		} else {
			// Check if user is not authenticated - suppress console errors for 401 but still log to server
			const { isLoggedIn } = await import('../store/userStore');
			const { debug: logDebug } = await import('./console');
			const userIsNotAuthenticated = !isLoggedIn();
			const shouldSuppress401 = userIsNotAuthenticated && response.status === 401;
			
			if (shouldSuppress401) {
				// User is not authenticated - log to server (database) but don't show in console
				logDebug(`[getData] HTTP 401 Unauthorized for ${fullUrl} (user not authenticated)`);
			} else {
				// User is authenticated or non-401 error - show in console
				logError(`[getData] HTTP error ${response.status} ${response.statusText} for ${fullUrl}`);
			}
			
			// Handle specific HTTP errors
			let error: AppError;
			let errorMessage: string;
			switch (response.status) {
				case 401:
					// Try to refresh token before giving up
					try {
						const { authManager } = await import('./authManager');
						const refreshToken = authManager.getRefreshToken();
						
						// If we have a refresh token, try to refresh before redirecting
						if (refreshToken) {
							try {
								const refreshSuccess = await authManager.refreshToken();
								if (refreshSuccess) {
									// Token refreshed successfully, retry the original request
									const retryResponse = await authManager.makeAuthenticatedRequest(fullUrl, {
										method: "GET",
										headers: { "Content-Type": "application/json" },
										signal: signal
									});
									
									if (retryResponse.ok) {
										// Retry succeeded, parse and return the response
										if (retryResponse.status === 204) {
											return { success: true, data: null, message: 'No content' };
										}
										
										const contentType = retryResponse.headers.get('content-type');
										if (!contentType || !contentType.includes('application/json')) {
											const error = new AppError('Invalid JSON response from server', 502);
											return handleError(error, 'global.ts', { url: fullUrl, status: retryResponse.status, contentType });
										}
										
										const text = await retryResponse.text();
										if (!text || text.trim() === '') {
											const error = new AppError('Empty response from server', 502);
											return handleError(error, 'global.ts', { url: fullUrl, status: retryResponse.status });
										}
										
										try {
											const response_json: ApiResponse = JSON.parse(text);
											return response_json;
										} catch (jsonError) {
											const error = new AppError('Invalid JSON response from server', 502);
											return handleError(error, 'global.ts', { url: fullUrl, status: retryResponse.status, jsonError: (jsonError as Error).message });
										}
									}
								}
							} catch (refreshError) {
								// Refresh failed, will fall through to redirect
							}
						}
						
						// If refresh failed or no refresh token, clear tokens and redirect
						const { setIsLoggedIn, setUser, setSubscription } = await import('../store/userStore');
						authManager.clearTokens();
						setIsLoggedIn(false);
						setUser(null);
						setSubscription(null);
						
						// Only redirect if we're not already on a public page (login, register, verify, etc.)
						const currentPath = window.location.pathname;
						if (!PUBLIC_AUTH_PATHS.includes(currentPath)) {
							window.location.href = '/login';
						}
					} catch (redirectErr) {
						// If redirect fails, still log the error
						logError('Failed to redirect to login:', redirectErr);
					}
					
					error = new AuthError('Authentication required');
					errorMessage = 'Authentication required';
					break;
				case 404:
					error = new NotFoundError('API endpoint');
					errorMessage = 'API endpoint not found';
					break;
				case 422:
					error = new ValidationError('Invalid request data');
					errorMessage = 'Invalid request data';
					break;
				case 500:
					error = new AppError('Server error', 500);
					errorMessage = 'Server error';
					break;
				default:
					error = new AppError(`HTTP ${response.status}: ${response.statusText}`, response.status);
					errorMessage = `HTTP ${response.status}: ${response.statusText}`;
			}
			
			return handleError(error, 'global.ts', { url: fullUrl, status: response.status });
		}
	} catch (error) {
		if ((error as Error).name === 'AbortError') {
			return { success: false, error: 'Request cancelled', status: 0, type: 'AbortError' };
		}

		const message = (error as Error).message || 'Unknown network error';
		
		// Always log network errors (except for streaming endpoints)
		if (!url.includes('/api/stream/')) {
			logError(`[getData] Network error for ${url}:`, error);
		}

		// For streaming/Redis endpoints, fail gracefully without logging a hard error
		// These endpoints are inherently best-effort and it's normal for them to be
		// unavailable or have no data; callers already handle empty/failed responses.
		if (url.includes('/api/stream/')) {
			return {
				success: false,
				error: `Network error: ${message}`,
				status: 0,
				type: 'NetworkError'
			};
		}
		
		const networkError = new NetworkError(`Network error: ${message}`);
		return handleError(networkError, 'global.ts', { url, signal: !!signal });
	}
}

export async function postBinary(url: string, body_json: any, signal?: AbortSignal): Promise<ApiResponse> {
	try {
		// Import authManager dynamically to avoid circular dependencies
		const { authManager } = await import('./authManager');
		
		// Construct full URL
		// If URL is already absolute (starts with http), use as-is
		// If URL starts with /api, use as-is (already a relative URL for nginx)
		// Otherwise, prepend API_BASE_URL
		let fullUrl: string;
		if (url.startsWith('http')) {
			fullUrl = url;
		} else if (url.startsWith('/api')) {
			// URL already starts with /api, use as-is
			fullUrl = url;
		} else {
			// Prepend API_BASE_URL for relative URLs
			fullUrl = config.API_BASE_URL + url;
		}

		const response = await authManager.makeAuthenticatedRequest(fullUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body_json),
			signal: signal
		});

		// Log the HTTP request after getting the response
		if (response.ok) {
			// Handle 204 No Content (valid response when no data available)
			if (response.status === 204) {
				return { "success": true, "status": 204, "message": "No content", data: [] };
			}
			
			const buffer = await response.arrayBuffer();
			
			// Check if buffer is empty
			if (buffer.byteLength === 0) {
				return { "success": true, "status": response.status, "message": "Empty response", data: [] };
			}
			
			try {
				const json_data = parseBinary(buffer);
				return { "success": true, data: json_data };
			} catch (parseError) {
				// Log parsing error for debugging
				logError(`[postBinary] Error parsing Arrow format response:`, parseError);
				return { 
					"success": false, 
					"status": response.status, 
					"message": `Failed to parse response: ${(parseError as Error).message}`,
					"error": (parseError as Error).message
				};
			}
		} else {
			// Try to get the actual error message from the server
			let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
			try {
				// Check if response has content before parsing JSON
				const contentType = response.headers.get('content-type');
				if (contentType && contentType.includes('application/json')) {
					const text = await response.text();
					if (text && text.trim() !== '') {
						const errorData = JSON.parse(text);
						if (errorData.message) {
							errorMessage = errorData.message;
						}
					}
				}
			} catch (e) {
				// If we can't parse JSON, use the status text
			}
			return {"success": false, "status": response.status, "message": errorMessage};
		}
	} catch (error) {
		const errorMessage = `Network error: ${(error as Error).message}`;
		return {"success": false, "error": (error as Error).message};
	}
}

export async function postData(url: string, body_json: any, signal?: AbortSignal): Promise<ApiResponse> {
	// Construct full URL
	// If URL is already absolute (starts with http), use as-is
	// If URL starts with /api, use as-is (already a relative URL for nginx)
	// Otherwise, prepend API_BASE_URL
	let fullUrl: string;
	if (url.startsWith('http')) {
		fullUrl = url;
	} else if (url.startsWith('/api')) {
		// URL already starts with /api, use as-is
		fullUrl = url;
	} else {
		// Prepend API_BASE_URL for relative URLs
		fullUrl = config.API_BASE_URL + url;
	}
	
	try {
		// Import authManager dynamically to avoid circular dependencies
		const { authManager } = await import('./authManager');
		
		const response = await authManager.makeAuthenticatedRequest(fullUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body_json),
			signal: signal
		});

		// Let backend sendResponse handle logging with proper source information
		if (response.ok) {
			// Check if response has content before parsing JSON
			const contentType = response.headers.get('content-type');
			if (!contentType || !contentType.includes('application/json')) {
				const error = new AppError('Invalid JSON response from server', 502);
				return handleError(error, 'global.ts', { url: fullUrl, status: response.status, contentType });
			}
			
			// Check if response body is empty
			const text = await response.text();
			if (!text || text.trim() === '') {
				const error = new AppError('Empty response from server', 502);
				return handleError(error, 'global.ts', { url: fullUrl, status: response.status });
			}
			
			try {
				const response_json: ApiResponse = JSON.parse(text);
				return response_json;
			} catch (jsonError) {
				const error = new AppError('Invalid JSON response from server', 502);
				return handleError(error, 'global.ts', { url: fullUrl, status: response.status, jsonError: (jsonError as Error).message });
			}
		} else {
			// Try to extract error message and full response body from response
			// Clone the response so we can read it without consuming it
			const responseClone = response.clone();
			let serverErrorMessage: string | null = null;
			let serverErrorBody: any = null;
			try {
				const contentType = response.headers.get('content-type');
				if (contentType && contentType.includes('application/json')) {
					const text = await responseClone.text();
					if (text && text.trim() !== '') {
						const errorResponse = JSON.parse(text);
						// Server returns { success: false, message: "...", data: {...} } format
						// OR FastAPI HTTPException format: { detail: "..." }
						serverErrorMessage = errorResponse.message || errorResponse.error || errorResponse.detail || null;
						
						// For script execution errors, try to extract more detailed error message from data.error_lines
						if (errorResponse.data?.error_lines && Array.isArray(errorResponse.data.error_lines) && errorResponse.data.error_lines.length > 0) {
							const lastError = errorResponse.data.error_lines[errorResponse.data.error_lines.length - 1];
							if (lastError && typeof lastError === 'string' && lastError.trim()) {
								// Use the last error line as the message if it's more specific than the generic message
								if (!serverErrorMessage || serverErrorMessage === 'Script execution failed' || serverErrorMessage === 'Server error') {
									serverErrorMessage = lastError.length > 300 ? lastError.substring(0, 300) + '...' : lastError;
								}
							}
						}
						
						// Capture the full error response body (includes data with error_lines, output_lines, etc.)
						serverErrorBody = errorResponse;
						
						// Special case: 409 Conflict "Process already running" is expected and handled by callers
						// Return it without logging as an error
						if (response.status === 409 && serverErrorBody?.data?.process_already_running) {
							return {
								success: false,
								status: 409,
								message: serverErrorMessage || 'Process already running',
								data: serverErrorBody.data,
								type: 'Conflict'
							};
						}
						
					// Log for debugging (skip for 409 "Process already running").
					// Use a summary only — never log full errorResponse to avoid huge DB payloads (e.g. data returned as error body).
					const errorSummary = buildErrorResponseLogSummary(errorResponse, response.status, serverErrorMessage);
					const summaryStr = JSON.stringify(errorSummary);
					logError('[global.ts] Server error response captured:', summaryStr.length > ERROR_LOG_CONTEXT_MAX_LENGTH ? summaryStr.substring(0, ERROR_LOG_CONTEXT_MAX_LENGTH) + '...' : summaryStr);
					} else {
						logError('[global.ts] Server returned empty error response body');
					}
				} else {
					logError('[global.ts] Server error response is not JSON, content-type:', contentType);
				}
			} catch (parseError) {
				// If we can't parse the error, log it for debugging
				logError('[global.ts] Error parsing server error response:', parseError);
			}
			
			let error: AppError;
			let errorMessage: string;
			switch (response.status) {
				case 401:
					// Try to refresh token before giving up
					try {
						const { authManager } = await import('./authManager');
						const refreshToken = authManager.getRefreshToken();
						
						// If we have a refresh token, try to refresh before redirecting
						if (refreshToken) {
							try {
								const refreshSuccess = await authManager.refreshToken();
								if (refreshSuccess) {
									// Token refreshed successfully, retry the original request
									const retryResponse = await authManager.makeAuthenticatedRequest(fullUrl, {
										method: "POST",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify(body_json),
										signal: signal
									});
									
									if (retryResponse.ok) {
										// Retry succeeded, parse and return the response
										const contentType = retryResponse.headers.get('content-type');
										if (!contentType || !contentType.includes('application/json')) {
											const error = new AppError('Invalid JSON response from server', 502);
											return handleError(error, 'global.ts', { url: fullUrl, status: retryResponse.status, contentType });
										}
										
										const text = await retryResponse.text();
										if (!text || text.trim() === '') {
											const error = new AppError('Empty response from server', 502);
											return handleError(error, 'global.ts', { url: fullUrl, status: retryResponse.status });
										}
										
										try {
											const response_json: ApiResponse = JSON.parse(text);
											return response_json;
										} catch (jsonError) {
											const error = new AppError('Invalid JSON response from server', 502);
											return handleError(error, 'global.ts', { url: fullUrl, status: retryResponse.status, jsonError: (jsonError as Error).message });
										}
									}
								}
							} catch (refreshError) {
								// Refresh failed, will fall through to redirect
							}
						}
						
						// If refresh failed or no refresh token, clear tokens and redirect
						const { setIsLoggedIn, setUser, setSubscription } = await import('../store/userStore');
						authManager.clearTokens();
						setIsLoggedIn(false);
						setUser(null);
						setSubscription(null);
						
						// Only redirect if we're not already on a public page (login, register, verify, etc.)
						const currentPath = window.location.pathname;
						if (!PUBLIC_AUTH_PATHS.includes(currentPath)) {
							window.location.href = '/login';
						}
					} catch (redirectErr) {
						// If redirect fails, still log the error
						logError('Failed to redirect to login:', redirectErr);
					}
					
					error = new AuthError('Authentication required');
					errorMessage = 'Authentication required';
					break;
				case 404:
					error = new NotFoundError('API endpoint');
					errorMessage = 'API endpoint not found';
					break;
				case 422:
					error = new ValidationError(serverErrorMessage || 'Invalid request data');
					errorMessage = serverErrorMessage || 'Invalid request data';
					break;
				case 500:
					// For script execution errors, include more details in the error message
					let detailedMessage = serverErrorMessage || 'Server error';
					if (serverErrorBody?.data) {
						const errorData = serverErrorBody.data;
						// If there are error lines, include the last one in the message
						if (errorData.error_lines && Array.isArray(errorData.error_lines) && errorData.error_lines.length > 0) {
							const lastError = errorData.error_lines[errorData.error_lines.length - 1];
							if (lastError && typeof lastError === 'string' && lastError.trim()) {
								detailedMessage = lastError.length > 200 ? lastError.substring(0, 200) + '...' : lastError;
							}
						}
						// Include return code if available
						if (errorData.return_code !== undefined && errorData.return_code !== null && errorData.return_code !== 0) {
							detailedMessage = `Script execution failed (return code: ${errorData.return_code}): ${detailedMessage}`;
						}
					}
					error = new AppError(detailedMessage, 500);
					errorMessage = detailedMessage;
					break;
				default:
					error = new AppError(serverErrorMessage || `HTTP ${response.status}: ${response.statusText}`, response.status);
					errorMessage = serverErrorMessage || `HTTP ${response.status}: ${response.statusText}`;
			}
			
			// Pass both the request body and the server's error response body
			return handleError(error, 'global.ts', { 
				url: fullUrl, 
				status: response.status, 
				body: body_json, // Request body
				errorResponse: serverErrorBody // Server's error response (includes data with error_lines, output_lines, etc.)
			});
		}
	} catch (error) {
		if ((error as Error).name === 'AbortError') {
			return { success: false, message: 'Request cancelled', status: 0, type: 'AbortError' };
		}
		
		const networkError = new NetworkError(`Network error: ${(error as Error).message}`);
		return handleError(networkError, 'global.ts', { url, body: body_json, signal: !!signal });
	}
}

/**
 * Helper function to get event times - always uses POST to avoid URL length limitations
 * @param params - Parameters for the event times request
 * @param signal - Optional AbortSignal for request cancellation
 */
export async function getEventTimes(
	params: {
		class_name: string;
		project_id: number;
		dataset_id?: number;
		source_id?: number;
		date?: string;
		event_list: number[] | string; // Can be array or JSON string
		timezone?: string;
	},
	signal?: AbortSignal
): Promise<ApiResponse> {
	const { apiEndpoints } = await import('../config/env.js');

	// API requires either dataset_id (valid id) OR (source_id and date). Don't send invalid requests.
	const hasDatasetId = params.dataset_id != null && params.dataset_id > 0;
	const hasSourceAndDate = params.source_id != null && params.source_id > 0 && !!params.date;
	if (!hasDatasetId && !hasSourceAndDate) {
		throw new Error('getEventTimes: Either dataset_id > 0 OR (source_id and date) must be provided');
	}
	
	// Convert event_list to JSON string if it's an array
	const eventListString = Array.isArray(params.event_list) 
		? JSON.stringify(params.event_list) 
		: params.event_list;
	
	const body = {
		class_name: params.class_name,
		project_id: params.project_id,
		...(hasDatasetId && { dataset_id: params.dataset_id }),
		...(params.source_id !== undefined && { source_id: params.source_id }),
		...(params.date && { date: params.date }),
		event_list: eventListString,
		...(params.timezone && { timezone: params.timezone })
	};
	
	return postData(`${apiEndpoints.app.events}/times`, body, signal);
}

export async function putData(url: string, body_json: any, signal?: AbortSignal): Promise<ApiResponse> {
	try {
		// Import authManager dynamically to avoid circular dependencies
		const { authManager } = await import('./authManager');
		
		// Construct full URL (same logic as getData and postData)
		let fullUrl: string;
		if (url.startsWith('http')) {
			fullUrl = url;
		} else if (url.startsWith('/api')) {
			// URL already starts with /api, use as-is
			fullUrl = url;
		} else {
			// Prepend API_BASE_URL for relative URLs
			fullUrl = config.API_BASE_URL + url;
		}
		
		const response = await authManager.makeAuthenticatedRequest(fullUrl, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body_json),
			signal: signal
		});

		// Let backend sendResponse handle logging with proper source information
		if (response.ok) {
			// Check if response has content before parsing JSON
			const contentType = response.headers.get('content-type');
			if (!contentType || !contentType.includes('application/json')) {
				const error = new AppError('Invalid JSON response from server', 502);
				return handleError(error, 'global.ts', { url: fullUrl, status: response.status, contentType });
			}
			
			// Check if response body is empty
			const text = await response.text();
			if (!text || text.trim() === '') {
				const error = new AppError('Empty response from server', 502);
				return handleError(error, 'global.ts', { url: fullUrl, status: response.status });
			}
			
			try {
				const response_json: ApiResponse = JSON.parse(text);
				return response_json;
			} catch (jsonError) {
				const error = new AppError('Invalid JSON response from server', 502);
				return handleError(error, 'global.ts', { url: fullUrl, status: response.status, jsonError: (jsonError as Error).message });
			}
		} else {
			// Try to extract error message and full response body from response
			// Clone the response so we can read it without consuming it
			const responseClone = response.clone();
			let serverErrorMessage: string | null = null;
			let serverErrorBody: any = null;
			try {
				const contentType = response.headers.get('content-type');
				if (contentType && contentType.includes('application/json')) {
					const text = await responseClone.text();
					if (text && text.trim() !== '') {
						const errorResponse = JSON.parse(text);
						// Server returns { success: false, message: "...", data: {...} } format
						// OR FastAPI HTTPException format: { detail: "..." }
						serverErrorMessage = errorResponse.message || errorResponse.error || errorResponse.detail || null;
						
						// For script execution errors, try to extract more detailed error message from data.error_lines
						if (errorResponse.data?.error_lines && Array.isArray(errorResponse.data.error_lines) && errorResponse.data.error_lines.length > 0) {
							const lastError = errorResponse.data.error_lines[errorResponse.data.error_lines.length - 1];
							if (lastError && typeof lastError === 'string' && lastError.trim()) {
								// Use the last error line as the message if it's more specific than the generic message
								if (!serverErrorMessage || serverErrorMessage === 'Script execution failed' || serverErrorMessage === 'Server error') {
									serverErrorMessage = lastError.length > 300 ? lastError.substring(0, 300) + '...' : lastError;
								}
							}
						}
						
						// Capture the full error response body (includes data with error_lines, output_lines, etc.)
						serverErrorBody = errorResponse;
						
						// Log for debugging. Use summary only — never full errorResponse (avoids huge DB payloads).
						const errorSummaryPut = buildErrorResponseLogSummary(errorResponse, response.status, serverErrorMessage);
						const summaryStrPut = JSON.stringify(errorSummaryPut);
						logError('[global.ts] Server error response captured:', summaryStrPut.length > ERROR_LOG_CONTEXT_MAX_LENGTH ? summaryStrPut.substring(0, ERROR_LOG_CONTEXT_MAX_LENGTH) + '...' : summaryStrPut);
					} else {
						logError('[global.ts] Server returned empty error response body');
					}
				} else {
					logError('[global.ts] Server error response is not JSON, content-type:', contentType);
				}
			} catch (parseError) {
				// If we can't parse the error, log it for debugging
				logError('[global.ts] Error parsing server error response:', parseError);
			}
			
			// Handle specific HTTP errors consistently
			let error: AppError;
			switch (response.status) {
				case 401:
					// Try to refresh token before giving up
					try {
						const { authManager } = await import('./authManager');
						const refreshToken = authManager.getRefreshToken();
						
						// If we have a refresh token, try to refresh before redirecting
						if (refreshToken) {
							try {
								const refreshSuccess = await authManager.refreshToken();
								if (refreshSuccess) {
									// Token refreshed successfully, retry the original request
									const retryResponse = await authManager.makeAuthenticatedRequest(fullUrl, {
										method: "PUT",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify(body_json),
										signal: signal
									});
									
									if (retryResponse.ok) {
										// Retry succeeded, parse and return the response (deleteData uses response.json() directly)
										const response_json: ApiResponse = await retryResponse.json();
										return response_json;
									}
								}
							} catch (refreshError) {
								// Refresh failed, will fall through to redirect
							}
						}
						
						// If refresh failed or no refresh token, clear tokens and redirect
						const { setIsLoggedIn, setUser, setSubscription } = await import('../store/userStore');
						authManager.clearTokens();
						setIsLoggedIn(false);
						setUser(null);
						setSubscription(null);
						
						// Only redirect if we're not already on a public page (login, register, verify, etc.)
						const currentPath = window.location.pathname;
						if (!PUBLIC_AUTH_PATHS.includes(currentPath)) {
							window.location.href = '/login';
						}
					} catch (redirectErr) {
						// If redirect fails, still log the error
						logError('Failed to redirect to login:', redirectErr);
					}
					
					error = new AuthError('Authentication required');
					break;
				case 404:
					error = new NotFoundError('API endpoint');
					break;
				case 422:
					error = new ValidationError('Invalid request data');
					break;
				case 500:
					error = new AppError('Server error', 500);
					break;
				default:
					error = new AppError(`HTTP ${response.status}: ${response.statusText}`, response.status);
			}
			
			// Pass both the request body and the server's error response body
			return handleError(error, 'global.ts', { 
				url: fullUrl, 
				status: response.status, 
				body: body_json, // Request body
				errorResponse: serverErrorBody // Server's error response (includes data with error_lines, output_lines, etc.)
			});
		}
	} catch (error) {
		if ((error as Error).name === 'AbortError') {
			return { success: false, message: 'Request cancelled', status: 0, type: 'AbortError' };
		}
		
		const networkError = new NetworkError(`Network error: ${(error as Error).message}`);
		return handleError(networkError, 'global.ts', { url, body: body_json, signal: !!signal });
	}
}

/**
 * Media Container Scaling Utility
 * 
 * Sets up dynamic scaling for media-container elements that accounts for:
 * - Browser zoom (via visualViewport API)
 * - Sidebar width (275px expanded, 64px collapsed)
 * - Header height (60px)
 * - Both width and height scaling
 * 
 * @param options Configuration options
 * @param options.baseWidth Base width for scaling calculation (default: 1620)
 * @param options.baseHeight Base height for scaling calculation (default: 1020 - approx 1080p minus header)
 * @param options.headerHeight Header height in pixels (default: 60)
 * @param options.sidebarExpandedWidth Sidebar width when expanded (default: 275)
 * @param options.sidebarCollapsedWidth Sidebar width when collapsed (default: 64)
 * @param options.scaleToWidth If true, scale based on width only (ignores height constraint). If false, uses minimum of width/height (default: false)
 * @param options.logPrefix Optional prefix for debug logs
 * @param options.onScale Optional callback function called when scale updates
 * @returns Cleanup function to remove event listeners and observers
 */

/** Custom event name for split panel resize (divider drag). Dispatch from Dashboard so scaling updates. */
export const SPLIT_PANEL_RESIZE_EVENT = 'split-panel-resize';

/** Call when the split view divider is dragged so media-container scaling can update. */
export function notifySplitPanelResize(): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.dispatchEvent(new CustomEvent(SPLIT_PANEL_RESIZE_EVENT));
    });
  });
}

export function setupMediaContainerScaling(options: {
  baseWidth?: number;
  baseHeight?: number;
  headerHeight?: number;
  sidebarExpandedWidth?: number;
  sidebarCollapsedWidth?: number;
  scaleToWidth?: boolean;
  logPrefix?: string;
  onScale?: (scaleFactor: number, containerWidth: number, containerHeight: number) => void;
  /** When set, used instead of document.getElementById('media-container') (e.g. multiple panels). */
  getMediaContainer?: () => HTMLElement | null;
  /**
   * Headerless ManeuverWindow popup: use #main-content client box (not window.innerHeight) and do not
   * apply maneuvers-page vertical reserves meant for the main dashboard (control bar + table strip).
   */
  soloManeuverWindow?: boolean;
  /**
   * Added to maneuvers-page layout height when `.maneuver-window-media-container` (e.g. TIME SERIES
   * in solo window) so charts aren’t short by a phantom toolbar band.
   */
  maneuverWindowExtraLayoutHeightPx?: number;
} = {}): () => void {
  const {
    baseWidth = 1620,
    baseHeight = 1020,
    headerHeight = 60,
    sidebarExpandedWidth = 275,
    sidebarCollapsedWidth = 64,
    scaleToWidth = false,
    logPrefix = 'MediaContainer',
    onScale,
    getMediaContainer,
    soloManeuverWindow = false,
    maneuverWindowExtraLayoutHeightPx = 0
  } = options;

  const updateScale = () => {
    const mediaContainer = getMediaContainer?.() ?? document.getElementById('media-container');
    if (!mediaContainer) return;
    
    const parentContainer = mediaContainer.parentElement;
    if (!parentContainer) return;

    const isManeuverWindowMedia = mediaContainer.classList.contains('maneuver-window-media-container');
    
    // Check if we're inside a split-panel
    const splitPanel = mediaContainer.closest('.split-panel');
    const isInSplitView = !!splitPanel;
    
    let availableWidth: number;
    let availableHeight: number;
    
    if (isInSplitView && splitPanel) {
      // In split view: use the actual panel dimensions (panel may not be laid out yet on first run)
      availableWidth = splitPanel.clientWidth;
      availableHeight = splitPanel.clientHeight;
      if (availableWidth < 100 || availableHeight < 100) {
        const rect = splitPanel.getBoundingClientRect();
        if (rect.width >= 100 && rect.height >= 100) {
          availableWidth = Math.round(rect.width);
          availableHeight = Math.round(rect.height);
        } else {
          const splitContent = splitPanel.parentElement?.closest('.split-view-content');
          if (splitContent && splitContent.clientWidth >= 100 && splitContent.clientHeight >= 100) {
            availableWidth = splitContent.clientWidth;
            availableHeight = splitContent.clientHeight;
          }
        }
      }
      if (availableWidth < 100 || availableHeight < 100) {
        warn(`${logPrefix} - Split panel dimensions not ready (${availableWidth}x${availableHeight}px), will retry`);
        return;
      }
    } else {
      // Normal view: use main-content dimensions directly (it already accounts for sidebar)
      const mainContent = document.getElementById('main-content') || parentContainer;
      const windowRoot = document.getElementById('window');

      // ManeuverWindow #media-container: use #window (or visualViewport when narrow) — not #main-content,
      // which scaling-page caps at 100vh-60px and under-fills the popup.
      if (isManeuverWindowMedia && windowRoot && windowRoot.clientHeight >= 100) {
        const narrow = window.innerWidth <= 1000;
        const vv = window.visualViewport;
        if (narrow && vv && (vv.height || 0) >= 100) {
          availableWidth = Math.max(100, Math.round(vv.width || windowRoot.clientWidth));
          availableHeight = Math.max(100, Math.round(vv.height) - headerHeight);
        } else {
          availableWidth = Math.max(100, windowRoot.clientWidth);
          availableHeight = Math.max(100, windowRoot.clientHeight - headerHeight);
        }
      } else if (soloManeuverWindow && mainContent.clientHeight > 0 && mainContent.clientWidth > 0) {
        availableWidth = mainContent.clientWidth;
        availableHeight = Math.max(100, mainContent.clientHeight - headerHeight);
      } else {
        // Get viewport height for height calculation
        const isMobile = window.innerWidth <= 1000;
        let viewportHeight: number;

        if (window.visualViewport && isMobile) {
          // On mobile, prefer visualViewport for accurate visible dimensions
          viewportHeight = window.visualViewport.height || window.innerHeight || (mainContent.clientHeight > 0 ? mainContent.clientHeight : 1280);
        } else {
          // On desktop or when visualViewport unavailable, use window dimensions
          viewportHeight = window.innerHeight || (mainContent.clientHeight > 0 ? mainContent.clientHeight : 1280);
        }

        // Use main-content's clientWidth (excludes padding/borders, gives inner width)
        // This is more accurate than getBoundingClientRect which includes padding/borders
        if (mainContent.clientWidth > 0) {
          availableWidth = mainContent.clientWidth;
        } else {
          // Fallback: use getBoundingClientRect if clientWidth not available
          const mainContentRect = mainContent.getBoundingClientRect();
          if (mainContentRect.width > 0) {
            availableWidth = mainContentRect.width;
          } else {
            // Final fallback: use parent container width
            const parentRect = parentContainer.getBoundingClientRect();
            availableWidth = parentRect.width > 0 ? parentRect.width : Math.max(100, window.innerWidth - 275);
          }
        }

        // Subtract header height from available height
        availableHeight = Math.max(100, viewportHeight - headerHeight);
      }
    }

    // Maneuvers page: reserve minimal height so table + Clear Formatting isn't cut off in big table mode
    if (
      mediaContainer.classList.contains('maneuvers-page') &&
      !soloManeuverWindow &&
      !isManeuverWindowMedia
    ) {
      availableHeight = Math.max(100, availableHeight - 60);
    }

    // Race Summary and Prestart (Start Summary): same full-width/full-height treatment (use full available space)
    const isRaceSummaryPage = mediaContainer.classList.contains('race-summary-page');
    const isPrestartPage = mediaContainer.classList.contains('prestart-page');
    const isCheatSheetPage = mediaContainer.classList.contains('cheat-sheet-page');
    // Cheat Sheet page: reserve bottom padding (32px) so content isn't cut off
    if (isCheatSheetPage) {
      availableHeight = Math.max(100, availableHeight - 32);
    }

    // When viewport >= 1620 use actual width so content fills the screen; when narrow keep 1620 base
    // For maneuvers: when window is >= 1620px and NOT in split view, use available width so we get scale 1.
    // In split view always use fixed base (1620) and scale to fit the panel, so layout is consistent and scaling works at any window size.
    const isManeuversPage = mediaContainer.classList.contains('maneuvers-page');
    const windowWideEnoughForBase = window.innerWidth >= baseWidth;
    const effectiveBaseWidth = isManeuversPage && windowWideEnoughForBase && !isInSplitView
      ? availableWidth
      : (availableWidth >= baseWidth ? availableWidth : baseWidth);
    document.documentElement.style.setProperty('--layout-base-width', `${effectiveBaseWidth}px`);

    // Calculate width scale factor early for performance pages
    const isMobile = window.innerWidth <= 1000;
    const widthScaleFactorEarly = availableWidth / effectiveBaseWidth;
    
    // Always set container to fill available space
    // For performance pages and scatter pages, calculate height based on width scaling
    // For timeseries pages, use viewport height directly (content will scroll inside)
    const isPerformancePage = mediaContainer.classList.contains('performance-page') || 
                              mediaContainer.classList.contains('fleet-performance-page') ||
                              mediaContainer.classList.contains('scatter-page') ||
                              mediaContainer.classList.contains('targets-page');
    const isTimeseriesPage = mediaContainer.classList.contains('timeseries-page');
    const isCalibrationPage = mediaContainer.classList.contains('calibration-page');
    /** Long scrollable dataset reports that use the same layout height / scale math as Explore TimeSeries */
    const isTimeseriesLikePage = isTimeseriesPage || isCalibrationPage;
    
    if (isPerformancePage) {
		// Performance pages need more height when width is narrower (content scales up)
		// The narrower the window, the more the content is scaled, requiring more vertical space
		// Use inverse relationship: as widthScaleFactor decreases, height multiplier increases
		// On mobile, use visualViewport height for accurate calculation
		const viewportHeightForCalc = (window.visualViewport && isMobile) 
			? (window.visualViewport.height || window.innerHeight)
			: window.innerHeight;
		const innerScaled = viewportHeightForCalc * (window.devicePixelRatio || 1);
		
		// Calculate height multiplier inversely proportional to width scale factor
		// When widthScaleFactor is 1.0 (full width), use smaller multiplier (1.8)
		// When widthScaleFactor is 0.5 (half width), use larger multiplier (>4.0)
		// Use piecewise function: at full width use 1.8, at narrow widths scale up more aggressively
		let heightMultiplier: number;
		if (widthScaleFactorEarly >= 0.95) {
			// Full width: use 1.8 (works perfectly per user)
			heightMultiplier = 1.8;
		} else if (widthScaleFactorEarly >= 0.6) {
			// Medium width: scale from 1.8 to 3.0, with 20% more height
			// Linear interpolation: 1.8 at 0.95, 3.0 at 0.6
			const t = (0.95 - widthScaleFactorEarly) / (0.95 - 0.6);
			heightMultiplier = (1.8 + (3.0 - 1.8) * t) * 1.2; // Add 20% more height
		} else {
			// Narrow width: use aggressive scaling to ensure >4.0 at 0.5, with 60% more height (40% + 20%)
			// At 0.6: 3.0, at 0.5: 4.5 * 1.68 = 7.56, at 0.4: 6.0 * 1.68 = 10.08
			const rawMultiplier = 2.25 / Math.max(widthScaleFactorEarly, 0.375); // 2.25 / 0.5 = 4.5
			heightMultiplier = Math.min(10.0, rawMultiplier * 1.68); // Add 68% more height (40% + 20% more)
		}
		const calculatedHeight = innerScaled * heightMultiplier;
		
		availableHeight = calculatedHeight;
    } else if (isTimeseriesLikePage) {
		// Timeseries / Calibration: use viewport height directly
		// Content will scale to fit width, and overflow will scroll vertically inside the scroll container
		// On mobile, use visualViewport height for accurate calculation
		const viewportHeightForCalc = (window.visualViewport && isMobile) 
			? (window.visualViewport.height || window.innerHeight)
			: window.innerHeight;
		availableHeight = viewportHeightForCalc - headerHeight;
    }

	// Use effectiveBaseWidth so when viewport >= 1620 content fills screen; when narrow CSS var is 1620
	if (isTimeseriesLikePage) {
		mediaContainer.style.setProperty('width', `${effectiveBaseWidth}px`, 'important');
		mediaContainer.style.setProperty('min-width', `${effectiveBaseWidth}px`, 'important');
		// Layout height must compensate for transform scale so visible height = availableHeight (layoutHeight * scaleFactor = availableHeight)
		const timeseriesScaleFactor = Math.min(availableWidth / effectiveBaseWidth, 1.5);
		const safeScale = Math.max(timeseriesScaleFactor, 0.1);
		const layoutHeight = Math.max(200, Math.round(availableHeight / safeScale));
		mediaContainer.style.setProperty('height', `${layoutHeight}px`, 'important');
		mediaContainer.style.setProperty('min-height', `${layoutHeight}px`, 'important');
		mediaContainer.style.setProperty('max-height', `${layoutHeight}px`, 'important');
		mediaContainer.style.setProperty('overflow-y', 'auto', 'important');
	} else if (mediaContainer.classList.contains('fleet-performance-page')) {
		// Same as Race Summary: do NOT set pixel dimensions - let CSS fill the parent
		mediaContainer.style.removeProperty('width');
		mediaContainer.style.removeProperty('height');
		mediaContainer.style.removeProperty('min-height');
	} else if (mediaContainer.classList.contains('performance-page') || mediaContainer.classList.contains('scatter-page')) {
		mediaContainer.style.setProperty('width', `${effectiveBaseWidth}px`, 'important');
		mediaContainer.style.setProperty('min-width', `${effectiveBaseWidth}px`, 'important');
		mediaContainer.style.setProperty('height', `${availableHeight}px`, 'important');
		mediaContainer.style.setProperty('min-height', `${availableHeight}px`, 'important');
    } else if (mediaContainer.classList.contains('maneuvers-page')) {
		// Same as timeseries-page: #media-container uses transform: scale(widthScale). Layout height must be
		// larger when scale < 1 so the painted height ≈ availableHeight (narrow windows were visibly too short).
		const maneuversLayoutScale = Math.min(availableWidth / effectiveBaseWidth, 1.5);
		const safeManeuversScale = Math.max(maneuversLayoutScale, 0.1);
		const maneuverWindowLayoutBoost =
			isManeuverWindowMedia && maneuverWindowExtraLayoutHeightPx > 0
				? maneuverWindowExtraLayoutHeightPx
				: 0;
		const maneuversLayoutHeight = Math.max(
			200,
			Math.round((availableHeight + maneuverWindowLayoutBoost) / safeManeuversScale)
		);
		mediaContainer.style.setProperty('width', `${effectiveBaseWidth}px`, 'important');
		mediaContainer.style.setProperty('min-width', `${effectiveBaseWidth}px`, 'important');
		mediaContainer.style.setProperty('height', `${maneuversLayoutHeight}px`, 'important');
		mediaContainer.style.setProperty('min-height', `${maneuversLayoutHeight}px`, 'important');
	} else if (isRaceSummaryPage || isPrestartPage) {
		mediaContainer.style.removeProperty('width');
		mediaContainer.style.removeProperty('height');
		mediaContainer.style.removeProperty('min-height');
	} else if (isCheatSheetPage) {
		// Cheat Sheet: set dimensions via JS; add header height so container fills (was short by header amount)
		const cheatSheetHeight = availableHeight + headerHeight;
		mediaContainer.style.removeProperty('width');
		mediaContainer.style.removeProperty('min-width');
		mediaContainer.style.setProperty('height', `${cheatSheetHeight}px`, 'important');
		mediaContainer.style.setProperty('min-height', `${cheatSheetHeight}px`, 'important');
		mediaContainer.style.setProperty('max-height', `${cheatSheetHeight}px`, 'important');
	} else {
		// Other pages (e.g. targets)
		mediaContainer.style.setProperty('width', `${effectiveBaseWidth}px`, 'important');
		mediaContainer.style.setProperty('min-width', `${effectiveBaseWidth}px`, 'important');
		mediaContainer.style.setProperty('height', `${availableHeight}px`, 'important');
	}
    
    // Scale factor: use effectiveBaseWidth so when viewport >= 1620 scale is 1
    const widthScaleFactor = availableWidth / effectiveBaseWidth;
    const heightScaleFactor = availableHeight / baseHeight;
    
    // Use width-based scaling if requested, or for maneuvers page so scale grows continuously with width (no plateau 1370–1620)
    // Width-based scaling fills the width completely (may require vertical scrolling)
    // Minimum scaling ensures content fits in both dimensions (maintains aspect ratio)
    const useWidthBasedScale = scaleToWidth || isManeuversPage;
    let scaleFactor = useWidthBasedScale ? widthScaleFactor : Math.min(widthScaleFactor, heightScaleFactor);
    
    // IMPORTANT: Cap scale factor appropriately based on page type
    // Scatter/probability pages: Never scale up beyond 100% (keep charts at base size)
    // Performance pages: Allow scaling up to fill larger monitors, but cap at reasonable maximum (1.5x)
    // Timeseries pages: Allow scaling up to fill larger monitors, but cap at reasonable maximum (1.5x)
    // Other pages: Cap at 1.0
    const isScatterOrProbabilityPage = mediaContainer.classList.contains('scatter-page');
    if (isScatterOrProbabilityPage) {
      scaleFactor = Math.min(scaleFactor, 1.0); // Never scale up beyond 100% for scatter/probability
    }
    // Performance pages and timeseries pages: allow scaling up to fill larger monitors, but cap at reasonable maximum
    else if (isPerformancePage || isTimeseriesLikePage) {
      scaleFactor = Math.min(scaleFactor, 1.5); // Cap at 150% for very large monitors (prevents excessive scaling)
    }
    // Maneuvers: allow scale up to fill width on large monitors (same as performance)
    else if (mediaContainer.classList.contains('maneuvers-page')) {
      scaleFactor = Math.min(scaleFactor, 1.5);
    }
    // Race Summary and Prestart: no transform scaling - container uses 100% width/height so keep scale 1
    else if (isRaceSummaryPage || isPrestartPage) {
      scaleFactor = 1;
    }
    // Cheat Sheet: no transform scaling - height set via JS above
    else if (isCheatSheetPage) {
      scaleFactor = 1;
    }
    // Other pages: cap at 1.0
    else {
      scaleFactor = Math.min(scaleFactor, 1.0);
    }
    
    // Per page-scaling-strategy.md: main-content scrolls (body.scaling-page gives overflow-y: auto)
    // For performance pages, do not set main-content height - CSS scaling-page rule applies
    if (isPerformancePage) {
        const mainContent = document.getElementById('main-content');
        if (mainContent) {
            mainContent.style.removeProperty('height');
        }
        // Set scroll container height so the scroll viewport is bounded (prevents scrollbar overflow)
        // Same formula as timeseries: layoutHeight = desiredVisibleHeight / scaleFactor (per maneuver-timeseries-scroll-fix.md)
        // Apply to performance-page, fleet-performance-page, and scatter-page (explore Probability and Scatter; per performance-page-scroll-fix.md)
        const isPerfOrFleetPerf = mediaContainer.classList.contains('performance-page') || mediaContainer.classList.contains('fleet-performance-page');
        const isScatterOrProbability = mediaContainer.classList.contains('scatter-page');
        if (isPerfOrFleetPerf || isScatterOrProbability) {
            const legendEl = mediaContainer.querySelector('.performance-legend-section');
            const legendHeight = legendEl ? (legendEl as HTMLElement).getBoundingClientRect().height : (isScatterOrProbability ? 0 : 50);
            const viewportHeightForScroll = (window.visualViewport && isMobile)
                ? (window.visualViewport.height || window.innerHeight)
                : window.innerHeight;
            const desiredVisibleHeight = Math.max(200, viewportHeightForScroll - headerHeight - legendHeight - 20);
            const layoutHeight = desiredVisibleHeight / scaleFactor;
            const scrollContainer = mediaContainer.querySelector('.performance-charts-scroll-container');
            if (scrollContainer) {
                (scrollContainer as HTMLElement).style.setProperty('height', `${layoutHeight}px`, 'important');
                (scrollContainer as HTMLElement).style.setProperty('max-height', `${layoutHeight}px`, 'important');
            }
        }
    } else if (isTimeseriesLikePage) {
        // For timeseries / calibration, don't constrain main-content height - let it expand with content
        const mainContent = document.getElementById('main-content');
        if (mainContent) {
            mainContent.style.setProperty('height', 'auto', 'important');
            mainContent.style.setProperty('min-height', `${availableHeight}px`, 'important');
        }
        
        // Set scroll container height to enable scrolling
        // Since the scroll container is inside a scaled parent, we need to account for scale factor
        // Formula: layoutHeight = desiredVisibleHeight / scaleFactor
        const scrollContainer = mediaContainer.querySelector('.performance-charts-scroll-container');
        if (scrollContainer) {
            const desiredVisibleHeight = availableHeight; // Viewport height minus header
            const layoutHeight = desiredVisibleHeight / scaleFactor;
            (scrollContainer as HTMLElement).style.setProperty('height', `${layoutHeight}px`, 'important');
            (scrollContainer as HTMLElement).style.setProperty('max-height', `${layoutHeight}px`, 'important');
        }
    } else if (isRaceSummaryPage || isPrestartPage) {
        // Race Summary / Prestart: same scroll pattern as FleetPerformance (per performance-page-scroll-fix.md)
        // No legend; scaleFactor is 1 so layoutHeight = desiredVisibleHeight
        const scrollContainer = mediaContainer.querySelector('.performance-charts-scroll-container');
        if (scrollContainer) {
            const viewportHeightForScroll = (window.visualViewport && isMobile)
                ? (window.visualViewport.height || window.innerHeight)
                : window.innerHeight;
            const desiredVisibleHeight = Math.max(200, viewportHeightForScroll - headerHeight - 20);
            const layoutHeight = desiredVisibleHeight / scaleFactor;
            (scrollContainer as HTMLElement).style.setProperty('height', `${layoutHeight}px`, 'important');
            (scrollContainer as HTMLElement).style.setProperty('max-height', `${layoutHeight}px`, 'important');
        }
    } else if (isCheatSheetPage) {
        // Cheat Sheet: set scroll container height via JS; use full viewport minus padding only (main-content is already below header)
        const scrollContainer = mediaContainer.querySelector('.performance-charts-scroll-container');
        if (scrollContainer) {
            const viewportHeightForScroll = (window.visualViewport && isMobile)
                ? (window.visualViewport.height || window.innerHeight)
                : window.innerHeight;
            const desiredVisibleHeight = Math.max(200, viewportHeightForScroll - 32 - 20);
            const layoutHeight = desiredVisibleHeight / scaleFactor;
            (scrollContainer as HTMLElement).style.setProperty('height', `${layoutHeight}px`, 'important');
            (scrollContainer as HTMLElement).style.setProperty('max-height', `${layoutHeight}px`, 'important');
        }
    }
    
    // Apply the scale factor (will scale both width and height proportionally via transform)
    document.documentElement.style.setProperty('--scale-factor', scaleFactor.toString());
    
    // Call optional callback
    if (onScale) {
      onScale(scaleFactor, availableWidth, availableHeight);
    }
    
    // Remove opacity class once scaling is fully applied to prevent flash
    mediaContainer.classList.remove('scaling-initializing');
    
    // Debug logging disabled in production to reduce console noise
  };
  
  // Add scaling-page class to body and html to allow overflow for scaled content
  document.body.classList.add('scaling-page');
  document.documentElement.classList.add('scaling-page');
  
  // Hide container initially to prevent flash, then show after scaling is applied
  const mediaContainer = document.getElementById('media-container');
  if (mediaContainer) {
    mediaContainer.classList.add('scaling-initializing');
  }
  
  // Retry logic for mobile: keep trying until media-container is found
  let retryCount = 0;
  const maxRetries = 20; // Try for up to 2 seconds (20 * 100ms)
  
  const tryUpdateScale = () => {
    const container = document.getElementById('media-container');
    if (container) {
      // Container found, update scale
      updateScale();
    } else if (retryCount < maxRetries) {
      // Container not found yet, retry
      retryCount++;
      setTimeout(tryUpdateScale, 100);
    } else {
      // Max retries reached - log warning but don't fail completely
      warn(`${logPrefix} - media-container not found after ${maxRetries} retries`);
    }
  };
  
  // Set initial scale immediately to prevent flash, then refine after DOM is ready
  // Use requestAnimationFrame to ensure DOM is ready but apply scale as soon as possible
  requestAnimationFrame(() => {
    tryUpdateScale();
    // Refine after a short delay to ensure DOM is fully laid out
    setTimeout(() => {
      updateScale();
    }, 50);
    // Additional retry for mobile devices that may be slower
    setTimeout(() => {
      updateScale();
    }, 200);
  });
  
  // Update on resize
  const resizeObserver = new ResizeObserver(updateScale);
  let splitPanelTransitionEndHandler: (() => void) | null = null;
  let splitPanelForCleanup: Element | null = null;
  setTimeout(() => {
    const mediaContainer = document.getElementById('media-container');
    if (mediaContainer) {
      // If in split view, observe the split panel and the split-view container so we react to both divider drag and window resize
      const splitPanel = mediaContainer.closest('.split-panel');
      if (splitPanel) {
        resizeObserver.observe(splitPanel);
        // Also observe split-view-content so resizing the window in split view triggers scale update (panel % of a changing container)
        const splitViewContent = splitPanel.closest('.split-view-content');
        if (splitViewContent) {
          resizeObserver.observe(splitViewContent);
        }
        // Panel width uses CSS transition (0.2s); run updateScale when transition ends so we pick up final size after divider drag
        splitPanelTransitionEndHandler = (e: TransitionEvent) => {
          if (e.propertyName === 'width') updateScale();
        };
        splitPanelForCleanup = splitPanel;
        splitPanel.addEventListener('transitionend', splitPanelTransitionEndHandler);
        // Split view: panel may not have final size yet; run scaling again after layout settles
        requestAnimationFrame(() => updateScale());
        setTimeout(() => updateScale(), 100);
        setTimeout(() => updateScale(), 350);
      } else {
        if (mediaContainer.parentElement) {
          resizeObserver.observe(mediaContainer.parentElement);
        }
        // Race-summary (and similar) may be wrapped; observe main-content so we react when it gets final size
        const mainContent = document.getElementById('main-content');
        if (mainContent && (mediaContainer.classList.contains('race-summary-page') || mediaContainer.classList.contains('maneuvers-page'))) {
          resizeObserver.observe(mainContent);
        }
      }
    } else {
      // Retry setting up ResizeObserver if container not found yet
      let observerRetryCount = 0;
      const trySetupObserver = () => {
        const container = document.getElementById('media-container');
        if (container) {
          const splitPanel = container.closest('.split-panel');
          if (splitPanel) {
            resizeObserver.observe(splitPanel);
            const splitViewContent = splitPanel.closest('.split-view-content');
            if (splitViewContent) {
              resizeObserver.observe(splitViewContent);
            }
            splitPanelTransitionEndHandler = (e: TransitionEvent) => {
              if (e.propertyName === 'width') updateScale();
            };
            splitPanelForCleanup = splitPanel;
            splitPanel.addEventListener('transitionend', splitPanelTransitionEndHandler);
            requestAnimationFrame(() => updateScale());
            setTimeout(() => updateScale(), 100);
            setTimeout(() => updateScale(), 350);
          } else {
            if (container.parentElement) {
              resizeObserver.observe(container.parentElement);
            }
            const mainContent = document.getElementById('main-content');
            if (mainContent && (container.classList.contains('race-summary-page') || container.classList.contains('maneuvers-page'))) {
              resizeObserver.observe(mainContent);
            }
          }
        } else if (observerRetryCount < 10) {
          observerRetryCount++;
          setTimeout(trySetupObserver, 100);
        }
      };
      trySetupObserver();
    }
  }, 200);

  // Extra delayed updates for race-summary / calibration so dimensions apply after layout has settled
  setTimeout(() => {
    const container = document.getElementById('media-container');
    if (container?.classList.contains('race-summary-page') || container?.classList.contains('calibration-page')) {
      updateScale();
    }
  }, 400);
  setTimeout(() => {
    const container = document.getElementById('media-container');
    if (container?.classList.contains('race-summary-page') || container?.classList.contains('calibration-page')) {
      updateScale();
    }
  }, 800);
  
  // Listen to window resize
  window.addEventListener('resize', updateScale);

  const onSplitPanelResize = () => updateScale();
  document.addEventListener(SPLIT_PANEL_RESIZE_EVENT, onSplitPanelResize);
  
  // Listen to visualViewport resize (handles browser zoom)
  let visualViewportResizeHandler: (() => void) | null = null;
  let visualViewportScrollHandler: (() => void) | null = null;
  if (window.visualViewport) {
    visualViewportResizeHandler = () => updateScale();
    visualViewportScrollHandler = () => updateScale();
    window.visualViewport.addEventListener('resize', visualViewportResizeHandler);
    window.visualViewport.addEventListener('scroll', visualViewportScrollHandler, { passive: true });
  }
  
  // Track last known dimensions to detect changes when moving between monitors
  let lastKnownWidth = window.innerWidth;
  let lastKnownHeight = window.innerHeight;
  
  // Handle window focus - recalculate when window regains focus (often happens when moving between monitors)
  const handleWindowFocus = () => {
    const currentWidth = window.innerWidth;
    const currentHeight = window.innerHeight;
    
    // If dimensions changed, recalculate scale
    if (currentWidth !== lastKnownWidth || currentHeight !== lastKnownHeight) {
      lastKnownWidth = currentWidth;
      lastKnownHeight = currentHeight;
      // Use requestAnimationFrame to ensure DOM is ready
      requestAnimationFrame(() => {
        updateScale();
      });
    }
  };
  window.addEventListener('focus', handleWindowFocus);
  
  // Handle visibility change - recalculate when page becomes visible (handles tab switching and monitor changes)
  const handleVisibilityChange = () => {
    if (!document.hidden) {
      const currentWidth = window.innerWidth;
      const currentHeight = window.innerHeight;
      
      // Always recalculate when page becomes visible, as dimensions might have changed
      if (currentWidth !== lastKnownWidth || currentHeight !== lastKnownHeight) {
        lastKnownWidth = currentWidth;
        lastKnownHeight = currentHeight;
        // Use requestAnimationFrame to ensure DOM is ready
        requestAnimationFrame(() => {
          updateScale();
        });
      } else {
        // Even if dimensions haven't changed, recalculate to handle DPI/resolution changes
        requestAnimationFrame(() => {
          updateScale();
        });
      }
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityChange);
  
  // Periodic check for dimension changes (fallback for cases where events don't fire)
  // This helps catch monitor changes that don't trigger resize events
  let dimensionCheckInterval: number | null = null;
  const checkDimensionChanges = () => {
    const currentWidth = window.innerWidth;
    const currentHeight = window.innerHeight;
    
    if (currentWidth !== lastKnownWidth || currentHeight !== lastKnownHeight) {
      lastKnownWidth = currentWidth;
      lastKnownHeight = currentHeight;
      updateScale();
    }
  };
  // Check every 500ms - frequent enough to catch changes, not too frequent to impact performance
  dimensionCheckInterval = window.setInterval(checkDimensionChanges, 500);
  
  // Watch for sidebar collapse/expand changes to recalculate scale
  let sidebarMutationObserver: MutationObserver | null = null;
  const setupSidebarObserver = () => {
    const sidebar = document.querySelector('.sidebar:not(.mobile)') || document.querySelector('.sidebar');
    if (sidebar && !sidebar.classList.contains('mobile')) {
      sidebarMutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
            // Sidebar class changed (collapsed/expanded), recalculate scale
            requestAnimationFrame(() => {
              updateScale();
            });
          }
        });
      });
      sidebarMutationObserver.observe(sidebar, {
        attributes: true,
        attributeFilter: ['class']
      });
    }
  };
  // Try to set up sidebar observer immediately, and retry if sidebar not found
  setTimeout(() => {
    setupSidebarObserver();
    // Retry a few times in case sidebar loads late
    let retryCount = 0;
    const retrySetup = () => {
      if (!sidebarMutationObserver && retryCount < 10) {
        setupSidebarObserver();
        if (!sidebarMutationObserver) {
          retryCount++;
          setTimeout(retrySetup, 200);
        }
      }
    };
    retrySetup();
  }, 100);
  
  // Return cleanup function
  return () => {
    if (splitPanelForCleanup && splitPanelTransitionEndHandler) {
      splitPanelForCleanup.removeEventListener('transitionend', splitPanelTransitionEndHandler);
      splitPanelForCleanup = null;
      splitPanelTransitionEndHandler = null;
    }
    document.removeEventListener(SPLIT_PANEL_RESIZE_EVENT, onSplitPanelResize);
    resizeObserver.disconnect();
    window.removeEventListener('resize', updateScale);
    window.removeEventListener('focus', handleWindowFocus);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    if (dimensionCheckInterval !== null) {
      clearInterval(dimensionCheckInterval);
      dimensionCheckInterval = null;
    }
    if (sidebarMutationObserver) {
      sidebarMutationObserver.disconnect();
      sidebarMutationObserver = null;
    }
    if (window.visualViewport && visualViewportResizeHandler) {
      window.visualViewport.removeEventListener('resize', visualViewportResizeHandler);
    }
    if (window.visualViewport && visualViewportScrollHandler) {
      window.visualViewport.removeEventListener('scroll', visualViewportScrollHandler);
    }
    
    // Remove scaling classes and reset layout width variable
    document.body.classList.remove('scaling-page');
    document.documentElement.classList.remove('scaling-page');
    document.documentElement.style.setProperty('--layout-base-width', '1620px');

    // Also remove scaling-initializing class from media-container if it exists
    const mediaContainer = document.getElementById('media-container');
    if (mediaContainer) {
      mediaContainer.classList.remove('scaling-initializing');
    }
    
    // Force a repaint to ensure browser updates the display immediately
    // This helps prevent visual artifacts when navigation happens quickly
    requestAnimationFrame(() => {
      // Double-check classes are removed (helps when browser is under load)
      if (document.body.classList.contains('scaling-page')) {
        document.body.classList.remove('scaling-page');
      }
      if (document.documentElement.classList.contains('scaling-page')) {
        document.documentElement.classList.remove('scaling-page');
      }
    });
  };
}

export async function deleteData(url: string, body_json: any, signal?: AbortSignal): Promise<ApiResponse> {
	try {
		// Import authManager dynamically to avoid circular dependencies
		const { authManager } = await import('./authManager');
		
		// Construct full URL
		// If URL is already absolute (starts with http), use as-is
		// If URL starts with /api, use as-is (already a relative URL for nginx)
		// Otherwise, prepend API_BASE_URL
		let fullUrl: string;
		if (url.startsWith('http')) {
			fullUrl = url;
		} else if (url.startsWith('/api')) {
			// URL already starts with /api, use as-is
			fullUrl = url;
		} else {
			// Prepend API_BASE_URL for relative URLs
			fullUrl = config.API_BASE_URL + url;
		}
		const response = await authManager.makeAuthenticatedRequest(fullUrl, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body_json),
			signal: signal
		});

		// Let backend sendResponse handle logging with proper source information
		if (response.ok) {
			const response_json: ApiResponse = await response.json();
			return response_json;
		} else {
			// Try to extract error message and full response body from response
			// Clone the response so we can read it without consuming it
			const responseClone = response.clone();
			let serverErrorMessage: string | null = null;
			let serverErrorBody: any = null;
			try {
				const contentType = response.headers.get('content-type');
				if (contentType && contentType.includes('application/json')) {
					const text = await responseClone.text();
					if (text && text.trim() !== '') {
						const errorResponse = JSON.parse(text);
						// Server returns { success: false, message: "...", data: {...} } format
						// OR FastAPI HTTPException format: { detail: "..." }
						serverErrorMessage = errorResponse.message || errorResponse.error || errorResponse.detail || null;
						
						// For script execution errors, try to extract more detailed error message from data.error_lines
						if (errorResponse.data?.error_lines && Array.isArray(errorResponse.data.error_lines) && errorResponse.data.error_lines.length > 0) {
							const lastError = errorResponse.data.error_lines[errorResponse.data.error_lines.length - 1];
							if (lastError && typeof lastError === 'string' && lastError.trim()) {
								// Use the last error line as the message if it's more specific than the generic message
								if (!serverErrorMessage || serverErrorMessage === 'Script execution failed' || serverErrorMessage === 'Server error') {
									serverErrorMessage = lastError.length > 300 ? lastError.substring(0, 300) + '...' : lastError;
								}
							}
						}
						
						// Capture the full error response body (includes data with error_lines, output_lines, etc.)
						serverErrorBody = errorResponse;
						
						// Log for debugging. Use summary only — never full errorResponse (avoids huge DB payloads).
						const errorSummaryDel = buildErrorResponseLogSummary(errorResponse, response.status, serverErrorMessage);
						const summaryStrDel = JSON.stringify(errorSummaryDel);
						logError('[global.ts] Server error response captured:', summaryStrDel.length > ERROR_LOG_CONTEXT_MAX_LENGTH ? summaryStrDel.substring(0, ERROR_LOG_CONTEXT_MAX_LENGTH) + '...' : summaryStrDel);
					} else {
						logError('[global.ts] Server returned empty error response body');
					}
				} else {
					logError('[global.ts] Server error response is not JSON, content-type:', contentType);
				}
			} catch (parseError) {
				// If we can't parse the error, log it for debugging
				logError('[global.ts] Error parsing server error response:', parseError);
			}
			
			// Handle specific HTTP errors consistently
			let error: AppError;
			switch (response.status) {
				case 401:
					// Try to refresh token before giving up
					try {
						const { authManager } = await import('./authManager');
						const refreshToken = authManager.getRefreshToken();
						
						// If we have a refresh token, try to refresh before redirecting
						if (refreshToken) {
							try {
								const refreshSuccess = await authManager.refreshToken();
								if (refreshSuccess) {
									// Token refreshed successfully, retry the original request
									const retryResponse = await authManager.makeAuthenticatedRequest(fullUrl, {
										method: "DELETE",
										headers: { "Content-Type": "application/json" },
										body: JSON.stringify(body_json),
										signal: signal
									});
									
									if (retryResponse.ok) {
										// Retry succeeded, parse and return the response (deleteData uses response.json() directly)
										const response_json: ApiResponse = await retryResponse.json();
										return response_json;
									}
								}
							} catch (refreshError) {
								// Refresh failed, will fall through to redirect
							}
						}
						
						// If refresh failed or no refresh token, clear tokens and redirect
						const { setIsLoggedIn, setUser, setSubscription } = await import('../store/userStore');
						authManager.clearTokens();
						setIsLoggedIn(false);
						setUser(null);
						setSubscription(null);
						
						// Only redirect if we're not already on a public page (login, register, verify, etc.)
						const currentPath = window.location.pathname;
						if (!PUBLIC_AUTH_PATHS.includes(currentPath)) {
							window.location.href = '/login';
						}
					} catch (redirectErr) {
						// If redirect fails, still log the error
						logError('Failed to redirect to login:', redirectErr);
					}
					
					error = new AuthError('Authentication required');
					break;
				case 404:
					error = new NotFoundError('API endpoint');
					break;
				case 422:
					error = new ValidationError('Invalid request data');
					break;
				case 500:
					error = new AppError('Server error', 500);
					break;
				default:
					error = new AppError(`HTTP ${response.status}: ${response.statusText}`, response.status);
			}
			
			// Pass both the request body and the server's error response body
			return handleError(error, 'global.ts', { 
				url: fullUrl, 
				status: response.status, 
				body: body_json, // Request body
				errorResponse: serverErrorBody // Server's error response (includes data with error_lines, output_lines, etc.)
			});
		}
	} catch (error) {
		if ((error as Error).name === 'AbortError') {
			return { success: false, message: 'Request cancelled', status: 0, type: 'AbortError' };
		}
		
		const networkError = new NetworkError(`Network error: ${(error as Error).message}`);
		return handleError(networkError, 'global.ts', { url, body: body_json, signal: !!signal });
	}
}
