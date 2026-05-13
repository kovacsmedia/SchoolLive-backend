// src/modules/snapcast/snapcast.types.ts

// Pre-gain érték 0..1 lineáris – csak az adott forrást érinti
// (csengetésre/üzenetekre nincs hatás, mert külön job-ok).
export type SnapAudioSource =
  | { type: "file";   path: string; volume?: number; }   // Bell: lokális fájl
  | { type: "url";    url:  string; volume?: number; }   // TTS / play-now URL
  | { type: "stream"; url:  string; volume?: number; };  // Rádió: élő stream URL

export type SnapJobType = "BELL" | "TTS" | "RADIO";

// Prioritás: kisebb szám = magasabb prioritás
export const SNAP_PRIORITY: Record<SnapJobType, number> = {
  BELL:  0,
  TTS:   1,
  RADIO: 2,
};

export interface SnapJob {
  id:        string;
  type:      SnapJobType;
  source:    SnapAudioSource;
  tenantId:  string;
  title?:    string;
  text?:     string;
  priority:  number;
  queuedAt:  Date;
  // Rádió esetén folyamatos lejátszás – nem kerül ki a queue-ból automatikusan
  persistent?: boolean;
}

export interface SnapStatus {
  running:        boolean;
  currentJob:     SnapJob | null;
  queueLength:    number;
  ffmpegPid:      number | null;
  fifoPath:       string;
  snapserverUrl:  string;
}