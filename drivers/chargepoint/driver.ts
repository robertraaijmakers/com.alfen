'use strict';

import Homey from 'homey';
import PairSession from 'homey/lib/PairSession';
import { PairData } from './types';

module.exports = class MyDriver extends Homey.Driver {

  ip?: string;
  username?: string;
  password?: string;

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

      // FIXME : add connection validation here
      return true;
    });

    session.setHandler('list_devices', async () => {
      this.homey.log('Listing devices');

      const devicesList = [];

      if (this.ip && this.username && this.password) {
        devicesList.push({
          name: 'Alfen Charger',
          data: {
            id: 'my-charger', // FIXME : add a better (unique) name for it
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

};
