'use strict';

import Homey from 'homey';
import { DeviceSettings } from '../../localTypes/types';
import { AlfenApi } from '../../lib/AlfenApi';

const P1_TITLES: Record<string, { en: string; nl: string }> = {
  'measure_current.p1_l1': { en: 'P1 current L1', nl: 'P1 stroom L1' },
  'measure_current.p1_l2': { en: 'P1 current L2', nl: 'P1 stroom L2' },
  'measure_current.p1_l3': { en: 'P1 current L3', nl: 'P1 stroom L3' },
  'measure_power.p1': { en: 'P1 power (grid)', nl: 'P1 vermogen (net)' },
};

class MyDevice extends Homey.Device {
  static P1_CAPABILITIES: string[] = Object.keys(P1_TITLES);
  refreshRate: number = 30; // seconds; overridden by the 'pollInterval' device setting
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
  #allowProfileWrites: boolean = true;
  #readChargeTag: boolean = true;
  #readP1: boolean = false;
  #lastP1Power: number | null = null;
  #lastP1ChangeAt: number = 0;
  #lastRefreshOkAt: number = 0;
  #operationQueue: Promise<void> = Promise.resolve();
  #pendingCapabilityWrites: Map<string, { value: string | number | boolean; requestedAt: number }> = new Map();
  #released: boolean = false;
  #releaseTimer: NodeJS.Timeout | null = null;
  #releaseMinutes: number = 60;
  #connMode: 'off' | 'interval' | 'continuous' = 'interval';
  /** poll interval while 'On - stay logged in' (seconds, 1-60); 'pollInterval' applies to 'login per poll'. */
  #pollIntervalSetting: number = 30;
  #fastPollSeconds: number = 5;
  #lastLimitReadAt: number = 0;
  #guardLogged: boolean = false;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    if (!this.hasCapability('status_summary')) await this.addCapability('status_summary').catch(this.error);
    if (!this.hasCapability('homey_connection')) await this.addCapability('homey_connection').catch(this.error);
    this.log('MyDevice has been initialized');

    const settings: DeviceSettings = await this.getSettings();

    this.socketIndex = Number(settings.socketIndex ?? 1) === 2 ? 2 : 1;
    const socketCount = Number(settings.socketCount ?? 1);

    // Duo: Solar/Greenshare UI & sensoren mogen NIET bestaan (ook niet op socket 1)
    if (socketCount === 2) {
      await this.#removeSolarCapabilitiesForDuo();
    }

    this.alfenApi = new AlfenApi(this.log, settings.ip, settings.username, settings.password);

    // Connection mode (3-way): restore the last choice; 'off' restarts its release timer (max 60 min).
    this.#applyFlags(settings);
    const storedMode = this.getCapabilityValue('homey_connection');
    this.#connMode = storedMode === 'off' || storedMode === 'continuous' ? storedMode : 'interval';
    this.alfenApi.persistent = this.#connMode === 'continuous';
    if (this.#connMode === 'off') this.#startReleaseTimer(this.#releaseMinutes);
    await this.setCapabilityValue('homey_connection', this.#connMode).catch(this.error);

    this.log(`Using socketIndex: ${this.socketIndex}`);

    this.#registerCapabilityListeners();
    this.#registerFlowCardListeners();

    this.#setFastPoll(settings.fastPollInterval);
    this.#startPolling(settings.pollInterval);

    await this.refreshDevice();

    // Get the current measure_current.limit value to set the correct target_power options on startup, from local property
    const measureCurrentLimit = this.getCapabilityValue('measure_current.limit') as number;
    if (measureCurrentLimit != null) {
      await this.#updateTargetPowerOptions(measureCurrentLimit);
    }
  }

  /**
   * (Re)starts the polling timer. The interval comes from the 'pollInterval' device setting
   * (seconds, clamped to 30-900). Every poll logs in to the charger, which has very little memory.
   */
  #applyFlags(settings: { allowProfileWrites?: unknown; readChargeTag?: unknown; readP1?: unknown; releaseMinutes?: unknown }): void {
    const rm = Number(settings.releaseMinutes);
    this.#releaseMinutes = Number.isFinite(rm) && rm >= 1 ? Math.min(60, Math.round(rm)) : 60;
    this.#allowProfileWrites = settings.allowProfileWrites !== false;
    this.#readChargeTag = settings.readChargeTag !== false;
    this.#readP1 = settings.readP1 === true;
    this.log(`allowProfileWrites=${this.#allowProfileWrites}, readChargeTag=${this.#readChargeTag}, readP1=${this.#readP1}`);

    if (!this.#readP1) {
      for (const cap of MyDevice.P1_CAPABILITIES) {
        if (this.hasCapability(cap)) this.removeCapability(cap).catch(this.error);
      }
    }
  }

