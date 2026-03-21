/**
 * CSRF Middleware Tests
 * Tests for the shared CSRF protection middleware
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// Mock the shared modules
vi.mock('../../shared/utils/logging', () => ({
  logMessage: vi.fn()
}));

// Import the CSRF middleware
import { csrfProtection } from '../../../../shared/middleware/csrf.js';

describe('CSRF Middleware', () => {
  let app: express.Application;

  const createAppWithCSRF = (allowedOrigins: string[] = []) => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use(cookieParser());
    testApp.use(csrfProtection(allowedOrigins));
    
    // Add test routes
    testApp.get('/test', (req, res) => res.json({ success: true }));
    testApp.post('/test', (req, res) => res.json({ success: true }));
    testApp.put('/test', (req, res) => res.json({ success: true }));
    testApp.delete('/test', (req, res) => res.json({ success: true }));
    
    return testApp;
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    
    // Add a test route
    app.get('/test', (req, res) => res.json({ success: true }));
    app.post('/test', (req, res) => res.json({ success: true }));
    app.put('/test', (req, res) => res.json({ success: true }));
    app.delete('/test', (req, res) => res.json({ success: true }));
  });

  describe('Safe Methods (GET, HEAD, OPTIONS)', () => {
    it('should allow GET requests without CSRF token', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .get('/test')
        .expect(200);
      
      expect(response.body.success).toBe(true);
    });

    it('should allow HEAD requests without CSRF token', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .head('/test')
        .expect(200);
    });

    it('should allow OPTIONS requests without CSRF token', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .options('/test')
        .expect(200);
    });
  });

  describe('Unsafe Methods (POST, PUT, DELETE)', () => {
    it('should require CSRF token for POST requests', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .post('/test')
        .expect(403);
      
      expect(response.status).toBe(403);
      expect(response.body).toEqual({});
    });

    it('should require CSRF token for PUT requests', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .put('/test')
        .expect(403);
      
      expect(response.status).toBe(403);
      expect(response.body).toEqual({});
    });

    it('should require CSRF token for DELETE requests', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .delete('/test')
        .expect(403);
      
      expect(response.status).toBe(403);
      expect(response.body).toEqual({});
    });
  });

  describe('CSRF Token Validation', () => {
    it('should accept valid CSRF token in header', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      // First request to get CSRF cookie
      const cookieResponse = await request(testApp)
        .get('/test')
        .expect(200);
      
      const csrfCookie = cookieResponse.headers['set-cookie']
        ?.find(cookie => cookie.startsWith('csrf_token='))
        ?.split(';')[0]
        ?.split('=')[1];
      
      expect(csrfCookie).toBeDefined();
      
      // Second request with CSRF token
      const response = await request(testApp)
        .post('/test')
        .set('X-CSRF-Token', csrfCookie!)
        .set('Cookie', `csrf_token=${csrfCookie}`)
        .expect(200);
      
      expect(response.body.success).toBe(true);
    });

    it('should reject invalid CSRF token', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .post('/test')
        .set('X-CSRF-Token', 'invalid-token')
        .set('Cookie', 'csrf_token=valid-token')
        .expect(403);
      
      expect(response.status).toBe(403);
      expect(response.body).toEqual({});
    });

    it('should reject missing CSRF token', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .post('/test')
        .set('Cookie', 'csrf_token=some-token')
        .expect(403);
      
      expect(response.status).toBe(403);
      expect(response.body).toEqual({});
    });

    it('should reject missing CSRF cookie', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .post('/test')
        .set('X-CSRF-Token', 'some-token')
        .expect(403);
      
      expect(response.status).toBe(403);
      expect(response.body).toEqual({});
    });
  });

  describe('Origin Validation', () => {
    it('should allow requests from allowed origins', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000', 'https://example.com']);
      
      // First request to get CSRF cookie
      const cookieResponse = await request(testApp)
        .get('/test')
        .expect(200);
      
      const csrfCookie = cookieResponse.headers['set-cookie']
        ?.find(cookie => cookie.startsWith('csrf_token='))
        ?.split(';')[0]
        ?.split('=')[1];
      
      // Request with valid origin
      const response = await request(testApp)
        .post('/test')
        .set('Origin', 'http://localhost:3000')
        .set('X-CSRF-Token', csrfCookie!)
        .set('Cookie', `csrf_token=${csrfCookie}`)
        .expect(200);
      
      expect(response.body.success).toBe(true);
    });

    it('should reject requests from disallowed origins', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      // First request to get CSRF cookie
      const cookieResponse = await request(testApp)
        .get('/test')
        .expect(200);
      
      const csrfCookie = cookieResponse.headers['set-cookie']
        ?.find(cookie => cookie.startsWith('csrf_token='))
        ?.split(';')[0]
        ?.split('=')[1];
      
      // Request with invalid origin
      const response = await request(testApp)
        .post('/test')
        .set('Origin', 'https://malicious.com')
        .set('X-CSRF-Token', csrfCookie!)
        .set('Cookie', `csrf_token=${csrfCookie}`)
        .expect(403);
      
      expect(response.status).toBe(403);
      expect(response.body).toEqual({});
    });

    it('should allow requests without origin header when no origins specified', async () => {
      const testApp = createAppWithCSRF([]);
      
      // First request to get CSRF cookie
      const cookieResponse = await request(testApp)
        .get('/test')
        .expect(200);
      
      const csrfCookie = cookieResponse.headers['set-cookie']
        ?.find(cookie => cookie.startsWith('csrf_token='))
        ?.split(';')[0]
        ?.split('=')[1];
      
      // Request without origin
      const response = await request(testApp)
        .post('/test')
        .set('X-CSRF-Token', csrfCookie!)
        .set('Cookie', `csrf_token=${csrfCookie}`)
        .expect(200);
      
      expect(response.body.success).toBe(true);
    });
  });

  describe('Cookie Management', () => {
    it('should set CSRF cookie on first request', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .get('/test')
        .expect(200);
      
      const csrfCookie = response.headers['set-cookie']
        ?.find(cookie => cookie.startsWith('csrf_token='));
      
      expect(csrfCookie).toBeDefined();
      expect(csrfCookie).toContain('csrf_token=');
      expect(csrfCookie).toContain('SameSite=Lax');
    });

    it('should not set new cookie if one already exists', async () => {
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      // First request
      const firstResponse = await request(testApp)
        .get('/test')
        .expect(200);
      
      const firstCookie = firstResponse.headers['set-cookie']
        ?.find(cookie => cookie.startsWith('csrf_token='));
      
      // Second request with existing cookie
      const secondResponse = await request(testApp)
        .get('/test')
        .set('Cookie', firstCookie!)
        .expect(200);
      
      // Should not set a new cookie
      expect(secondResponse.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle middleware errors gracefully', async () => {
      // Mock crypto.randomBytes to throw an error
      const originalCrypto = require('crypto');
      vi.spyOn(originalCrypto, 'randomBytes').mockImplementation(() => {
        throw new Error('Crypto error');
      });
      
      const testApp = createAppWithCSRF(['http://localhost:3000']);
      
      const response = await request(testApp)
        .post('/test')
        .expect(403);
      
      expect(response.status).toBe(403);
      expect(response.body).toEqual({});
      
      // Restore original crypto
      vi.restoreAllMocks();
    });
  });

  describe('Configuration', () => {
    it('should work with empty allowed origins array', async () => {
      const testApp = createAppWithCSRF([]);
      
      const response = await request(testApp)
        .get('/test')
        .expect(200);
      
      expect(response.body.success).toBe(true);
    });

    it('should work with undefined allowed origins', async () => {
      const testApp = createAppWithCSRF(undefined as any);
      
      const response = await request(testApp)
        .get('/test')
        .expect(200);
      
      expect(response.body.success).toBe(true);
    });
  });
});
