import { error, debug, warn } from './console';
import { isLoggedIn } from '../store/userStore';

interface ErrorResponse {
  success: false;
  message: string;
  status: number;
  field?: string | null;
  type: string;
  body?: any; // Include body from server response for detailed error information
  data?: any; // Include data from server response
}

interface ApiResponse {
  success: boolean;
  error?: string;
  status?: number;
  field?: string | null;
  type?: string;
}

interface ErrorInfo {
  componentStack?: string;
  type?: string;
  [key: string]: any;
}

// Custom Error Classes
export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;
  public field?: string | null;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.field = null;
    this.name = this.constructor.name;

    // captureStackTrace is V8/Node-only; Safari and some browsers don't support it
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export class ValidationError extends AppError {
  constructor(message: string, field: string | null = null) {
    super(message, 400);
    this.field = field;
  }
}

export class AuthError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource') {
    super(`${resource} not found`, 404);
  }
}

export class NetworkError extends AppError {
  constructor(message: string = 'Network error') {
    super(message, 0);
  }
}

// Global error handler
export function handleError(errorObj: Error, file_name: string, additionalContext: Record<string, any> = {}): ErrorResponse {
  // Suppress AuthError console output when user is not authenticated
  // These errors are expected when user hasn't logged in yet
  // Still log to server (database) but don't show in console
  const shouldSuppressError = 
    errorObj instanceof AuthError &&
    typeof window !== 'undefined' &&
    !isLoggedIn();
  
  // Check if this is a connection-related error that should be logged as a warning
  const isConnectionError = 
    errorObj.message?.toLowerCase().includes('connection') ||
    errorObj.message?.toLowerCase().includes('remote') ||
    errorObj.message?.toLowerCase().includes('disconnected') ||
    (additionalContext.errorResponse?.data?.error_lines && 
     Array.isArray(additionalContext.errorResponse.data.error_lines) &&
     additionalContext.errorResponse.data.error_lines.some((line: string) => 
       line.toLowerCase().includes('connection') ||
       line.toLowerCase().includes('remotedisconnected') ||
       line.toLowerCase().includes('connection aborted')
     ));
  
  if (shouldSuppressError) {
    // User is not authenticated - log to server (database) but don't show in console
    debug(`[${file_name}] AuthError (user not authenticated):`, errorObj.message, additionalContext);
  } else if (isConnectionError && file_name === 'global.ts' && errorObj.message?.includes('Script execution failed')) {
    // Connection errors during script execution are often transient - log as warning
    warn(`[${file_name}] ${errorObj.message} (connection error - may be transient)`, additionalContext);
  } else {
    // User is authenticated or non-AuthError - show in console and log to database
    error(`[${file_name}]`, errorObj, additionalContext);
  }
  
  // Return user-friendly error response
  if (errorObj instanceof AppError) {
    const response: ErrorResponse = {
      success: false,
      message: errorObj.message,
      status: errorObj.statusCode,
      field: errorObj.field || null,
      type: errorObj.name
    };
    
    // Include request body (what was sent to server)
    if (additionalContext.body) {
      response.body = additionalContext.body;
    }
    
    // Include server's error response (what server returned - includes data with error_lines, output_lines, etc.)
    if (additionalContext.errorResponse) {
      response.data = additionalContext.errorResponse.data || null;
      // Also include the full error response for debugging
      if (additionalContext.errorResponse.data) {
        // The data field contains error_lines, output_lines, return_code, etc.
        response.data = additionalContext.errorResponse.data;
      }
    }
    
    return response;
  }
  
  // Unknown error - don't expose details
  return {
    success: false,
    message: 'An unexpected error occurred',
    status: 500,
    type: 'UnknownError'
  };
}

// API Response Handler
export function handleApiResponse(response: ApiResponse, url: string, file_name: string): ApiResponse {
  if (response.success === false) {
    // Already handled error response
    return response;
  }
  
  // Success response
  return response;
}

// Error Boundary Helper
export function createErrorHandler(componentName: string) {
  return (errorObj: Error, errorInfo: ErrorInfo): void => {
    error(`[${componentName}]`, errorObj, {
      componentStack: errorInfo?.componentStack,
      type: 'component_error'
    });
  };
}
