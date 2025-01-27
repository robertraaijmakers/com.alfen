'use strict';

import Homey from 'homey';
import { DeviceSettings } from '../../localTypes/types';
import { AlfenApi } from '../../lib/AlfenApi';

module.exports = class MyDevice extends Homey.Device {
  refreshRate: number = 30;
  apiHeader: string = 'alfen/json; charset=utf-8';
  apiUrl: string = 'api';

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.homey.setInterval(this.refreshDevice.bind(this), this.refreshRate * 1000);
    this.log('MyDevice has been initialized');

    // Remove on-off capability for older devices
    if (this.hasCapability('onoff')) {
      await this.removeCapability('onoff');
    }

    await this.refreshDevice();
  }

  async refreshDevice() {
    this.log('Refresh Device');

    const settings: DeviceSettings = await this.getSettings();
    const alfenApi = new AlfenApi(this.log, settings.ip, settings.username, settings.password);

    try {
      await alfenApi.apiLogin();
      const result = await alfenApi.apiGetActualValues();
      await alfenApi.apiLogout();

      // Parse result values
      await this.updateCapabilities(result);
    } catch (error) {
      this.log('Error refreshing device:', error);
    }
  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log('MyDevice has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: {
      [key: string]: boolean | string | number | undefined | null;
    };
    newSettings: {
      [key: string]: boolean | string | number | undefined | null;
    };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log('MyDevice settings where changed');
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('MyDevice was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log('MyDevice has been deleted');
  }

  /** Helper Functions */
  async updateCapabilities(
    capabilitiesData: Array<{
      capabilityId: string;
      value: number | string | boolean;
    }>,
  ) {
    const deviceState = this.getState();

    for (const { capabilityId, value } of capabilitiesData) {
      try {
        const hasCapability = this.hasCapability(capabilityId);
        if (!hasCapability) await this.addCapability(capabilityId).catch(this.error);

        if (value === null || (typeof deviceState !== 'undefined' && typeof deviceState[capabilityId] !== 'undefined' && deviceState[capabilityId] === value)) continue;

        await this.setCapabilityValue(capabilityId, value)
          .catch(this.error)
          .then(() => this.log(`Update capability: ${capabilityId} with value ${value}`));
      } catch (error) {
        this.error(`Error updating capability ${capabilityId}:`, error);
      }
    }
  }
};
