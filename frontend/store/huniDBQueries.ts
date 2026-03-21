/**
 * HuniDB Query Builders
 * 
 * Optimized query builders for common operations
 */

import { huniDBStore } from './huniDBStore.js';
import { TableNames, escapeTableName, type MultiChannelResult } from './huniDBTypes.js';
import type { Database } from '@hunico/hunidb';

/**
 * Query multiple channels with SQL JOINs
 */
export async function queryMultiChannel(
  className: string,
  channels: string[],
  datasetId: number,
  projectId: number,
  sourceId: number,
  timeRange?: { start: number; end: number }
): Promise<MultiChannelResult[]> {
  const db = await huniDBStore.getDatabase(className);

  if (channels.length === 0) {
    return [];
  }

  if (channels.length === 1) {
    // Single channel - use time-series query
    return await querySingleChannel(db, channels[0], datasetId, projectId, sourceId, timeRange);
  }

  // Multi-channel - query from single wide table
  const tableName = TableNames.timeSeries('timeseries_default');
  const escapedTableName = escapeTableName(tableName);
  
  // Get available columns
  const tableInfo = await db.query<{ name: string; type: string }>(
    `PRAGMA table_info(${escapedTableName})`
  );
  const availableColumns = new Set(tableInfo.map(col => col.name.toLowerCase()));
  
  // Filter channels to only those that exist as columns
  const validChannels = channels.filter(ch => {
    const chLower = ch.toLowerCase();
    return availableColumns.has(chLower) || availableColumns.has(ch);
  });
  
  if (validChannels.length === 0) {
    return [];
  }
  
  // Build SELECT clause
  const selects = [
    'timestamp',
    ...validChannels.map(ch => {
      const actualCol = tableInfo.find(col => col.name.toLowerCase() === ch.toLowerCase())?.name || ch;
      return `${actualCol} as ${ch}`;
    })
  ];
  
  const whereConditions: string[] = [];
  const params: any[] = [];
  
  // WHERE conditions
  whereConditions.push(`dataset_id = ?`);
  params.push(datasetId);
  whereConditions.push(`project_id = ?`);
  params.push(projectId);
  whereConditions.push(`source_id = ?`);
  params.push(sourceId);

  if (timeRange) {
    whereConditions.push(`timestamp >= ?`);
    params.push(timeRange.start);
    whereConditions.push(`timestamp <= ?`);
    params.push(timeRange.end);
  }

  const sql = `
    SELECT ${selects.join(', ')}
    FROM ${escapedTableName}
    WHERE ${whereConditions.join(' AND ')}
    ORDER BY timestamp ASC
  `;

  const results = await db.query<Record<string, any>>(sql, params);

  return results.map(row => {
    const result: MultiChannelResult = {
      timestamp: row.timestamp,
      Datetime: new Date(row.timestamp).toISOString(),
    };

    for (const channel of channels) {
      if (row[channel] !== undefined && row[channel] !== null) {
        result[channel] = row[channel];
      }
    }

    return result;
  });
}

/**
 * Query single channel
 */
async function querySingleChannel(
  db: Database,
  channel: string,
  datasetId: number,
  projectId: number,
  sourceId: number,
  timeRange?: { start: number; end: number }
): Promise<MultiChannelResult[]> {
  const tableName = TableNames.timeSeries('timeseries_default');
  const escapedTableName = escapeTableName(tableName);
  
  // Check if channel column exists
  const tableInfo = await db.query<{ name: string; type: string }>(
    `PRAGMA table_info(${escapedTableName})`
  );
  const channelCol = tableInfo.find(col => col.name.toLowerCase() === channel.toLowerCase());
  
  if (!channelCol) {
    return [];
  }
  
  const whereConditions: string[] = [];
  const params: any[] = [];
  
  whereConditions.push(`dataset_id = ?`);
  params.push(datasetId);
  whereConditions.push(`project_id = ?`);
  params.push(projectId);
  whereConditions.push(`source_id = ?`);
  params.push(sourceId);
  
  if (timeRange) {
    whereConditions.push(`timestamp >= ?`);
    params.push(timeRange.start);
    whereConditions.push(`timestamp <= ?`);
    params.push(timeRange.end);
  }
  
  const sql = `
    SELECT timestamp, ${channelCol.name} as ${channel}
    FROM ${escapedTableName}
    WHERE ${whereConditions.join(' AND ')}
    ORDER BY timestamp ASC
  `;
  
  const results = await db.query<Record<string, any>>(sql, params);
  
  return results.map(row => ({
    timestamp: row.timestamp,
    Datetime: new Date(row.timestamp).toISOString(),
    [channel]: row[channel],
  }));
}

/**
 * Query aggregated data (downsampling)
 */
export async function queryAggregated(
  className: string,
  channel: string,
  aggregation: { function: 'avg' | 'sum' | 'min' | 'max' | 'count'; interval: number },
  datasetId: number,
  projectId: number,
  sourceId: number,
  timeRange: { start: number; end: number }
): Promise<Array<{ timestamp: number; value: number }>> {
  const db = await huniDBStore.getDatabase(className);
  const tableName = TableNames.timeSeries('timeseries_default');
  const escapedTableName = escapeTableName(tableName);
  
  // Check if channel column exists
  const tableInfo = await db.query<{ name: string; type: string }>(
    `PRAGMA table_info(${escapedTableName})`
  );
  const channelCol = tableInfo.find(col => col.name.toLowerCase() === channel.toLowerCase());
  
  if (!channelCol) {
    return [];
  }
  
  const { function: aggFunc, interval } = aggregation;
  
  const sql = `
    SELECT 
      (timestamp / ${interval}) * ${interval} as bucket,
      ${aggFunc}(CAST(${channelCol.name} AS REAL)) as value
    FROM ${escapedTableName}
    WHERE timestamp >= ? 
      AND timestamp <= ?
      AND dataset_id = ?
      AND project_id = ?
      AND source_id = ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `;
  
  const results = await db.query<{ bucket: number; value: number }>(sql, [
    timeRange.start,
    timeRange.end,
    datasetId,
    projectId,
    sourceId
  ]);
  
  return results.map(row => ({
    timestamp: row.bucket,
    value: row.value,
  }));
}

/**
 * Query events with filters
 */
export async function queryEvents(
  className: string,
  filters?: {
    eventType?: string;
    timeRange?: { start: string; end: string };
    tags?: any;
  }
): Promise<any[]> {
  return await huniDBStore.queryEvents(className, filters);
}

