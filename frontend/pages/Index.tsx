import { Show, onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { isLoggedIn, user } from "../store/userStore";
import Footer from "../components/app/Footer";
import AlinghiHeroBackdrop from "../components/branding/AlinghiHeroBackdrop";
import { debug } from "../utils/console";
import { setNoRobotsMetaTags } from "../utils/metaTags";

export default function Index() {
    const navigate = useNavigate();
    let viewportCleanup: (() => void) | null = null;
    
    // Check if cookies are accepted
    const areCookiesAccepted = () => {
      const cookiesAccepted = localStorage.getItem("cookiesAccepted");
      return cookiesAccepted === "true";
    };
    
    // Handle navigation to login/register with cookie check
    const handleAuthNavigation = (path: string, e: MouseEvent) => {
      e.preventDefault();
      if (areCookiesAccepted()) {
        navigate(path);
      } else {
        navigate(`/cookie-policy?redirect=${path}`);
      }
    };
    
    const cleanupIndexStyles = () => {
      document.body.classList.remove('index-page');
      document.documentElement.classList.remove('index-page');
      // Reset all overflow and height styles to defaults
      document.documentElement.style.overflowX = '';
      document.documentElement.style.overflowY = '';
      (document.documentElement.style as any).webkitOverflowScrolling = '';
      document.body.style.overflowX = '';
      document.body.style.overflowY = '';
      document.body.style.height = '';
      document.body.style.minHeight = '';
      (document.body.style as any).webkitOverflowScrolling = '';
      document.documentElement.style.removeProperty('--vh');
      
      // Reset root element styles
      const rootElement = document.getElementById('root');
      if (rootElement) {
        rootElement.style.overflowY = '';
        rootElement.style.overflowX = '';
        rootElement.style.height = '';
        rootElement.style.minHeight = '';
      }
    };

    onMount(() => {
      // Debug: Log that Index page is mounting
      debug('[Index] Index page mounted - path:', window.location.pathname);
      
      // Set robots meta tags to prevent crawling
      setNoRobotsMetaTags();
      
      // Add class to body and html to identify index page
      document.body.classList.add('index-page');
      document.documentElement.classList.add('index-page');
      
      // Enable scrolling on html and body for index page with mobile optimizations
      // Explicitly enable vertical scrolling for all screen sizes
      document.documentElement.style.overflowX = 'hidden';
      document.documentElement.style.overflowY = 'auto';
      (document.documentElement.style as any).webkitOverflowScrolling = 'touch';
      document.body.style.overflowX = 'hidden';
      document.body.style.overflowY = 'auto';
      document.body.style.height = 'auto';
      document.body.style.minHeight = '100vh';
      (document.body.style as any).webkitOverflowScrolling = 'touch';
      
      // Ensure root element also allows scrolling
      const rootElement = document.getElementById('root');
      if (rootElement) {
        rootElement.style.overflowY = 'auto';
        rootElement.style.overflowX = 'hidden';
        rootElement.style.height = 'auto';
        rootElement.style.minHeight = '100vh';
      }
      
      // Fix iOS viewport height issues
      const setViewportHeight = () => {
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty('--vh', `${vh}px`);
      };
      setViewportHeight();
      window.addEventListener('resize', setViewportHeight);
      window.addEventListener('orientationchange', setViewportHeight);
      
      // Store cleanup function
      viewportCleanup = () => {
        window.removeEventListener('resize', setViewportHeight);
        window.removeEventListener('orientationchange', setViewportHeight);
      };
    });

    onCleanup(() => {
      cleanupIndexStyles();
      // Cleanup viewport height event listeners
      if (viewportCleanup) {
        viewportCleanup();
        viewportCleanup = null;
      }
      // Note: Meta tags cleanup is handled automatically by the utility
      // when navigating away, but we could also explicitly remove them here if needed
    });

    return (
      <div class="index-page-scroll-container w-full max-w-full">
        {/* Main content area */}
        <main>
        {/* Hero Section - Different content based on login status - Full viewport height */}
        <section class="relative overflow-hidden w-full h-screen min-h-[100vh] min-h-[calc(var(--vh,1vh)*100)] bg-gradient-to-br from-[#1a1a1a] via-[#1f1f1f] to-[#2a2a2a]">
          <AlinghiHeroBackdrop />
          {/* Dark gradient overlay with subtle patterns */}
          <div class="absolute inset-0 bg-gradient-to-r from-[#1f1f1f]/20 via-[#2a2a2a]/30 to-[#404040]/20"></div>
          <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-[#2a2a2a]/10 via-transparent to-transparent"></div>
          <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,_var(--tw-gradient-stops))] from-[#404040]/10 via-transparent to-transparent"></div>
          
          <div class="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-full flex items-center">
            <div class="text-center w-full">
              <Show when={!isLoggedIn()}>

                <h1 class="text-5xl md:text-7xl font-bold text-white mb-6 leading-tight">
                  Welcome to <span class="bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">RACESIGHT</span>
                </h1>
                <p class="text-xl md:text-2xl text-gray-200 mb-8 max-w-3xl mx-auto leading-relaxed">
                  Racing Insights You Can Act On
                </p>
                <p class="text-base md:text-lg text-gray-300 mb-12 whitespace-normal md:whitespace-nowrap mx-auto leading-relaxed">
                  Expert analysis and interactive reports that help teams make clear, confident decisions.
                </p>
                
                <div class="flex flex-col sm:flex-row gap-4 justify-center">
                  {/* <a href="/register" onClick={(e) => handleAuthNavigation("/register", e)} class="group bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold py-4 px-8 rounded-xl text-lg transition-all duration-300 shadow-2xl hover:shadow-blue-500/25 hover:scale-105 transform">
                    <span class="flex items-center justify-center gap-2">
                      Sign Up Free
                      <svg class="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"></path>
                      </svg>
                    </span>
                  </a> */}
                  <a href="/login" onClick={(e) => handleAuthNavigation("/login", e)} class="bg-white/10 hover:bg-white/20 backdrop-blur-sm text-white font-semibold py-4 px-8 rounded-xl text-lg border border-white/30 transition-all duration-300 hover:scale-105 transform">
                    Sign In
                  </a>
                </div>
              </Show>
              
              <Show when={isLoggedIn()}>
                {/* Welcome back message for logged-in users - Full height section */}
                <div class="welcome-back-section">
                  <div class="text-center">
                      <h1 class="text-5xl md:text-7xl font-bold text-white mb-6 leading-tight">
                        Welcome back, {(() => {
                          const userData = user();
                          if (!userData) return 'User';
                          
                          // Try different name fields in order of preference
                          // Note: JWT token uses snake_case field names
                          const displayName = (userData as any).first_name || 
                                           (userData as any).last_name || 
                                           (userData as any).user_name || 
                                           (userData as any).email?.split('@')[0] || 
                                           'User';
                          return displayName;
                        })()}!
                      </h1>
                    <p class="text-xl md:text-2xl text-gray-200 mb-8 max-w-3xl mx-auto leading-relaxed">
                      Ready to dive into your data?
                    </p>
                    <p class="text-lg text-gray-300 mb-12 max-w-2xl mx-auto leading-relaxed">
                      Access your projects, create new visualizations, and collaborate with your team.
                    </p>
                    
                    <div class="flex flex-col sm:flex-row gap-4 justify-center">
                      <a href="/dashboard" class="group bg-gradient-to-r from-green-600 to-blue-600 hover:from-green-700 hover:to-blue-700 text-white font-semibold py-4 px-8 rounded-xl text-lg transition-all duration-300 shadow-2xl hover:shadow-green-500/25 hover:scale-105 transform">
                        <span class="flex items-center justify-center gap-2">
                          View Projects
                          <svg class="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6"></path>
                          </svg>
                        </span>
                      </a>
                    </div>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </section>

        {/* Features Section - Only show for non-logged-in users */}
        <Show when={!isLoggedIn()}>
          <section class="py-20 bg-gradient-to-b from-slate-50 to-white relative overflow-hidden">
            {/* Subtle background patterns */}
            <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-blue-50/30 via-transparent to-transparent"></div>
            <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,_var(--tw-gradient-stops))] from-indigo-50/30 via-transparent to-transparent"></div>
            
            <div class="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div class="text-center mb-16">
                <h2 class="text-4xl md:text-5xl font-bold text-gray-900 mb-4">Powerful Features</h2>
                <p class="text-xl text-gray-600 max-w-2xl mx-auto">
                  Everything you need to analyze, visualize, and share your data effectively
                </p>
              </div>
            
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {/* Feature 1 */}
                <div class="group bg-white p-8 rounded-xl border border-gray-200 hover:border-pink-300 hover:shadow-lg transition-all duration-300" style="touch-action: pan-y; pointer-events: auto;">
                  <div class="w-12 h-12 bg-pink-100 rounded-lg flex items-center justify-center mb-6 group-hover:bg-pink-200 transition-colors duration-300">
                    <svg class="w-6 h-6 text-pink-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path>
                    </svg>
                  </div>
                  <h3 class="text-xl font-semibold text-gray-900 mb-3">Performance & Maneuvers Analysis</h3>
                  <p class="text-gray-600 leading-relaxed">
                    Automated maneuver detection, performance metrics, fleet comparisons, and historical analysis with detailed reporting and visualization tools.
                  </p>
                </div>

                {/* Feature 2 */}
                <div class="group bg-white p-8 rounded-xl border border-gray-200 hover:border-indigo-300 hover:shadow-lg transition-all duration-300" style="touch-action: pan-y; pointer-events: auto;">
                  <div class="w-12 h-12 bg-indigo-100 rounded-lg flex items-center justify-center mb-6 group-hover:bg-indigo-200 transition-colors duration-300">
                    <svg class="w-6 h-6 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                    </svg>
                  </div>
                  <h3 class="text-xl font-semibold text-gray-900 mb-3">Historical Trend Analysis</h3>
                  <p class="text-gray-600 leading-relaxed">
                    Analyze complete historical datasets to identify long-term trends, patterns, and performance improvements over time across multiple sessions and events.
                  </p>
                </div>

                {/* Feature 3 */}
                <div class="group bg-white p-8 rounded-xl border border-gray-200 hover:border-blue-300 hover:shadow-lg transition-all duration-300" style="touch-action: pan-y; pointer-events: auto;">
                  <div class="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center mb-6 group-hover:bg-blue-200 transition-colors duration-300">
                    <svg class="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                    </svg>
                  </div>
                  <h3 class="text-xl font-semibold text-gray-900 mb-3">Real-Time Data Streaming</h3>
                  <p class="text-gray-600 leading-relaxed">
                    Live data ingestion from multiple WebSocket and InfluxDB sources with real-time processing, computed channels, and instant visualization updates.
                  </p>
                </div>

                {/* Feature 4 */}
                <div class="group bg-white p-8 rounded-xl border border-gray-200 hover:border-green-300 hover:shadow-lg transition-all duration-300" style="touch-action: pan-y; pointer-events: auto;">
                  <div class="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center mb-6 group-hover:bg-green-200 transition-colors duration-300">
                    <svg class="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                    </svg>
                  </div>
                  <h3 class="text-xl font-semibold text-gray-900 mb-3">Advanced Chart Builders</h3>
                  <p class="text-gray-600 leading-relaxed">
                    Powerful visualization tools including Polar Rose, Time Series, Scatter, Probability, Performance, Overlay, Parallel, Grid, and Table builders with D3.js rendering.
                  </p>
                </div>

                {/* Feature 5 */}
                <div class="group bg-white p-8 rounded-xl border border-gray-200 hover:border-purple-300 hover:shadow-lg transition-all duration-300" style="touch-action: pan-y; pointer-events: auto;">
                  <div class="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center mb-6 group-hover:bg-purple-200 transition-colors duration-300">
                    <svg class="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>
                    </svg>
                  </div>
                  <h3 class="text-xl font-semibold text-gray-900 mb-3">Advanced Data Processing</h3>
                  <p class="text-gray-600 leading-relaxed">
                    Intelligent data compression and optimization algorithms improve performance and clarify insights by reducing storage overhead while maintaining data integrity.
                  </p>
                </div>

                {/* Feature 6 */}
                <div class="group bg-white p-8 rounded-xl border border-gray-200 hover:border-emerald-300 hover:shadow-lg transition-all duration-300" style="touch-action: pan-y; pointer-events: auto;">
                  <div class="w-12 h-12 bg-emerald-100 rounded-lg flex items-center justify-center mb-6 group-hover:bg-emerald-200 transition-colors duration-300">
                    <svg class="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                    </svg>
                  </div>
                  <h3 class="text-xl font-semibold text-gray-900 mb-3">Video Synchronization</h3>
                  <p class="text-gray-600 leading-relaxed">
                    Synchronize video playback with time-series data for precise analysis. Frame-accurate alignment with variable playback speeds and timeline controls.
                  </p>
                </div>

                {/* Feature 7 */}
                <div class="group bg-white p-8 rounded-xl border border-gray-200 hover:border-orange-300 hover:shadow-lg transition-all duration-300" style="touch-action: pan-y; pointer-events: auto;">
                  <div class="w-12 h-12 bg-orange-100 rounded-lg flex items-center justify-center mb-6 group-hover:bg-orange-200 transition-colors duration-300">
                    <svg class="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path>
                    </svg>
                  </div>
                  <h3 class="text-xl font-semibold text-gray-900 mb-3">Multi-Window Synchronization</h3>
                  <p class="text-gray-600 leading-relaxed">
                    Cross-tab synchronization keeps selection, playback, and filter state consistent across multiple browser windows for seamless team collaboration.
                  </p>
                </div>

                {/* Feature 8 */}
                <div class="group bg-white p-8 rounded-xl border border-gray-200 hover:border-teal-300 hover:shadow-lg transition-all duration-300" style="touch-action: pan-y; pointer-events: auto;">
                  <div class="w-12 h-12 bg-teal-100 rounded-lg flex items-center justify-center mb-6 group-hover:bg-teal-200 transition-colors duration-300">
                    <svg class="w-6 h-6 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"></path>
                    </svg>
                  </div>
                  <h3 class="text-xl font-semibold text-gray-900 mb-3">Geospatial Mapping</h3>
                  <p class="text-gray-600 leading-relaxed">
                    Interactive maps with Mapbox GL and custom D3.js overlays for track visualization, fleet analysis, and location-based data exploration.
                  </p>
                </div>

                {/* Feature 9 */}
                <div class="group bg-white p-8 rounded-xl border border-gray-200 hover:border-cyan-300 hover:shadow-lg transition-all duration-300" style="touch-action: pan-y; pointer-events: auto;">
                  <div class="w-12 h-12 bg-cyan-100 rounded-lg flex items-center justify-center mb-6 group-hover:bg-cyan-200 transition-colors duration-300">
                    <svg class="w-6 h-6 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path>
                    </svg>
                  </div>
                  <h3 class="text-xl font-semibold text-gray-900 mb-3">Enterprise Security</h3>
                  <p class="text-gray-600 leading-relaxed">
                    JWT authentication, role-based permissions, subscription management, and secure data encryption to protect your valuable racing data.
                  </p>
                </div>
              </div>
          </div>
        </section>
        </Show>

        {/* Technology Stack Section - Only show for non-logged-in users */}
        <Show when={!isLoggedIn()}>
          <section class="py-12 md:py-16 bg-gray-50 relative overflow-hidden">
            {/* Subtle background patterns */}
            <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,_var(--tw-gradient-stops))] from-blue-50/40 via-transparent to-transparent"></div>
            <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_right,_var(--tw-gradient-stops))] from-indigo-50/40 via-transparent to-transparent"></div>
            
            <div class="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <div class="text-center mb-8 md:mb-10">
                <h2 class="text-4xl md:text-5xl font-bold text-gray-900 mb-4">Built with Modern Technology</h2>
                <p class="text-lg md:text-xl text-gray-600 whitespace-normal md:whitespace-nowrap mx-auto">
                  Leveraging cutting-edge technologies for the best performance and user experience
                </p>
              </div>
            
              <div class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-7 lg:grid-cols-10 gap-2 sm:gap-3 md:gap-4 items-center">
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-blue-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-blue-600">S</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-blue-600 transition-colors">SolidJS</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-green-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-green-600">D3</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-green-600 transition-colors">D3.js</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-purple-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-purple-600">V</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-purple-600 transition-colors">Vite</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-cyan-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-cyan-600">TS</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-cyan-600 transition-colors">TypeScript</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-indigo-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-indigo-600">TW</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-indigo-600 transition-colors">Tailwind</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-teal-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-teal-600">MB</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-teal-600 transition-colors">Mapbox</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-emerald-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-emerald-600">WW</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-emerald-600 transition-colors">Web Workers</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-orange-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-orange-600">PG</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-orange-600 transition-colors">PostgreSQL</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-red-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-red-600">R</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-red-600 transition-colors">Redis</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-pink-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-pink-600">I</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-pink-600 transition-colors">InfluxDB</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-yellow-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-yellow-600">DD</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-yellow-600 transition-colors">DuckDB</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-amber-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-amber-600">A</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-amber-600 transition-colors">Apache Arrow</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-lime-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-lime-600">P</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-lime-600 transition-colors">Parquet</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-green-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-green-600">E</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-green-600 transition-colors">Express</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-sky-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-sky-600">FA</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-sky-600 transition-colors">FastAPI</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-violet-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-violet-600">WS</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-violet-600 transition-colors">WebSockets</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-purple-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-purple-600">JWT</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-purple-600 transition-colors">JWT Auth</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-cyan-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-cyan-600">PY</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-cyan-600 transition-colors">Python</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-rose-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-rose-600">NJS</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-rose-600 transition-colors">Node.js</p>
                </div>
                <div class="group text-center">
                  <div class="w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14 bg-white rounded-lg shadow-sm border border-gray-200 flex items-center justify-center mx-auto mb-1.5 md:mb-2 group-hover:shadow-md group-hover:border-orange-300 transition-all duration-300">
                    <span class="text-base sm:text-lg md:text-xl font-bold text-orange-600">FF</span>
                  </div>
                  <p class="text-xs md:text-sm font-medium text-gray-700 group-hover:text-orange-600 transition-colors">FFmpeg</p>
                </div>
              </div>
          </div>
        </section>
        </Show>

        </main>

        <Footer />
      </div>
      );
  }

