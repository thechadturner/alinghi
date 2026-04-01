/**
 * Centralized Environment Configuration
 * 
 * This file provides a single source of truth for all environment variables
 * used by the frontend application. It separates client-side environment
 * variables from server-side ones and provides fallback values.
 */

// Client-side environment variables (prefixed with VITE_)
import { warn } from '../utils/console';

export const config = {
  // API Configuration - Always use relative URLs (nginx handles routing)
  get API_BASE_URL() {
    return '/api';
  },
  get ADMIN_BASE_URL() {
    return '/api/admin';
  },
  get FILE_BASE_URL() {
    return '/api/file';
  },
  get MEDIA_BASE_URL() {
    return '/api/media';
  },
  get PYTHON_BASE_URL() {
    return '/api/python';
  },
  get STREAM_BASE_URL() {
    return '/api/stream';
  },
  
  // Mapbox Configuration
  MAPBOX_TOKEN: import.meta.env.VITE_MAPBOX_TOKEN || '',
  MAPBOX_STYLE: import.meta.env.VITE_MAPBOX_STYLE || 'mapbox://styles/mapbox/streets-v11',
  
  // Development Configuration
  DEV_TOOLS: import.meta.env.VITE_DEV_TOOLS === 'true',
  DEBUG_MODE: import.meta.env.VITE_DEBUG_MODE === 'true',
  VERBOSE: import.meta.env.VITE_VERBOSE === 'true',
  IS_DEV: import.meta.env.DEV,
  IS_PROD: import.meta.env.PROD,
  
  // WebSocket Configuration
  // Set VITE_ENABLE_WEBSOCKETS=true to enable WebSocket streaming
  // Default: false (WebSockets disabled until further notice)
  ENABLE_WEBSOCKETS: import.meta.env.VITE_ENABLE_WEBSOCKETS === 'true',

  // Media: when true, only med_res exists (e.g. upload bypass); player uses med_res only, no quality switching
  MEDIA_MED_RES_ONLY: import.meta.env.VITE_MEDIA_MED_RES_ONLY === 'true',

  // Environment
  NODE_ENV: import.meta.env.MODE || 'development',
};

