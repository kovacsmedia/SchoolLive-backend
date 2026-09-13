// src/modules/snapcast/snapcast.types.ts

// Pre-gain érték 0..1 lineáris – csak az adott forrást érinti
// (csengetésre/üzenetekre nincs hatás, mert külön job-ok).
export type SnapAudioSource =
  | { type: "file";   path: string; volume?: number; }   // Bell: lokális fájl
  | { type: "url";    url:  string; volume?: number; }   // TTS / play-now URL
  // Rádió: élő stream URL.
  //
  // `seekable`: VÉGES, pozicionálható média (pl. a YouTube fülről élőbe
  // küldött videó googlevideo-URL-je), szemben egy valódi, végtelen
  // internetrádió-adással. Csak ilyenkor van értelme `-ss`-sel beljebb
  // ugrani, és csak ilyenkor szabad megszakítás után a megszakítás pontján
  // folytatni – egy élő adásnál mindkettő hibás lenne (ott az "ott tartunk,
  // ahol az adás most tart" a helyes viselkedés).
  | { type: "stream"; url:  string; volume?: number; seekable?: boolean; };

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