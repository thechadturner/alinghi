import { createSignal, Show, onMount, onCleanup, JSX } from 'solid-js';
import { error as logError } from '../../utils/console';
import { logError as structuredLogError } from '../../utils/logging';

export interface ErrorBoundaryProps {
  name?: string;
  children: JSX.Element;
  showDetails?: boolean;
  clearDataCache?: () => Promise<void>;
}

type ErrorType = 'unknown' | 'chunk_load' | 'network' | 'data' | 'rendering' | 'memory';

export function ErrorBoundary(props: ErrorBoundaryProps) {
  const [error, setError] = createSignal<Error | null>(null);
  const [errorInfo, setErrorInfo] = createSignal<any>(null);
  const [errorType, setErrorType] = createSignal<ErrorType>('unknown');
  const [retryCount, setRetryCount] = createSignal(0);
  const [isRetrying, setIsRetrying] = createSignal(false);

  const MAX_RETRIES = 3;

  const handleError = (err: Error, info: any) => {
    // Categorize error types for better recovery
    let type: ErrorType = 'unknown';
    if (err.name === 'ChunkLoadError') type = 'chunk_load';
    else if (err.message.includes('Network') || err.message.includes('fetch')) type = 'network';
    else if (err.message.includes('Data') || err.message.includes('API')) type = 'data';
    else if (err.message.includes('Rendering') || err.message.includes('D3')) type = 'rendering';
    else if (err.message.includes('Memory') || err.message.includes('heap')) type = 'memory';

    setError(err);
    setErrorInfo(info);
    setErrorType(type);
    
    // Log the error to console and structured logging
    logError('ErrorBoundary error:', err, {
      component: props.name || 'Unknown',
      errorType: type,
      retryCount: retryCount(),
      errorInfo: info?.componentStack || info,
      type: 'component_error'
    });
    
    // Also log to structured logging system
    structuredLogError('ErrorBoundary', err, {
      component: props.name || 'Unknown',
      errorType: type,
      retryCount: retryCount(),
      errorInfo: info?.componentStack || info,
      type: 'component_error'
    }).catch(() => {
      // Silently fail if structured logging fails
    });
  };

  onMount(() => {
    // Global error handler
    const globalErrorHandler = (event: ErrorEvent) => {
      const error = event.error || new Error('Unknown error');
      // Silently ignore AbortErrors - they're expected when requests are cancelled
      if ((error as Error)?.name === 'AbortError' || 
          (error as any)?.type === 'AbortError' ||
          (error as Error)?.message?.toLowerCase().includes('request aborted') ||
          (error as Error)?.message?.toLowerCase().includes('aborted')) {
        return; // Don't handle AbortErrors - they're expected
      }
      handleError(error, { componentStack: event.error?.stack });
    };

    // Unhandled promise rejection handler
    const unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      // Silently ignore AbortErrors - they're expected when requests are cancelled
      if ((reason as Error)?.name === 'AbortError' || 
          (reason as any)?.type === 'AbortError' ||
          (reason as Error)?.message?.toLowerCase().includes('request aborted') ||
          (reason as Error)?.message?.toLowerCase().includes('aborted')) {
        return; // Don't handle AbortErrors - they're expected
      }
      handleError(new Error(reason), { 
        type: 'unhandledrejection',
        reason: reason 
      });
    };

    window.addEventListener('error', globalErrorHandler);
    window.addEventListener('unhandledrejection', unhandledRejectionHandler);

    onCleanup(() => {
      window.removeEventListener('error', globalErrorHandler);
      window.removeEventListener('unhandledrejection', unhandledRejectionHandler);
    });
  });

  const retry = async () => {
    if (retryCount() >= MAX_RETRIES) return;
    
    setIsRetrying(true);
    setRetryCount(prev => prev + 1);
    
    try {
      // Different recovery strategies based on error type
      switch (errorType()) {
        case 'network':
          // Wait longer for network errors
          await new Promise(resolve => setTimeout(resolve, 2000 * retryCount()));
          break;
        case 'chunk_load':
          // Force reload for chunk load errors
          window.location.reload();
          return;
        case 'data':
          // Clear data cache and retry
          if (props.clearDataCache) {
            await props.clearDataCache();
          }
          break;
        case 'memory':
          // Force garbage collection and retry
          if ((window as any)['gc']) {
            (window as any)['gc']();
          }
          break;
        default:
          // Short delay for other errors
          await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      setError(null);
      setErrorType('unknown');
    } catch (retryError) {
      logError('ErrorBoundary retry failed:', retryError, {
        component: props.name,
        type: 'retry_failed',
        retryCount: retryCount()
      });
    } finally {
      setIsRetrying(false);
    }
  };

  const resetError = () => {
    setError(null);
    setErrorInfo(null);
    setErrorType('unknown');
    setRetryCount(0);
    setIsRetrying(false);
  };

  const getErrorMessage = () => {
    switch (errorType()) {
      case 'network':
        return 'Network connection lost. Please check your internet connection.';
      case 'chunk_load':
        return 'Application update detected. Reloading...';
      case 'data':
        return 'Data loading failed. This might be a temporary issue.';
      case 'rendering':
        return 'Display error occurred. Trying to recover...';
      case 'memory':
        return 'Memory issue detected. Attempting to free up resources...';
      default:
        return 'An unexpected error occurred.';
    }
  };

  const getRecoveryAction = () => {
    switch (errorType()) {
      case 'network':
        return 'Retry Connection';
      case 'chunk_load':
        return 'Reload Application';
      case 'data':
        return 'Reload Data';
      case 'rendering':
        return 'Reset Display';
      case 'memory':
        return 'Free Memory';
      default:
        return 'Try Again';
    }
  };

  return (
    <Show when={error()} fallback={props.children}>
      <div class="error-boundary" style="padding: 2rem; text-align: center; background: #fef2f2; border: 1px solid #fecaca; border-radius: 0.5rem; margin: 1rem;">
        <div style="color: #dc2626; font-size: 1.5rem; font-weight: bold; margin-bottom: 1rem;">
          ⚠️ {getErrorMessage()}
        </div>
        
        <Show when={retryCount() < MAX_RETRIES}>
          <div style="margin-bottom: 1rem;">
            <button 
              onclick={retry}
              disabled={isRetrying()}
              style={`background: #dc2626; color: white; border: none; padding: 0.5rem 1rem; border-radius: 0.25rem; cursor: pointer; margin-right: 0.5rem; opacity: ${isRetrying() ? 0.6 : 1};`}
            >
              {isRetrying() ? 'Retrying...' : getRecoveryAction()}
            </button>
            <button 
              onclick={() => window.location.reload()}
              style="background: #6b7280; color: white; border: none; padding: 0.5rem 1rem; border-radius: 0.25rem; cursor: pointer;"
            >
              Reload Page
            </button>
          </div>
        </Show>

        <Show when={retryCount() >= MAX_RETRIES}>
          <div style="margin-bottom: 1rem;">
            <p style="color: #7f1d1d;">Maximum retry attempts reached. Please reload the page.</p>
            <button 
              onclick={() => window.location.reload()}
              style="background: #dc2626; color: white; border: none; padding: 0.5rem 1rem; border-radius: 0.25rem; cursor: pointer;"
            >
              Reload Page
            </button>
          </div>
        </Show>

        <Show when={props.showDetails && error()}>
          <details style="text-align: left; background: white; padding: 1rem; border-radius: 0.25rem; margin-top: 1rem;">
            <summary style="cursor: pointer; font-weight: bold; margin-bottom: 0.5rem;">
              Error Details (for developers)
            </summary>
            <pre style="font-size: 0.875rem; color: #374151; white-space: pre-wrap; word-break: break-word;">
              {error()?.message}
              {error()?.stack && `\n\nStack Trace:\n${error()?.stack}`}
            </pre>
          </details>
        </Show>
      </div>
    </Show>
  );
}

