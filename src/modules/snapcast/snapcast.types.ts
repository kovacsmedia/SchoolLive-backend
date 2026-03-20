// src/modules/snapcast/snapcast.types.ts

export type SnapAudioSource =
  | { type: "file";   path: string;  }   // Bell: lokális fájl
  | { type: "url";    url:  string;  }   // TTS: generált MP3 URL
  | { type: "stream"; url:  string;  };  // Rádió: élő stream URL

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