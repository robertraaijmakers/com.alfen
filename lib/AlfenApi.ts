'use strict';

import { IncomingHttpHeaders } from 'undici/types/header';
import { HttpsPromiseOptions, HttpsPromiseResponse, InfoResponse, PropertyResponseBody } from '../localTypes/types';

import { Pool } from 'undici';

const energyMeterCapabilitiesMap: { [key: string]: string } = {
  '2062_0': 'measure_current.stationlimit', // Max. station limit
  '2126_0': 'authmode',
  '2129_0': 'measure_current.limit', // Custom Set Limit (A)
  '2201_0': 'measure_temperature', // °C
  '2221_3': 'measure_voltage.l1', // A
  '2221_4': 'measure_voltage.l2', // A
  '2221_5': 'measure_voltage.l3', // A
  '2221_A': 'measure_current.l1', // V
  '2221_B': 'measure_current.l2', // V
  '2221_C': 'measure_current.l3', // V
  //'2221_13': 'measure_power.l1', // W
  //'2221_14': 'measure_power.l2', // W
  //'2221_15': 'measure_power.l3', // W
  '2221_16': 'measure_power', // W (Power / Vermogen)
  '2221_22': 'meter_power', // kWh (Energy / Energie)
  '2501_2': 'operatingmode',
  '3280_1': 'chargetype',
  '3280_2': 'greenshare',
  '3280_3': 'comfortchargelevel',
};

const apiHeader: string = 'alfen/json; charset=utf-8';
const apiUrl: string = 'api';

export class AlfenApi {
  #agent: Pool | null = null;
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

    this.#agent = new Pool(`https://${this.#ip}`, {
      connections: 1,
      pipelining: 1,
      keepAliveTimeout: 2000,
      keepAliveMaxTimeout: 5000,
      connect: { rejectUnauthorized: false },
    });

    if (this.#agent === null) {
      this.#log(`Creating new agent failed.`);
    }

    // Define the request body
    const body = JSON.stringify({
      username: this.#username,
      password: this.#password,
    });

    // Define the options for the HTTPS request
    const options = {
      path: `/${apiUrl}/login`,
      method: 'POST',
      headers: {},
    } as HttpsPromiseOptions;

    this.#log(`Set body & options`);

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise({ ...options, body });

      // Handle the response
      this.#log('Login successful:', response);
    } catch (error) {
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

    this.#log(`Logout procedure, logout & clean-up agent.`);

    // Define the options for the HTTPS request
    const options = {
      path: `/${apiUrl}/logout`,
      method: 'POST',
      headers: {} as IncomingHttpHeaders,
    } as HttpsPromiseOptions;

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise(options);
      this.#log('Logout successful: ', response);

      this.#agent?.destroy();
      this.#agent = null;

      // Handle the response
      this.#log('Agent destroyed');
    } catch (error) {
      this.#log('Logout failed:', error);
      this.#agent?.destroy();
    } finally {
      this.#agent = null;
    }
  }

  async apiGetChargerDetails() {
    // Define the options for the HTTPS request (no body, just headers)
    const options: HttpsPromiseOptions = {
      path: `/${apiUrl}/info`,
      method: 'GET',
      headers: {},
    } as HttpsPromiseOptions;

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise(options);

      // Handle the response
      this.#log('Info retrieved successfully:', response.body);
      return <InfoResponse>response.body;
    } catch (error) {
      throw new Error(`Request failed: ${error}`);
    }
  }

  async apiGetActualValues() {
    // Define the 'ids' parameter
    const ids = '2056_0,2060_0,2062_0,2126_0,2129_0,2201_0,2221_3,2221_4,2221_5,2221_0A,2221_0B,2221_0C,2221_13,2221_14,2221_15,2221_16,2221_22,2501_2,3280_1,3280_2,3280_3';

    // Define the options for the HTTPS request (no body, just headers)
    const options: HttpsPromiseOptions = {
      path: `/${apiUrl}/prop?ids=${ids}`, // Add the 'ids' parameter to the path
      method: 'GET',
      headers: {},
    } as HttpsPromiseOptions;

    let bodyResult: PropertyResponseBody;
    const capabilitiesData: Array<{
      capabilityId: string;
      value: number | string | boolean;
    }> = [];

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise(options);
      bodyResult = <PropertyResponseBody>response.body;
    } catch (error) {
      this.#log('Request failed:', error);
      throw new Error(`Request failed: ${error}`);
    }

    if (bodyResult === undefined) return capabilitiesData;

    // Handle the response
    const result = bodyResult.properties;

    for (const prop of result) {
      const capabilityId = energyMeterCapabilitiesMap[prop.id];

      this.#log(`Property: ${prop.id}: ${prop.value}, Type: ${prop.type}, Category: ${prop.cat}, Access: ${prop.access}, Capability: ${capabilityId ?? 'Unknown'}`);

      if (capabilityId) {
        let value: string | number | boolean | null = null;

        // Handle specific rounding or transformation for certain properties
        switch (prop.id) {
          case '2501_2':
            value = this.#statusToString(prop.value);
            break;
          case '2221_3': // Voltage L1
          case '2221_4': // Voltage L2
          case '2221_5': // Voltage L3
            value = Math.round(prop.value); // rounding values, no decimal
            break;
          case '2201_0': // Temperature
          case '2221_A': // Current L1
          case '2221_B': // Current L2
          case '2221_C': // Current L3
          case '2221_16': // Power (watts)
            value = Math.round(prop.value * 10) / 10; // rounding values, one decimal
            break;
          case '2221_22': // Total energy
            value = Math.round(prop.value / 10) / 100; // rounding values, 2 decimal (but needs to be devided by 1000)
            break;
          case '2126_0': // Auth mode
          case '3280_1': // Charge type
            value = prop.value.toString();
            break;
          default:
            value = prop.value;
            break;
        }

        // Collect the mapped data
        capabilitiesData.push({ capabilityId, value });
      }
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

  async apiSetCurrentLimit(currentLimit: number) {
    if (currentLimit < 1 || currentLimit > 32) return false;

    // Define the request body
    const body = JSON.stringify({
      '2129_0': {
        id: '2129_0',
        value: currentLimit,
      },
    });

    try {
      await this.#apiSetProperty(body);
    } catch (e) {
      throw new Error(`Error setting current limit: ${e}`);
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
    if (comfortChargingkWh < 1400 || comfortChargingkWh > 5000) return false;

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

  async #apiSetProperty(body: string) {
    // Define the options for the HTTPS request
    const options = {
      path: `/${apiUrl}/prop`,
      method: 'POST',
      headers: {},
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
    const { body, ...requestOptions } = options;

    if (body && body.length > 0) {
      requestOptions.headers = { 'Content-Length': Buffer.byteLength(body).toString(), ...requestOptions.headers };
    }

    if (requestOptions.path.indexOf('logout') <= 0) {
      requestOptions.headers = { Connection: 'keep-alive', ...requestOptions.headers };
    }

    const res = await this.#agent!.request({
      path: requestOptions.path,
      method: requestOptions.method,
      headers: {
        'User-Agent': 'undici',
        'Content-Type': apiHeader,
        ...requestOptions.headers,
      },
      body: body,
    });

    if (!res.statusCode || res.statusCode !== 200) {
      throw new Error(`Request failed with status: ${res.statusCode}`);
    }

    const rawBody = await res.body.text(); // Read body once as text
    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody); // Try parsing as JSON
    } catch {
      parsedBody = rawBody; // Fallback to text if JSON parsing fails
    }

    return { body: parsedBody, headers: res.headers } as HttpsPromiseResponse;
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
}
