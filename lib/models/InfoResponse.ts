// lib/models/InfoResponse.ts

export type InfoResponse = {
  Identity?: string;
  SCNNetwork?: string;
  FWVersion?: string;
  LastConfig?: number;
  ContentType?: string;
  Model?: string;
  ObjectId?: string;
  Type?: string; // "x.y.z"
  BOConnection?: string;
};
