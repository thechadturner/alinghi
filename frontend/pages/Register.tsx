import { createSignal, Show, onMount, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { postData, getCookie } from "../utils/global";
import { apiEndpoints } from "@config/env";
import { error as logError } from "../utils/console";
import { setNoRobotsMetaTags } from "../utils/metaTags";

interface FormData {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
  confirmPassword: string;
}

interface ValidationErrors {
  first_name: string;
  last_name: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export default function Register() {
  const [formData, setFormData] = createSignal<FormData>({
    first_name: "",
    last_name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });

  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");
  const [validationErrors, setValidationErrors] = createSignal<ValidationErrors>({
    first_name: "",
    last_name: "",
    email: "",
    password: "",
    confirmPassword: ""
  });
  const [passwordStrength, setPasswordStrength] = createSignal(0); // 0 = weak, 1 = medium, 2 = strong
  const [passwordMatch, setPasswordMatch] = createSignal(false); // Track if passwords match
  const [isLoading, setIsLoading] = createSignal(false); // Track loading state

  const navigate = useNavigate();
  
  // Refs to capture autofilled values from password managers
  let passwordInputRef: HTMLInputElement;
  let confirmPasswordInputRef: HTMLInputElement;
  
  // Check if cookies are accepted
  const areCookiesAccepted = () => {
    const cookiesAccepted = localStorage.getItem("cookiesAccepted");
    return cookiesAccepted === "true";
  };
  
  // Always show the form - check cookies on submit instead
  onMount(() => {
    // Set robots meta tags to prevent crawling
    const cleanup = setNoRobotsMetaTags();
    onCleanup(() => cleanup());
    
    // Enable scrolling on html and body for register page with mobile optimizations
    // Explicitly enable vertical scrolling for all screen sizes
    // Use setProperty for important styles to ensure they override CSS
    document.documentElement.style.setProperty('overflow-x', 'hidden', 'important');
    document.documentElement.style.setProperty('overflow-y', 'auto', 'important');
    document.documentElement.style.setProperty('height', 'auto', 'important');
    document.documentElement.style.setProperty('min-height', '100vh', 'important');
    (document.documentElement.style as any).webkitOverflowScrolling = 'touch';
    (document.documentElement.style as any).touchAction = 'pan-y';
    
    document.body.style.setProperty('overflow-x', 'hidden', 'important');
    document.body.style.setProperty('overflow-y', 'auto', 'important');
    document.body.style.setProperty('height', 'auto', 'important');
    document.body.style.setProperty('min-height', '100vh', 'important');
    document.body.style.setProperty('display', 'block', 'important');
    (document.body.style as any).webkitOverflowScrolling = 'touch';
    (document.body.style as any).touchAction = 'pan-y';
    
    // Ensure root element also allows scrolling
    const rootElement = document.getElementById('root');
    if (rootElement) {
      rootElement.style.setProperty('overflow-y', 'auto', 'important');
      rootElement.style.setProperty('overflow-x', 'hidden', 'important');
      rootElement.style.setProperty('height', 'auto', 'important');
      rootElement.style.setProperty('min-height', '100vh', 'important');
      rootElement.style.setProperty('display', 'block', 'important');
      (rootElement.style as any).touchAction = 'pan-y';
    }
    
    // Fix iOS viewport height issues
    const setViewportHeight = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    };
    setViewportHeight();
    window.addEventListener('resize', setViewportHeight);
    window.addEventListener('orientationchange', setViewportHeight);
    
    // Restore form data if returning from cookie policy
    const savedFormData = sessionStorage.getItem("registerFormData");
    if (savedFormData) {
      try {
        const parsed = JSON.parse(savedFormData);
        setFormData(parsed);
        sessionStorage.removeItem("registerFormData");
      } catch (e) {
        // Ignore parse errors
      }
    }
    
    // Cleanup function for scrolling styles
    onCleanup(() => {
      // Reset styles
      document.documentElement.style.removeProperty('overflow-x');
      document.documentElement.style.removeProperty('overflow-y');
      document.documentElement.style.removeProperty('height');
      document.documentElement.style.removeProperty('min-height');
      (document.documentElement.style as any).webkitOverflowScrolling = '';
      (document.documentElement.style as any).touchAction = '';
      
      document.body.style.removeProperty('overflow-x');
      document.body.style.removeProperty('overflow-y');
      document.body.style.removeProperty('height');
      document.body.style.removeProperty('min-height');
      document.body.style.removeProperty('display');
      (document.body.style as any).webkitOverflowScrolling = '';
      (document.body.style as any).touchAction = '';
      
      const rootEl = document.getElementById('root');
      if (rootEl) {
        rootEl.style.removeProperty('overflow-y');
        rootEl.style.removeProperty('overflow-x');
        rootEl.style.removeProperty('height');
        rootEl.style.removeProperty('min-height');
        rootEl.style.removeProperty('display');
        (rootEl.style as any).touchAction = '';
      }
      
      // Remove viewport height event listeners
      window.removeEventListener('resize', setViewportHeight);
      window.removeEventListener('orientationchange', setViewportHeight);
    });
  }); 

  // Calculate password strength
  const calculatePasswordStrength = (password: string): number => {
    if (!password) return 0;
    
    let score = 0;
    if (password.length >= 8) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/[a-z]/.test(password)) score++;
    if (/[0-9]/.test(password)) score++;
    if (/[!@#$%^&*()_+\-=\[\]{};'':"\\|,.<>\/?]/.test(password)) score++;
    
    // Better scoring distribution - show all three levels
    if (score <= 1) return 0; // weak
    if (score <= 3) return 1; // medium
    return 2; // strong
  };

  const handleInputChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const { name, value } = target;
    setFormData({ ...formData(), [name]: value });
    
    // Update password strength in real-time
    if (name === 'password') {
      setPasswordStrength(calculatePasswordStrength(value));
    }
    
    // Check password match in real-time
    if (name === 'password' || name === 'confirmPassword') {
      const currentData = formData();
      const password = name === 'password' ? value : currentData.password;
      const confirmPassword = name === 'confirmPassword' ? value : currentData.confirmPassword;
      setPasswordMatch(password === confirmPassword && password.length > 0 && confirmPassword.length > 0);
    }
    
    // Clear validation error for this field when user starts typing
    if (validationErrors()[name as keyof ValidationErrors]) {
      setValidationErrors({ ...validationErrors(), [name]: "" });
    }
  };

  // Client-side validation function
  const validateForm = (): boolean => {
    const data = formData();
    const errors: Partial<ValidationErrors> = {};

    // First name validation
    if (!data.first_name || data.first_name.trim().length === 0) {
      errors.first_name = "First name is required";
    } else if (data.first_name.trim().length < 1) {
      errors.first_name = "First name must be at least 1 character";
    }

    // Last name validation
    if (!data.last_name || data.last_name.trim().length === 0) {
      errors.last_name = "Last name is required";
    } else if (data.last_name.trim().length < 1) {
      errors.last_name = "Last name must be at least 1 character";
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!data.email || data.email.trim().length === 0) {
      errors.email = "Email address is required";
    } else if (!emailRegex.test(data.email)) {
      errors.email = "Please enter a valid email address";
    }

    // Password validation - simplified for better UX
    if (!data.password || data.password.length === 0) {
      errors.password = "Password is required";
    } else if (data.password.length < 8) {
      errors.password = "Password must be at least 8 characters long";
    } else {
      // Check for 4 out of 5 criteria (same as server validation)
      const passwordErrors: string[] = [];
      
      if (!/[A-Z]/.test(data.password)) {
        passwordErrors.push('one uppercase letter');
      }
      if (!/[a-z]/.test(data.password)) {
        passwordErrors.push('one lowercase letter');
      }
      if (!/[0-9]/.test(data.password)) {
        passwordErrors.push('one number');
      }
      if (!/[!@#$%^&*()_+\-=\[\]{};'':"\\|,.<>\/?]/.test(data.password)) {
        passwordErrors.push('one special character');
      }
      
      // Require at least 4 out of 5 criteria (allow 1 missing)
      if (passwordErrors.length > 1) {
        const shownErrors = passwordErrors.slice(0, 2);
        errors.password = `Password must contain ${shownErrors.join(', ')}. Please update your password and try again.`;
      }
    }

    // Confirm password validation
    if (!data.confirmPassword || data.confirmPassword.length === 0) {
      errors.confirmPassword = "Please confirm your password";
    } else if (data.password !== data.confirmPassword) {
      errors.confirmPassword = "Passwords do not match";
    }

    setValidationErrors({
      first_name: errors.first_name || "",
      last_name: errors.last_name || "",
      email: errors.email || "",
      password: errors.password || "",
      confirmPassword: errors.confirmPassword || ""
    });
    return Object.keys(errors).length === 0;
  };

  const handleRegister = async (e: Event) => {
    e.preventDefault();
    
    // Check if cookies are accepted before attempting registration
    if (!areCookiesAccepted()) {
      // Store form data in sessionStorage so we can restore it after cookie acceptance
      sessionStorage.setItem("registerFormData", JSON.stringify(formData()));
      
      // Redirect to cookie policy with redirect back to register
      navigate(`/cookie-policy?redirect=/register`, { replace: true });
      return;
    }
    
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
  
    // Extract form data
    const data = formData();
    
    // Extract pid from URL query parameters if present
    const urlParams = new URLSearchParams(window.location.search);
    const pid = urlParams.get('pid');
    
    // Build registration URL with pid query parameter if present
    let registerUrl = apiEndpoints.auth.register;
    if (pid) {
      const separator = registerUrl.includes('?') ? '&' : '?';
      registerUrl = `${registerUrl}${separator}pid=${encodeURIComponent(pid)}`;
    }
  
    try {
      // Use unauthenticated request for registration
      const response = await fetch(registerUrl, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCookie('csrf_token') || ''
        },
        body: JSON.stringify({
          first_name: data.first_name.trim(),
          last_name: data.last_name.trim(),
          email: data.email.trim(),
          password: data.password
        })
      });

      const response_json = await response.json();
  
      if (response.ok) {
        if (response_json.success) {
          setSuccess("Registration successful! Please check your email for the verification code.");
          setTimeout(() => {
            navigate(`/verify?email=${data.email}`);
          }, 2000);
        } else {
          setError(response_json.message || "Registration failed. Please try again.");
          setIsLoading(false); // Reset loading state on error
        }
      } else {
        // Handle HTTP error responses
        if (response.status === 400) {
          // Show the specific validation error from server
          setError(response_json.message || "Invalid data provided. Please check your information and try again.");
        } else if (response.status === 403) {
          // Email not found in pending list (invitation-only registration)
          setError(response_json.message || "Your email address could not be found. Registration is currently invitation-only. Please contact support if you believe you should have access.");
        } else if (response.status === 409) {
          setError("An account with this email already exists. Redirecting to password reset...");
          setTimeout(() => {
            navigate("/forgot-password");
          }, 2000);
        } else if (response.status === 500) {
          setError("Server error occurred. Please try again later or contact support.");
        } else {
          setError(`Registration failed: ${response.status} ${response.statusText}`);
        }
        setIsLoading(false); // Reset loading state on error
      }
    } catch (error: any) {
      logError("Registration error:", error);
      setError("An unexpected error occurred. Please try again later.");
      setIsLoading(false); // Reset loading state on error
    }
  };  

  return (
    <div class="login-page">
      <div class="login-container register-container">
        <div class="login-header">
          <div class="logo-section">
            <div class="logo-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <h1 class="login-title">Create Account</h1>
            <p class="login-subtitle">Join TeamShare and start analyzing your data</p>
          </div>
        </div>
        
        <form class="login-form register-form" onSubmit={handleRegister} autocomplete="on">
          <div class="form-row">
            <div class="form-group form-group-half">
              <label for="first_name" class="form-label">First Name</label>
              <div class="input-container">
                <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <input
                  id="first_name"
                  type="text"
                  name="first_name"
                  autocomplete="given-name"
                  placeholder="Enter your first name"
                  value={formData().first_name}
                  onInput={handleInputChange}
                  required
                  class={`form-input ${validationErrors().first_name ? 'error' : ''}`}
                />
              </div>
              {validationErrors().first_name && (
                <div class="field-error">{validationErrors().first_name}</div>
              )}
            </div>
            
            <div class="form-group form-group-half">
              <label for="last_name" class="form-label">Last Name</label>
              <div class="input-container">
                <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M20 21V19C20 17.9391 19.5786 16.9217 18.8284 16.1716C18.0783 15.4214 17.0609 15 16 15H8C6.93913 15 5.92172 15.4214 5.17157 16.1716C4.42143 16.9217 4 17.9391 4 19V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <input
                  id="last_name"
                  type="text"
                  name="last_name"
                  autocomplete="family-name"
                  placeholder="Enter your last name"
                  value={formData().last_name}
                  onInput={handleInputChange}
                  required
                  class={`form-input ${validationErrors().last_name ? 'error' : ''}`}
                />
              </div>
              {validationErrors().last_name && (
                <div class="field-error">{validationErrors().last_name}</div>
              )}
            </div>
          </div>
          
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
                autocomplete="email"
                placeholder="Enter your email"
                value={formData().email}
                onInput={handleInputChange}
                required
                class={`form-input ${validationErrors().email ? 'error' : ''}`}
              />
            </div>
            {validationErrors().email && (
              <div class="field-error">{validationErrors().email}</div>
            )}
          </div>
          
          <div class="form-row">
            <div class="form-group form-group-half">
              <label for="password" class="form-label">Password</label>
              <div class="input-container">
                <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke="currentColor" stroke-width="2"/>
                  <circle cx="12" cy="16" r="1" fill="currentColor"/>
                  <path d="M7 11V7A5 5 0 0 1 17 7V11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <input
                  id="password"
                  type="password"
                  name="password"
                  autocomplete="new-password"
                  placeholder="Enter your password"
                  value={formData().password}
                  onInput={handleInputChange}
                  required
                  class={`form-input ${validationErrors().password ? 'error' : ''}`}
                />
              </div>
              {validationErrors().password && (
                <div class="field-error">{validationErrors().password}</div>
              )}
              <div class="password-strength-container">
                <div class="password-strength-label">
                  <small>Password strength: </small>
                  <span class={`password-strength-text strength-${passwordStrength()}`}>
                    {passwordStrength() === 0 ? 'Weak' : passwordStrength() === 1 ? 'Medium' : 'Strong'}
                  </span>
                </div>
                <div class="password-strength-bar">
                  <div class={`password-strength-fill strength-${passwordStrength()}`}></div>
                </div>
              </div>
            </div>
            
            <div class="form-group form-group-half">
              <label for="confirmPassword" class="form-label">Confirm Password</label>
              <div class="input-container">
                <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke="currentColor" stroke-width="2"/>
                  <circle cx="12" cy="16" r="1" fill="currentColor"/>
                  <path d="M7 11V7A5 5 0 0 1 17 7V11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <input
                  id="confirmPassword"
                  type="password"
                  name="confirmPassword"
                  autocomplete="new-password"
                  placeholder="Confirm your password"
                  value={formData().confirmPassword}
                  onInput={handleInputChange}
                  required
                  class={`form-input ${validationErrors().confirmPassword ? 'error' : ''}`}
                />
                <Show when={formData().confirmPassword.length > 0}>
                  <div class="password-match-indicator">
                    <Show when={passwordMatch()}>
                      <svg class="password-match-icon success" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M9 12L11 14L15 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3C16.9706 3 21 7.02944 21 12Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      </svg>
                    </Show>
                    <Show when={!passwordMatch()}>
                      <svg class="password-match-icon error" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>
                        <line x1="15" y1="9" x2="9" y2="15" stroke="currentColor" stroke-width="2"/>
                        <line x1="9" y1="9" x2="15" y2="15" stroke="currentColor" stroke-width="2"/>
                      </svg>
                    </Show>
                  </div>
                </Show>
              </div>
              {validationErrors().confirmPassword && (
                <div class="field-error">{validationErrors().confirmPassword}</div>
              )}
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
          
          <Show when={!success()}>
            <button type="submit" class="login-button" disabled={isLoading()}>
              <span class="button-text">{isLoading() ? 'Creating Account...' : 'Create Account'}</span>
              <svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M16 21V19C16 17.9391 15.5786 16.9217 14.8284 16.1716C14.0783 15.4214 13.0609 15 12 15H5C3.93913 15 2.92172 15.4214 2.17157 16.1716C1.42143 16.9217 1 17.9391 1 19V21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="8.5" cy="7" r="4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="20" y1="8" x2="20" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <line x1="23" y1="11" x2="17" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </Show>
        </form>
        
        <div class="login-footer">
          <p class="footer-text">
            Already have an account? 
            <a href="/login" class="register-link">Sign in here</a>
          </p>
        </div>
      </div>
    </div>
  );
}

