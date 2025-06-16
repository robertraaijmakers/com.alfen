'use strict';

import Homey from 'homey';
import PairSession from 'homey/lib/PairSession';
import { PairData, InfoResponse } from '../../localTypes/types';
import { AlfenApi } from '../../lib/AlfenApi';

module.exports = class MyDriver extends Homey.Driver {
  #ip?: string;
  #username?: string;
  #password?: string;

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

      this.#ip = data.ip;
      this.#username = data.user;
      this.#password = data.pass;

      const alfenApi = new AlfenApi(this.homey.log, data.ip, data.user, data.pass);

      if (!this.#ip) {
        throw new Error('No IP address provided. Please provide an IP address.');
      }

      const localAddress = await this.homey.cloud.getLocalAddress();
      if (!localAddress) {
        throw new Error('No local address found');
      }

      // Compare if local address is on the same subnet as this.#ip
      const ipParts = this.#ip.split('.');
      const localParts = localAddress.split('.');
      if (ipParts.length !== 4) {
        throw new Error(`Invalid IP address provided (${this.#ip}).`);
      }

      if (ipParts[0] !== localParts[0] || ipParts[1] !== localParts[1] || ipParts[2] !== localParts[2]) {
        throw new Error(
          `IP address of your charger (${this.#ip}) is not on the same subnet as your Homey (${localAddress}).
          Please make sure they are on the same subnet (${localParts[0]}.${localParts[1]}.${localParts[2]}.xxx)).`,
        );
      }

      try {
        await alfenApi.apiLogin();
      } catch (error) {
        this.log(error);
        throw new Error('Error logging in to charger, note that your Homey should be on the same subnet as your charger. This is a fysical limitation by Alfen. Error: ' + error);
      }

      try {
        const result = await alfenApi.apiGetChargerDetails();
        this.infoData = result;
        await alfenApi.apiLogout();
        this.log(result);
      } catch (error) {
        this.log(error);
        throw new Error("Login was successful, but couldn't retrieve charge information. Your charger is probably not supported or has firmware incompatible with this Homey app. Error: " + error);
      }

      return true;
    });

    session.setHandler('list_devices', async () => {
      this.homey.log('Listing devices');

      const devicesList = [];

      if (this.#ip && this.#username && this.#password && this.infoData) {
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
            ip: this.#ip,
            username: this.#username,
            password: this.#password,
          },
        });
      }

      return devicesList;
    });
  }
};