  #isP1FeedLost(minutes: number): boolean {
    if (!this.#readP1) throw new Error("Switch on the device setting 'Show P1 meter values' first");
    const limitMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60_000;
    if (this.#lastP1Power === null || this.#lastP1ChangeAt === 0) return true;
    return Date.now() - this.#lastP1ChangeAt > limitMs;
  }

  #assertProfileWritesAllowed(): void {
    if (!this.#allowProfileWrites) {
      throw new Error('Blocked: Start/Stop and target power are switched off in the device settings (they change the charging profile; 0 W blocks every charge mode).');
    }
  }

  #setFastPoll(requested?: unknown): void {
    const v = Number(requested);
    this.#fastPollSeconds = Number.isFinite(v) && v > 0 ? Math.min(60, Math.max(1, Math.round(v))) : 5;
  }

  /**
   * (Re)starts the polling timer. 'On - login per poll' uses the 'pollInterval' setting (30-900 s,
   * every poll logs in and out); 'On - stay logged in' uses 'fastPollInterval' (1-60 s, no logins).
   */
  #startPolling(requested?: number | null): void {
    if (requested !== undefined && requested !== null) {
      const value = Number(requested);
      this.#pollIntervalSetting = Number.isFinite(value) && value > 0 ? Math.min(900, Math.max(30, Math.round(value))) : 30;
    }
    const fast = this.#connMode === 'continuous';
    this.refreshRate = fast ? this.#fastPollSeconds : this.#pollIntervalSetting;
    this.alfenApi.verbose = this.refreshRate >= 30;
    if (this.currentInterval) this.homey.clearInterval(this.currentInterval);
    this.currentInterval = this.homey.setInterval(() => {
      this.refreshDevice();
    }, this.refreshRate * 1000);
    this.log(`Polling every ${this.refreshRate} s (${fast ? 'stay logged in' : 'login per poll'})`);
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
    if (this.#released) {
      this.log('Connection released for Eve: poll skipped.');
      return;
    }
    // Do not queue every timer tick: one fresh poll is enough after the current one.
    if (this.#refreshing) {
      this.log('Refresh already in progress, skipping this tick.');
      return;
    }
    if (this.alfenApi.persistent && this.alfenApi.isBackingOff()) {
      if (!this.#guardLogged) this.log('Login guard active (wallbox used by another client?): reads paused for up to 15 min.');
      this.#guardLogged = true;
      return;
    }
    this.#guardLogged = false;
    this.#refreshing = true;

    try {
      await this.#enqueueOperation(async () => {
        if (this.alfenApi.verbose) this.log('Refresh Device');

        try {
          const includeLimit = !this.alfenApi.persistent || Date.now() - this.#lastLimitReadAt >= 60_000;
          const result = await this.alfenApi.withSession(async (api) => {
            const capabilities = await api.apiGetActualValues(this.socketIndex, this.#readP1, includeLimit);
            if (includeLimit) this.#lastLimitReadAt = Date.now();
            if (this.#readChargeTag && this.#shouldRefreshActiveChargeId(capabilities)) {
              await this.#refreshActiveChargeId(api, capabilities);
            }
            return capabilities;
          });

          await this.updateCapabilities(result);
          this.#lastRefreshOkAt = Date.now();
        } catch (error) {
          this.log('Error refreshing device:', error);
        } finally {
          this.#refreshing = false;
        }
      });
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
    if (typeof newState !== 'string') return false;

    if (newState !== this.#lastChargingState) return true;

    // The authorization log can arrive after the first connected-state poll.
    // Keep checking until a tag is found instead of treating an empty scan as final.
    const activeChargeId = this.getCapabilityValue('active_charge_id');
    return newState !== 'plugged_out' && (activeChargeId === '' || activeChargeId == null);
  }

  async #refreshActiveChargeId(api: AlfenApi, result: { capabilityId: string; value: string | number | boolean }[]): Promise<void> {
    const newState = result.find((r) => r.capabilityId === 'evcharger_charging_state')?.value;
    if (typeof newState === 'string') this.#lastChargingState = newState;
    this.#activeChargeIdInitialized = true;

    try {
      const { tag, offset, caughtUp } = await api.apiGetActiveChargeTag(this.socketIndex, this.#transactionOffset);
      this.#transactionOffset = offset;
      this.#activeChargeIdCaughtUp = caughtUp;
      if (caughtUp) result.push({ capabilityId: 'active_charge_id', value: tag ?? '' });
    } catch (error) {
      this.error('Error refreshing active charge ID:', error);
    }
  }

  #enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.#operationQueue.then(operation, operation);
    this.#operationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async #writeCapabilities(
    expectedValues: Array<{ capabilityId: string; value: string | number | boolean }>,
    operation: (api: AlfenApi) => Promise<unknown>,
  ): Promise<void> {
    if (this.#released) {
      throw new Error('The wallbox connection is released for Eve. Reconnect first (device toggle or flow card).');
    }
    // Skip writes that would not change anything: every write costs a login on the charger
    // plus a refresh poll. Only when the last poll is recent, so the cached value is trustworthy.
    const fresh = Date.now() - this.#lastRefreshOkAt < (this.refreshRate + 30) * 1000;
    if (fresh && expectedValues.length > 0
      && expectedValues.every(({ capabilityId, value }) => String(this.getCapabilityValue(capabilityId)) === String(value))) {
      this.log('Write skipped, value already set:', expectedValues);
      return;
    }

    const pendingWrites = expectedValues.map(({ capabilityId, value }) => {
      const pending = { value, requestedAt: Date.now() };
      this.#pendingCapabilityWrites.set(capabilityId, pending);
      return { capabilityId, pending };
    });

    try {
      await this.#enqueueOperation(() => this.alfenApi.withSession(operation, { isWrite: true }));
    } catch (error) {
      for (const { capabilityId, pending } of pendingWrites) {
        if (this.#pendingCapabilityWrites.get(capabilityId) === pending) {
          this.#pendingCapabilityWrites.delete(capabilityId);
        }
      }
      throw error;
    }

    await this.refreshDevice();
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

    await this.#enqueueOperation(async () => {
      this.socketIndex = Number(settings.socketIndex ?? 1) === 2 ? 2 : 1;

      // Wait for in-flight charger operations before replacing its client.
      if (this.alfenApi) {
        try {
          await this.alfenApi.release();
        } catch (err) {
          this.log('Logout of previous AlfenApi failed (ignored):', err);
        }
      }

      this.alfenApi = new AlfenApi(this.log, settings.ip, settings.username, settings.password);
      this.alfenApi.persistent = this.#connMode === 'continuous';
      this.log(`Using socketIndex: ${this.socketIndex}`);

      this.#applyFlags(newSettings);
      this.#setFastPoll(newSettings.fastPollInterval);
      this.#startPolling(Number(newSettings.pollInterval));
    });
  }

  /**
   * onDeleted is called when the user deletes the device.
   */
  async onDeleted() {
    if (this.currentInterval) {
      this.homey.clearInterval(this.currentInterval);
      this.currentInterval = null;
    }
    if (this.alfenApi) {
      try {
        await this.#enqueueOperation(() => this.alfenApi.release());
      } catch (err) {
        this.log('Logout on delete failed (ignored):', err);
      }
    }
  }

  /** App stop / update: free the wallbox login so Eve or a reinstall can log in. */
  async onUninit() {
    if (this.#releaseTimer) this.homey.clearTimeout(this.#releaseTimer);
    if (this.currentInterval) this.homey.clearInterval(this.currentInterval);
    if (this.alfenApi) await this.alfenApi.release().catch(() => undefined);
  }

  /** Arms the automatic end of 'off': after max 60 min Homey goes to 'on' (login per poll). */
  #startReleaseTimer(minutes: number): void {
    if (this.#releaseTimer) this.homey.clearTimeout(this.#releaseTimer);
    const m = Math.min(60, Math.max(1, Math.round(Number.isFinite(minutes) ? minutes : 60)));
    this.#released = true;
    this.#releaseTimer = this.homey.setTimeout(() => {
      this.setConnectionMode('interval').catch(this.error);
    }, m * 60_000);
    this.log(`No login for max ${m} min, then Homey switches to 'on'`);
  }

  /**
   * Three connection modes (device picker 'Homey connection'):
   *  - off:        Homey logs out and does not log in (for Eve/MyEve/ACE). Max 60 min, then 'interval'.
   *  - interval:   login + logout on every poll (poll interval 30-900 s).
   *  - continuous: one login kept open; never dropped unless the user picks another mode.
   */
  async setConnectionMode(mode: 'off' | 'interval' | 'continuous', minutes?: number): Promise<void> {
    if (this.#releaseTimer) this.homey.clearTimeout(this.#releaseTimer);
    this.#releaseTimer = null;
    this.#connMode = mode;
    if (mode === 'off') {
      this.#startReleaseTimer(minutes ?? this.#releaseMinutes);
      await this.#enqueueOperation(() => this.alfenApi.release());
    } else {
      this.#released = false;
      const persistent = mode === 'continuous';
      if (this.alfenApi.persistent !== persistent) {
        await this.#enqueueOperation(() => this.alfenApi.release());
        this.alfenApi.persistent = persistent;
      }
    }
    this.alfenApi.resetLoginGuard();
    this.#startPolling();
    await this.setCapabilityValue('homey_connection', mode).catch(this.error);
    this.log(`Connection mode: ${mode}`);
    if (mode !== 'off') await this.refreshDevice();
    await this.#updateStatusSummary();
  }

  /** Flow card 'Release the wallbox login': same as picking 'off'. */
  async releaseConnection(minutes: number): Promise<void> {
    await this.setConnectionMode('off', minutes);
  }

  /** Ends 'off' early: back to 'on' (login per poll). */
  async reconnect(): Promise<void> {
    await this.setConnectionMode('interval');
  }

  isReleased(): boolean {
    return this.#released;
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
        const pending = this.#pendingCapabilityWrites.get(capabilityId);
        if (pending) {
          const matchesRequestedValue = capabilityId === 'target_power'
            && typeof value === 'number'
            && typeof pending.value === 'number'
            ? Math.abs(value - pending.value) <= 115
            : value === pending.value;

          if (matchesRequestedValue) {
            this.#pendingCapabilityWrites.delete(capabilityId);
          } else if (Date.now() - pending.requestedAt < 120_000) {
            continue;
          } else {
            this.#pendingCapabilityWrites.delete(capabilityId);
          }
        }

        if (P1_TITLES[capabilityId] && !this.#readP1) continue;

        // P1 freshness tracking (for the 'P1 feed is lost' condition)
        if (capabilityId === 'measure_power.p1' && typeof value === 'number') {
          if (this.#lastP1Power === null || value !== this.#lastP1Power) {
            this.#lastP1Power = value;
            this.#lastP1ChangeAt = Date.now();
          }
        }

        const hasCapability = this.hasCapability(capabilityId);
        if (!hasCapability) {
          await this.addCapability(capabilityId).catch(this.error);
          if (P1_TITLES[capabilityId]) {
            await this.setCapabilityOptions(capabilityId, { title: P1_TITLES[capabilityId], insights: true }).catch(this.error);
          }
        }

        // Reboot detection: boot count went up since the previous poll
        if (capabilityId === 'bootups' && typeof value === 'number') {
          const previous = this.getCapabilityValue('bootups');
          if (typeof previous === 'number' && value > previous) {
            const reason = capabilitiesData.find((x) => x.capabilityId === 'boot_reason')?.value;
            this.homey.flow
              .getDeviceTriggerCard('wallbox_rebooted')
              .trigger(this, { bootups: value, boot_reason: String(reason ?? '') })
              .catch((error: Error) => this.error('Error triggering wallbox_rebooted flow:', error));
          }
        }

        if (value === null || (typeof deviceState !== 'undefined' && typeof deviceState[capabilityId] !== 'undefined' && deviceState[capabilityId] === value)) continue;

        await this.setCapabilityValue(capabilityId, value ?? '')
          .catch((error) => this.error(`Error updating capability ${capabilityId} with value ${value}: `, error))
          .then(() => { if (this.alfenApi.verbose) this.log(`Update capability: ${capabilityId} with value ${value}`); });

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
    await this.#updateStatusSummary();
  }

  /**
   * One-line status for the device tile: charge mode plus live charging power,
   * e.g. "Comfort · 1.95 kW" / "Green · 0 kW" / "Default · 11.0 kW"; "Released (Eve)" while released.
   * The power is as fresh as the poll interval (seconds in 'stay logged in').
   */
  async #updateStatusSummary(): Promise<void> {
    if (!this.hasCapability('status_summary')) return;
    const nl = this.homey.i18n.getLanguage() === 'nl';
    let text: string;
    if (this.#released) {
      text = nl ? 'Vrijgegeven (Eve)' : 'Released (Eve)';
    } else {
      const labels: Record<string, string> = nl
        ? { 0: 'Standaard', 1: 'Comfort', 2: 'Groen' }
        : { 0: 'Default', 1: 'Comfort', 2: 'Green' };
      const type = this.hasCapability('chargetype') ? this.getCapabilityValue('chargetype') : null;
      const mode = type === null || type === undefined ? '?' : (labels[String(type)] ?? String(type));
      // mode plus the live charging power (was: comfort level), like '223 km · 66 %' on a car tile.
      const watts = Number(this.getCapabilityValue('measure_power'));
      if (Number.isFinite(watts)) {
        const kw = Math.max(0, watts) / 1000;
        const kwText = kw === 0 ? '0' : kw < 10 ? kw.toFixed(2) : kw.toFixed(1);
        text = `${mode} · ${nl ? kwText.replace('.', ',') : kwText} kW`;
      } else {
        text = mode;
      }
    }
    if (this.getCapabilityValue('status_summary') === text) return;
    await this.setCapabilityValue('status_summary', text).catch(this.error);
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

    this.registerCapabilityListener('homey_connection', async (value) => {
      await this.setConnectionMode(value === 'off' || value === 'continuous' ? value : 'interval');
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
    this.homey.flow.getConditionCard('chargetype_is').registerRunListener(async (args) => {
      const device = args.device as MyDevice;
      return String(device.getCapabilityValue('chargetype')) === String(args.chargetype);
    });

    this.homey.flow.getConditionCard('charging_blocked_by_profile').registerRunListener(async (args) => {
      const device = args.device as MyDevice;
      const watts = Number(device.getCapabilityValue('target_power'));
      if (!Number.isFinite(watts)) throw new Error('Charging profile not read yet');
      return watts < 6 * 230;
    });

    this.homey.flow.getConditionCard('p1_feed_lost').registerRunListener(async (args) => {
      const device = args.device as MyDevice;
      return device.#isP1FeedLost(Number(args.minutes));
    });

    this.homey.flow.getConditionCard('waiting_for_disconnect').registerRunListener(async (args) => {
      const device = args.device as MyDevice;
      return device.getCapabilityValue('operatingmode') === 'Finish Wait Disconnect';
    });

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

    this.homey.flow.getActionCard('release_connection').registerRunListener(async (args) => {
      const device = args.device as MyDevice;
      await device.releaseConnection(Number(args.minutes));
    });

    this.homey.flow.getActionCard('set_connection_mode').registerRunListener(async (args) => {
      const device = args.device as MyDevice;
      const mode = args.mode === 'off' || args.mode === 'continuous' ? args.mode : 'interval';
      await device.setConnectionMode(mode);
    });

    this.homey.flow.getActionCard('reconnect_connection').registerRunListener(async (args) => {
      const device = args.device as MyDevice;
      await device.reconnect();
    });

    this.homey.flow.getConditionCard('connection_released').registerRunListener(async (args) => {
      const device = args.device as MyDevice;
      return device.isReleased();
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
      await this.#writeCapabilities([], (api) => api.apiSetOperativeMode(value));
    } catch (error) {
      this.log('Error setting charge type:', error);
      throw new Error(`${error}`);
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
    this.#assertProfileWritesAllowed();
    const targetWatts = enabled ? this.#getStartChargingLimitWatts() : 0;

    this.log('setChargingEnabled', { enabled, targetWatts });

    try {
      await this.#writeCapabilities([
        { capabilityId: 'target_power', value: targetWatts },
        { capabilityId: 'evcharger_charging', value: enabled },
      ], (api) =>
        api.apiSetChargingLimit(targetWatts, this.#detectActivePhases()));
    } catch (error) {
      this.log('Error setting charging enabled state via charging limit:', error);
      throw new Error(`${error}`);
    }
  }

  async #setChargeType(value: string) {
    this.log('setChargeType', value);

    try {
      await this.#writeCapabilities([{ capabilityId: 'chargetype', value }], (api) => api.apiSetChargeType(value));
    } catch (error) {
      this.log('Error setting charge type:', error);
      throw new Error(`${error}`);
    }
  }

  async #setComfortChargeLevel(value: number) {
    this.log('setComfortChargeLevel', value);

    try {
      await this.#writeCapabilities([{ capabilityId: 'comfortchargelevel', value }], (api) => api.apiSetComfortChargeLevel(value));
    } catch (error) {
      this.log('Error setting comfort charge level:', error);
      throw new Error(`${error}`);
    }
  }

  async #setGreenSharePercentage(value: number) {
    this.log('setGreenSharePercentage', value);

    try {
      await this.#writeCapabilities([{ capabilityId: 'greenshare', value }], (api) => api.apiSetGreenSharePercentage(value));
    } catch (error) {
      this.log('Error setting green share percentage:', error);
      throw new Error(`${error}`);
    }
  }

  async #setAuthMode(value: string) {
    this.log('setAuthMode', value);

    try {
      await this.#writeCapabilities([{ capabilityId: 'authmode', value }], (api) => api.apiSetAuthMode(value));
    } catch (error) {
      this.log('Error setting auth mode:', error);
      throw new Error(`${error}`);
    }
  }

  async #setChargeID(value: string) {
    this.log('setChargeID', value);

    try {
      await this.#writeCapabilities([{ capabilityId: 'chargeid', value }], (api) => api.apiSetChargeID(value));
    } catch (error) {
      this.log('Error setting charge ID:', error);
      throw new Error(`${error}`);
    }
  }

  async #enablePlugAndCharge(chargeID: string) {
    this.log('enablePlugAndCharge', chargeID);

    try {
      await this.#writeCapabilities([
        { capabilityId: 'chargeid', value: chargeID },
        { capabilityId: 'authmode', value: '0' },
      ], async (api) => {
        await api.apiSetChargeID(chargeID);
        await api.apiSetAuthMode('0');
      });
    } catch (error) {
      this.log('Error enabling Plug & Charge:', error);
      throw new Error(`${error}`);
    }
  }

  async #enableRFID() {
    this.log('enableRFID');

    try {
      await this.#writeCapabilities([
        { capabilityId: 'chargeid', value: '' },
        { capabilityId: 'authmode', value: '2' },
      ], async (api) => {
        await api.apiSetChargeID('');
        await api.apiSetAuthMode('2');
      });
    } catch (error) {
      this.log('Error enabling RFID:', error);
      throw new Error(`${error}`);
    }
  }

  async #rebootWallbox() {
    this.log('rebootWallbox');

    try {
      await this.#writeCapabilities([], (api) => api.apiRebootEvCharger());
    } catch (error) {
      this.log('Error rebooting wallbox:', error);
      throw new Error(`${error}`);
    }

    return true;
  }

  /** Snap a requested power to the 230 W step used by the capability and clamp to 0..max. */
  #normalizeTargetPower(value: number): number {
    const step = 230;
    const max = this.#lastTargetPowerMax != null && this.#lastTargetPowerMax > 0 ? this.#lastTargetPowerMax : 22080;
    const requested = Number.isFinite(value) ? value : 0;
    const snapped = Math.round(requested / step) * step;

    return Math.min(Math.max(snapped, 0), max);
  }

  async #setStationLimit(requestedValue: number) {
    this.#assertProfileWritesAllowed();
    const value = this.#normalizeTargetPower(requestedValue);
    this.log('setStationLimit', { requestedValue, value });

    try {
      await this.#writeCapabilities([{ capabilityId: 'target_power', value }], (api) =>
        api.apiSetChargingLimit(value, this.#detectActivePhases()));
    } catch (error) {
      this.log('Error setting station limit:', error);
      throw new Error(`${error}`);
    }

    return true;
  }

  async #setCurrentLimit(value: number) {
    this.log('setCurrentLimit', value, 'socket', this.socketIndex);

    try {
      await this.#writeCapabilities([{ capabilityId: 'measure_current.limit', value }], (api) =>
        api.apiSetCurrentLimit(value, this.socketIndex));
    } catch (error) {
      this.log('Error setting current limit:', error);
      throw new Error(`${error}`);
    }

    return true;
  }
}

module.exports = MyDevice;
