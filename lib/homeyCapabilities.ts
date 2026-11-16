export const Cap = {
  OperatingMode: 'operatingmode',
  EvCharging: 'evcharger_charging',
  EvChargingState: 'evcharger_charging_state',

  MeasureTemperature: 'measure_temperature',

  MeasureVoltageL1: 'measure_voltage.l1',
  MeasureVoltageL2: 'measure_voltage.l2',
  MeasureVoltageL3: 'measure_voltage.l3',

  MeasureCurrentL1: 'measure_current.l1',
  MeasureCurrentL2: 'measure_current.l2',
  MeasureCurrentL3: 'measure_current.l3',
  MeasureCurrentTotal: 'measure_current',

  MeasurePower: 'measure_power',
  MeasurePowerL1: 'measure_power.l1',
  MeasurePowerL2: 'measure_power.l2',
  MeasurePowerL3: 'measure_power.l3',

  MeterPower: 'meter_power',

  AuthMode: 'authmode',
  ChargeID: 'chargeid',
  ActiveChargeId: 'active_charge_id',
  ChargeType: 'chargetype',
  GreenShare: 'greenshare',
  ComfortChargeLevel: 'comfortchargelevel',

  CurrentLimit: 'measure_current.limit',
  StationLimit: 'measure_current.stationlimit',
  CurrentActiveLb: 'measure_current.activelb',

  MeasureFrequency: 'measure_frequency',

  Bootups: 'bootups',
  UptimeHours: 'uptime_hours',
  BootReason: 'boot_reason',

  P1CurrentL1: 'measure_current.p1_l1',
  P1CurrentL2: 'measure_current.p1_l2',
  P1CurrentL3: 'measure_current.p1_l3',
  P1PowerTotal: 'measure_power.p1',
} as const;

export type CapabilityId = (typeof Cap)[keyof typeof Cap];
