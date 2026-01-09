// lib/models/ChargerDetails.ts

import { InfoResponse } from './InfoResponse';
import { ChargerSocketsInfo } from './SocketType';

/**
 * Combined charger details retrieved from /api/info
 * - info: raw charger information
 * - sockets: parsed socket configuration (single / duo)
 */
export type ChargerDetails = {
  /** Raw /api/info response */
  info: InfoResponse;

  /** Parsed socket configuration derived from info.Type */
  sockets: ChargerSocketsInfo;
};
