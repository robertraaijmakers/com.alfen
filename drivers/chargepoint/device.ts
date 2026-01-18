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
  socketIndex: 1 | 2 = 1;

  currentInterval: NodeJS.Timeout | null = null;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.log('MyDevice has been initialized');

    const settings: DeviceSettings = await this.getSettings();

    this.socketIndex = Number(settings.socketIndex ?? 1) === 2 ? 2 : 1;
    const socketCount = Number(settings.socketCount ?? 1);

    // Duo: Solar/Greenshare UI & sensoren mogen NIET bestaan (ook niet op socket 1)
    if (socketCount === 2) {
      await this.#removeSolarCapabilitiesForDuo();
    }

    // Backwards compatibility: add chargeid capability if it doesn't exist
    await this.#ensureRequiredCapabilities();

    this.alfenApi = new AlfenApi(this.log, settings.ip, settings.username, settings.password);

    this.log(`Using socketIndex: ${this.socketIndex}`);

    this.#registerCapabilityListeners();
    this.#registerFlowCardListeners();

    if (this.currentInterval) clearInterval(this.currentInterval);
    this.currentInterval = this.homey.setInterval(() => {
      this.refreshDevice();
    }, this.refreshRate * 1000);

    await this.refreshDevice();
  }

  async #removeSolarCapabilitiesForDuo(): Promise<void> {
    const forbidden = [
      'chargetype', // "Standaard / Comfort+ groen / 100%"
      'greenshare', // aandeel groen
      'comfortchargelevel', // comfort level
    ];

    for (const cap of forbidden) {
      if (this.hasCapability(cap)) {
        try {
          await this.removeCapability(cap);
          this.log(`Removed capability (Duo): ${cap}`);
        } catch (err) {
          this.error(`Failed removing capability ${cap}:`, err);
        }
      }
    }
  }

  /**
   * Backwards compatibility: Ensure required capabilities exist.
   * This adds the chargeid capability to existing devices that were created before this feature.
   * Note: chargeid is station-wide (device-level), not per-socket, so it's added to all devices.
   */
  async #ensureRequiredCapabilities(): Promise<void> {
    const requiredCapabilities = [
      'chargeid', // Plug & Charge ID (station-wide, not per-socket)
    ];

    for (const cap of requiredCapabilities) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
          this.log(`Added missing capability (backwards compatibility): ${cap}`);
        } catch (err) {
          this.error(`Failed adding capability ${cap}:`, err);
        }
      }
    }
  }

  async refreshDevice() {
    this.log('Refresh Device');
    let result: { capabilityId: string; value: string | number | boolean }[] | null = null;

    try {
      await this.alfenApi.apiLogin();
      result = await this.alfenApi.apiGetActualValues(this.socketIndex);
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

    this.socketIndex = Number(settings.socketIndex ?? 1) === 2 ? 2 : 1;

    this.alfenApi = new AlfenApi(this.log, settings.ip, settings.username, settings.password);
    this.log(`Using socketIndex: ${this.socketIndex}`);
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

        // Trigger flow card for comfort charge level changes
        if (capabilityId === 'comfortchargelevel') {
          this.homey.flow
            .getDeviceTriggerCard('comfortchargelevel_changed')
            .trigger(this, { comfortchargelevel: value })
            .catch((error: Error) => this.error('Error triggering comfortchargelevel_changed flow:', error));
        }
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

    this.registerCapabilityListener('chargeid', async (value) => {
      await this.#setChargeID(value);
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

    this.homey.flow.getActionCard('chargeid').registerRunListener(async (args, state) => {
      this.log('Flow card action', args, state);
      await this.#setChargeID(args.chargeid);
    });

    this.homey.flow.getActionCard('enable_plug_and_charge').registerRunListener(async (args, state) => {
      this.log('Flow card action: enable_plug_and_charge', args, state);
      await this.#enablePlugAndCharge(args.chargeid);
    });

    this.homey.flow.getActionCard('enable_rfid').registerRunListener(async (args, state) => {
      this.log('Flow card action: enable_rfid', args, state);
      await this.#enableRFID();
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

  async #setChargeID(value: string) {
    this.log('setChargeID', value);

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiSetChargeID(value);
    } catch (error) {
      this.log('Error setting charge ID:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }
  }

  async #enablePlugAndCharge(chargeID: string) {
    this.log('enablePlugAndCharge', chargeID);

    try {
      await this.alfenApi.apiLogin();
      // First set the charge ID
      await this.alfenApi.apiSetChargeID(chargeID);
      // Then set auth mode to Plug & Charge (0)
      await this.alfenApi.apiSetAuthMode('0');
    } catch (error) {
      this.log('Error enabling Plug & Charge:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }
  }

  async #enableRFID() {
    this.log('enableRFID');

    try {
      await this.alfenApi.apiLogin();
      // First clear the charge ID
      await this.alfenApi.apiSetChargeID('');
      // Then set auth mode to RFID (2)
      await this.alfenApi.apiSetAuthMode('2');
    } catch (error) {
      this.log('Error enabling RFID:', error);
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
