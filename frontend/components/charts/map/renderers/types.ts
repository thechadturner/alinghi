import * as d3 from "d3";
import { TrackPoint, TrackConfig } from "../hooks/useTrackRendering";

export interface TrackRendererProps {
  data: TrackPoint[];
  map: any;
  svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, any>;
  trackOverlay: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
  config: TrackConfig;
  onPointClick?: (point: TrackPoint) => void;
  onRangeSelect?: (start: TrackPoint, end: TrackPoint) => void;
  onMouseOver?: (event: MouseEvent, point: TrackPoint) => void;
  onMouseOut?: (event: MouseEvent) => void;
  samplingFrequency: number;
  currentTime?: Date;
  timeWindow?: number;
  tilesAvailable?: boolean;
  maneuversEnabled?: boolean;
  // Color and thickness functions from useTrackRendering
  getColor: (d: TrackPoint, prev: TrackPoint | null, config: TrackConfig) => string;
  getThickness: (d: TrackPoint, prev: TrackPoint | null, config: TrackConfig) => number;
}

export interface TimeSeriesRendererProps {
  data: TrackPoint[];
  svg: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
  xScale: d3.ScaleTime<number, number>;
  yScale: d3.ScaleLinear<number, number>;
  lineGenerator: d3.Line<TrackPoint>;
  config: TrackConfig;
  samplingFrequency: number;
  channel: string;
  colors: {
    lightGrey: string;
    red: string;
    lightGreen: string;
    green: string;
    yellow: string;
    blue: string;
    lightBlue: string;
    axis: string;
    text: string;
  };
  // D3 color scales from MapTimeSeries
  myOrdinalColor: d3.ScaleOrdinal<any, string>;
  myLinearColor: d3.ScaleLinear<number, string>;
  myLinearThickness: d3.ScaleLinear<number, string>;
  getColor: (d: TrackPoint, prev: TrackPoint) => string;
  getThickness: (type: string, d: TrackPoint, prev: TrackPoint) => number;
}

export interface RendererResult {
  success: boolean;
  error?: string;
}

export type TrackRenderer = (props: TrackRendererProps) => RendererResult;
export type TimeSeriesRenderer = (props: TimeSeriesRendererProps) => RendererResult;
