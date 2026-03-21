/**
 * API Mock for Testing
 * 
 * Provides a mock implementation of API operations
 * that can be used in unit and integration tests
 */

import { vi } from 'vitest';
import { mockDataPoints, mockAPIResponses } from '../fixtures/mockData';

export class MockAPI {
  private responses: Map<string, any> = new Map();
  private errors: Map<string, Error> = new Map();
  private callCount: Map<string, number> = new Map();

  // Mock function declarations - initialized in constructor and reset in clear()
  getDataByChannels: any;
  setResponse: any;
  setError: any;
  getCallCount: any;
  clear: any;

  constructor() {
    this.initializeMocks();
  }


  /**
   * Initialize mock functions with fresh implementations
   * This ensures clean state after clearing
   */
  private initializeMocks(): void {
    this.getDataByChannels = vi.fn().mockImplementation(async (
      channels: string[],
      params: any
    ): Promise<any> => {
      const key = this.createKey(channels, params);
      this.callCount.set(key, (this.callCount.get(key) || 0) + 1);

      // Check if we should throw an error
      if (this.errors.has(key)) {
        throw this.errors.get(key);
      }

      // Return configured response or default
      const response = this.responses.get(key) || mockAPIResponses.success;
      
      // Ensure response matches getDataByChannels format: { data, availableChannels, missingChannels, hasAll }
      if (response && response.data) {
        const data = response.data;
        const availableChannels = data.length > 0 ? 
          Object.keys(data[0] || {}).filter(key => key !== 'timestamp' && key !== 'Datetime') : [];
        const missingChannels = (channels || []).filter(ch => !availableChannels.includes(ch));
        const hasAll = availableChannels.length === (channels || []).length && data.length > 0;
        
        return {
          data,
          availableChannels,
          missingChannels,
          hasAll
        };
      }
      
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 10));
      
      return response;
    });

    this.setResponse = vi.fn().mockImplementation((
      channels: string[],
      params: any,
      response: any
    ): void => {
      const key = this.createKey(channels, params);
      this.responses.set(key, response);
    });

    this.setError = vi.fn().mockImplementation((
      channels: string[],
      params: any,
      error: Error
    ): void => {
      const key = this.createKey(channels, params);
      this.errors.set(key, error);
    });

    this.getCallCount = vi.fn().mockImplementation((
      channels: string[],
      params: any
    ): number => {
      const key = this.createKey(channels, params);
      return this.callCount.get(key) || 0;
    });

    this.clear = vi.fn().mockImplementation((): void => {
      this.responses.clear();
      this.errors.clear();
      this.callCount.clear();
      
      // Re-initialize the mock functions to ensure clean state
      this.initializeMocks();
    });
  }

  private createKey(channels: string[], params: any): string {
    const sortedChannels = [...channels].sort();
    const paramString = JSON.stringify(params);
    return `${sortedChannels.join(',')}_${paramString}`;
  }
}

export const mockAPI = new MockAPI();
