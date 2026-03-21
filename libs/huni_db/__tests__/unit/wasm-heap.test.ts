/**
 * Tests for WASM heap access utilities
 */

import { describe, it, expect } from 'vitest';
import { getWasmHeapU8, getDatabaseHandle, copyFromWasmHeap, copyToWasmHeap } from '../../src/core/wasm-heap-utils.js';
import type { SQLiteAPI } from '../../src/core/sqlite-wasm-types.js';

describe('WASM Heap Utilities', () => {
  describe('getWasmHeapU8', () => {
    it('should return null for null sqlite', () => {
      const result = getWasmHeapU8(null);
      expect(result).toBeNull();
    });

    it('should return null for sqlite without wasm', () => {
      const sqlite = {
        capi: {},
        oo1: { DB: class {} },
      } as SQLiteAPI;

      const result = getWasmHeapU8(sqlite);
      expect(result).toBeNull();
    });

    it('should handle wasm with memory.buffer', () => {
      const buffer = new ArrayBuffer(1024);
      const memory = {
        buffer,
      } as WebAssembly.Memory;

      const sqlite = {
        capi: {},
        oo1: { DB: class {} },
        wasm: {
          memory,
        },
      } as SQLiteAPI;

      const result = getWasmHeapU8(sqlite);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result?.length).toBe(1024);
    });

    it('should handle wasm with heap8u as Uint8Array', () => {
      const heap8u = new Uint8Array(512);
      const sqlite = {
        capi: {},
        oo1: { DB: class {} },
        wasm: {
          heap8u,
        },
      } as SQLiteAPI;

      const result = getWasmHeapU8(sqlite);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result?.length).toBe(512);
    });

    it('should handle wasm with heap8u as function', () => {
      const heap8u = () => new Uint8Array(256);
      const sqlite = {
        capi: {},
        oo1: { DB: class {} },
        wasm: {
          heap8u,
        },
      } as SQLiteAPI;

      const result = getWasmHeapU8(sqlite);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result?.length).toBe(256);
    });

    it('should handle wasm with heap8 (Int8Array)', () => {
      const heap8 = new Int8Array(128);
      const sqlite = {
        capi: {},
        oo1: { DB: class {} },
        wasm: {
          heap8,
        },
      } as SQLiteAPI;

      const result = getWasmHeapU8(sqlite);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result?.length).toBe(128);
    });

    it('should handle uppercase HEAPU8', () => {
      const HEAPU8 = new Uint8Array(64);
      const sqlite = {
        capi: {},
        oo1: { DB: class {} },
        HEAPU8,
      } as SQLiteAPI & { HEAPU8: Uint8Array };

      const result = getWasmHeapU8(sqlite);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result?.length).toBe(64);
    });

    it('should reject detached buffers', () => {
      // Create a buffer and then detach it (simulate memory growth)
      const buffer = new ArrayBuffer(1024);
      const view = new Uint8Array(buffer);
      
      // Simulate detached buffer (byteLength becomes 0)
      Object.defineProperty(view, 'buffer', {
        value: { byteLength: 0 },
        writable: false,
      });
      Object.defineProperty(view, 'length', {
        value: 0,
        writable: false,
      });

      const sqlite = {
        capi: {},
        oo1: { DB: class {} },
        wasm: {
          heap8u: view,
        },
      } as SQLiteAPI;

      const result = getWasmHeapU8(sqlite);
      // Should fall back to other methods or return null
      expect(result).toBeNull();
    });
  });

  describe('getDatabaseHandle', () => {
    it('should return number if db is number', () => {
      const handle = getDatabaseHandle(12345);
      expect(handle).toBe(12345);
    });

    it('should return null for null db', () => {
      const handle = getDatabaseHandle(null);
      expect(handle).toBeNull();
    });

    it('should return null for non-object db', () => {
      const handle = getDatabaseHandle('not-an-object');
      expect(handle).toBeNull();
    });

    it('should extract pointer property', () => {
      const db = {
        pointer: 67890,
        filename: ':memory:',
      };

      const handle = getDatabaseHandle(db);
      expect(handle).toBe(67890);
    });

    it('should extract $$ property', () => {
      const db = {
        $$: 11111,
        filename: ':memory:',
      };

      const handle = getDatabaseHandle(db);
      expect(handle).toBe(11111);
    });

    it('should extract db property', () => {
      const db = {
        db: 22222,
        filename: ':memory:',
      };

      const handle = getDatabaseHandle(db);
      expect(handle).toBe(22222);
    });

    it('should extract _db property', () => {
      const db = {
        _db: 33333,
        filename: ':memory:',
      };

      const handle = getDatabaseHandle(db);
      expect(handle).toBe(33333);
    });

    it('should prefer pointer over other properties', () => {
      const db = {
        pointer: 44444,
        $$: 55555,
        db: 66666,
        filename: ':memory:',
      };

      const handle = getDatabaseHandle(db);
      expect(handle).toBe(44444);
    });

    it('should return null if no valid handle found', () => {
      const db = {
        filename: ':memory:',
        // No handle properties
      };

      const handle = getDatabaseHandle(db);
      expect(handle).toBeNull();
    });
  });

  describe('copyFromWasmHeap', () => {
    it('should copy data from heap', () => {
      const heap = new Uint8Array(1024);
      // Write some test data
      heap[0] = 0x01;
      heap[1] = 0x02;
      heap[2] = 0x03;

      const result = copyFromWasmHeap(heap, 0, 3);
      
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(3);
      expect(result[0]).toBe(0x01);
      expect(result[1]).toBe(0x02);
      expect(result[2]).toBe(0x03);
    });

    it('should throw on invalid heap', () => {
      const invalidHeap = {} as Uint8Array;
      
      expect(() => {
        copyFromWasmHeap(invalidHeap, 0, 10);
      }).toThrow();
    });

    it('should throw on invalid pointer', () => {
      const heap = new Uint8Array(1024);
      
      expect(() => {
        copyFromWasmHeap(heap, -1, 10);
      }).toThrow();
    });

    it('should throw on invalid size', () => {
      const heap = new Uint8Array(1024);
      
      expect(() => {
        copyFromWasmHeap(heap, 0, -1);
      }).toThrow();
    });

    it('should throw when pointer exceeds heap size', () => {
      const heap = new Uint8Array(1024);
      
      expect(() => {
        copyFromWasmHeap(heap, 2000, 10);
      }).toThrow();
    });

    it('should truncate when size exceeds available heap', () => {
      const heap = new Uint8Array(100);
      heap[50] = 0xFF;
      
      // Try to copy 100 bytes starting at position 50 (only 50 available)
      const result = copyFromWasmHeap(heap, 50, 100);
      
      expect(result.length).toBe(50);
      expect(result[0]).toBe(0xFF);
    });
  });

  describe('copyToWasmHeap', () => {
    it('should copy data to heap', () => {
      const heap = new Uint8Array(1024);
      const data = new Uint8Array([0xAA, 0xBB, 0xCC]);

      copyToWasmHeap(heap, 0, data);

      expect(heap[0]).toBe(0xAA);
      expect(heap[1]).toBe(0xBB);
      expect(heap[2]).toBe(0xCC);
    });

    it('should throw on invalid heap', () => {
      const invalidHeap = {} as Uint8Array;
      const data = new Uint8Array([1, 2, 3]);
      
      expect(() => {
        copyToWasmHeap(invalidHeap, 0, data);
      }).toThrow();
    });

    it('should throw on invalid pointer', () => {
      const heap = new Uint8Array(1024);
      const data = new Uint8Array([1, 2, 3]);
      
      expect(() => {
        copyToWasmHeap(heap, -1, data);
      }).toThrow();
    });

    it('should throw when data exceeds available space', () => {
      const heap = new Uint8Array(100);
      const data = new Uint8Array(200);
      
      expect(() => {
        copyToWasmHeap(heap, 0, data);
      }).toThrow();
    });

    it('should copy at offset', () => {
      const heap = new Uint8Array(1024);
      const data = new Uint8Array([0x11, 0x22, 0x33]);

      copyToWasmHeap(heap, 100, data);

      expect(heap[100]).toBe(0x11);
      expect(heap[101]).toBe(0x22);
      expect(heap[102]).toBe(0x33);
    });
  });
});

