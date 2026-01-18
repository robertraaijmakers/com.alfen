// lib/models/SocketType.ts

/** Type socket */
export enum SocketType {
  FixedCable = 0,
  Mennekes = 1,
  FCT = 2,
  Schuko = 3,
  FixCable1 = 4,
  FixCable2 = 5,
  FixCableCCS = 6,
  FixCableChaDeMo = 7,
}

export type ChargerSocketsInfo = {
  numberOfSockets: 1 | 2;
  socketType1: SocketType;
  socketType2?: SocketType;
};

function isValidSocketType(n: number): n is SocketType {
  return Number.isInteger(n) && n >= 0 && n <= 7;
}

/**
 * Parse Alfen "Type" string: "x.y.z"
 */
export function parseChargerSocketsInfo(typeStr: string | undefined): ChargerSocketsInfo {
  if (!typeStr || typeof typeStr !== 'string') {
    return { numberOfSockets: 1, socketType1: SocketType.Mennekes };
  }

  const parts = typeStr.split('.').map(p => p.trim());
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);

  const numberOfSockets: 1 | 2 = x === 2 ? 2 : 1;
  const socketType1: SocketType = isValidSocketType(y) ? y : SocketType.Mennekes;

  if (numberOfSockets === 2) {
    const socketType2: SocketType = isValidSocketType(z) ? z : SocketType.Mennekes;
    return { numberOfSockets, socketType1, socketType2 };
  }

  return { numberOfSockets, socketType1 };
}
