/**
 * Ambient type declarations for modules without @types and build globals.
 * Used to satisfy TS7016 and TS2304 without installing extra packages.
 */

declare module 'express' {
  export namespace Express {
    export interface Application {}
    export interface Request {}
    export interface Response {}
  }
}
declare module 'supertest';
declare module 'compression';
declare module 'cookie-parser';
declare module 'cors';
declare module 'robust-point-in-polygon';
declare module 'pg';

/** Production flag (may be set by build tooling) */
declare const __PROD__: boolean | undefined;
