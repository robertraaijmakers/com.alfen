// lib/alfenProps.ts
import { Cap, type CapabilityId } from './homeyCapabilities';

/** Which socket/device instance (Homey device) we are polling. */
export type SocketIndex = 1 | 2;

/**
 * Property id input type.
 * - `number` represents a 24-bit hex-style prop id, e.g. 0x222111.
 * - `string` represents the legacy "2221_16" style used by some Alfen firmwares.
 */
export type PropId = number | string;

/** Convert 0x222111 -> "2221_11" for /api/prop ids */
export function propIdToApiId(propId: number): string {
  const hex = propId.toString(16).toUpperCase().padStart(6, '0'); // "222111"
  return normalizeApiId(`${hex.slice(0, 4)}_${hex.slice(4, 6)}`); // "2221_11"
}

export function normalizeApiId(id: string): string {
  const [aRaw, bRaw = '0'] = id.split('_');

  const a = aRaw.trim().toUpperCase();

  // bRaw kan zijn: "00", "0A", "A", "0", "0001", etc.
  let b = bRaw.trim().toUpperCase();

  // strip leading zeros, maar laat minimaal "0" over
  b = b.replace(/^0+/, '');
  if (b === '') b = '0';

  return `${a}_${b}`;
}

/** Build comma-separated `ids=` parameter value. */
export function buildIds(propIds: ReadonlyArray<PropId>): string {
  return propIds.map((p) => (typeof p === 'number' ? propIdToApiId(p) : p)).join(',');
}

/**
 * Socket2 offset, derived from your enums:
 * - socket1 power/energy: 0x2221xx
 * - socket2 power/energy: 0x3221xx
 */
const socket2Offset = 0x100000;

/** Apply socket offset to a socket-1 based numeric prop id. */
export function forSocket(propIdSocket1: number, socketIndex: SocketIndex): number {
  return socketIndex === 1 ? propIdSocket1 : propIdSocket1 + socket2Offset;
}

function unique<T>(items: ReadonlyArray<T>): T[] {
  return Array.from(new Set(items));
}

function asApiId(p: PropId): string {
  return typeof p === 'number' ? propIdToApiId(p) : p;
}

/**
 * Canonical prop ids (numeric) derived from your C# enums.
 * We also keep a small set of legacy string ids for firmwares that still expose those.
 */
export const alfenProps = {
  general: {
    //AlfenGeneralPropId
    temperatureInternal: 0x220100, // °C
    authMode: 0x212600, //Authorization mode
    chargeID: 0x206300, //Plug & Charge ID
    stationLimit: 0x206200, //station maximum current (A)
  },
  solar: {
    //(only Single, not on Duo)
    chargeType: 0x328001, // Operation Mode
    greenShare: 0x328002, //Geen Share
    comfortChargeLevel: 0x328003, //comfort Level
  },
  status: {
    //chargerStatus: 0x100100,
    //isCharging: 0x100110,
    //vehicleConnected: 0x100112,
    deviceState: {
      1: 0x319001,
      2: 0x319101,
    },
    operatingMode: {
      1: 0x250102,
      2: 0x250202,
    },
  },
  // Socket-1 base values (socket-2 computed via forSocket)
  socketBase: {
    currentLimit: 0x212900, // A

    //Socket 1 values, for socket wil be calc
    voltageL1: 0x222103, // V
    voltageL2: 0x222104, // V
    voltageL3: 0x222105, // V

    currentL1: 0x22210a, // A
    currentL2: 0x22210b, // A
    currentL3: 0x22210c, // A

    powerRealL1: 0x222113, // kW
    powerRealL2: 0x222114, // kW
    powerRealL3: 0x222115, // kW
    powerRealTotal: 0x222116, // kW

    energyDeliveredTotal: 0x222122, // kWh

    energyConsumedL1: 0x222123,
    energyConsumedL2: 0x222124,
    energyConsumedL3: 0x222125,
    energyConsumedTotal: 0x222126,
  },
} as const;

/**
 * The ids we request for polling.
 * We request both canonical numeric ids and legacy string ids where applicable.
 *
 * Rules:
 * - Socket 1: everything (general + solar/greenshare + socket1 status + socket1 meters)
 * - Socket 2+: NO solar/greenshare (Greenshare works only on socket 1)
 * - Socket 2+: use forSocket(...) to request the socket-specific meter ids (e.g. 2221_x -> 3221_x)
 */
