import { createSignal, createEffect, onCleanup, Show } from 'solid-js';

export interface LoadingOverlayProps {
  message?: string;
  className?: string;
  fullScreen?: boolean;
  progress?: number | null; // 0-100 or null for indeterminate
  showProgress?: boolean;
  progressMessage?: string;
  type?: "spinner" | "dots" | "pulse" | "skeleton";
  containerStyle?: string;
}

export default function LoadingOverlay(props: LoadingOverlayProps) {
  const message = () => props.message ?? "Loading...";
  const className = () => props.className ?? "";
  const fullScreen = () => props.fullScreen ?? false;
  const progress = () => props.progress;
  const showProgress = () => props.showProgress ?? false;
  const progressMessage = () => props.progressMessage ?? "";
  const type = () => props.type ?? "spinner";
  const containerStyle = () => props.containerStyle ?? "";
  
  // Use a computed signal that tracks the progress prop
  const currentProgress = () => {
    const progressValue = progress();
    return progressValue !== null && progressValue !== undefined ? progressValue : 0;
  };
  
  const isIndeterminate = () => {
    const progressValue = progress();
    return progressValue === null || progressValue === undefined;
  };
  
  const [autoProgressInterval, setAutoProgressInterval] = createSignal<ReturnType<typeof setInterval> | null>(null);
  
  // Handle auto-progress when progress is not provided
  createEffect(() => {
    const progressValue = progress();
    const showProgressValue = showProgress();
    
    // Clear any existing auto-progress interval
    const existingInterval = autoProgressInterval();
    if (existingInterval) {
      clearInterval(existingInterval);
      setAutoProgressInterval(null);
    }
    
    // Only start auto-progress if progress is null/undefined and showProgress is true
    if ((progressValue === null || progressValue === undefined) && showProgressValue) {
      // This case is handled by the indeterminate display, so we don't need auto-increment
      // The indeterminate display will show instead
    }
  });

  const containerClass = () => fullScreen() 
    ? `fixed inset-0 flex items-center justify-center z-10 ${className()}`
    : `absolute inset-0 flex items-center justify-center z-10 ${className()}`;

  const renderSpinner = () => (
    <div class="w-12 h-12 border-4 border-t-transparent rounded-full animate-spin mx-auto" style="border-color: var(--color-bg-button);"></div>
  );

  const renderDots = () => (
    <div class="flex space-x-2">
      <div class="w-3 h-3 rounded-full animate-bounce" style="background: var(--color-bg-button);"></div>
      <div class="w-3 h-3 rounded-full animate-bounce" style="animation-delay: 0.1s; background: var(--color-bg-button);"></div>
      <div class="w-3 h-3 rounded-full animate-bounce" style="animation-delay: 0.2s; background: var(--color-bg-button);"></div>
    </div>
  );

  const renderPulse = () => (
    <div class="w-12 h-12 rounded-full animate-pulse mx-auto" style="background: var(--color-bg-button);"></div>
  );

  const renderSkeleton = () => (
    <div class="space-y-3 w-64">
      <div class="h-4 rounded animate-pulse" style="background: var(--color-bg-tertiary);"></div>
      <div class="h-4 rounded animate-pulse w-3/4" style="background: var(--color-bg-tertiary);"></div>
      <div class="h-4 rounded animate-pulse w-1/2" style="background: var(--color-bg-tertiary);"></div>
    </div>
  );

  const renderLoader = () => {
    switch (type) {
      case 'dots': return renderDots();
      case 'pulse': return renderPulse();
      case 'skeleton': return renderSkeleton();
      default: return renderSpinner();
    }
  };

  return (
    <div class={containerClass()} style={`background: var(--color-bg-primary); ${containerStyle()}`}>
      <div class="text-center rounded-lg shadow-lg p-8 max-w-md mx-4" style="background: var(--color-bg-card);">
        {/* Only show spinner/loader when progress is not being shown */}
        <Show when={!showProgress() || isIndeterminate()}>
          {renderLoader()}
        </Show>
        
        <p class="mt-4 text-lg font-medium" style="color: var(--color-text-primary);">{message()}</p>
        
        <Show when={showProgress() && !isIndeterminate()}>
          <div class="mt-4">
            <div class="w-full rounded-full h-2.5" style="background: var(--color-bg-tertiary);">
              <div 
                class="h-2.5 rounded-full transition-all duration-300 ease-out"
                style={`width: ${Math.max(0, Math.min(100, currentProgress()))}%; background: var(--color-bg-button);`}
              ></div>
            </div>
            <div class="flex justify-between mt-2 text-sm" style="color: var(--color-text-secondary);">
              <span>{progressMessage() || `${Math.round(currentProgress())}% complete`}</span>
              <span>{Math.round(currentProgress())}%</span>
            </div>
          </div>
        </Show>
        
        <Show when={showProgress() && isIndeterminate()}>
          <div class="mt-4">
            <div class="w-full rounded-full h-2.5" style="background: var(--color-bg-tertiary);">
              <div class="h-2.5 rounded-full animate-pulse" style="width: 60%; background: var(--color-bg-button);"></div>
            </div>
            <p class="mt-2 text-sm" style="color: var(--color-text-secondary);">Processing...</p>
          </div>
        </Show>
      </div>
    </div>
  );
}

