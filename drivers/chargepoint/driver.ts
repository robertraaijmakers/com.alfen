'use strict';

import Homey from 'homey';

module.exports = class MyDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    return [
      {
        name: 'Alfen Charger',
        data: {
          id: 'my-charger',
        },
        store: {
          address: '192.168.5.117',
          username: 'admin',
          password: 'XT8R@iwWjf-ugzkHx6Fgtq',
        },
      },
    ];
  }

};
