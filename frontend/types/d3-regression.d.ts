declare module 'd3-regression' {
  import { Accessor } from 'd3';

  export interface RegressionResult {
    a?: number;
    b?: number;
    c?: number;
    r2?: number;
    points: Array<[number, number]>;
  }

  export interface Regression {
    x(accessor: Accessor<number, any>): this;
    y(accessor: Accessor<number, any>): this;
    bandwidth(value: number): this;
    (data: any[]): Array<[number, number]>;
  }

  export function regressionLog(): Regression;
  export function regressionLoess(): Regression;
}

