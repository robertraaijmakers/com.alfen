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
}

export interface HttpsPromiseOptions {
  body?: string | Buffer;
  path: string;
  method: string;
  headers: { [key: string]: string };
  keepAlive: boolean;
}

export interface HttpsPromiseResponse {
  body: string | object;
  headers: IncomingHttpHeaders;
}

export interface InfoResponse {
  Identity: string;
  ContentType: string;
  Model: string;
  ObjectId: string;
  Type: string;
  FWVersion: string;
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
