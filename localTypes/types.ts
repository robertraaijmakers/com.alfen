// localTypes/types.ts

'use strict';

import { IncomingHttpHeaders } from 'http';

export interface PairData {
  ip: string;
  user: string;
  pass: string;
}

export interface DeviceSettings {
  ip: string;
  username: string;
  password: string;
  socketIndex?: number;
  /** Poll interval in seconds (30-3600), default 120 */
  pollInterval?: number;
  fastPollInterval?: number;
  /** Allow Start/Stop and target power (charging profile) writes, default false */
  allowProfileWrites?: boolean;
  /** Read the active charge tag from the charger log, default false */
  readChargeTag?: boolean;
  /** Read P1 / smart meter values as the charger sees them, default false */
  readP1?: boolean;
  /** Minutes the device toggle releases the login for Eve before reconnecting (5-60), default 60 */
  releaseMinutes?: number;
  /** Total number of sockets of the charger (1 = Single, 2 = Duo) */
  socketCount?: number;
}

export interface EnergySettings {
  evCharger?: boolean;
  meterPowerImportedCapability?: string;
  meterPowerExportedCapability?: string;
}

export interface HttpsPromiseOptions {
  body?: string | Buffer;
  path: string;
  method: 'POST' | 'GET';
  headers: { [key: string]: string };
  keepAlive: boolean;
}

export interface HttpsPromiseResponse {
  body: string | object;
  headers: IncomingHttpHeaders;
}

export interface PropertyResponse {
  id: string;
  access: number;
  type: number;
  len: number;
  cat: string;
  value: number;
}

export interface PropertyResponseBody {
  properties: PropertyResponse[]; // Adjust based on actual response structure
}
