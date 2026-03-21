import { onMount, onCleanup } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { setIsAccepted, setCookiePolicy } from "../store/userStore";
import { logPageLoad } from "../utils/logging";
import { setNoRobotsMetaTags } from "../utils/metaTags";

export default function CookiePolicyPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  
  // Get the redirect URL from query params (where user was trying to go)
  const redirectTo = () => searchParams.redirect || "/";

  onMount(() => {
    logPageLoad('CookiePolicy.tsx', 'Cookie Policy Page');
    const cleanup = setNoRobotsMetaTags();
    onCleanup(() => cleanup());
  });

  const handleAccept = () => {
    // Set cookies accepted in localStorage
    localStorage.setItem("cookiesAccepted", "true");
    
    // Update user store
    setCookiePolicy(true);
    setIsAccepted(true);
    
    // Navigate to the redirect target
    const target = redirectTo();
    navigate(target, { replace: true });
  };

  const handleReject = () => {
    // Clear cookies and redirect to index
    localStorage.removeItem("cookiesAccepted");
    setCookiePolicy(false);
    setIsAccepted(false);
    
    navigate("/", { replace: true });
  };

  return (
    <div class="login-page-theme" style="overflow-y: auto; min-height: 100vh; height: auto;">
      <div class="login-container-theme cookie-policy-container" style="margin: 2rem auto;">
        <div class="login-header">
          <div class="logo-section">
            <div class="logo-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <h1 class="login-title">Cookie Policy</h1>
            <p class="login-subtitle">Please review and accept our cookie policy to continue</p>
          </div>
        </div>
        
        <div class="cookie-policy-content">
          <h2>How we use cookies</h2>
          <p>
            Hunico uses cookies to provide essential functionality for your account and preferences:
          </p>
          <ul>
            <li><strong>Session management:</strong> Keeps you logged in and maintains your authentication state</li>
            <li><strong>User preferences:</strong> Remembers your theme settings, project selections, and display preferences</li>
            <li><strong>Security tokens:</strong> Protects your account with tokens and session validation</li>
          </ul>
          
          <p>
            These cookies are required for the applicaiton to function properly. By accepting, you enable full access to project managment and data analysis features. If you reject cookies, it will not be possible to login and access data.
          </p>
        </div>
        
        <div class="cookie-policy-buttons">
          <button 
            onClick={handleAccept}
            class="login-button cookie-button-accept"
          >
            <span class="button-text">Accept Cookies</span>
          </button>
          <button 
            onClick={handleReject}
            class="login-button cookie-button-reject"
          >
            <span class="button-text">Reject</span>
          </button>
        </div>
      </div>
    </div>
  );
}

