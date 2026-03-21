import { getCookie } from "../utils/global";
import { createSignal, onMount, onCleanup } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { apiEndpoints } from "@config/env";
import { error as logError, log } from "../utils/console";
import { setNoRobotsMetaTags } from "../utils/metaTags";
import { handleLogin } from "../utils/loginHelper";

interface ValidationErrors {
  email: string;
  code: string;
}

export default function Verify() {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = createSignal("");
  const [emailFromRegistration, setEmailFromRegistration] = createSignal(false);
  const [code, setCode] = createSignal("");
  const [codeDigits, setCodeDigits] = createSignal<string[]>(["", "", "", ""]);
  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");
  const [validationErrors, setValidationErrors] = createSignal<ValidationErrors>({
    email: "",
    code: ""
  });
  const [isLoading, setIsLoading] = createSignal(false); // Track loading state

  const navigate = useNavigate();

  // Pre-fill email from URL parameter if available
  onMount(() => {
    // Set robots meta tags to prevent crawling
    const cleanup = setNoRobotsMetaTags();
    onCleanup(() => cleanup());
    
    const emailFromUrl = searchParams.email;
    if (emailFromUrl) {
      setEmail(emailFromUrl);
      setEmailFromRegistration(true);
      log("Email pre-filled from registration:", emailFromUrl);
      // Auto-focus on first code digit
      setTimeout(() => {
        const firstDigit = document.getElementById('digit-0');
        if (firstDigit) firstDigit.focus();
      }, 100);
    }
  }); 

  const handleDigitChange = (index: number, value: string) => {
    // Only allow single numeric digit
    if (value.length > 1) return;
    if (value && !/^\d$/.test(value)) return; // Only allow digits 0-9
    
    const newDigits = [...codeDigits()];
    newDigits[index] = value;
    setCodeDigits(newDigits);
    
    // Update the combined code
    const combinedCode = newDigits.join("");
    setCode(combinedCode);
    
    
    // Clear validation error when user starts typing
    if (validationErrors().code) {
      setValidationErrors({ ...validationErrors(), code: "" });
    }
    
    // Auto-advance to next field if digit entered
    if (value && index < 3) {
      const nextInput = document.getElementById(`digit-${index + 1}`);
      if (nextInput) nextInput.focus();
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent) => {
    // Handle backspace to go to previous field
    if (e.key === "Backspace" && !codeDigits()[index] && index > 0) {
      const prevInput = document.getElementById(`digit-${index - 1}`);
      if (prevInput) prevInput.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData?.getData("text").replace(/\D/g, "").slice(0, 4) || "";
    const newDigits = ["", "", "", ""];
    for (let i = 0; i < pastedData.length; i++) {
      newDigits[i] = pastedData[i];
    }
    setCodeDigits(newDigits);
    
    const combinedCode = newDigits.join("");
    setCode(combinedCode);
    
    
    // Clear validation error when user pastes
    if (validationErrors().code) {
      setValidationErrors({ ...validationErrors(), code: "" });
    }
    
    // Focus the last filled digit or first empty
    const lastFilledIndex = newDigits.findIndex(d => d === "") - 1;
    const focusIndex = lastFilledIndex >= 0 ? lastFilledIndex : Math.min(3, pastedData.length);
    const nextInput = document.getElementById(`digit-${focusIndex}`);
    if (nextInput) nextInput.focus();
  };

  // Client-side validation function
  const validateForm = (): boolean => {
    const errors: Partial<ValidationErrors> = {};

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email() || email().trim().length === 0) {
      errors.email = "Email address is required";
    } else if (!emailRegex.test(email())) {
      errors.email = "Please enter a valid email address";
    }

    // Code validation
    if (!code() || code().length === 0) {
      errors.code = "Verification code is required";
    } else if (code().length !== 4) {
      errors.code = "Verification code must be exactly 4 digits";
    } else if (!/^\d{4}$/.test(code())) {
      errors.code = "Verification code must contain only numbers";
    }
    setValidationErrors({
      email: errors.email || "",
      code: errors.code || ""
    });
    return Object.keys(errors).length === 0;
  };

  const handleVerification = async (e: Event) => {
    e.preventDefault();
    
    // Set loading state immediately
    setIsLoading(true);
    
    // Clear previous errors
    setError("");
    setSuccess("");
    
    // Validate form before submission
    if (!validateForm()) {
      setError("Please fix the errors below before submitting.");
      setIsLoading(false); // Reset loading state on validation failure
      return;
    }

    try {
      const controller = new AbortController();
      
      
      // Use unauthenticated request for verification
      const response = await fetch(apiEndpoints.auth.verify, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCookie('csrf_token') || ''
        },
        body: JSON.stringify({
          email: email().trim(), 
          code: code(), 
          rememberMe: false 
        }),
        signal: controller.signal
      });

      const response_json = await response.json();
      
      log("Verification response:", response_json);
      log("Response data:", response_json.data);
      log("User in data:", response_json.data?.user);

      if (response.ok) {
        if (response_json.success) {
          const userData = response_json.data;

          // If user data is returned, automatically log them in
          if (userData && userData.user) {
            log("User data found, logging in automatically");
            
            // Use shared login helper function
            // Pass tokens so they're stored in localStorage (backend sets cookie, but authManager needs localStorage)
            await handleLogin(userData.user, 'Verify', {
              accessToken: userData.accessToken,
              refreshToken: userData.refreshToken,
              expiresIn: userData.expiresIn
            });
            
            setSuccess(`Verification successful! Welcome ${userData.user.first_name || userData.user.user_name || 'User'}!`);
            log("Verification successful, automatically logged in, redirecting to dashboard...");
          } else {
            // Backend sets auth cookie, so user is authenticated even without user data in response
            logError("No user data in response, but verification successful. Backend should have set auth cookie.");
            setSuccess("Verification successful! Redirecting to dashboard...");
            log("Verification successful, redirecting to dashboard (auth cookie should be set)...");
          }
          
          // Full-page redirect so browser fetches fresh index.html (and latest app assets)
          setTimeout(() => {
            window.location.href = '/dashboard';
          }, 1500);
        } else {
          setError(response_json.message || "Verification failed.");
          setIsLoading(false); // Reset loading state on error
        }
      } else {
        // Handle HTTP error responses
        if (response.status === 400) {
          setError("Invalid verification code or email. Please check your information and try again.");
        } else if (response.status === 404) {
          setError("Verification code not found. Please request a new code.");
        } else if (response.status === 500) {
          setError("Server error occurred. Please try again later or contact support.");
        } else {
          setError(`Verification failed: ${response.status} ${response.statusText}`);
        }
        setIsLoading(false); // Reset loading state on error
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Request was cancelled, do nothing
      } else {
        logError("Verification error:", err);
        setError("An unexpected error occurred. Please try again.");
        setIsLoading(false); // Reset loading state on error
      }
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
            <h1 class="login-title">Email Verification</h1>
            <p class="login-subtitle">
              {emailFromRegistration() 
                ? "Enter the 4-digit code sent to your email address" 
                : "Enter your email and the 4-digit code sent to your email address"}
            </p>
          </div>
        </div>
        
        <form class="login-form" onSubmit={handleVerification}>
          <div class="form-group">
            <label for="email" class="form-label">Email Address</label>
            <div class="input-container">
              <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 4H20C21.1 4 22 4.9 22 6V18C22 19.1 21.1 20 20 20H4C2.9 20 2 19.1 2 18V6C2 4.9 2.9 4 4 4Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <polyline points="22,6 12,13 2,6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              {emailFromRegistration() ? (
                <>
                  <div
                    id="email-display"
                    class={`email-display-textbox ${validationErrors().email ? 'error' : ''}`}
                  >
                    {email() || "Enter your email"}
                  </div>
                  <input
                    type="hidden"
                    name="email"
                    value={email()}
                  />
                </>
              ) : (
                <input
                  id="email"
                  type="email"
                  name="email"
                  placeholder="Enter your email"
                  value={email()}
                  onInput={(e) => {
                    setEmail((e.target as HTMLInputElement).value);
                    // Clear validation error when user starts typing
                    if (validationErrors().email) {
                      setValidationErrors({ ...validationErrors(), email: "" });
                    }
                  }}
                  required
                  class={`form-input ${validationErrors().email ? 'error' : ''}`}
                />
              )}
            </div>
            {validationErrors().email && (
              <div class="field-error">{validationErrors().email}</div>
            )}
          </div>
          
          <div class="form-group">
            <label class="form-label">Verification Code</label>
            <div class="code-input-container">
              {codeDigits().map((digit, index) => (
                <input
                  data-key={index}
                  id={`digit-${index}`}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]"
                  maxLength={1}
                  value={digit}
                  onInput={(e) => handleDigitChange(index, (e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => handleKeyDown(index, e)}
                  onPaste={handlePaste}
                  class={`code-digit-input ${validationErrors().code ? 'error' : ''}`}
                  required
                />
              ))}
            </div>
            {validationErrors().code && (
              <div class="field-error">{validationErrors().code}</div>
            )}
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
          
          <button type="submit" class="login-button" disabled={isLoading()}>
            <span class="button-text">{isLoading() ? 'Verifying...' : 'Verify Email'}</span>
            <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M9 12L11 14L15 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </form>
        
        <div class="login-footer">
          <p class="footer-text">
            Need help? 
            <a href="/login" class="register-link">Contact support</a>
          </p>
        </div>
      </div>
    </div>
  );
}

