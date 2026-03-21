/**
 * Device Detection Utility
 * 
 * Robust mobile device detection using multiple methods:
 * - User agent detection (mobile patterns)
 * - Touch support detection
 * - Screen size check
 */

/**
 * Check if the current device is a mobile device
 * Uses multiple detection methods for robustness
 */
export function isMobileDevice(): boolean {
  // Check if we're in a browser environment
  if (typeof window === 'undefined') {
    return false;
  }

  // Method 0: Desktop OS check - if we're on a desktop OS, we're NOT mobile
  // This takes precedence to prevent touch-enabled laptops from being detected as mobile
  const platform = navigator.platform || '';
  const userAgent = navigator.userAgent || navigator.vendor || (window as any).opera;
  
  // Desktop OS patterns for platform - if we match these, we're definitely NOT mobile
  const desktopPlatformPatterns = [
    /Win32/i,           // Windows 32-bit
    /Win64/i,           // Windows 64-bit
    /Windows NT/i,      // Windows NT/10/11
    /MacIntel/i,        // macOS on Intel (but check for iPad separately)
    /MacPPC/i,          // macOS on PowerPC
    /Mac68K/i,          // macOS on 68K
    /Linux/i,           // Linux (but exclude Android)
  ];
  
  // Desktop OS patterns for user agent (more reliable for Windows detection)
  const desktopUserAgentPatterns = [
    /Windows NT/i,      // Windows NT/10/11
    /Windows/i,         // Windows (general)
    /Win64/i,           // Windows 64-bit
    /Win32/i,           // Windows 32-bit
    /Mac OS X/i,        // macOS
    /Macintosh/i,       // macOS
    /Linux/i,           // Linux (but exclude Android)
  ];
  
  // Check if we're on a desktop OS by checking both platform and user agent
  // This is more robust for Windows detection
  const isDesktopPlatform = desktopPlatformPatterns.some(pattern => pattern.test(platform));
  const isDesktopUserAgent = desktopUserAgentPatterns.some(pattern => pattern.test(userAgent)) && 
                             !/Android/i.test(userAgent);
  const isDesktopOS = (isDesktopPlatform || isDesktopUserAgent) && !/Android/i.test(userAgent);
  
  // CRITICAL: Additional explicit checks for Windows - these should always be desktop
  // Windows detection can be tricky, so we check multiple ways
  const isWindows = /Win/i.test(platform) || 
                    /Windows/i.test(userAgent) || 
                    /Win32/i.test(platform) || 
                    /Win64/i.test(platform) ||
                    /Windows NT/i.test(userAgent);
  
  // CRITICAL: If we're on a desktop OS (especially Windows), we're NEVER mobile
  // Desktop users can resize windows, use touch screens, etc. - they're still desktop
  // The only exception would be if we're running in a mobile emulator, but that's not a real mobile device
  if (isDesktopOS || isWindows) {
    // Desktop OS detected - this is NOT a mobile device
    // Even if the window is small or touch is enabled, it's still a desktop
    return false;
  }

  // Method 1: User agent detection - only specific mobile device patterns
  // Note: We don't use generic /Mobile/i pattern as it can match desktop browsers
  const mobilePatterns = [
    /Android/i,           // Android devices
    /webOS/i,              // Palm webOS
    /iPhone/i,             // iPhone (but not iPad)
    /iPod/i,               // iPod touch
    /BlackBerry/i,         // BlackBerry devices
    /Windows Phone/i,      // Windows Phone
    // Note: iPad is handled separately - we check for iPad specifically
    // and don't use generic /Mobile/i as it's too broad
  ];
  
  // Check for iPad specifically (iPadOS can appear as desktop in some cases)
  // But only if we're NOT on a desktop OS (already checked above)
  // CRITICAL: Be very careful with iPad detection - don't match Macs with touch support
  // Only consider it an iPad if:
  // 1. User agent explicitly says iPad, OR
  // 2. Platform is MacIntel AND has touch points AND user agent doesn't explicitly say Mac
  const isIPad = /iPad/i.test(userAgent) || 
                 (navigator.platform === 'MacIntel' && 
                  navigator.maxTouchPoints > 1 && 
                  !/Macintosh|Mac OS X/i.test(userAgent) &&
                  !isDesktopOS); // Double-check we're not on a desktop OS
  
  const isMobileUserAgent = mobilePatterns.some(pattern => pattern.test(userAgent)) || isIPad;

  // Method 2: Touch support detection
  const hasTouchSupport = 'ontouchstart' in window || 
                         navigator.maxTouchPoints > 0 ||
                         (navigator as any).msMaxTouchPoints > 0;

  // Method 3: Screen size check
  // Use a conservative threshold - only very small screens are considered mobile
  const isVerySmallScreen = window.innerWidth <= 600; // Phone size threshold

  // Consider mobile if:
  // - User agent indicates specific mobile device (Android, iPhone, iPad, etc.)
  // - OR very small screen (phone-sized, ≤600px) AND touch support (both required)
  // Note: We require BOTH touch support AND very small screen to prevent desktop window resizing
  // from triggering mobile mode. A desktop user resizing their window should NOT trigger mobile mode.
  // We also don't use generic "Mobile" pattern as it can match desktop browsers.
  const isMobile = isMobileUserAgent || (isVerySmallScreen && hasTouchSupport);

  return isMobile;
}

/**
 * Check if device has touch support
 */
export function hasTouchSupport(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  
  return 'ontouchstart' in window || 
         navigator.maxTouchPoints > 0 ||
         (navigator as any).msMaxTouchPoints > 0;
}

/**
 * Get device type classification
 */
export function getDeviceType(): 'mobile' | 'tablet' | 'desktop' {
  if (!isMobileDevice()) {
    return 'desktop';
  }
  
  // Distinguish between mobile and tablet
  const userAgent = navigator.userAgent || '';
  const isTablet = /iPad/i.test(userAgent) || 
                   (hasTouchSupport() && window.innerWidth > 768 && window.innerWidth <= 1024);
  
  return isTablet ? 'tablet' : 'mobile';
}

/**
 * True when the OS is macOS (including OS X), for showing Cmd vs Ctrl in shortcuts.
 */
export function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform || '';
  const ua = navigator.userAgent || '';
  return /Mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua);
}

/**
 * True when we should use in-document bottom-center positioning for play/pause controls
 * (fixes controls not loading in Safari/macOS). When false, use Portal + fixed positioning (Windows).
 */
export function useSafariFriendlyPlayPausePosition(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = navigator.platform || '';
  const ua = navigator.userAgent || '';
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua);
  return platform.includes('Mac') || isSafari;
}

