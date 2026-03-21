/**
 * JSON Table API
 * 
 * Main exports for JSON document storage and querying
 */

export { JSONTable } from './table.js';
export { JSONIndexer } from './indexer.js';
export { JSONQueryBuilder } from './query-builder.js';
export { HybridQueryBuilder } from './hybrid.js';
export { FTSIndexer } from './fts.js';
export { TrigramIndexer } from './trigram.js';
export { createJSONTable, dropJSONTable } from './migration-helpers.js';
export type {
  JSONDocument,
  JSONFilter,
  JSONTableOptions,
  JSONTableMetadata,
} from './types.js';

