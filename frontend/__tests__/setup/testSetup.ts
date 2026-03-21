/**
 * Test Setup Configuration
 * 
 * Global setup for all tests including mocks, utilities, and environment configuration
 */

import { vi, beforeEach, afterEach } from 'vitest';
import { setupMocks } from '../utils/testHelpers';

// Global test setup
beforeEach(() => {
  // Clear all mocks before each test
  vi.clearAllMocks();
  
  // Setup default mocks
  setupMocks();
  
  // Reset timers
  vi.useFakeTimers();
});

afterEach(() => {
  // Restore timers after each test
  vi.useRealTimers();
  
  // Clear all mocks after each test
  vi.clearAllMocks();
});

// Mock global objects that might be used in tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock performance API
Object.defineProperty(global, 'performance', {
  writable: true,
  value: {
    now: vi.fn(() => Date.now()),
    mark: vi.fn(),
    measure: vi.fn(),
    getEntriesByType: vi.fn(() => []),
    getEntriesByName: vi.fn(() => []),
  },
});

// Mock console methods to prevent noise in tests
const originalConsole = { ...console };
global.console = {
  ...originalConsole,
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// Note: IndexedDB mocking is handled by the MockIndexedDB class in mocks/indexedDB.mock.ts

// Mock IDBRequest
class MockIDBRequest {
  result = null;
  error = null;
  readyState = 'done';
  source = null;
  transaction = null;
  
  onsuccess = null;
  onerror = null;
  onabort = null;
  
  constructor() {
    // Simulate async behavior
    setTimeout(() => {
      if (this.onsuccess) {
        this.onsuccess({ target: this });
      }
    }, 0);
  }
}

// Mock IDBTransaction
class MockIDBTransaction {
  mode = 'readonly';
  db = mockIndexedDB;
  error = null;
  oncomplete = null;
  onerror = null;
  onabort = null;
  
  objectStore = vi.fn(() => new MockIDBObjectStore());
  abort = vi.fn();
  commit = vi.fn();
}

// Mock IDBObjectStore
class MockIDBObjectStore {
  name = 'test';
  keyPath = null;
  indexNames = [];
  transaction = new MockIDBTransaction();
  autoIncrement = false;
  
  add = vi.fn(() => new MockIDBRequest());
  put = vi.fn(() => new MockIDBRequest());
  get = vi.fn(() => new MockIDBRequest());
  delete = vi.fn(() => new MockIDBRequest());
  clear = vi.fn(() => new MockIDBRequest());
  count = vi.fn(() => new MockIDBRequest());
  openCursor = vi.fn(() => new MockIDBRequest());
  openKeyCursor = vi.fn(() => new MockIDBRequest());
  createIndex = vi.fn(() => new MockIDBIndex());
  deleteIndex = vi.fn();
  index = vi.fn(() => new MockIDBIndex());
}

// Mock IDBIndex
class MockIDBIndex {
  name = 'test';
  objectStore = new MockIDBObjectStore();
  keyPath = null;
  multiEntry = false;
  unique = false;
  
  get = vi.fn(() => new MockIDBRequest());
  getKey = vi.fn(() => new MockIDBRequest());
  getAll = vi.fn(() => new MockIDBRequest());
  getAllKeys = vi.fn(() => new MockIDBRequest());
  count = vi.fn(() => new MockIDBRequest());
  openCursor = vi.fn(() => new MockIDBRequest());
  openKeyCursor = vi.fn(() => new MockIDBRequest());
}

// Mock IDBOpenDBRequest
class MockIDBOpenDBRequest extends MockIDBRequest {
  onupgradeneeded = null;
  onblocked = null;
}

// Mock IDBDatabase
class MockIDBDatabase {
  name = 'test';
  version = 1;
  objectStoreNames = mockIndexedDB.objectStoreNames;
  
  close = vi.fn();
  createObjectStore = vi.fn(() => new MockIDBObjectStore());
  deleteObjectStore = vi.fn();
  transaction = vi.fn(() => new MockIDBTransaction());
}

// Mock IDBFactory
class MockIDBFactory {
  open = vi.fn(() => new MockIDBOpenDBRequest());
  deleteDatabase = vi.fn(() => new MockIDBRequest());
  cmp = vi.fn();
}

// Set up IndexedDB mocks
global.indexedDB = new MockIDBFactory();
global.IDBRequest = MockIDBRequest;
global.IDBTransaction = MockIDBTransaction;
global.IDBObjectStore = MockIDBObjectStore;
global.IDBIndex = MockIDBIndex;
global.IDBOpenDBRequest = MockIDBOpenDBRequest;
global.IDBDatabase = MockIDBDatabase;
global.IDBFactory = MockIDBFactory;

// Mock IDBKeyRange
global.IDBKeyRange = {
  only: vi.fn((value) => ({ lower: value, upper: value, lowerOpen: false, upperOpen: false })),
  lowerBound: vi.fn((value, open = false) => ({ lower: value, upper: undefined, lowerOpen: open, upperOpen: false })),
  upperBound: vi.fn((value, open = false) => ({ lower: undefined, upper: value, lowerOpen: false, upperOpen: open })),
  bound: vi.fn((lower, upper, lowerOpen = false, upperOpen = false) => ({ lower, upper, lowerOpen, upperOpen }))
};

// Export test utilities for use in tests
// Note: mockIndexedDB is exported from mocks/indexedDB.mock.ts
