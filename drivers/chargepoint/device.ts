'use strict';

import Homey from 'homey';
import { DeviceSettings } from '../../localTypes/types';
import { EnergySettings } from '../../localTypes/types';
import { AlfenApi } from '../../lib/AlfenApi';

module.exports = class MyDevice extends Homey.Device {
  refreshRate: number = 30;
  apiHeader: string = 'alfen/json; charset=utf-8';
  apiUrl: string = 'api';
  alfenApi!: AlfenApi;

  currentInterval: NodeJS.Timeout | null = null;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');

    let energy: EnergySettings = await this.getEnergy();

    /* Enable ev charger */
    if (energy.evCharger == undefined || energy.meterPowerImportedCapability == undefined) {
      energy.evCharger = true;
      energy.meterPowerImportedCapability = "meter_power";
      await this.setEnergy(energy);
    }

    // Remove on-off capability for older devices
    if (this.hasCapability('onoff')) {
      await this.removeCapability('onoff');
    }

    if (this.hasCapability('meter_power.l1')) {
      await this.removeCapability('meter_power.l1');
    }

    if (this.hasCapability('meter_power.l2')) {
      await this.removeCapability('meter_power.l2');
    }

    if (this.hasCapability('meter_power.l3')) {
      await this.removeCapability('meter_power.l3');
    }

    // Initiate the Alfen API
    const settings: DeviceSettings = await this.getSettings();
    this.alfenApi = new AlfenApi(this.log, settings.ip, settings.username, settings.password);

    // Register property listeners
    this.#registerCapabilityListeners();

    // Register flow card listeners
    this.#registerFlowCardListeners();

    // Set (and clear) interval and refresh device data
    if (this.currentInterval) clearInterval(this.currentInterval);
    this.currentInterval = this.homey.setInterval(() => {
      this.refreshDevice();
    }, this.refreshRate * 1000);

    await this.refreshDevice();
  }

  async refreshDevice() {
    this.log('Refresh Device');
    let result: { capabilityId: string; value: string | number | boolean }[] | null = null;

    try {
      await this.alfenApi.apiLogin();
      result = await this.alfenApi.apiGetActualValues();
    } catch (error) {
      this.log('Error refreshing device:', error);
    } finally {
      await this.alfenApi.apiLogout();
    }

    if (result == null) return;

    // Parse result values
    await this.updateCapabilities(result);
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

    const settings: DeviceSettings = {
      ...newSettings,
      ip: newSettings.ip as string,
      username: newSettings.username as string,
      password: newSettings.password as string,
    };

    this.alfenApi = new AlfenApi(this.log, settings.ip, settings.username, settings.password);
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
          .catch((error) => this.error(`Error updating capability ${capabilityId} with value ${value}: `, error))
          .then(() => this.log(`Update capability: ${capabilityId} with value ${value}`));
      } catch (error) {
        this.error(`Error updating capability ${capabilityId}:`, error);
      }
    }
  }

  async #registerCapabilityListeners() {
    this.registerCapabilityListener('comfortchargelevel', async (value) => {
      await this.#setComfortChargeLevel(value);
    });

    this.registerCapabilityListener('greenshare', async (value) => {
      await this.#setGreenSharePercentage(value);
    });

    this.registerCapabilityListener('chargetype', async (value) => {
      await this.#setChargeType(value);
    });

    this.registerCapabilityListener('authmode', async (value) => {
      await this.#setAuthMode(value);
    });
  }

  async #registerFlowCardListeners() {
    this.homey.flow.getActionCard('comfortchargelevel').registerRunListener(async (args, state) => {
      this.log('Flow card action', args, state);
      await this.#setComfortChargeLevel(args.comfortchargelevel);
    });

    this.homey.flow.getActionCard('greenshare').registerRunListener(async (args, state) => {
      this.log('Flow card action', args, state);
      await this.#setGreenSharePercentage(args.greenshare);
    });

    this.homey.flow.getActionCard('chargetype').registerRunListener(async (args, state) => {
      this.log('Flow card action', args, state);
      await this.#setChargeType(args.chargetype);
    });

    this.homey.flow.getActionCard('authmode').registerRunListener(async (args, state) => {
      this.log('Flow card action', args, state);
      await this.#setAuthMode(args.authmode);
    });

    this.homey.flow.getActionCard('measure_current.limit').registerRunListener(async (args, state) => {
      this.log('Flow card action', args, state);
      await this.#setCurrentLimit(args.limit);
    });
  }

  async #setChargeType(value: string) {
    this.log('setChargeType', value);

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiSetChargeType(value);
    } catch (error) {
      this.log('Error setting charge type:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }
  }

  async #setComfortChargeLevel(value: number) {
    this.log('setComfortChargeLevel', value);

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiSetComfortChargeLevel(value);
    } catch (error) {
      this.log('Error setting comfort charge level:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }
  }

  async #setGreenSharePercentage(value: number) {
    this.log('setGreenSharePercentage', value);

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiSetGreenSharePercentage(value);
    } catch (error) {
      this.log('Error setting green share percentage:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }
  }

  async #setAuthMode(value: string) {
    this.log('setAuthMode', value);

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiSetAuthMode(value);
    } catch (error) {
      this.log('Error setting auth mode:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }
  }

  async #setCurrentLimit(value: number) {
    this.log('setCurrentLimit', value);

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiSetCurrentLimit(value);
    } catch (error) {
      this.log('Error setting current limit:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }

    return true;
  }
};