export function getActualValuePropIds(socketIndex: SocketIndex): PropId[] {
  const s = alfenProps.socketBase;

  // Shared / station-wide (not socket dependent)
  const shared: PropId[] = [alfenProps.general.temperatureInternal, alfenProps.general.stationLimit, alfenProps.general.authMode, alfenProps.general.chargeID];

  // Solar / GreenShare: ONLY for socket 1
  const solarSocket1Only: PropId[] = [alfenProps.solar.chargeType, alfenProps.solar.greenShare, alfenProps.solar.comfortChargeLevel];

  // Explicit status ids per socket
  const statusSocket1: PropId[] = [alfenProps.status.deviceState[1], alfenProps.status.operatingMode[1]];

  const statusSocket2: PropId[] = [alfenProps.status.deviceState[2], alfenProps.status.operatingMode[2]];

  // Numeric meter candidates (socket 1 ids).
  // For socket 2 we transform them via forSocket(id, 2).
  const meterCandidates: number[] = [
    s.voltageL1,
    s.voltageL2,
    s.voltageL3,

    s.currentL1,
    s.currentL2,
    s.currentL3,

    s.currentLimit,

    s.powerRealTotal,
    s.powerRealL1,
    s.powerRealL2,
    s.powerRealL3,

    s.energyDeliveredTotal,
    s.energyConsumedTotal,

    // Optional debug
    s.energyConsumedL1,
    s.energyConsumedL2,
    s.energyConsumedL3,
  ];

  if (socketIndex === 1) {
    return unique([...shared, ...solarSocket1Only, ...statusSocket1, ...meterCandidates]);
  }

  // Socket 2+: no solar/greenshare
  const meterSocket2: PropId[] = meterCandidates.map((id) => forSocket(id, 2));

  return unique([...shared, ...statusSocket2, ...meterSocket2]);
}

/**
 * Map api prop-ids to Homey capabilities.
 * Only include capabilities that exist / are sane to auto-add.
 */
export function getCapabilityMap(socketIndex: SocketIndex): Record<string, CapabilityId> {
  const s = alfenProps.socketBase;

  return {
    [propIdToApiId(alfenProps.general.temperatureInternal)]: Cap.MeasureTemperature,

    // Status code (numeriek) -> operatingmode (string) + derived
    [propIdToApiId(alfenProps.general.stationLimit)]: Cap.StationLimit,
    [propIdToApiId(alfenProps.general.authMode)]: Cap.AuthMode,
    [propIdToApiId(alfenProps.general.chargeID)]: Cap.ChargeID,
    [propIdToApiId(alfenProps.solar.chargeType)]: Cap.ChargeType,
    [propIdToApiId(alfenProps.solar.greenShare)]: Cap.GreenShare,
    [propIdToApiId(alfenProps.solar.comfortChargeLevel)]: Cap.ComfortChargeLevel,

    [propIdToApiId(alfenProps.status.operatingMode[socketIndex])]: Cap.OperatingMode,
    [propIdToApiId(forSocket(s.currentLimit, socketIndex))]: Cap.CurrentLimit,

    [propIdToApiId(forSocket(s.voltageL1, socketIndex))]: Cap.MeasureVoltageL1,
    [propIdToApiId(forSocket(s.voltageL2, socketIndex))]: Cap.MeasureVoltageL2,
    [propIdToApiId(forSocket(s.voltageL3, socketIndex))]: Cap.MeasureVoltageL3,

    [propIdToApiId(forSocket(s.currentL1, socketIndex))]: Cap.MeasureCurrentL1,
    [propIdToApiId(forSocket(s.currentL2, socketIndex))]: Cap.MeasureCurrentL2,
    [propIdToApiId(forSocket(s.currentL3, socketIndex))]: Cap.MeasureCurrentL3,

    [propIdToApiId(forSocket(s.powerRealTotal, socketIndex))]: Cap.MeasurePower,
    [propIdToApiId(forSocket(s.energyDeliveredTotal, socketIndex))]: Cap.MeterPower,
  };
}
