import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import compression from 'compression';

/**
 * Compression Integration Tests
 * 
 * Tests verify that:
 * 1. JSON responses are compressed
 * 2. Compression headers are set correctly
 * 3. Compression is skipped for small responses (< 1KB threshold)
 * 4. Compression is skipped for non-compressible content types
 * 5. Compression level and filter work correctly
 */

describe('API Response Compression', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    
    // Configure compression with same settings as production servers
    app.use(compression({
      level: 6,
      threshold: 1024, // 1KB
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false;
        }
        const contentType = res.getHeader('content-type') || '';
        return /json|text|javascript|css|xml|html|svg/i.test(contentType);
      }
    }));

    // Test routes
    app.get('/api/test/small', (req, res) => {
      res.json({ message: 'small response' }); // < 1KB, should not compress
    });

    app.get('/api/test/large', (req, res) => {
      // Generate large JSON response (> 1KB)
      const largeData = {
        items: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `Item ${i}`,
          description: `This is a description for item ${i}. `.repeat(10),
          metadata: {
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            tags: ['tag1', 'tag2', 'tag3', 'tag4', 'tag5']
          }
        }))
      };
      res.json(largeData);
    });

    app.get('/api/test/json', (req, res) => {
      res.json({ 
        status: 'ok', 
        data: Array.from({ length: 50 }, (_, i) => ({ id: i, value: `test-${i}` }))
      });
    });

    app.get('/api/test/text', (req, res) => {
      res.setHeader('Content-Type', 'text/plain');
      res.send('This is a text response that should be compressed if large enough. '.repeat(20));
    });

    app.get('/api/test/image', (req, res) => {
      res.setHeader('Content-Type', 'image/png');
      res.send(Buffer.alloc(2048)); // 2KB image data
    });

    app.get('/api/test/no-compress', (req, res) => {
      res.setHeader('x-no-compression', 'true');
      res.json({ message: 'This should not be compressed' });
    });
  });

  afterAll(() => {
    // Cleanup if needed
  });

  describe('JSON Response Compression', () => {
    it('should compress large JSON responses (> 1KB)', async () => {
      const response = await request(app)
        .get('/api/test/large')
        .set('Accept-Encoding', 'gzip, deflate, br')
        .expect(200);

      // Check for compression header (gzip or br are both valid)
      expect(['gzip', 'br']).toContain(response.headers['content-encoding']);
      
      // Verify content is actually compressed
      // Note: content-length may not always be set with compression, but response should be valid
      if (response.headers['content-length']) {
        const compressedSize = parseInt(response.headers['content-length'] || '0', 10);
        expect(compressedSize).toBeGreaterThan(0);
      }
      
      // Verify response is valid JSON when decompressed
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body.items)).toBe(true);
      expect(response.body.items.length).toBe(100);
    });

    it('should compress medium JSON responses (> 1KB)', async () => {
      const response = await request(app)
        .get('/api/test/json')
        .set('Accept-Encoding', 'gzip, deflate, br')
        .expect(200);

      // Check for compression header (gzip or br are both valid)
      expect(['gzip', 'br']).toContain(response.headers['content-encoding']);
      
      // Verify response is valid JSON
      expect(response.body).toBeDefined();
      expect(response.body.status).toBe('ok');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should NOT compress small JSON responses (< 1KB threshold)', async () => {
      const response = await request(app)
        .get('/api/test/small')
        .set('Accept-Encoding', 'gzip, deflate, br')
        .expect(200);

      // Small responses should not be compressed (below threshold)
      expect(response.headers['content-encoding']).toBeUndefined();
      
      // Verify response is valid JSON
      expect(response.body).toBeDefined();
      expect(response.body.message).toBe('small response');
    });
  });

  describe('Content Type Filtering', () => {
    it('should compress text/plain responses', async () => {
      const response = await request(app)
        .get('/api/test/text')
        .set('Accept-Encoding', 'gzip, deflate, br')
        .expect(200);

      // Text responses should be compressed if large enough (gzip or br are both valid)
      expect(['gzip', 'br']).toContain(response.headers['content-encoding']);
      expect(response.headers['content-type']).toContain('text/plain');
    });

    it('should NOT compress image responses', async () => {
      const response = await request(app)
        .get('/api/test/image')
        .set('Accept-Encoding', 'gzip, deflate, br')
        .expect(200);

      // Images should not be compressed (not in filter list)
      expect(response.headers['content-encoding']).toBeUndefined();
      expect(response.headers['content-type']).toBe('image/png');
    });
  });

  describe('Compression Control Headers', () => {
    it('should skip compression when x-no-compression header is set', async () => {
      const response = await request(app)
        .get('/api/test/no-compress')
        .set('Accept-Encoding', 'gzip, deflate, br')
        .set('x-no-compression', 'true')
        .expect(200);

      // Should not compress when header is set
      expect(response.headers['content-encoding']).toBeUndefined();
      
      // Verify response is valid
      expect(response.body).toBeDefined();
      expect(response.body.message).toBe('This should not be compressed');
    });
  });

  describe('Compression Headers', () => {
    it('should set correct compression headers for compressed responses', async () => {
      const response = await request(app)
        .get('/api/test/large')
        .set('Accept-Encoding', 'gzip, deflate, br')
        .expect(200);

      // Check compression headers (gzip or br are both valid)
      expect(['gzip', 'br']).toContain(response.headers['content-encoding']);
      expect(response.headers['vary']).toContain('Accept-Encoding');
      // content-length may not always be set with compression, but vary header should be present
    });

    it('should handle clients that do not support compression', async () => {
      const response = await request(app)
        .get('/api/test/large')
        // No Accept-Encoding header
        .expect(200);

      // Should still return response, but may not be compressed
      // (compression middleware handles this)
      expect(response.body).toBeDefined();
      expect(response.body.items).toBeDefined();
    });
  });

  describe('Compression Performance', () => {
    it('should significantly reduce size of large JSON responses', async () => {
      // Get uncompressed size estimate (by disabling compression)
      const uncompressedResponse = await request(app)
        .get('/api/test/large')
        .set('x-no-compression', 'true')
        .expect(200);

      // Get compressed response
      const compressedResponse = await request(app)
        .get('/api/test/large')
        .set('Accept-Encoding', 'gzip, deflate, br')
        .expect(200);

      const uncompressedSize = parseInt(uncompressedResponse.headers['content-length'] || '0', 10);
      const compressedSize = parseInt(compressedResponse.headers['content-length'] || '0', 10);

      // Compressed should be significantly smaller
      expect(compressedSize).toBeLessThan(uncompressedSize);
      
      // Compression ratio should be at least 50% for JSON
      const compressionRatio = compressedSize / uncompressedSize;
      expect(compressionRatio).toBeLessThan(0.5);
    });
  });
});

