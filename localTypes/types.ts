'use strict';

import https from 'https';
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
}

export interface HttpsPromiseOptions {
  body?: string | Buffer;
  hostname: string;
  path: string;
  method: string;
  headers: { [key: string]: string };
  agent: https.Agent;
  rejectUnauthorized?: boolean; // Optional for SSL/TLS validation
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
