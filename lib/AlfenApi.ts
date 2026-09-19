//lib/AlfenApi.tx

'use strict';

import * as https from 'https';

import { HttpsPromiseOptions, HttpsPromiseResponse, PropertyResponseBody } from '../localTypes/types';
import { InfoResponse } from './models/InfoResponse';
import { parseChargerSocketsInfo } from './models/SocketType';
import { ChargerDetails } from './models/ChargerDetails';
import { SocketIndex, alfenProps, buildIds, forSocket, getActualValuePropIds, getCapabilityMap, normalizeApiId, propIdToApiId } from './alfenProps';
import { Cap, type CapabilityId } from './homeyCapabilities';

const apiUrl: string = 'api';

export class AlfenApi {
  #agent: https.Agent | null = null;
  #retrieving: number = 0;

  #ip: string;
  #username: string;
  #password: string;

  #log: (...args: any[]) => void;

  constructor(logger: (...args: any[]) => void, ip: string, username: string, password: string) {
    this.#log = logger || console.log;

    this.#ip = ip;
    this.#username = username;
    this.#password = password;
  }

  async apiLogin() {
    this.#log(`Starting login process: ${this.#retrieving}`);

    // Try handling multiple requests at the same time
    if (this.#retrieving > 10) {
      this.#retrieving = 1;
      await this.apiLogout();
    }

    if (this.#agent == null) this.#retrieving = 0;
    this.#retrieving += 1;
    if (this.#agent != null) return; // Already running another process and already loggedin

    this.#log(`Creating new agent and start login: ${this.#retrieving}`);

    this.#agent = new https.Agent({
      keepAlive: true,
      maxSockets: 1,
      rejectUnauthorized: false,
    });

    const body = JSON.stringify({
      username: this.#username,
      password: this.#password,
    });

    this.#log(`Set body & options`);

    try {
      const response = await this.#httpsRequestKeepAlive(this.#agent, `/${apiUrl}/login`, 'POST', body);
      this.#log('Login successful:', response);
    } catch (error) {
      this.#agent.destroy();
      this.#agent = null;
      this.#retrieving = 0;
      this.#log('Login failed:', error);
      throw new Error(`Login failed: ${error}`);
    }
  }

