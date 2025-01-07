'use strict';

import Homey from 'homey';
import https from 'https';
import { IncomingHttpHeaders } from 'http';
import PairSession from 'homey/lib/PairSession';
import { PairData } from './types';

interface HttpsPromiseOptions {
  body?: string | Buffer;
  hostname: string;
  path: string;
  method: string;
  headers: { [key: string]: string };
  agent: https.Agent,
  rejectUnauthorized?: boolean; // Optional for SSL/TLS validation
}

interface HttpsPromiseResponse {
  body: string | object;
  headers: IncomingHttpHeaders;
}

interface InfoResponse {
  Identity: string,
  ContentType: string,
  Model: string,
  ObjectId: string,
  Type: string,
  FWVersion: string,
}

module.exports = class MyDriver extends Homey.Driver {

  apiHeader: string = 'alfen/json; charset=utf-8';
  apiUrl: string = 'api';

  ip?: string;
  username?: string;
  password?: string;
  tempId?: string;

  infoData?: InfoResponse;

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');
  }

  async onPair(session: PairSession) {
    session.setHandler('validate', async (data: PairData) => {
      this.homey.log('Pair data received');

      this.ip = data.ip;
      this.username = data.user;
      this.password = data.pass;

      const agent = new https.Agent({
        keepAlive: true, // Enable connection keep-alive
        maxSockets: 1, // Optionally limit the number of sockets (default is Infinity)
      });

      try {
        await this.apiLogin(agent);
      } catch (error) {
        throw new Error('Error logging in to charger, note that your Homey should be on the same subnet as your charger. This is a fysical limitation by Alfen.');
      }

      try {
        const result = await this.apiGetChargerDetails(agent);
        this.infoData = result;
        await this.apiLogout(agent);
        this.log(result);
      } catch (error) {
        throw new Error('Login was successful, but couldn\'t retrieve charge information. Your charger is probably not supported or has firmware incompatible with this Homey app.');
      }

      return true;
    });

    session.setHandler('list_devices', async () => {
      this.homey.log('Listing devices');

      const devicesList = [];

      if (this.ip && this.username && this.password && this.infoData) {
        devicesList.push({
          name: this.infoData.Identity ?? 'Alfen Charger',
          data: {
            id: this.infoData.ObjectId ?? 'my-charger',
            model: this.infoData.Model ?? 'Unknown',
            type: this.infoData.Type ?? 'Unknown',
            fwVersion: this.infoData.FWVersion ?? 'Unknown',
            contentType: this.infoData.ContentType ?? 'Unknown',
          },
          settings: {
            ip: this.ip,
            username: this.username,
            password: this.password,
          },
        });
      }

      return devicesList;
    });
  }

  async apiLogin(agent: https.Agent) {
    const {
      username, password, ip, apiUrl, apiHeader,
    } = this;

    // Define the request body
    const body = JSON.stringify({
      username,
      password,
    });

    // Define the options for the HTTPS request
    const options = {
      hostname: ip ?? '',
      path: `/${apiUrl}/login`,
      method: 'POST',
      headers: {
        'Content-Type': apiHeader,
        'Content-Length': Buffer.byteLength(body).toString(),
        Connection: 'keep-alive',
      },
      agent,
      rejectUnauthorized: false, // Disable SSL certificate validation if needed
    };

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.httpsPromise({ ...options, body });

      // Handle the response
      this.log('Login successful:', response.body);
    } catch (error) {
      this.error('Login failed:', error);
      throw new Error(`Login failed: ${error}`);
    }
  }

  async apiLogout(agent: https.Agent) {
    const {
      ip, apiUrl, apiHeader,
    } = this;

    // Define the options for the HTTPS request
    const options = {
      hostname: ip ?? '',
      path: `/${apiUrl}/logout`,
      method: 'POST',
      headers: {
        'Content-Type': apiHeader,
      },
      agent,
      rejectUnauthorized: false, // Disable SSL certificate validation if needed
    };

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.httpsPromise(options);

      // Handle the response
      this.log('Logout successful:', response.body);
    } catch (error) {
      this.error('Logout failed:', error);
      throw new Error(`Logout failed: ${error}`);
    }
  }

  async apiGetChargerDetails(agent: https.Agent) {
    const {
      ip, apiHeader, apiUrl,
    } = this;

    // Define the options for the HTTPS request (no body, just headers)
    const options: HttpsPromiseOptions = {
      hostname: ip ?? '',
      path: `/${apiUrl}/info`,
      method: 'GET',
      headers: {
        'Content-Type': apiHeader,
        Connection: 'keep-alive',
      },
      agent,
      rejectUnauthorized: false, // Disable SSL certificate validation if needed
    };

    try {
      // Make the HTTPS request using the httpsPromise method
      const response = await this.httpsPromise(options);

      // Handle the response
      this.log('Info retrieved successfully:', response.body);
      return <InfoResponse>response.body;
    } catch (error) {
      this.error('Request failed:', error);
      throw new Error(`Request failed: ${error}`);
    }
  }

  httpsPromise(options: HttpsPromiseOptions): Promise<HttpsPromiseResponse> {
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

          this.log(`Content-Length: ${res.headers['content-length']}`);
          this.log(`Content-Type: ${res.headers['content-type']}`);
          this.log(`Authorization: ${res.headers['Set-Cookie']}`);

          let resBody = Buffer.concat(chunks).toString();
          this.log(resBody);

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

};
