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
  ChargeType: 'chargetype',
  GreenShare: 'greenshare',
  ComfortChargeLevel: 'comfortchargelevel',

  CurrentLimit: 'measure_current.limit',
  StationLimit: 'measure_current.stationlimit',

  P1CurrentL1: 'measure_current.p1l1',
  P1CurrentL2: 'measure_current.p1l2',
  P1CurrentL3: 'measure_current.p1l3',
} as const;

export type CapabilityId = (typeof Cap)[keyof typeof Cap];