// API Endpoint Helpers
// All endpoints use relative URLs (nginx handles routing)
export const apiEndpoints = {
  // Auth endpoints - JWT
  auth: {
    login: `${config.API_BASE_URL}/auth/login`,
    logout: `${config.API_BASE_URL}/auth/logout`,
    register: `${config.API_BASE_URL}/auth/register`,
    verify: `${config.API_BASE_URL}/auth/verify`,
    resetPassword: `${config.API_BASE_URL}/auth/reset-password`,
    forgotPassword: `${config.API_BASE_URL}/auth/forgot-password`,
    me: `${config.API_BASE_URL}/auth/user`,
    refresh: `${config.API_BASE_URL}/auth/refresh`,
    autoLogin: `${config.API_BASE_URL}/auth/refresh`, // Use refresh for auto-login
  },
  
  // App endpoints (API_BASE_URL routes)
  app: {
    projects: `${config.API_BASE_URL}/projects`,
    datasets: `${config.API_BASE_URL}/datasets`,
    channels: `${config.API_BASE_URL}/datasets/channels`,
    comments: `${config.API_BASE_URL}/comments`,
    userEvents: `${config.API_BASE_URL}/user-events`,
    events: `${config.API_BASE_URL}/events`,
    targets: `${config.API_BASE_URL}/targets`,
    sources: `${config.API_BASE_URL}/sources`,
    pages: `${config.API_BASE_URL}/pages`,
    users: `${config.API_BASE_URL}/users`,
    usersPending: `${config.API_BASE_URL}/usersPending`,
    classes: `${config.API_BASE_URL}/classes`,
    data: `${config.API_BASE_URL}/data`,
    admin: {
      log_activity: `${config.API_BASE_URL}/admin/log_activity`,
      user_activity: `${config.API_BASE_URL}/admin/user_activity`,
      timezones: `${config.API_BASE_URL}/admin/timezones`,
    },
  },
  
  // Admin endpoints (ADMIN_BASE_URL routes)
  admin: {
    upload: `${config.ADMIN_BASE_URL}/upload`,
    log: `${config.ADMIN_BASE_URL}/log`,
    projects: `${config.ADMIN_BASE_URL}/projects`,
    datasets: `${config.ADMIN_BASE_URL}/datasets`,
    events: `${config.ADMIN_BASE_URL}/events`,
    tokens: `${config.ADMIN_BASE_URL}/tokens`,
    targets: `${config.ADMIN_BASE_URL}/targets`,
    truncateDatasetsCascade: `${config.ADMIN_BASE_URL}/truncate-datasets-cascade`,
    mediaRemoveByDate: `${config.ADMIN_BASE_URL}/media/by-date`,
  },

  // Python endpoints
  python: {
    sse: `${config.PYTHON_BASE_URL}/sse`,
    fetch_data: `${config.PYTHON_BASE_URL}/fetch_data`,
    execute_script: `${config.PYTHON_BASE_URL}/execute_script/`, // Trailing slash required by FastAPI endpoint
    running_processes: `${config.PYTHON_BASE_URL}/scripts/running`,
    cancel_process: (processId) => `${config.PYTHON_BASE_URL}/scripts/cancel/${processId}`,
  },
  
  // File endpoints
  file: {
    channels: `${config.FILE_BASE_URL}/get-available-channels`, // Use get-available-channels to avoid route conflicts
    channelGroups: `${config.FILE_BASE_URL}/channel-groups`,
    channelValues: `${config.FILE_BASE_URL}/channel-values`,
    dates: `${config.FILE_BASE_URL}/dates`,
    sources: `${config.FILE_BASE_URL}/sources`,
    classes: `${config.FILE_BASE_URL}/classes`,
    influxdbAvailable: `${config.FILE_BASE_URL}/influxdb/available`,
  },
  
  // Media endpoints
  media: {
    video: '/api/media/video',
    sources: `${config.API_BASE_URL}/media/sources`,
    files: `${config.API_BASE_URL}/media`,
    removeByDate: `${config.ADMIN_BASE_URL}/media/by-date`,
  },
  
  // Stream endpoints (realtime data)
  stream: {
    config: `${config.STREAM_BASE_URL}/config`,
    status: `${config.STREAM_BASE_URL}/status`,
    sources: `${config.STREAM_BASE_URL}/sources`,
    sourceStatus: (sourceName) => `${config.STREAM_BASE_URL}/sources/${encodeURIComponent(sourceName)}/status`,
    sourceData: (sourceName) => `${config.STREAM_BASE_URL}/sources/${encodeURIComponent(sourceName)}/data`,
    sourceChannels: (sourceName) => `${config.STREAM_BASE_URL}/sources/${encodeURIComponent(sourceName)}/channels`,
    websocket: `${config.STREAM_BASE_URL}/ws`,
    redisStatus: `${config.STREAM_BASE_URL}/redis/status`,
    redisFlush: `${config.STREAM_BASE_URL}/redis/flush`,
    monitoringStatus: `${config.STREAM_BASE_URL}/monitoring/status`,
    influxdbEnable: `${config.STREAM_BASE_URL}/influxdb/enable`,
    start: `${config.STREAM_BASE_URL}/start`,
    stop: `${config.STREAM_BASE_URL}/stop`,
  },
};

// Validation function to check required environment variables
export function validateEnvironment() {
  // No longer require VITE_API_HOST since we always use relative URLs
  
  // Warn about optional but recommended variables
  if (!import.meta.env.VITE_MAPBOX_TOKEN || import.meta.env.VITE_MAPBOX_TOKEN.trim() === '') {
    warn('VITE_MAPBOX_TOKEN not set - Mapbox features will be disabled');
  }
  
  return true;
}

// Initialize validation in development
if (config.IS_DEV) {
  validateEnvironment();
}

export default config;
