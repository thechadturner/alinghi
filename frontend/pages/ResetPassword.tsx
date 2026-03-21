import { createSignal, Show, onMount, onCleanup } from "solid-js";
import { useNavigate, useSearchParams } from "@solidjs/router";
import { postData, getData, getCookie } from "../utils/global";
import { apiEndpoints } from "@config/env";
import { log, error as logError } from "../utils/console";
import { setNoRobotsMetaTags } from "../utils/metaTags";
import { handleLogin } from "../utils/loginHelper";

interface ValidationErrors {
  email: string;
  code: string;
  newPassword: string;
  confirmPassword: string;
}

export default function ResetPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = createSignal("");
  const [code, setCode] = createSignal("");
  const [codeDigits, setCodeDigits] = createSignal<string[]>(["", "", "", ""]);
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const [passwordMatch, setPasswordMatch] = createSignal(false);
  const [passwordStrength, setPasswordStrength] = createSignal(0); // 0 = weak, 1 = medium, 2 = strong
  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");
  const [validationErrors, setValidationErrors] = createSignal<ValidationErrors>({
    email: "",
    code: "",
    newPassword: "",
    confirmPassword: ""
  });

  // Auto-focus first digit input on mount
  onMount(() => {
    // Set robots meta tags to prevent crawling
    const cleanup = setNoRobotsMetaTags();
    onCleanup(() => cleanup());
    
    // Enable scrolling on body/html for this page
    document.body.style.overflowY = 'auto';
    document.body.style.height = 'auto';
    document.documentElement.style.overflowY = 'auto';
    document.documentElement.style.height = 'auto';
    
    // Populate email from URL params if available
    const emailParam = searchParams.email;
    if (emailParam) {
      setEmail(decodeURIComponent(emailParam));
    }
    
    setTimeout(() => {
      const firstDigit = document.getElementById('digit-0');
      if (firstDigit) firstDigit.focus();
    }, 100);
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

  // Handle digit input for verification code
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

    // Verification code validation
    if (!code() || code().length === 0) {
      errors.code = "Verification code is required";
    } else if (code().length !== 4) {
      errors.code = "Verification code must be 4 digits";
    } else if (!/^\d{4}$/.test(code())) {
      errors.code = "Verification code must contain only numbers";
    }

    // Password validation - same as registration
    if (!newPassword() || newPassword().length === 0) {
      errors.newPassword = "Password is required";
    } else if (newPassword().length < 8) {
      errors.newPassword = "Password must be at least 8 characters long";
    } else {
      // Check for 4 out of 5 criteria (same as server validation)
      const passwordErrors: string[] = [];
      
      if (!/[A-Z]/.test(newPassword())) {
        passwordErrors.push('one uppercase letter');
      }
      if (!/[a-z]/.test(newPassword())) {
        passwordErrors.push('one lowercase letter');
      }
      if (!/[0-9]/.test(newPassword())) {
        passwordErrors.push('one number');
      }
      if (!/[!@#$%^&*()_+\-=\[\]{};'':"\\|,.<>\/?]/.test(newPassword())) {
        passwordErrors.push('one special character');
      }
      
      // Require at least 4 out of 5 criteria (allow 1 missing)
      if (passwordErrors.length > 1) {
        const shownErrors = passwordErrors.slice(0, 2);
        errors.newPassword = `Password must contain ${shownErrors.join(', ')}. Please update your password and try again.`;
      }
    }

    // Confirm password validation
    if (!confirmPassword() || confirmPassword().length === 0) {
      errors.confirmPassword = "Please confirm your password";
    } else if (newPassword() !== confirmPassword()) {
      errors.confirmPassword = "Passwords do not match";
    }

    setValidationErrors({
      email: errors.email || "",
      code: errors.code || "",
      newPassword: errors.newPassword || "",
      confirmPassword: errors.confirmPassword || ""
    });
    return Object.keys(errors).length === 0;
  };

  const handleInputChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    const { name, value } = target;
    
    if (name === 'newPassword') {
      setNewPassword(value);
      // Update password strength in real-time
      setPasswordStrength(calculatePasswordStrength(value));
    } else if (name === 'confirmPassword') {
      setConfirmPassword(value);
    }
    
    // Check password match in real-time
    if (name === 'newPassword' || name === 'confirmPassword') {
      const password = name === 'newPassword' ? value : newPassword();
      const confirm = name === 'confirmPassword' ? value : confirmPassword();
      setPasswordMatch(password === confirm && password.length > 0 && confirm.length > 0);
    }
    
    // Clear validation error for this field when user starts typing
    if (validationErrors()[name as keyof ValidationErrors]) {
      setValidationErrors({ ...validationErrors(), [name]: "" });
    }
  };

  const handleResetPassword = async (e: Event) => {
    e.preventDefault();

    // Clear previous messages
    setError("");
    setSuccess("");

    // Validate form before submission
    if (!validateForm()) {
      setError("Please fix the errors below before submitting.");
      return;
    }

    try {
      const payload = {
        email: email(), 
        code: code(), 
        newPassword: newPassword() 
      };
      log("Sending password reset with payload:", { email: email(), code: code(), passwordLength: newPassword().length });
      
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
      
      // Use non-authenticated request for reset password
      const response = await fetch(apiEndpoints.auth.resetPassword, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': getCookie('csrf_token') || ''
        },
        body: JSON.stringify(payload)
      });
      
      const response_json = await response.json();
      
      log("Password reset response:", response_json);
      log("Response data:", response_json.data);
      log("User in data:", response_json.data?.user);

      if (response.ok && response_json.success) {
        const userData = response_json.data;
        
        // If user data is returned, automatically log them in
        if (userData && userData.user) {
          log("User data found, logging in automatically");
          
          // Use shared login helper function
          // Pass tokens so they're stored in localStorage (backend sets cookie, but authManager needs localStorage)
          await handleLogin(userData.user, 'ResetPassword', {
            accessToken: userData.accessToken,
            refreshToken: userData.refreshToken,
            expiresIn: userData.expiresIn
          });
          
          setSuccess(`Password reset successful! Welcome back, ${userData.user.first_name || userData.user.user_name || 'User'}!`);
          log("Password reset successful, automatically logged in, redirecting to dashboard...");
          setTimeout(() => {
            window.location.href = '/dashboard';
          }, 1500);
        } else {
          // Fallback: redirect to login if no user data
          logError("No user data in response:", userData);
          setSuccess("Password reset successful! You can now log in.");
          log("Password reset successful, redirecting to login...");
          setTimeout(() => {
            navigate("/login", { replace: true });
          }, 2000);
        }
      } else {
        const errorMsg = response_json.message || "Password reset failed.";
        logError("Password reset failed:", errorMsg, response_json);
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
            <p class="login-subtitle">Enter your email, verification code, and new password</p>
          </div>
        </div>
        
        <form class="login-form" onSubmit={handleResetPassword}>
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
                readonly
                disabled
                required
                class={`form-input email-readonly-input ${validationErrors().email ? 'error' : ''}`}
                style="cursor: not-allowed; background-color: var(--color-bg-tertiary);"
              />
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
          
          <div class="form-group">
            <label for="newPassword" class="form-label">New Password</label>
            <div class="input-container">
              <svg class="input-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" stroke="currentColor" stroke-width="2"/>
                <circle cx="12" cy="16" r="1" fill="currentColor"/>
                <path d="M7 11V7A5 5 0 0 1 17 7V11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
              <input
                id="newPassword"
                type="password"
                name="newPassword"
                placeholder="Enter new password"
                value={newPassword()}
                onInput={handleInputChange}
                required
                class={`form-input ${validationErrors().newPassword ? 'error' : ''}`}
              />
            </div>
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
            {validationErrors().newPassword && (
              <div class="field-error">{validationErrors().newPassword}</div>
            )}
          </div>
          
          <div class="form-group">
            <label for="confirmPassword" class="form-label">Confirm New Password</label>
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
                placeholder="Confirm new password"
                value={confirmPassword()}
                onInput={handleInputChange}
                required
                class={`form-input ${validationErrors().confirmPassword ? 'error' : ''}`}
              />
              <Show when={confirmPassword().length > 0}>
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
            <span class="button-text">Reset Password</span>
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

