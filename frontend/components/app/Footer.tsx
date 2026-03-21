import { createSignal, onMount } from "solid-js";
import { useNavigate } from "@solidjs/router";

export default function Footer() {
  const navigate = useNavigate();
  const [screenWidth, setScreenWidth] = createSignal(window.innerWidth);
  
  const checkScreenSize = () => {
    setScreenWidth(window.innerWidth);
  };

  onMount(() => {
    checkScreenSize();
    window.addEventListener('resize', checkScreenSize);
    
    return () => {
      window.removeEventListener('resize', checkScreenSize);
    };
  });

  return (
    <footer class="text-white bg-gradient-to-br from-[#1a1a1a] via-[#1f1f1f] to-[#2a2a2a] relative overflow-hidden">
      {/* Dark gradient overlay with subtle patterns */}
      <div class="absolute inset-0 bg-gradient-to-r from-[#1f1f1f]/20 via-[#2a2a2a]/30 to-[#404040]/20"></div>
      <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-[#2a2a2a]/10 via-transparent to-transparent"></div>
      <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,_var(--tw-gradient-stops))] from-[#404040]/10 via-transparent to-transparent"></div>
      
      <div class="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Simplified footer for EU compliance - minimal required information */}
        <div class="flex flex-col md:flex-row justify-between items-center gap-4">
          <div class="text-gray-400 text-sm text-center md:text-left">
            <div class="mb-2">
              <strong class="text-white">RACESIGHT</strong> - Collaborative data analysis platform for modern teams.
            </div>
            <div>
              &copy; 2025 RACESIGHT. All rights reserved.
            </div>
          </div>
          
          {/* Legal links - Required for EU compliance */}
          <div class="flex flex-wrap justify-center gap-4 md:gap-6">
            <a 
              href="/privacy-policy" 
              onClick={(e) => { e.preventDefault(); navigate("/privacy-policy"); }}
              class="text-gray-400 hover:text-white text-sm transition-colors duration-200"
            >
              Privacy Policy
            </a>
            <a 
              href="/terms-of-service" 
              onClick={(e) => { e.preventDefault(); navigate("/terms-of-service"); }}
              class="text-gray-400 hover:text-white text-sm transition-colors duration-200"
            >
              Terms of Service
            </a>
            <a 
              href="/cookie-policy" 
              onClick={(e) => { e.preventDefault(); navigate("/cookie-policy"); }}
              class="text-gray-400 hover:text-white text-sm transition-colors duration-200"
            >
              Cookie Policy
            </a>
            <a 
              href="/contact" 
              onClick={(e) => { e.preventDefault(); navigate("/contact"); }}
              class="text-gray-400 hover:text-white text-sm transition-colors duration-200"
            >
              Contact
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

  
