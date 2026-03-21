// @ts-nocheck
import { createSignal, Show, onMount, onCleanup } from "solid-js";
import { useNavigate, A } from "@solidjs/router";

import { authManager } from "../utils/authManager";
import { isAccepted, setIsAccepted, isCookiePolicy, setCookiePolicy } from "../store/userStore"; 
import { logPageLoad } from "../utils/logging";
import { error as logError, log } from "../utils/console";
import { handleLogin as handleLoginHelper } from "../utils/loginHelper";
import { setNoRobotsMetaTags } from "../utils/metaTags";

export default function Login() {
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");

  const navigate = useNavigate();
  
  // Refs to capture autofilled values
  let emailInputRef: HTMLInputElement;
  let passwordInputRef: HTMLInputElement; 
  
  const cookies = localStorage.getItem("cookiesAccepted");
  if (cookies != undefined) {
    setCookiePolicy(true)
    setIsAccepted(Boolean(cookies));
  }

  // Register meta-tag cleanup in component scope so Solid can attach it to this component
  const cleanupMeta = setNoRobotsMetaTags();
  onCleanup(() => cleanupMeta());

  onMount(async () => {
    await logPageLoad('Login.tsx', 'Login Page');

    // Redirect to cookie policy if not accepted
    const cookiesAccepted = localStorage.getItem("cookiesAccepted");
    if (cookiesAccepted !== "true") {
      navigate('/cookie-policy?redirect=/login', { replace: true });
    }
  });
  
  const handleLogin = async (e: Event) => {
    if (e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    
    // Always read from DOM directly (password managers inject directly into DOM)
    const actualEmail = emailInputRef?.value || email();
    const actualPassword = passwordInputRef?.value || password();
    
    // Sync signals with actual DOM values
    if (actualEmail !== email()) {
      setEmail(actualEmail);
    }
    if (actualPassword !== password()) {
      setPassword(actualPassword);
    }

    try {
      if (isAccepted()) {
        log('JWT Login attempt:', { email: actualEmail });
        
        // Use JWT authentication with actual DOM values
        const response = await authManager.login(actualEmail, actualPassword, false);
        
        if (response.success) {
          const user_info = response.data.user;
          
          if (user_info != undefined) {
            // Use shared login helper function
            await handleLoginHelper(user_info, 'Login');
            
            // Small delay to ensure signals are propagated to all components
            await new Promise(resolve => setTimeout(resolve, 50));
    
            setSuccess(`Login successful!`);
            // Full-page redirect so browser fetches fresh index.html (and latest app assets)
            setTimeout(() => {
              window.location.href = '/dashboard';
            }, 500);
          }
        } else {
          setError(response.message || "Login failed.");
          
          if (response.message && response.message.includes('un-verified')) {
            navigate(`/verify`);
          }
        }
      } else {
        setError("Cookies policy rejected...unable to log in.");
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Request was cancelled
      } else {
        setError('Login error:' + err);
        logError('Error details:', {
          message: err.message,
          stack: err.stack,
          name: err.name
        });
        setError("An unexpected error occurred. Please try again.");
      }
    }
  };

  const handleCookiePolicyClick = () => {
    navigate('/cookie-policy?redirect=/login');
  };

  return (
    <div class="login-page-theme">
      <div class="login-container-theme">
        <div class="login-header">
          <div class="logo-section">
            <div class="logo-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <h1 class="login-title">Welcome Back</h1>
            <p class="login-subtitle">Sign in to your TeamShare account</p>
          </div>
        </div>
        
        <form 
          class="login-form" 
          onSubmit={handleLogin} 
          autocomplete="on"
          method="post"
          action="/login"
          id="login-form"
        >
          <div class="form-group">
            <label for="email" class="form-label">Email Address</label>
            <div class="input-container">
              <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6C2 4.9 2.9 4 4 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <polyline points="22,6 12,13 2,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <input
                ref={emailInputRef}
                id="email"
                type="email"
                name="email"
                autocomplete="username"
                placeholder="Enter your email"
                value={email()}
                onInput={(e) => setEmail(e.target.value)}
                onChange={(e) => setEmail(e.target.value)}
                required
                class="form-input"
              />
            </div>
          </div>
          
          <div class="form-group">
            <label for="password" class="form-label">Password</label>
            <div class="input-container">
              <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke="currentColor" stroke-width="2"/>
                <circle cx="12" cy="16" r="1" fill="currentColor"/>
                <path d="M7 11V7A5 5 0 0 1 17 7V11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <input
                ref={passwordInputRef}
                id="password"
                type="password"
                name="password"
                autocomplete="current-password"
                placeholder="Enter your password"
                onInput={(e) => {
                  const value = (e.target as HTMLInputElement).value;
                  setPassword(value);
                  if (error()) {
                    setError("");
                  }
                }}
                onChange={(e) => {
                  setPassword((e.target as HTMLInputElement).value);
                }}
                required
                class="form-input"
              />
            </div>
          </div>
          
          <Show when={!success()}>
            <div class="form-options">
              <A href="/forgot-password" class="forgot-link">Forgot Password?</A>
            </div>
          </Show>
          
          {error() && (
            <div class="message-container error-container">
              <svg class="message-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2"/>
                <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2"/>
              </svg>
              <span class="error-text">{error()}</span>
            </div>
          )}
          
          {success() && (
            <div class="message-container success-container">
              <svg class="message-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M22 11.08V12A10 10 0 1 1 5.93 5.93" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <polyline points="22,4 12,14.01 9,11.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <span class="success-text">{success()}</span>
            </div>
          )}
          
          <Show 
            when={isCookiePolicy()} 
            fallback={
              <button 
                type="button"
                onClick={handleCookiePolicyClick}
                class="login-button"
              >
                <span class="button-text">Review Cookie Policy</span>
                <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M12 5L19 12L12 19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            }
          >
            <button 
              type="submit" 
              class="login-button"
            >
              <span class="button-text">Sign In</span>
              <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M12 5L19 12L12 19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </Show>
        </form>
        
        <div class="login-footer">
          <p class="footer-text">
            Don't have an account? 
            <A href="/register" class="register-link">Sign up here</A>
          </p>
        </div>
      </div>
    </div>
  );
}