  async apiLogout() {
    this.#log(`Starting logout process: ${this.#retrieving}`);

    this.#retrieving -= 1;
    if (this.#retrieving > 0) return;
    if (this.#retrieving < 0) this.#retrieving = 0;

    // Nothing to tear down. This happens when a prior apiLogin() threw
    // (which already nulled #agent); we must not attempt an HTTPS call
    // against a null pool.
    if (!this.#agent) {
      this.#log('No active session, logout skipped.');
      return;
    }

    this.#log(`Logout procedure, logout & clean-up agent.`);

    try {
      const response = await this.#httpsRequestKeepAlive(this.#agent, `/${apiUrl}/logout`, 'POST');
      this.#log('Logout successful:', response);
    } catch (error) {
      this.#log('Logout failed:', error);
    } finally {
      this.#agent.destroy();
      this.#agent = null;
      this.#log('Agent destroyed');
    }
  }

  async apiGetChargerDetails(): Promise<ChargerDetails> {
    const options: HttpsPromiseOptions = {
      path: `/${apiUrl}/info`,
      method: 'GET',
      headers: {},
      keepAlive: true,
    };

    try {
      const response = await this.#httpsPromise(options);

      const info = response.body as InfoResponse;
      const sockets = parseChargerSocketsInfo(info.Type);

      this.#log('Info retrieved successfully:', info);
      this.#log('Sockets parsed:', sockets);

      return { info, sockets };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`apiGetChargerDetails failed: ${msg}`);
    }
  }

  async apiGetActualValues(socketIndex: SocketIndex = 1) {
    const propIds = getActualValuePropIds(socketIndex);
    const ids = buildIds(propIds);

    const options: HttpsPromiseOptions = {
      path: `/${apiUrl}/prop?ids=${ids}`,
      method: 'GET',
      headers: {},
      keepAlive: true,
    };

    let bodyResult: PropertyResponseBody;
    const capabilitiesData: Array<{
      capabilityId: string;
      value: number | string | boolean;
    }> = [];

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise(options);
      bodyResult = <PropertyResponseBody>response.body;

      const additionalData = await this.#apiGetChargingLimit();
      capabilitiesData.push(...additionalData);
    } catch (error) {
      this.#log('Request failed:', error);
      throw new Error(`Request failed: ${error}`);
    }

    // A successful HTTP 200 but missing/malformed body means the session is
    // live but the charger returned something we cannot parse. Treat as an
    // error so the caller can invalidate and retry; silently returning [] here
    // would leave Homey showing stale capability values indefinitely.
    if (bodyResult === undefined || !Array.isArray(bodyResult?.properties)) {
      throw new Error('apiGetActualValues: unexpected response body (no properties array).');
    }

    // Handle the response
    const result = bodyResult.properties;

    // primary map for this socket
    const capMap = getCapabilityMap(socketIndex);

    // fallback for Duo: some firmwares still return socket-1 ids
    const fallbackMap = undefined;
    for (const prop of result) {
      const apiId = normalizeApiId(prop.id);
      const capabilityId = capMap[apiId] ?? fallbackMap?.[apiId];

      this.#log(`Property: ${apiId}: ${prop.value}, Type: ${prop.type}, Category: ${prop.cat}, Access: ${prop.access}, Capability: ${capabilityId ?? 'Unknown'}`);

      if (!capabilityId) {
        // development aid: shows missing mappings
        this.#log(`Unmapped prop id: ${apiId} (raw=${prop.id}, socketIndex=${socketIndex})`);
        continue;
      }

      const normalized = this.#normalizeCapabilityValue(capabilityId, prop.value, apiId);

      if (normalized?.derived?.length) {
        for (const d of normalized.derived) {
          capabilitiesData.push(d);
        }
      }

      if (normalized?.value !== undefined) {
        capabilitiesData.push({
          capabilityId,
          value: normalized.value,
        });
      }
    }

    // For UI: add a single total current so you can easily see socket-1 vs socket-2.
    // Uses max phase current (works for 1p + 3p).
    const i1 = Number(capabilitiesData.find((x) => x.capabilityId === 'measure_current.l1')?.value ?? 0);
    const i2 = Number(capabilitiesData.find((x) => x.capabilityId === 'measure_current.l2')?.value ?? 0);
    const i3 = Number(capabilitiesData.find((x) => x.capabilityId === 'measure_current.l3')?.value ?? 0);
    const current = Math.round(Math.max(i1, i2, i3) * 10) / 10;
    if (!Number.isNaN(current)) {
      capabilitiesData.push({ capabilityId: 'measure_current', value: current });
    }

    // Calculate power (Volt * Ampere = Watt) for L1, L2, and L3
    ['l1', 'l2', 'l3'].forEach((phase) => {
      const voltage = capabilitiesData.find((x) => x.capabilityId === `measure_voltage.${phase}`)?.value;
      const current = capabilitiesData.find((x) => x.capabilityId === `measure_current.${phase}`)?.value;
      if (voltage && current && !isNaN(Number(voltage)) && !isNaN(Number(current))) {
        capabilitiesData.push({ capabilityId: `measure_power.${phase}`, value: Math.round(Number(voltage) * Number(current) * 10) / 10 });
      } else {
        capabilitiesData.push({ capabilityId: `measure_power.${phase}`, value: 0 });
      }
    });

    return capabilitiesData;
  }

