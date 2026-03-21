/**
 * Utility functions for managing meta tags, particularly robots directives
 * to prevent search engine crawling and indexing
 */

/**
 * Sets comprehensive robots meta tags to prevent crawling and indexing
 * This includes:
 * - noindex: Don't index the page
 * - nofollow: Don't follow links
 * - noarchive: Don't archive/cache the page
 * - nosnippet: Don't show snippets in search results
 * - noimageindex: Don't index images
 * - notranslate: Don't offer translation
 */
export function setNoRobotsMetaTags(): () => void {
  const head = document.head;
  
  // Remove existing robots meta tag if present
  const existingRobots = head.querySelector('meta[name="robots"]');
  if (existingRobots) {
    existingRobots.remove();
  }
  
  // Create and add comprehensive robots meta tag
  const robotsMeta = document.createElement('meta');
  robotsMeta.name = 'robots';
  robotsMeta.content = 'noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate';
  head.appendChild(robotsMeta);
  
  // Also add Google-specific robots tag for additional coverage
  const googleRobotsMeta = document.createElement('meta');
  googleRobotsMeta.name = 'googlebot';
  googleRobotsMeta.content = 'noindex, nofollow, noarchive, nosnippet, noimageindex';
  head.appendChild(googleRobotsMeta);
  
  // Add Bing-specific robots tag
  const bingRobotsMeta = document.createElement('meta');
  bingRobotsMeta.name = 'bingbot';
  bingRobotsMeta.content = 'noindex, nofollow, noarchive, nosnippet, noimageindex';
  head.appendChild(bingRobotsMeta);
  
  // Return cleanup function
  return () => {
    robotsMeta.remove();
    googleRobotsMeta.remove();
    bingRobotsMeta.remove();
  };
}

/**
 * Removes all robots meta tags
 */
export function removeNoRobotsMetaTags(): void {
  const head = document.head;
  const robotsTags = head.querySelectorAll('meta[name="robots"], meta[name="googlebot"], meta[name="bingbot"]');
  robotsTags.forEach(tag => tag.remove());
}
