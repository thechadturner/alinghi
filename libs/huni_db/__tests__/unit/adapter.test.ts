import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectStorageCapabilities, getBrowserInfo, selectStorageType } from '../../src/core/adapter';

describe('Storage Adapter', () => {
  describe('detectStorageCapabilities', () => {
    it('should detect storage capabilities', async () => {
      const capabilities = await detectStorageCapabilities();
      
      expect(capabilities).toHaveProperty('indexedDB');
      expect(typeof capabilities.indexedDB).toBe('boolean');
    });
  });

  describe('getBrowserInfo', () => {
    it('should get browser information', () => {
      const info = getBrowserInfo();
      
      expect(info).toHaveProperty('name');
      expect(info).toHaveProperty('version');
      expect(info).toHaveProperty('userAgent');
      
      expect(typeof info.name).toBe('string');
      expect(typeof info.version).toBe('string');
      expect(typeof info.userAgent).toBe('string');
    });
  });

  describe('selectStorageType', () => {
    it('should return memory as fallback', async () => {
      const type = await selectStorageType('memory');
      expect(type).toBe('memory');
    });

    it('should auto-select best available storage', async () => {
      const type = await selectStorageType();
      expect(['indexeddb', 'memory']).toContain(type);
    });
  });
});

