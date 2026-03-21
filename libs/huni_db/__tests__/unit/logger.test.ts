import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Logger, LogLevel, createLogger } from '../../src/utils/logger';

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = createLogger({ level: LogLevel.DEBUG });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  describe('LogLevel', () => {
    it('should respect log level', () => {
      logger.setLevel(LogLevel.ERROR);
      logger.debug('debug message');
      expect(console.debug).not.toHaveBeenCalled();

      logger.error('error message');
      expect(console.error).toHaveBeenCalled();
    });

    it('should get current log level', () => {
      logger.setLevel(LogLevel.INFO);
      expect(logger.getLevel()).toBe(LogLevel.INFO);
    });
  });

  describe('Logging methods', () => {
    beforeEach(() => {
      logger.setLevel(LogLevel.DEBUG);
    });

    it('should log error', () => {
      logger.error('error message');
      expect(console.error).toHaveBeenCalled();
    });

    it('should log warning', () => {
      logger.warn('warning message');
      expect(console.warn).toHaveBeenCalled();
    });

    it('should log info', () => {
      logger.info('info message');
      expect(console.info).toHaveBeenCalled();
    });

    it('should log debug', () => {
      logger.debug('debug message');
      expect(console.debug).toHaveBeenCalled();
    });
  });

  describe('Performance metrics', () => {
    it('should track query metrics', () => {
      logger.logQuery('SELECT * FROM users', [], 10);
      logger.logQuery('SELECT * FROM posts', [], 20);

      const metrics = logger.getMetrics();
      expect(metrics.queryCount).toBe(2);
      expect(metrics.totalQueryTime).toBe(30);
      expect(metrics.averageQueryTime).toBe(15);
    });

    it('should track transaction metrics', () => {
      logger.logTransaction(100, true);
      logger.logTransaction(200, true);

      const metrics = logger.getMetrics();
      expect(metrics.transactionCount).toBe(2);
      expect(metrics.totalTransactionTime).toBe(300);
      expect(metrics.averageTransactionTime).toBe(150);
    });

    it('should track cache hits and misses', () => {
      logger.logCacheHit();
      logger.logCacheHit();
      logger.logCacheMiss();

      const metrics = logger.getMetrics();
      expect(metrics.cacheHits).toBe(2);
      expect(metrics.cacheMisses).toBe(1);
      expect(metrics.cacheHitRate).toBeCloseTo(0.667, 2);
    });

    it('should reset metrics', () => {
      logger.logQuery('SELECT 1', [], 10);
      logger.logCacheHit();
      
      logger.resetMetrics();
      
      const metrics = logger.getMetrics();
      expect(metrics.queryCount).toBe(0);
      expect(metrics.cacheHits).toBe(0);
    });

    it('should calculate percentiles', () => {
      for (let i = 1; i <= 100; i++) {
        logger.logQuery('SELECT 1', [], i);
      }

      const percentiles = logger.getQueryPercentiles();
      // Percentile calculation uses Math.floor, so values may be slightly off
      expect(percentiles.p50).toBeGreaterThanOrEqual(49);
      expect(percentiles.p50).toBeLessThanOrEqual(51);
      expect(percentiles.p95).toBeGreaterThanOrEqual(94);
      expect(percentiles.p95).toBeLessThanOrEqual(96);
      expect(percentiles.p99).toBeGreaterThanOrEqual(98);
      expect(percentiles.p99).toBeLessThanOrEqual(100);
    });
  });
});

