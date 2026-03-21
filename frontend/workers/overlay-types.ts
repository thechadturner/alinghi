/**
 * Overlay Data Processor Types
 */

export interface OverlayProcessingConfig {
  channels: Array<{
    name: string;
    type: string;
    color?: string;
  }>;
  timeRange?: {
    startTime: string | Date;
    endTime: string | Date;
  };
  chunkSize?: number;
  validate?: boolean;
  transform?: boolean;
}

export interface OverlayProcessingResult {
  data: any[];
  channels: Array<{
    name: string;
    type: string;
    color?: string;
  }>;
  processingTime: number;
  originalCount: number;
  processedCount: number;
  metadata: {
    timeRange: {
      start: number;
      end: number;
    };
    channelCount: number;
  };
}
