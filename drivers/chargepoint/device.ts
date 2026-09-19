'use strict';

import Homey from 'homey';
import { DeviceSettings } from '../../localTypes/types';
import { AlfenApi } from '../../lib/AlfenApi';

module.exports = class MyDevice extends Homey.Device {
  refreshRate: number = 30;
  apiHeader: string = 'alfen/json; charset=utf-8';
  apiUrl: string = 'api';
  alfenApi!: AlfenApi;
  socketIndex: 1 | 2 = 1;
  activePhases: number = 3;

  currentInterval: NodeJS.Timeout | null = null;
  #lastTargetPowerMax: number | null = null;
  #transactionOffset: number = 0;
  #lastChargingState: string | null = null;
  #activeChargeIdInitialized: boolean = false;
  #activeChargeIdCaughtUp: boolean = false;
  #refreshing: boolean = false;

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

    this.alfenApi = new AlfenApi(this.log, settings.ip, settings.username, settings.password);

    // Resume the transaction scan near where we left off, otherwise every app
    // restart re-scans the charger's entire transaction history from offset 0.
    this.#transactionOffset = Number(await this.getStoreValue('transactionOffset')) || 0;

    this.log(`Using socketIndex: ${this.socketIndex}`);

    this.#registerCapabilityListeners();
    this.#registerFlowCardListeners();

    if (this.currentInterval) clearInterval(this.currentInterval);
    this.currentInterval = this.homey.setInterval(() => {
      this.refreshDevice();
    }, this.refreshRate * 1000);

    await this.refreshDevice();

    // Get the current measure_current.limit value to set the correct target_power options on startup, from local property
    const measureCurrentLimit = this.getCapabilityValue('measure_current.limit') as number;
    if (measureCurrentLimit != null) {
      await this.#updateTargetPowerOptions(measureCurrentLimit);
    }
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

  async refreshDevice() {
    // The interval timer doesn't await the previous run, so a slow transaction
    // scan (see #refreshActiveChargeId) could otherwise overlap with the next tick.
    if (this.#refreshing) {
      this.log('Refresh already in progress, skipping this tick.');
      return;
    }
    this.#refreshing = true;

    this.log('Refresh Device');
    let result: { capabilityId: string; value: string | number | boolean }[] | null = null;

    try {
      try {
        await this.alfenApi.apiLogin();
        try {
          result = await this.alfenApi.apiGetActualValues(this.socketIndex);
          if (result && this.#shouldRefreshActiveChargeId(result)) {
            await this.#refreshActiveChargeId(result);
          }
        } finally {
          // Only logout when login actually succeeded.
          await this.alfenApi.apiLogout();
        }
      } catch (error) {
        this.log('Error refreshing device:', error);
      }

      if (result == null) return;

      // Parse result values
      await this.updateCapabilities(result);
    } finally {
      this.#refreshing = false;
    }
  }

  /**
   * Active Charge ID needs a refresh when the socket's charging state changed (e.g. a new
   * session started/stopped), on the very first poll after init, or when a previous scan
   * was cut short by its time budget and hasn't yet caught up to the live end of the log.
   */
  #shouldRefreshActiveChargeId(result: Array<{ capabilityId: string; value: string | number | boolean }>): boolean {
    if (!this.#activeChargeIdInitialized || !this.#activeChargeIdCaughtUp) return true;

    const newState = result.find((r) => r.capabilityId === 'evcharger_charging_state')?.value;
    return typeof newState === 'string' && newState !== this.#lastChargingState;
  }

  async #refreshActiveChargeId(result: { capabilityId: string; value: string | number | boolean }[]): Promise<void> {
    const newState = result.find((r) => r.capabilityId === 'evcharger_charging_state')?.value;
    if (typeof newState === 'string') this.#lastChargingState = newState;
    this.#activeChargeIdInitialized = true;

    try {
      const { tag, offset, caughtUp } = await this.alfenApi.apiGetActiveChargeTag(this.socketIndex, this.#transactionOffset);
      this.#transactionOffset = offset;
      this.#activeChargeIdCaughtUp = caughtUp;
      await this.setStoreValue('transactionOffset', offset).catch((err) => this.error('Error persisting transactionOffset:', err));
      // Only report a tag once we've actually caught up; a mid-scan cursor doesn't reflect the current session yet.
      if (caughtUp) result.push({ capabilityId: 'active_charge_id', value: tag ?? '' });
    } catch (error) {
      this.error('Error refreshing active charge ID:', error);
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

    const settings: DeviceSettings = {
      ...newSettings,
      ip: newSettings.ip as string,
      username: newSettings.username as string,
      password: newSettings.password as string,
    };

    this.socketIndex = Number(settings.socketIndex ?? 1) === 2 ? 2 : 1;

    // Close the previous session before replacing the client, otherwise the old
    // undici Pool stays alive and the charger sees a stale logged-in session.
    if (this.alfenApi) {
      try {
        await this.alfenApi.apiLogout();
      } catch (err) {
        this.log('Logout of previous AlfenApi failed (ignored):', err);
      }
    }

    this.alfenApi = new AlfenApi(this.log, settings.ip, settings.username, settings.password);
    this.log(`Using socketIndex: ${this.socketIndex}`);
  }

  /**
   * onDeleted is called when the user deletes the device.
   */
  async onDeleted() {
    if (this.currentInterval) {
      clearInterval(this.currentInterval);
      this.currentInterval = null;
    }
    if (this.alfenApi) {
      try {
        await this.alfenApi.apiLogout();
      } catch (err) {
        this.log('Logout on delete failed (ignored):', err);
      }
    }
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log('MyDevice was renamed');
  }

  /** Helper Functions */
  async #updateTargetPowerOptions(measureCurrentLimit: number): Promise<void> {
    try {
      const phases = this.#detectActivePhases();
      // Calculate max power in Watts: currentLimit (A) * phases * voltage (V)
      const maxPowerWatts = Math.round(measureCurrentLimit * phases * 230);

      // Only update if the max value has changed
      if (this.#lastTargetPowerMax !== maxPowerWatts) {
        this.log(`Updating target_power options: max=${maxPowerWatts}W (${measureCurrentLimit}A × ${phases} phases × 230V)`);

        this.setCapabilityOptions('target_power', {
          excludeMin: 0,
          excludeMax: 1380,
          min: 0,
          max: maxPowerWatts,
          step: 230,
        });

        this.#lastTargetPowerMax = maxPowerWatts;
      }
    } catch (error) {
      this.error('Error updating target_power options:', error);
    }
  }

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

        await this.setCapabilityValue(capabilityId, value ?? '')
          .catch((error) => this.error(`Error updating capability ${capabilityId} with value ${value}: `, error))
          .then(() => this.log(`Update capability: ${capabilityId} with value ${value}`));

        // Update target_power options when measure_current.limit changes
        if (capabilityId === 'measure_current.limit') {
          await this.#updateTargetPowerOptions(Number(value));
        }

        // Trigger flow card for comfort charge level changes
        if (capabilityId === 'comfortchargelevel') {
          this.homey.flow
            .getDeviceTriggerCard('comfortchargelevel_changed')
            .trigger(this, { comfortchargelevel: value })
            .catch((error: Error) => this.error('Error triggering comfortchargelevel_changed flow:', error));
        }

        // Trigger flow card for charge type changes
        if (capabilityId === 'chargetype') {
          this.homey.flow
            .getDeviceTriggerCard('chargetype_changed')
            .trigger(this, { chargetype: value })
            .catch((error: Error) => this.error('Error triggering chargetype_changed flow:', error));
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

    this.registerCapabilityListener('target_power', async (value) => {
      await this.#setStationLimit(Number(value));
    });

    this.registerCapabilityListener('evcharger_charging', async (value) => {
      await this.#setChargingEnabled(Boolean(value));
    });
  }

  async #registerFlowCardListeners() {
    // NOTE: homey.flow.getActionCard(id) returns one shared card per app, so
    // registerRunListener() here REPLACES any listener registered by another
    // device instance (last device to init "wins"). We must therefore always
    // act on `args.device` (the device the flow action is actually targeting),
    // never on `this`, otherwise actions from all chargers hit a single device.
    this.homey.flow.getActionCard('comfortchargelevel').registerRunListener(async (args, state) => {
      const device = args.device as MyDevice;
      device.log('Flow card action', args, state);
      await device.#setComfortChargeLevel(args.comfortchargelevel);
    });

    this.homey.flow.getActionCard('greenshare').registerRunListener(async (args, state) => {
      const device = args.device as MyDevice;
      device.log('Flow card action', args, state);
      await device.#setGreenSharePercentage(args.greenshare);
    });

    this.homey.flow.getActionCard('chargetype').registerRunListener(async (args, state) => {
      const device = args.device as MyDevice;
      device.log('Flow card action', args, state);
      await device.#setChargeType(args.chargetype);
    });

    this.homey.flow.getActionCard('authmode').registerRunListener(async (args, state) => {
      const device = args.device as MyDevice;
      device.log('Flow card action', args, state);
      await device.#setAuthMode(args.authmode);
    });

    this.homey.flow.getActionCard('chargeid').registerRunListener(async (args, state) => {
      const device = args.device as MyDevice;
      device.log('Flow card action', args, state);
      await device.#setChargeID(args.chargeid);
    });

    this.homey.flow.getActionCard('enable_plug_and_charge').registerRunListener(async (args, state) => {
      const device = args.device as MyDevice;
      device.log('Flow card action: enable_plug_and_charge', args, state);
      await device.#enablePlugAndCharge(args.chargeid);
    });

    this.homey.flow.getActionCard('enable_rfid').registerRunListener(async (args, state) => {
      const device = args.device as MyDevice;
      device.log('Flow card action: enable_rfid', args, state);
      await device.#enableRFID();
    });

    this.homey.flow.getActionCard('reboot_wallbox').registerRunListener(async (args, state) => {
      const device = args.device as MyDevice;
      device.log('Flow card action: reboot_wallbox', args, state);
      await device.#rebootWallbox();
    });
  }

  async #setOperativeMode(value: 0 | 2) {
    this.log('setOperativeMode', value);

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiSetOperativeMode(value);
    } catch (error) {
      this.log('Error setting charge type:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }
  }

  #detectActivePhases(): number {
    const voltageL2 = Number(this.getCapabilityValue('measure_voltage.l2') ?? 0);
    const voltageL3 = Number(this.getCapabilityValue('measure_voltage.l3') ?? 0);

    // Single-phase stations often expose only L1; 3-phase has meaningful L2/L3 voltage.
    const detected = voltageL2 > 50 || voltageL3 > 50 ? 3 : 1;
    this.activePhases = detected;

    return detected;
  }

  #getStartChargingLimitWatts(): number {
    const currentLimit = Number(this.getCapabilityValue('measure_current.limit') ?? 0);
    const phases = this.#detectActivePhases();
    const derivedMax = Math.round(currentLimit * phases * 230);
    if (Number.isFinite(derivedMax) && derivedMax > 0) {
      this.#lastTargetPowerMax = derivedMax;
      return derivedMax;
    }

    if (this.#lastTargetPowerMax != null && this.#lastTargetPowerMax > 0) {
      return this.#lastTargetPowerMax;
    }

    // Fall back to the current target value if no max has been discovered yet.
    const currentTarget = Number(this.getCapabilityValue('target_power') ?? 0);
    if (Number.isFinite(currentTarget) && currentTarget > 0) {
      return currentTarget;
    }

    return 0;
  }

  async #setChargingEnabled(enabled: boolean) {
    const targetWatts = enabled ? this.#getStartChargingLimitWatts() : 0;

    this.log('setChargingEnabled', { enabled, targetWatts });

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiSetChargingLimit(targetWatts, this.#detectActivePhases());
    } catch (error) {
      this.log('Error setting charging enabled state via charging limit:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }

    await this.refreshDevice();
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

  async #rebootWallbox() {
    this.log('rebootWallbox');

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiRebootEvCharger();
    } catch (error) {
      this.log('Error rebooting wallbox:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }

    return true;
  }

  async #setStationLimit(value: number) {
    this.log('setStationLimit', value);

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiSetChargingLimit(value, this.#detectActivePhases());
    } catch (error) {
      this.log('Error setting station limit:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }

    await this.refreshDevice();

    return true;
  }

  async #setCurrentLimit(value: number) {
    this.log('setCurrentLimit', value, 'socket', this.socketIndex);

    try {
      await this.alfenApi.apiLogin();
      await this.alfenApi.apiSetCurrentLimit(value, this.socketIndex);
    } catch (error) {
      this.log('Error setting current limit:', error);
      throw new Error(`${error}`);
    } finally {
      await this.alfenApi.apiLogout();
    }

    return true;
  }
};
