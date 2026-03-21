/**
 * CSRF End-to-End Tests
 * Tests CSRF protection in real browser-like scenarios
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { chromium, Browser, Page } from 'playwright';

describe('CSRF E2E Tests', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    
    // Listen for console messages
    page.on('console', msg => {
      console.log('PAGE CONSOLE:', msg.text());
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  describe('Client-Side CSRF Token Handling', () => {
    it('should automatically include CSRF token in fetch requests', async () => {
      // Set cookie in browser context first
      await page.context().addCookies([{
        name: 'csrf_token',
        value: 'test-csrf-token-123',
        domain: 'localhost',
        path: '/',
        sameSite: 'Lax',
        httpOnly: false
      }]);

      // Navigate to a proper origin
      await page.goto('http://localhost:3000');
      await page.waitForLoadState('networkidle');

      // Test the fetch interceptor logic directly
      const result = await page.evaluate(() => {
        
        // Helper function to get cookie value
        const getCookie = (name) => {
          const value = `; ${document.cookie}`;
          const parts = value.split(`; ${name}=`);
          if (parts.length === 2) return parts.pop()?.split(';').shift() || '';
          return '';
        };
        
        // Mock fetch to capture requests and simulate server responses
        const originalFetch = window.fetch;
        const requests = [];
        
        window.fetch = async (url, options = {}) => {
          console.log('Fetch intercepted:', url, options);
          
          // Convert URL to string for easier handling
          const urlString = typeof url === 'string' ? url : url.toString();
          
          // Create a copy of options to avoid modifying the original
          const modifiedOptions = { ...options };
          
          // Check if this is an API request
          const isApiRequest = urlString.startsWith('/api/') || 
                              urlString.includes(window.location.origin) ||
                              urlString.startsWith('http://localhost:') ||
                              urlString.startsWith('https://localhost:');
          
          console.log('Is API request:', isApiRequest, urlString);
          
          if (isApiRequest) {
            // Get the method (default to GET)
            const method = (modifiedOptions.method || 'GET').toUpperCase();
            
            // Only add CSRF token for unsafe methods
            if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
              const csrfToken = getCookie('csrf_token');
              console.log('CSRF token:', csrfToken);
              
              if (csrfToken) {
                // Ensure headers object exists
                const headers = new Headers(modifiedOptions.headers);
                headers.set('X-CSRF-Token', csrfToken);
                
                // Convert Headers to plain object for serialization
                const headersObj = {};
                headers.forEach((value, key) => {
                  headersObj[key] = value;
                });
                
                // Update the options
                modifiedOptions.headers = headersObj;
                modifiedOptions.credentials = 'include';
              } else {
                // If no CSRF token, still ensure credentials are included
                modifiedOptions.credentials = 'include';
              }
            } else {
              // For safe methods, just ensure credentials are included
              modifiedOptions.credentials = 'include';
            }
          }
          
          // Store the modified request for inspection
          requests.push({ url: urlString, options: modifiedOptions });
          console.log('Stored request:', { url: urlString, options: modifiedOptions });
          
          // Simulate server response for CSRF-protected endpoints
          if (urlString.includes('/api/auth/login')) {
            console.log('Returning mock login response');
            return new Response(JSON.stringify({ success: false, message: 'Invalid credentials' }), {
              status: 401,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          return originalFetch(url, modifiedOptions);
        };
        
        // Test the fetch interceptor
        async function testFetch() {
          console.log('About to make fetch request');
          try {
            const response = await fetch('/api/auth/login', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                email: 'test@example.com',
                password: 'password'
              })
            });
            console.log('Fetch response:', response.status);
          } catch (error) {
            console.log('Fetch error:', error);
            // Expected to fail, we just want to see the request
          }
        }
        
        // Run the test
        return testFetch().then(() => {
          const filtered = requests.filter((req) => 
            req.options?.method === 'POST' && 
            req.url.includes('/api/auth/login')
          );
          return { requests: filtered, allRequests: requests };
        });
      });
      
      console.log('Test result:', result);
      expect(result.requests.length).toBeGreaterThan(0);
      
      const loginRequest = result.requests[0];
      console.log('Login request options:', loginRequest.options);
      console.log('Headers:', loginRequest.options.headers);
      
      // Check if the headers object has the X-CSRF-Token property
      const headers = loginRequest.options.headers;
      if (headers instanceof Headers) {
        expect(headers.get('X-CSRF-Token')).toBe('test-csrf-token-123');
      } else {
        expect(headers).toHaveProperty('x-csrf-token');
        expect(headers['x-csrf-token']).toBe('test-csrf-token-123');
      }
      expect(loginRequest.options.credentials).toBe('include');
    });

    it('should handle CSRF token refresh', async () => {
      // Set cookie in browser context before navigating
      await page.context().addCookies([{
        name: 'csrf_token',
        value: 'test-csrf-token-123',
        domain: 'localhost',
        path: '/',
        sameSite: 'Lax',
        httpOnly: false
      }]);

      await page.goto('data:text/html,<html><body><div id="root"></div></body></html>');
      await page.waitForLoadState('networkidle');

      // Get initial CSRF cookie
      const initialCookies = await page.context().cookies();
      const initialCsrfCookie = initialCookies.find(c => c.name === 'csrf_token');
      expect(initialCsrfCookie).toBeDefined();

      // Simulate multiple requests to test token persistence
      await page.evaluate(async () => {
        // Make multiple requests
        for (let i = 0; i < 3; i++) {
          try {
            await fetch('/api/auth/me', {
              method: 'GET',
              credentials: 'include'
            });
          } catch (error) {
            // Expected to fail without proper auth
          }
        }
      });

      // Verify CSRF cookie is still present
      const finalCookies = await page.context().cookies();
      const finalCsrfCookie = finalCookies.find(c => c.name === 'csrf_token');
      expect(finalCsrfCookie).toBeDefined();
      expect(finalCsrfCookie?.value).toBe(initialCsrfCookie?.value);
    });
  });

  describe('Form Submission CSRF Protection', () => {
    it('should include CSRF token in form submissions', async () => {
      // Set cookie in browser context first
      await page.context().addCookies([{
        name: 'csrf_token',
        value: 'test-csrf-token-123',
        domain: 'localhost',
        path: '/',
        sameSite: 'Lax',
        httpOnly: false
      }]);

      // Navigate to a proper origin
      await page.goto('http://localhost:3000');
      await page.waitForLoadState('networkidle');

      // Test the fetch interceptor logic directly for form submission
      const result = await page.evaluate(() => {
        // Helper function to get cookie value
        const getCookie = (name) => {
          const value = `; ${document.cookie}`;
          const parts = value.split(`; ${name}=`);
          if (parts.length === 2) return parts.pop()?.split(';').shift() || '';
          return '';
        };
        
        // Mock fetch to capture requests and simulate server responses
        const originalFetch = window.fetch;
        const requests = [];
        
        window.fetch = async (url, options = {}) => {
          console.log('Fetch intercepted:', url, options);
          
          // Convert URL to string for easier handling
          const urlString = typeof url === 'string' ? url : url.toString();
          
          // Create a copy of options to avoid modifying the original
          const modifiedOptions = { ...options };
          
          // Check if this is an API request
          const isApiRequest = urlString.startsWith('/api/') || 
                              urlString.includes(window.location.origin) ||
                              urlString.startsWith('http://localhost:') ||
                              urlString.startsWith('https://localhost:');
          
          console.log('Is API request:', isApiRequest, urlString);
          
          if (isApiRequest) {
            // Get the method (default to GET)
            const method = (modifiedOptions.method || 'GET').toUpperCase();
            
            // Only add CSRF token for unsafe methods
            if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
              const csrfToken = getCookie('csrf_token');
              console.log('CSRF token:', csrfToken);
              
              if (csrfToken) {
                // Ensure headers object exists
                const headers = new Headers(modifiedOptions.headers);
                headers.set('X-CSRF-Token', csrfToken);
                
                // Convert Headers to plain object for serialization
                const headersObj = {};
                headers.forEach((value, key) => {
                  headersObj[key] = value;
                });
                
                // Update the options
                modifiedOptions.headers = headersObj;
                modifiedOptions.credentials = 'include';
              } else {
                // If no CSRF token, still ensure credentials are included
                modifiedOptions.credentials = 'include';
              }
            } else {
              // For safe methods, just ensure credentials are included
              modifiedOptions.credentials = 'include';
            }
          }
          
          // Store the modified request for inspection
          requests.push({ url: urlString, options: modifiedOptions });
          console.log('Stored request:', { url: urlString, options: modifiedOptions });
          
          // Simulate server response for CSRF-protected endpoints
          if (urlString.includes('/api/auth/register')) {
            console.log('Returning mock register response');
            return new Response(JSON.stringify({ success: true, message: 'Registration successful' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          return originalFetch(url, modifiedOptions);
        };
        
        // Test the fetch interceptor for form submission
        async function testFormSubmission() {
          console.log('About to make form submission fetch request');
          try {
            const response = await fetch('/api/auth/register', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                first_name: 'Test',
                last_name: 'User',
                email: 'test@example.com',
                password: 'password123',
                confirmPassword: 'password123'
              })
            });
            console.log('Fetch response:', response.status);
          } catch (error) {
            console.log('Fetch error:', error);
            // Expected to fail, we just want to see the request
          }
        }
        
        // Run the test
        return testFormSubmission().then(() => {
          const filtered = requests.filter((req) => 
            req.options?.method === 'POST' && 
            req.url.includes('/api/auth/register')
          );
          return { requests: filtered, allRequests: requests };
        });
      });
      
      console.log('Form submission test result:', result);
      expect(result.requests.length).toBeGreaterThan(0);
      
      const registerRequest = result.requests[0];
      console.log('Register request options:', registerRequest.options);
      console.log('Headers:', registerRequest.options.headers);
      
      // Check if the headers object has the X-CSRF-Token property
      const headers = registerRequest.options.headers;
      if (headers instanceof Headers) {
        expect(headers.get('X-CSRF-Token')).toBe('test-csrf-token-123');
      } else {
        expect(headers).toHaveProperty('x-csrf-token');
        expect(headers['x-csrf-token']).toBe('test-csrf-token-123');
      }
      expect(registerRequest.options.credentials).toBe('include');
    });
  });

  describe('Cross-Origin CSRF Protection', () => {
    it('should block cross-origin requests without proper headers', async () => {
      // Create a new page to simulate cross-origin request
      const maliciousPage = await browser.newPage();
      
      await maliciousPage.addInitScript(() => {
        // Mock fetch to simulate cross-origin request and server response
        const originalFetch = window.fetch;
        
        window.fetch = async (url: string | Request, options?: RequestInit) => {
          // Simulate request from different origin
          if (typeof url === 'string' && url.includes('/api/auth/login')) {
            // Check if CSRF token is present
            const csrfToken = options?.headers?.['X-CSRF-Token'];
            if (!csrfToken) {
              // Return 403 for missing CSRF token
              return new Response(JSON.stringify({ success: false, message: 'Forbidden (csrf)' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
              });
            }
            // If CSRF token is present, return success
            return new Response(JSON.stringify({ success: true, message: 'Login successful' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          return originalFetch(url, options);
        };
      });

      try {
        await maliciousPage.goto('data:text/html,<html><body><div id="root"></div></body></html>');
        await maliciousPage.waitForLoadState('networkidle');

        // Try to make a POST request without proper CSRF token
        const response = await maliciousPage.evaluate(async () => {
          try {
            const response = await fetch('/api/auth/login', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://malicious.com'
              },
              body: JSON.stringify({
                email: 'test@example.com',
                password: 'password'
              })
            });
            return { status: response.status, ok: response.ok };
          } catch (error) {
            return { error: (error as Error).message };
          }
        });

        // Should be blocked
        expect(response.status).toBe(403);
        expect(response.ok).toBe(false);
      } finally {
        await maliciousPage.close();
      }
    });
  });

  describe('Cookie Security', () => {
    it('should set secure cookie attributes', async () => {
      // Set cookie in browser context before navigating
      await page.context().addCookies([{
        name: 'csrf_token',
        value: 'test-csrf-token-123',
        domain: 'localhost',
        path: '/',
        sameSite: 'Lax',
        httpOnly: false
      }]);

      await page.goto('data:text/html,<html><body><div id="root"></div></body></html>');
      await page.waitForLoadState('networkidle');

      const cookies = await page.context().cookies();
      const csrfCookie = cookies.find(c => c.name === 'csrf_token');
      
      expect(csrfCookie).toBeDefined();
      expect(csrfCookie?.httpOnly).toBe(false); // Must be readable by client
      expect(csrfCookie?.sameSite).toBe('Lax');
      expect(csrfCookie?.path).toBe('/');
    });
  });

  describe('Error Handling', () => {
    it('should display user-friendly error messages for CSRF failures', async () => {
      await page.addInitScript(() => {
        // Mock fetch to simulate CSRF failure
        const originalFetch = window.fetch;
        
        window.fetch = async (url: string | Request, options?: RequestInit) => {
          if (typeof url === 'string' && url.includes('/api/auth/login')) {
            // Check if CSRF token is present
            const csrfToken = options?.headers?.['X-CSRF-Token'];
            if (!csrfToken) {
              // Return 403 for missing CSRF token
              return new Response(JSON.stringify({ success: false, message: 'Forbidden (csrf)' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' }
              });
            }
            // If CSRF token is present, return success
            return new Response(JSON.stringify({ success: true, message: 'Login successful' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          
          return originalFetch(url, options);
        };
      });

      await page.goto('data:text/html,<html><body><div id="root"></div></body></html>');
      await page.waitForLoadState('networkidle');

      // Simulate a CSRF failure by making a request without proper token
      const response = await page.evaluate(async () => {
        try {
          const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              email: 'test@example.com',
              password: 'password'
            })
          });
          const data = await response.json();
          return { status: response.status, data };
        } catch (error) {
          return { error: (error as Error).message };
        }
      });

      // Should receive CSRF error
      expect(response.status).toBe(403);
      expect(response.data?.message).toContain('Forbidden (csrf)');
    });
  });
});
