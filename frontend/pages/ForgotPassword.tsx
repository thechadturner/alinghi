import { createSignal, onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";

import { postData, getCookie } from "../utils/global";
import { apiEndpoints } from "@config/env";
import { log, error as logError } from "../utils/console";
import { setNoRobotsMetaTags } from "../utils/metaTags";

export default function ForgotPassword() {
  const [email, setEmail] = createSignal("");
  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");

  const navigate = useNavigate(); // For client-side navigation

  onMount(() => {
    // Set robots meta tags to prevent crawling
    const cleanup = setNoRobotsMetaTags();
    onCleanup(() => cleanup());
  });

  const handleForgotPassword = async (e: Event) => {
    e.preventDefault();

    // Clear previous messages
    setError("");
    setSuccess("");

    try {
      const payload = { email: email() }
      log("Sending password reset request for:", email());
      
      // First, ensure we have a CSRF token by making a simple request
      // This will trigger the CSRF middleware to set the cookie
      try {
        await fetch('/api/auth/user', {
          method: 'GET',
          credentials: 'include'
        });
      } catch (e) {
        // Ignore errors from the GET request - we just need the CSRF cookie
      }
      
      // Now make the actual POST request with the CSRF token
      const response = await fetch(apiEndpoints.auth.forgotPassword, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCookie('csrf_token') || ''
        },
        body: JSON.stringify(payload)
      });
      
      const responseData = await response.json();
      
      log("Password reset response:", responseData);

      if (response.ok && responseData.success) {
        setSuccess("Reset code generated! Check the server console for your reset code.");
        // Delay navigation slightly so user can see the success message
        setTimeout(() => {
          navigate(`/reset-password?email=${encodeURIComponent(email())}`);
        }, 1500);
      } else {
        const errorMsg = responseData.message || "Failed to send reset instructions.";
        logError("Password reset failed:", errorMsg);
        setError(errorMsg);
      }
    } catch (err: any) {
      logError("Password reset error:", err);
      setError("An unexpected error occurred. Please try again.");
    }
  };

  return (
    <div class="login-page">
      <div class="login-container">
        <div class="login-header">
          <div class="logo-section">
            <div class="logo-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <h1 class="login-title">Reset Password</h1>
            <p class="login-subtitle">Enter your email to receive a reset code</p>
          </div>
        </div>
        
        <form class="login-form" onSubmit={handleForgotPassword}>
          <div class="form-group">
            <label for="email" class="form-label">Email Address</label>
            <div class="input-container">
              <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6C2 4.9 2.9 4 4 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <polyline points="22,6 12,13 2,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <input
                id="email"
                type="email"
                name="email"
                placeholder="Enter your email"
                value={email()}
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                required
                class="form-input"
              />
            </div>
          </div>
          
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
          
          <button type="submit" class="login-button">
            <span class="button-text">Send Reset Code</span>
            <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M22 2L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </form>
        
        <div class="login-footer">
          <p class="footer-text">
            Remember your password? 
            <a href="/login" class="register-link">Sign in here</a>
          </p>
        </div>
      </div>
    </div>
  );
}