  /**
   * Get the RFID/Plug&Charge tag of the currently active (started, not yet stopped) session
   * for a single socket, by scanning /api/transactions (same endpoint & line format used by
   * https://github.com/leeyuentuen/alfen_wallbox, see txstart/txstop parsing).
   *
   * Resumes from `offset` so repeated calls only need to scan newly appended lines.
   * Bounded by `maxDurationMs` so a cold start (offset 0, large history) can never block
   * the polling loop for long: it just returns the furthest cursor reached so far, and the
   * caller resumes from there on the next call.
   */
  async apiGetActiveChargeTag(socketIndex: SocketIndex, offset: number = 0, maxDurationMs: number = 8000): Promise<{ tag: string | null; offset: number; caughtUp: boolean }> {
    this.#log('apiGetActiveChargeTag called with socketIndex:', socketIndex, 'offset:', offset);
    // Just a sanity ceiling against garbage/negative values, not a real protocol limit -
    // chargers with a long transaction history can legitimately exceed six-digit tids.
    const maxOffset = Number.MAX_SAFE_INTEGER;
    const targetSocket = `Socket ${socketIndex}`;
    const deadline = Date.now() + maxDurationMs;
    const startingCursor = Number.isFinite(offset) && offset >= 0 ? Math.min(offset, maxOffset) : 0;

    let cursor = startingCursor;
    let sessionTag: string | null = null;
    let sessionActive = false;
    let counter = 0;
    let loop = true;
    // TEMP diagnostics: counts per line type seen during this scan.
    const seen = { txstart: 0, txstop: 0, mv: 0, dto: 0, unknown: 0 };
    // Only the explicit 0_Empty marker (or an empty body) from the charger confirms
    // we've reached the live end of the log; every other exit path is inconclusive.
    let caughtUp = false;
    // The charger can apparently return an old/stale replay of its earliest retained
    // history when queried at an offset past its real writable range (instead of a
    // clean empty response). If the very first page we read is clearly ancient, back
    // the cursor off and retry a few times (bounded by the time budget) before giving up.
    const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;
    const MAX_STALE_BACKOFF_ATTEMPTS = 6;
    let isFirstPage = true;
    let staleStart = false;
    let staleBackoffAttempts = 0;
    let staleBackoffStep = 2000;

    try {
      while (loop) {
        if (Date.now() >= deadline) {
          this.#log('apiGetActiveChargeTag: time budget exceeded, deferring rest to next call. cursor:', cursor);
          break;
        }
        const requestedCursor = Math.min(Math.max(cursor, 0), maxOffset);
        cursor = requestedCursor;

        const options: HttpsPromiseOptions = {
          path: `/${apiUrl}/transactions?offset=${cursor}`,
          method: 'GET',
          headers: {},
          keepAlive: true,
        };

        const response = await this.#httpsPromise(options);
        const text = typeof response.body === 'string' ? response.body : '';
        const lines = text.split('\n');

        this.#log('apiGetActiveChargeTag raw page:', { cursor, text });

        // No more data available right now at this cursor - we've caught up to the
        // charger's live position (a new line only appears once something changes).
        if (!text || lines.length === 0) {
          caughtUp = true;
          break;
        }

        // Tracks how far this whole page lets us advance. A page can mix a leading
        // "dto" hint with much older entries further behind our current cursor (e.g.
        // when the retained history restarts from an earlier point); advancing must
        // be judged once per full page, not line-by-line against a moving cursor.
        let pageAdvancedTo = requestedCursor;
        let pageMaxDate: number | null = null;

        for (const rawLine of lines) {
          let line = rawLine;
          if (!line) break;

          let tidStr = '';
          try {
            if (line.includes('version')) {
              line = line.split(':2,')[1] ?? line;
            }
            const parts = line.split(' ');
            tidStr = parts[0].split('_')[0];

            if (line.includes('txstart')) {
              const socket = `${parts[3]} ${parts[4]?.split(',')[0] ?? ''}`;
              seen.txstart += 1;
              // Charger reports lowercase "socket N"; compare case-insensitively.
              if (socket.toLowerCase() === targetSocket.toLowerCase()) {
                sessionTag = parts[8] ?? null;
                sessionActive = true;
              }
            } else if (line.includes('txstop')) {
              const socket = `${parts[3]} ${parts[4]?.split(',')[0] ?? ''}`;
              seen.txstop += 1;
              if (socket.toLowerCase() === targetSocket.toLowerCase()) {
                sessionActive = false;
              }
            } else if (line.includes('mv')) {
              seen.mv += 1;
            } else if (line.includes('dto')) {
              seen.dto += 1;
            } else if (line.includes('0_Empty')) {
              loop = false;
              caughtUp = true;
              break;
            } else {
              // Empty/placeholder slots (e.g. "629965_}") can appear in long contiguous
              // runs; still carry an id prefix we can advance past.
              seen.unknown += 1;
            }
          } catch {
            loop = false;
            break;
          }

          const parsedOffset = parseInt(tidStr, 10);
          if (!Number.isNaN(parsedOffset)) {
            pageAdvancedTo = Math.max(pageAdvancedTo, parsedOffset + 1);

            const dateMatch = line.match(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
            const ts = dateMatch ? new Date(`${dateMatch[1]}T${dateMatch[2]}`).getTime() : NaN;
            if (Number.isFinite(ts)) {
              pageMaxDate = pageMaxDate === null ? ts : Math.max(pageMaxDate, ts);
            }
          }

          if (line === lines[lines.length - 1]) break;
        }

        if (isFirstPage) {
          isFirstPage = false;
          if (pageMaxDate !== null && Date.now() - pageMaxDate > STALE_THRESHOLD_MS) {
            if (staleBackoffAttempts < MAX_STALE_BACKOFF_ATTEMPTS) {
              staleBackoffAttempts += 1;
              const backedOffCursor = Math.max(0, requestedCursor - staleBackoffStep);
              this.#log('apiGetActiveChargeTag: stale content, backing off and retrying.', {
                requestedCursor,
                pageMaxDate: new Date(pageMaxDate).toISOString(),
                backedOffCursor,
                attempt: staleBackoffAttempts,
              });
              cursor = backedOffCursor;
              staleBackoffStep *= 4;
              isFirstPage = true;
              continue;
            }

            this.#log('apiGetActiveChargeTag: resumed offset stayed stale after backoff retries, giving up for now.', {
              requestedCursor,
              pageMaxDate: new Date(pageMaxDate).toISOString(),
            });
            cursor = requestedCursor;
            staleStart = true;
            loop = false;
            break;
          }
        }

