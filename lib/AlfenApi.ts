'use strict';

import { HttpsPromiseOptions, HttpsPromiseResponse, InfoResponse, PropertyResponseBody } from '../localTypes/types';

import https from 'https';

const energyMeterCapabilitiesMap: { [key: string]: string } = {
  '2221_16': 'measure_power',
  // '2501_2': 'onoff',
  '2221_22': 'meter_power',
  '2221_A': 'measure_current.l1',
  '2221_B': 'measure_current.l2',
  '2221_C': 'measure_current.l3',
  '2221_3': 'measure_voltage.l1',
  '2221_4': 'measure_voltage.l2',
  '2221_5': 'measure_voltage.l3',
  '2201_0': 'measure_temperature',
  '2129_0': 'measure_current.limit',
};

export class AlfenApi {
  #apiHeader: string = 'alfen/json; charset=utf-8';
  #apiUrl: string = 'api';

  #agent!: https.Agent;

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
    this.#agent = new https.Agent({
      keepAlive: true, // Enable connection keep-alive
      maxSockets: 1, // Optionally limit the number of sockets (default is Infinity)
    });

    // Define the request body
    const body = JSON.stringify({
      username: this.#username,
      password: this.#password,
    });

    // Define the options for the HTTPS request
    const options = {
      hostname: this.#ip,
      path: `/${this.#apiUrl}/login`,
      method: 'POST',
      headers: {
        'Content-Type': this.#apiHeader,
        'Content-Length': Buffer.byteLength(body).toString(),
        Connection: 'keep-alive',
      },
      agent: this.#agent,
      rejectUnauthorized: false, // Disable SSL certificate validation if needed
    };

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise({ ...options, body });

      // Handle the response
      this.#log('Login successful:', response.body);
    } catch (error) {
      this.#log('Login failed:', error);
      throw new Error(`Login failed: ${error}`);
    }
  }

  async apiLogout() {
    // Define the options for the HTTPS request
    const options = {
      hostname: this.#ip,
      path: `/${this.#apiUrl}/logout`,
      method: 'POST',
      headers: {
        'Content-Type': this.#apiHeader,
      },
      agent: this.#agent,
      rejectUnauthorized: false, // Disable SSL certificate validation if needed
    };

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise(options);

      // Handle the response
      this.#log('Logout successful:', response.body);
    } catch (error) {
      this.#log('Logout failed:', error);
      throw new Error(`Logout failed: ${error}`);
    }
  }

  async apiGetChargerDetails() {
    // Define the options for the HTTPS request (no body, just headers)
    const options: HttpsPromiseOptions = {
      hostname: this.#ip,
      path: `/${this.#apiUrl}/info`,
      method: 'GET',
      headers: {
        'Content-Type': this.#apiHeader,
        Connection: 'keep-alive',
      },
      agent: this.#agent,
      rejectUnauthorized: false, // Disable SSL certificate validation if needed
    };

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise(options);

      // Handle the response
      this.#log('Info retrieved successfully:', response.body);
      return <InfoResponse>response.body;
    } catch (error) {
      this.#log('Request failed:', error);
      throw new Error(`Request failed: ${error}`);
    }
  }

  async apiGetActualValues() {
    // Define the 'ids' parameter
    const ids = '2060_0,2056_0,2221_3,2221_4,2221_5,2221_A,2221_B,2221_C,2221_16,2201_0,2501_2,2221_22,2129_0,2126_0';

    // Define the options for the HTTPS request (no body, just headers)
    const options: HttpsPromiseOptions = {
      hostname: this.#ip,
      path: `/${this.#apiUrl}/prop?ids=${ids}`, // Add the 'ids' parameter to the path
      method: 'GET',
      headers: {
        'Content-Type': this.#apiHeader,
        Connection: 'keep-alive',
      },
      agent: this.#agent,
      rejectUnauthorized: false, // Disable SSL certificate validation if needed
    };

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.#httpsPromise(options);

      // Handle the response
      this.#log('Properties retrieved successfully:', response.body);

      const bodyResult = <PropertyResponseBody>response.body;
      const result = bodyResult.properties;
      const capabilitiesData: Array<{
        capabilityId: string;
        value: number | string | boolean;
      }> = [];

      for (const prop of result) {
        const capabilityId = energyMeterCapabilitiesMap[prop.id];

        if (capabilityId) {
          let value: string | number | boolean | null = null;

          // Handle specific rounding or transformation for certain properties
          switch (prop.id) {
            case '2501_2':
              value = this.#statusToBool(prop.value);
              // capabilitiesData.push({ capabilityId: 'evcharger_state', value: this.statusToString(prop.value) });
              break;
            case '2221_3': // Ampere L1
            case '2221_4': // Ampere L2
            case '2221_5': // Ampere L3
              value = Math.round(prop.value); // rounding values, no decimal
              break;
            case '2201_0': // Temperature
            case '2221_16': // Power (watts)
              value = Math.round(prop.value * 10) / 10; // rounding values, one decimal
              break;
            case '2221_22': // Total energy
              value = Math.round(prop.value / 10) / 100; // rounding values, 2 decimal (but needs to be devided by 1000)
              break;
            default:
              value = prop.value;
              break;
          }

          // Collect the mapped data
          capabilitiesData.push({ capabilityId, value });
        }
      }

      return capabilitiesData;
    } catch (error) {
      this.#log('Request failed:', error);
      throw new Error(`Request failed: ${error}`);
    }
  }

  async #httpsPromise(options: HttpsPromiseOptions): Promise<HttpsPromiseResponse> {
    const { body, ...requestOptions } = options;

    return new Promise((resolve, reject) => {
      const req = https.request(requestOptions, (res) => {
        const chunks: Uint8Array[] = [];
        res.on('data', (data: Uint8Array) => chunks.push(data));
        res.on('end', () => {
          if (res.statusCode && res.statusCode !== 200) {
            reject(new Error(`Request failed with status ${res.statusCode}`));
            return;
          }

          this.#log(`Content-Length: ${res.headers['content-length']}`);
          this.#log(`Content-Type: ${res.headers['content-type']}`);
          this.#log(`Authorization: ${res.headers['Set-Cookie']}`);

          let resBody = Buffer.concat(chunks).toString();
          this.#log(resBody);

          switch (res.headers['content-type']) {
            case 'application/json':
            case 'alfen/json':
              try {
                resBody = JSON.parse(resBody);
              } catch (error) {
                reject(new Error(`Exception parsing JSON: ${error}`));
                return;
              }
              break;
            default:
              try {
                resBody = JSON.parse(resBody);
              } catch (error) {
                resBody = resBody.toString();
              }
              break;
          }

          resolve({ body: resBody, headers: res.headers });
        });
      });
      req.on('error', reject);
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  #statusToString(statusKey: number): string {
    const statusMapping: Record<number, string> = {
      4: 'Available',
      7: 'Cable connected',
      10: 'Vehicle connected',
      11: 'Charging',
      17: 'Session end', // (Unit with socket only?) Cable still connected to EVSE after charging, but car disconnected. Screen shows charging stats until cable disconnected from EVSE.
      26: 'ConnectorLock Failure', // Not able to lock cable. Please reconnect cable
      34: 'Blocked', // EVSE is blocked through management interface of CPO.
      36: 'Paused',
      41: 'Solar charging',
    };

    return statusMapping[statusKey] ?? 'Unknown';
  }

  #statusToBool(statusKey: number): boolean {
    const statusMapping: Record<number, boolean> = {
      4: false,
      7: true,
      10: true,
      11: true,
      17: true,
      26: true,
      34: false,
      36: true,
      41: true,
    };

    return statusMapping[statusKey] ?? false;
  }
}
