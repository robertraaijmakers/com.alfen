// localTypes/types.ts

'use strict';

import { IncomingHttpHeaders } from 'undici/types/header';

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