        if (pageAdvancedTo > requestedCursor) {
          cursor = Math.min(pageAdvancedTo, maxOffset);
          counter = 0;
        } else {
          // No forward progress across the whole page; not a confirmed end-of-log.
          counter += 1;
        }

        if (counter >= 2) {
          loop = false;
        }
      }
    } catch (error) {
      // Not all firmwares/configurations expose transaction history; treat as non-fatal.
      this.#log('apiGetActiveChargeTag failed (ignored):', error);
    }

    if (staleStart && !caughtUp) {
      cursor = Math.round(cursor / 2);
      offset = cursor;
    }

    this.#log('apiGetActiveChargeTag result:', { sessionTag, sessionActive, cursor, caughtUp, staleStart, seen });
    return { tag: sessionActive ? sessionTag : null, offset, caughtUp };
  }

  async #apiGetChargingLimit(): Promise<Array<{ capabilityId: string; value: number | string | boolean }>> {
    const options: HttpsPromiseOptions = {
      path: `/${apiUrl}/chargingprofiles?cpid=-19930828`,
      method: 'GET',
      headers: {},
      keepAlive: true,
    };

    const capabilitiesData: Array<{
      capabilityId: string;
      value: number | string | boolean;
    }> = [];

    try {
      const response = await this.#httpsPromise(options);

      type ChargingProfileResponse = {
        profile?: {
          csChargingProfiles?: {
            limit?: number[];
            numberPhases?: number[];
          };
        };
      };

      const body = response.body as ChargingProfileResponse;
      const ampsPerPhase = Number(body?.profile?.csChargingProfiles?.limit?.[0]);
      const phasesRaw = Number(body?.profile?.csChargingProfiles?.numberPhases?.[0]);
      const phases = Number.isFinite(phasesRaw) && phasesRaw > 0 ? phasesRaw : 3;

      if (!Number.isFinite(ampsPerPhase)) {
        throw new Error('apiGetChargingLimit: profile response did not contain a numeric limit[0].');
      }

      // Convert A per phase back to total power in Watts for target_power.
      const limitWatts = ampsPerPhase * phases * 230;
      capabilitiesData.push({
        capabilityId: 'target_power',
        value: limitWatts,
      });

      this.#log('Charging limit profile read:', {
        ampsPerPhase,
        phases,
        limitWatts,
      });
    } catch (error) {
      this.#log('Request failed:', error);
      // Not all chargers support this reading (404 not found), treat as non-fatal and just return no limit data.
    }

    return capabilitiesData;
  }

  async apiSetCurrentLimit(currentLimit: number, socketIndex: SocketIndex = 1) {
    if (currentLimit < 1 || currentLimit > 32) return false;

    // Socket 1 -> "2129_0"; Socket 2 -> "3129_0" (see alfenProps.forSocket)
    const apiId = propIdToApiId(forSocket(alfenProps.socketBase.currentLimit, socketIndex));

    // Define the request body
    const body = JSON.stringify({
      [apiId]: {
        id: apiId,
        value: currentLimit,
      },
    });

    try {
      await this.#apiSetProperty(body);
    } catch (e) {
      throw new Error(`Error setting current limit (socket ${socketIndex}): ${e}`);
    }

    return true;
  }

  async apiSetChargingLimit(limitWatts: number, activePhases: number = 3) {
    this.#log(`Executing apiSetChargingLimit: ${limitWatts} W, activePhases: ${activePhases}`);

    if (!Number.isFinite(limitWatts) || limitWatts < 0) return false;
    if (!Number.isInteger(activePhases) || activePhases < 1 || activePhases > 3) return false;

    this.#log(`Setting charging limit: ${limitWatts} W, activePhases: ${activePhases}`);

    // The target_power capability uses Watts. Convert W -> A and divide over active phases.
    const totalAmps = Math.round((limitWatts / 230) * 10) / 10;
    const ampsPerPhase = Math.round((totalAmps / activePhases) * 10) / 10;

    const body = JSON.stringify({
      connectorId: 0,
      csChargingProfiles: {
        chargingProfileId: -19930828,
        chargingProfileKind: 'Relative',
        chargingProfilePurpose: 'ChargingStationExternalConstraints',
        stackLevel: 0,
        useLocalTime: true,
        useRandomisedDelay: false,
        chargingSchedule: {
          chargingRateUnit: 'A',
          chargingSchedulePeriod: [
            {
              startPeriod: 0,
              limit: ampsPerPhase,
              numberPhases: activePhases,
            },
          ],
        },
      },
    });

    this.#log(`Constructed charging limit profile body: ${body}`);

    if (!this.#agent) {
      throw new Error('No active session: apiLogin() required before making requests.');
    }

    try {
      const response = await this.#httpsRequestKeepAlive(this.#agent, `/${apiUrl}/chargingprofiles?add`, 'POST', body);
      this.#log('Charging profile updated:', { limitWatts, activePhases, ampsPerPhase, response: response.body });
    } catch (error) {
      throw new Error(`Error setting charging limit profile: ${error}`);
    }

    return true;
  }

  async apiSetChargeType(chargeType: string) {
    // Define the request body
    const body = JSON.stringify({
      '3280_1': {
        id: '3280_1',
        value: chargeType,
      },
    });

    try {
      await this.#apiSetProperty(body);
    } catch (e) {
      throw new Error(`Error setting charge type: ${e}`);
    }

    return true;
  }

  async apiSetGreenSharePercentage(percentage: number) {
    if (percentage < 0 || percentage > 100) return false;

    // Define the request body
    const body = JSON.stringify({
      '3280_2': {
        id: '3280_2',
        value: percentage,
      },
    });

    try {
      await this.#apiSetProperty(body);
    } catch (e) {
      throw new Error(`Error setting green share percentage: ${e}`);
    }

    return true;
  }

  async apiSetComfortChargeLevel(comfortChargingkWh: number) {
    if (comfortChargingkWh < 1400 || comfortChargingkWh > 11000) return false;

    // Define the request body
    const body = JSON.stringify({
      '3280_3': {
        id: '3280_3',
        value: comfortChargingkWh,
      },
    });

    try {
      await this.#apiSetProperty(body);
    } catch (e) {
      throw new Error(`Error setting comfort charge level: ${e}`);
    }

    return true;
  }

  async apiSetAuthMode(authMode: string) {
    // Define the request body
    const body = JSON.stringify({
      '2126_0': {
        id: '2126_0',
        value: authMode,
      },
    });

    try {
      await this.#apiSetProperty(body);
    } catch (e) {
      throw new Error(`Error setting auth mode: ${e}`);
    }

    return true;
  }

  async apiSetChargeID(chargeID: string) {
    // Define the request body
    const body = JSON.stringify({
      '2063_0': {
        id: '2063_0',
        value: chargeID,
      },
    });

    try {
      await this.#apiSetProperty(body);
    } catch (e) {
      throw new Error(`Error setting charge ID: ${e}`);
    }

    return true;
  }

  async apiRebootEvCharger() {
    // Define the request body
    const body = JSON.stringify({
      command: 'reboot',
    });

    // Define the options for the HTTPS request
    const options = {
      path: `/${apiUrl}/cmd`,
      method: 'POST',
      headers: {},
      keepAlive: true,
    } as HttpsPromiseOptions;

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise({ ...options, body });

      // Handle the response
      this.#log('Start reboot:', response.body);
      return true;
    } catch (error) {
      throw new Error(`Reboot failed: ${error}`);
    }
  }

  /**
   * Operative mode (prop 205F_0): 0 = Operative (resume), 2 = In-operative (pause).
   */
  async apiSetOperativeMode(value: 0 | 2) {
    const body = JSON.stringify({
      '205F_0': {
        id: '205F_0',
        value,
      },
    });

    try {
      await this.#apiSetProperty(body);
    } catch (e) {
      throw new Error(`Error setting operative mode: ${e}`);
    }

    return true;
  }

  async #apiSetProperty(body: string) {
    // Define the options for the HTTPS request
    const options = {
      path: `/${apiUrl}/prop`,
      method: 'POST',
      headers: {},
      keepAlive: true,
    } as HttpsPromiseOptions;

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise({ ...options, body });

      // Handle the response
      this.#log('Written property:', response.body);
    } catch (error) {
      throw new Error(`Property write failed: ${error}`);
    }
  }

  async #httpsPromise(options: HttpsPromiseOptions): Promise<HttpsPromiseResponse> {
    if (!this.#agent) {
      throw new Error('No active session: apiLogin() required before making requests.');
    }

    const result = await this.#httpsRequestKeepAlive(this.#agent, options.path, options.method, options.body as string | undefined);

    return { body: result.body, headers: result.headers };
  }

  async #httpsRequestKeepAlive(agent: https.Agent, path: string, method: 'POST' | 'GET', body?: string): Promise<HttpsPromiseResponse & { statusCode: number }> {
    const headers: Record<string, string> = {
      Connection: 'Keep-Alive',
      'Content-Type': 'application/json',
      'User-Agent': '',
      Accept: 'application/json',
      'Accept-Encoding': '',
    };

    if (body !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }

    const raw = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = https.request(
        {
          hostname: this.#ip,
          path,
          method,
          headers,
          agent,
          rejectUnauthorized: false,
          timeout: 15000,
        },
        (res: import('http').IncomingMessage) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk;
          });
          res.on('end', () => {
            resolve({ statusCode: Number(res.statusCode || 0), body: data });
          });
        },
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error(`Request timed out: ${method} ${path}`));
      });

      if (body !== undefined) {
        req.write(body);
      }

      req.end();
    });

    if (raw.statusCode !== 200) {
      throw new Error(`Request failed with status ${raw.statusCode}: ${raw.body}`);
    }

    let parsedBody: string | object;
    try {
      parsedBody = JSON.parse(raw.body) as object;
    } catch {
      parsedBody = raw.body;
    }

    return {
      statusCode: raw.statusCode,
      body: parsedBody,
      headers: {},
    };
  }

  #normalizeCapabilityValue(
    capabilityId: CapabilityId,
    raw: unknown,
    propId: string,
  ): { value?: number | string | boolean; derived?: Array<{ capabilityId: CapabilityId; value: number | string | boolean }> } {
    if (raw === null || raw === undefined) return {};

    let v: unknown = raw;

    if (capabilityId === Cap.OperatingMode && typeof v === 'number') {
      const value = this.#statusToString(v);
      const enumString = this.#statusToEnum(v);
      const isCharging = enumString === 'plugged_in_charging';

      return {
        value,
        derived: [
          { capabilityId: Cap.EvChargingState, value: enumString },
          { capabilityId: Cap.EvCharging, value: isCharging },
        ],
      };
    }

    // if (capabilityId === Cap.EvCharging && typeof v === 'number') {
    //   // Handle different property types that map to evcharger_charging:
    //   // - value 1 from some properties -> true
    //   // - operative mode (205F_0): 0 = operative -> true, 2 = in-operative -> false
    //   if (v === 1) return { value: true };
    //   if (v === 0 || v === 2) return { value: v === 0 };
    //   return {};
    // }

    // String capabilities
    if (capabilityId === Cap.AuthMode || capabilityId === Cap.ChargeType || capabilityId === Cap.ChargeID) {
      return { value: String(v) };
    }

    // Numeric capabilities (Alfen returns these sometimes as string)
    if (capabilityId === Cap.GreenShare || capabilityId === Cap.ComfortChargeLevel) {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? { value: n } : {};
    }

    // Try parse numeric strings for numeric capabilities
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) v = n;
    }

    if (typeof v === 'number') {
      if (capabilityId === Cap.MeasureTemperature) return { value: Math.round(v * 10) / 10 };
      if (capabilityId.startsWith('measure_voltage')) return { value: Math.round(v) };
      if (capabilityId.startsWith('measure_current')) return { value: Math.round(v * 10) / 10 };

      if (capabilityId.startsWith('measure_power')) {
        // Alfen returns real power in Watts (property 2221_16 and its per-phase variants).
        // A previous heuristic multiplied small values by 1000, which turned idle
        // standby (~5 W) into a ghost 5 kW reading on the dashboard. See issue #24.
        return { value: Math.round(v * 10) / 10 };
      }

      if (capabilityId === Cap.MeterPower) return { value: Math.round(v / 10) / 100 };

      return { value: v };
    }

    return { value: v as any };
  }

  #statusToString(statusKey: number): string {
    const statusMapping: Record<number, string> = {
      0: 'Unknown',
      1: 'Off',
      2: 'Booting',
      3: 'Check Mains',
      4: 'Available',
      5: 'Authorizing',
      6: 'Authorized',
      7: 'Cable connected',
      8: 'EV Connected',
      9: 'Preparing Charging',
      10: 'Wait Vehicle Charging',
      11: 'Charging Normal',
      12: 'Charging Simplified',
      13: 'Suspended Over-Current',
      14: 'Suspended HF Switching',
      15: 'Suspended EV Disconnected',
      16: 'Finish Wait Vehicle',
      17: 'Finish Wait Disconnect',
      18: 'Error Protective Earth',
      19: 'Error Power Failure',
      20: 'Error Contactor Fault',
      21: 'Error Charging',
      22: 'Error Power Failure',
      23: 'Error Error Temperature',
      24: 'Error Illegal CP Value',
      25: 'Error Illegal PP Value',
      26: 'Error Too Many Restarts',
      27: 'Error',
      28: 'Error Message',
      29: 'Error Message Not Authorised',
      30: 'Error Message Cable Not Supported',
      31: 'Error Message S2 Not Opened',
      32: 'Error Message Time-Out',
      33: 'Reserved',
      34: 'In Operative',
      35: 'Load Balancing Limited',
      36: 'Load Balancing Forced Off',
      38: 'Not Charging',
      39: 'Solar Charging Wait',
      40: 'Charging Non Charging',
      41: 'Solar Charging',
      42: 'Charge Point Ready, Waiting For Power',
      43: 'Partial Solar Charging',
    };

    return statusMapping[statusKey] ?? 'Unknown';
  }

  #statusToEnum(statusKey: number): string {
    const statusMapping: Record<number, string> = {
      0: 'plugged_out',
      1: 'plugged_out',
      2: 'plugged_out',
      3: 'plugged_out',
      4: 'plugged_out',
      5: 'plugged_out',
      6: 'plugged_out',
      7: 'plugged_in',
      8: 'plugged_in',
      9: 'plugged_in',
      10: 'plugged_in',
      11: 'plugged_in_charging',
      12: 'plugged_in_charging',
      13: 'plugged_in_paused',
      14: 'plugged_in_paused',
      15: 'plugged_in_paused',
      16: 'plugged_in_paused',
      17: 'plugged_in_paused',
      18: 'plugged_in_paused',
      19: 'plugged_in_paused',
      20: 'plugged_in_paused',
      21: 'plugged_in_paused',
      22: 'plugged_in_paused',
      23: 'plugged_in_paused',
      24: 'plugged_in_paused',
      25: 'plugged_in_paused',
      26: 'plugged_in_paused',
      27: 'plugged_in_paused',
      28: 'plugged_in_paused',
      29: 'plugged_in_paused',
      30: 'plugged_in_paused',
      31: 'plugged_in_paused',
      32: 'plugged_in_paused',
      33: 'plugged_in_paused',
      34: 'plugged_in_paused',
      35: 'plugged_in_charging',
      36: 'plugged_in_charging',
      38: 'plugged_in_paused',
      39: 'plugged_in_paused',
      40: 'plugged_in_paused',
      41: 'plugged_in_charging',
      42: 'plugged_in_paused',
      43: 'plugged_in_charging',
    };

    return statusMapping[statusKey] ?? 'plugged_out';
  }
}
