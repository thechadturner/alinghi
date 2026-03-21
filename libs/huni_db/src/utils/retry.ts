/**
 * Retry Utilities
 * 
 * Provides retry logic for transient errors with exponential backoff.
 */

import { defaultLogger } from './logger.js';
import { HuniDBError as HuniDBErrorClass } from './errors.js';

/**
 * Check if an error is transient (should be retried)
 * 
 * @param error - Error to check
 * @returns true if error is transient, false otherwise
 */
export function isTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  const name = error.name.toLowerCase();

  // SQLite transient errors
  const transientPatterns = [
    'locked',
    'busy',
    'timeout',
    'temporary',
    'interrupted',
    'io error',
    'network',
    'connection',
    'eagain',
    'ewouldblock',
  ];

  // Check error message
  for (const pattern of transientPatterns) {
    if (message.includes(pattern)) {
      return true;
    }
  }

  // Check error name
  for (const pattern of transientPatterns) {
    if (name.includes(pattern)) {
      return true;
    }
  }

  // Check if it's a HuniDBError with transient code
  if (error instanceof HuniDBErrorClass) {
    const transientCodes = ['CONNECTION_ERROR', 'QUERY_ERROR'];
    return transientCodes.includes(error.code);
  }

  return false;
}

/**
 * Sleep for specified milliseconds
 * 
 * @param ms - Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry options
 */
export interface RetryOptions {
  /** Maximum number of retries */
  maxRetries?: number;
  /** Initial delay in milliseconds */
  initialDelay?: number;
  /** Maximum delay in milliseconds */
  maxDelay?: number;
  /** Exponential backoff multiplier */
  backoffMultiplier?: number;
  /** Custom retry condition */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Callback before retry */
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
}

/**
 * Default retry options
 */
const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelay: 100,
  maxDelay: 5000,
  backoffMultiplier: 2,
  shouldRetry: isTransientError,
  onRetry: () => {},
};

/**
 * Execute a function with retry logic
 * 
 * @param fn - Function to execute
 * @param options - Retry options
 * @returns Result of function execution
 * @throws Last error if all retries fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;
  let delay = opts.initialDelay;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on last attempt
      if (attempt === opts.maxRetries) {
        break;
      }

      // Check if we should retry
      const shouldRetry = opts.shouldRetry(error, attempt);
      if (!shouldRetry) {
        defaultLogger.debug('Error is not transient, not retrying', {
          error: error instanceof Error ? error.message : String(error),
          attempt: attempt + 1,
        });
        throw error;
      }

      // Calculate delay with exponential backoff
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelay);

      // Call retry callback
      opts.onRetry(error, attempt + 1, delay);

      defaultLogger.debug(`Retrying after ${delay}ms (attempt ${attempt + 1}/${opts.maxRetries})`, {
        error: error instanceof Error ? error.message : String(error),
      });

      // Wait before retry
      await sleep(delay);
    }
  }

  // All retries exhausted
  defaultLogger.warn('All retries exhausted', {
    maxRetries: opts.maxRetries,
    lastError: lastError instanceof Error ? lastError.message : String(lastError),
  });

  throw lastError;
}

