import type { Migration, MigrationRecord, MigrationExecutor } from './types.js';
import type { Connection } from '../core/connection.js';
import { MigrationError } from '../utils/errors.js';
import { defaultLogger } from '../utils/logger.js';

/**
 * Migration table name
 */
const MIGRATION_TABLE = '_migrations';

/**
 * Migration runner
 */
export class MigrationRunner {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Initialize migration table
   */
  private async initializeMigrationTable(): Promise<void> {
    const sql = `
      CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
        version INTEGER PRIMARY KEY,
        description TEXT,
        applied_at INTEGER NOT NULL
      )
    `;

    await this.connection.exec(sql);
    defaultLogger.debug('Migration table initialized');
  }

  /**
   * Get current migration version
   */
  async getCurrentVersion(): Promise<number> {
    await this.initializeMigrationTable();

    const result = await this.connection.queryValue<number>(
      `SELECT MAX(version) FROM ${MIGRATION_TABLE}`
    );

    return result ?? 0;
  }

  /**
   * Get all applied migrations
   */
  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    await this.initializeMigrationTable();

    const migrations = await this.connection.query<MigrationRecord>(
      `SELECT version, description, applied_at FROM ${MIGRATION_TABLE} ORDER BY version ASC`
    );

    return migrations;
  }

  /**
   * Check if a migration has been applied
   */
  async isMigrationApplied(version: number): Promise<boolean> {
    await this.initializeMigrationTable();

    const result = await this.connection.queryValue<number>(
      `SELECT COUNT(*) FROM ${MIGRATION_TABLE} WHERE version = ?`,
      [version]
    );

    return (result ?? 0) > 0;
  }

  /**
   * Run migrations up to a target version
   */
  async migrate(migrations: Migration[], targetVersion?: number): Promise<void> {
    // Validate migrations
    this.validateMigrations(migrations);

    // Sort migrations by version
    const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version);

    // Get current version
    const currentVersion = await this.getCurrentVersion();
    const target = targetVersion ?? sortedMigrations[sortedMigrations.length - 1]?.version ?? 0;

    defaultLogger.info(`Current migration version: ${currentVersion}`);
    defaultLogger.info(`Target migration version: ${target}`);

    if (target < currentVersion) {
      // Rollback migrations
      await this.rollback(sortedMigrations, target);
    } else if (target > currentVersion) {
      // Apply migrations
      await this.applyMigrations(sortedMigrations, currentVersion, target);
    } else {
      defaultLogger.info('Database is already at target version');
    }
  }

  /**
   * Apply migrations
   */
  private async applyMigrations(
    migrations: Migration[],
    currentVersion: number,
    targetVersion: number
  ): Promise<void> {
    const migrationsToApply = migrations.filter(
      m => m.version > currentVersion && m.version <= targetVersion
    );

    if (migrationsToApply.length === 0) {
      defaultLogger.info('No migrations to apply');
      return;
    }

    defaultLogger.info(`Applying ${migrationsToApply.length} migration(s)`);

    for (const migration of migrationsToApply) {
      await this.applyMigration(migration);
    }

    defaultLogger.info('All migrations applied successfully');
  }

  /**
   * Apply a single migration
   */
  private async applyMigration(migration: Migration): Promise<void> {
    const startTime = performance.now();

    try {
      defaultLogger.info(`Applying migration ${migration.version}: ${migration.description || 'Unnamed'}`);

      // Get engine directly for transaction operations
      const engine = this.connection.getEngine();
      
      await engine.transaction(async () => {
        // Create migration executor that uses engine directly (bypasses connection write lock)
        const executor: MigrationExecutor = {
          exec: async (sql: string, params?: unknown[]) => {
            await engine.exec(sql, params);
          },
          query: async <T = unknown>(sql: string, params?: unknown[]) => {
            return await engine.query<T>(sql, params);
          },
        };

        // Run migration up
        await migration.up(executor);

        // Record migration
        await engine.exec(
          `INSERT INTO ${MIGRATION_TABLE} (version, description, applied_at) VALUES (?, ?, ?)`,
          [migration.version, migration.description || null, Date.now()]
        );
      });

      const executionTime = performance.now() - startTime;
      defaultLogger.info(
        `Migration ${migration.version} applied successfully in ${executionTime.toFixed(2)}ms`
      );
    } catch (error) {
      throw new MigrationError(
        `Failed to apply migration ${migration.version}: ${error instanceof Error ? error.message : String(error)}`,
        { migration: migration.version, description: migration.description, error }
      );
    }
  }

  /**
   * Rollback migrations to a target version
   */
  private async rollback(migrations: Migration[], targetVersion: number): Promise<void> {
    const currentVersion = await this.getCurrentVersion();

    const migrationsToRollback = migrations
      .filter(m => m.version > targetVersion && m.version <= currentVersion)
      .sort((a, b) => b.version - a.version); // Reverse order for rollback

    if (migrationsToRollback.length === 0) {
      defaultLogger.info('No migrations to rollback');
      return;
    }

    defaultLogger.info(`Rolling back ${migrationsToRollback.length} migration(s)`);

    for (const migration of migrationsToRollback) {
      await this.rollbackMigration(migration);
    }

    defaultLogger.info('All migrations rolled back successfully');
  }

  /**
   * Rollback a single migration
   */
  private async rollbackMigration(migration: Migration): Promise<void> {
    const startTime = performance.now();

    try {
      defaultLogger.info(`Rolling back migration ${migration.version}: ${migration.description || 'Unnamed'}`);

      // Use engine directly to avoid writeLock deadlock inside transaction
      const engine = this.connection.getEngine();
      await engine.transaction(async () => {
        // Create migration executor that uses engine directly (bypasses connection write lock)
        const executor: MigrationExecutor = {
          exec: async (sql: string, params?: unknown[]) => {
            await engine.exec(sql, params);
          },
          query: async <T = unknown>(sql: string, params?: unknown[]) => {
            return await engine.query<T>(sql, params);
          },
        };

        // Run migration down
        await migration.down(executor);

        // Remove migration record
        await this.connection.exec(
          `DELETE FROM ${MIGRATION_TABLE} WHERE version = ?`,
          [migration.version]
        );
      });

      const executionTime = performance.now() - startTime;
      defaultLogger.info(
        `Migration ${migration.version} rolled back successfully in ${executionTime.toFixed(2)}ms`
      );
    } catch (error) {
      throw new MigrationError(
        `Failed to rollback migration ${migration.version}: ${error instanceof Error ? error.message : String(error)}`,
        { migration: migration.version, description: migration.description, error }
      );
    }
  }

  /**
   * Validate migrations
   */
  private validateMigrations(migrations: Migration[]): void {
    if (migrations.length === 0) {
      return;
    }

    // Check for duplicate versions
    const versions = new Set<number>();
    for (const migration of migrations) {
      if (versions.has(migration.version)) {
        throw new MigrationError(
          `Duplicate migration version: ${migration.version}`,
          { version: migration.version }
        );
      }
      versions.add(migration.version);

      // Validate version is positive integer
      if (!Number.isInteger(migration.version) || migration.version <= 0) {
        throw new MigrationError(
          `Invalid migration version: ${migration.version}. Must be a positive integer.`,
          { version: migration.version }
        );
      }

      // Validate up and down functions exist
      if (typeof migration.up !== 'function') {
        throw new MigrationError(
          `Migration ${migration.version} is missing 'up' function`,
          { version: migration.version }
        );
      }

      if (typeof migration.down !== 'function') {
        throw new MigrationError(
          `Migration ${migration.version} is missing 'down' function`,
          { version: migration.version }
        );
      }
    }

    // Check for gaps in version numbers (optional warning)
    const sortedVersions = Array.from(versions).sort((a, b) => a - b);
    for (let i = 1; i < sortedVersions.length; i++) {
      const prevVersion = sortedVersions[i - 1];
      const currVersion = sortedVersions[i];
      if (prevVersion !== undefined && currVersion !== undefined && currVersion !== prevVersion + 1) {
        defaultLogger.warn(
          `Gap detected in migration versions: ${prevVersion} -> ${currVersion}`
        );
      }
    }
  }

  /**
   * Reset all migrations (dangerous - for testing only)
   */
  async reset(): Promise<void> {
    defaultLogger.warn('Resetting all migrations - this is a destructive operation!');

    await this.connection.exec(`DROP TABLE IF EXISTS ${MIGRATION_TABLE}`);

    defaultLogger.info('All migrations reset');
  }

  /**
   * Get migration status
   */
  async getStatus(migrations: Migration[]): Promise<{
    currentVersion: number;
    availableVersion: number;
    pendingMigrations: number[];
    appliedMigrations: MigrationRecord[];
  }> {
    const currentVersion = await this.getCurrentVersion();
    const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version);
    const availableVersion = sortedMigrations[sortedMigrations.length - 1]?.version ?? 0;
    
    const pendingMigrations = sortedMigrations
      .filter(m => m.version > currentVersion)
      .map(m => m.version);

    const appliedMigrations = await this.getAppliedMigrations();

    return {
      currentVersion,
      availableVersion,
      pendingMigrations,
      appliedMigrations,
    };
  }
}

/**
 * Create a migration runner
 */
export function createMigrationRunner(connection: Connection): MigrationRunner {
  return new MigrationRunner(connection);
}

