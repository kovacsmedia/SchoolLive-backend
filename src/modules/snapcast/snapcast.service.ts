// src/modules/snapcast/snapcast.service.ts
// ─────────────────────────────────────────────────────────────────────────────
//  SnapcastService – ffmpeg → named FIFO → snapserver pipeline
//
//  Működési elv:
//    1. play() híváskor a job a prioritásos sorba kerül
//    2. Ha nincs aktív lejátszás → azonnal indul
//    3. Ha van aktív:
//       - BELL (priority 0): azonnal megszakítja az aktívat, indul
//       - TTS  (priority 1): megszakítja a RADIO-t, de BELL-t nem
//       - RADIO (priority 2): csak akkor indul, ha üres a sor
//    4. ffmpeg PCM-be konvertál (-f s16le -ar 48000 -ac 2)
//       és a /tmp/snapfifo-ba írja
//    5. Job végeztével a következő indul a sorból
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, ChildProcess } from "child_process";
import { existsSync }          from "fs";
import { EventEmitter }        from "events";
import { randomUUID }          from "crypto";
import {
  SnapJob, SnapJobType, SnapStatus,
  SnapAudioSource, SNAP_PRIORITY,
} from "./snapcast.types";

// ── Konfig ────────────────────────────────────────────────────────────────────
const FIFO_PATH       = process.env.SNAP_FIFO_PATH    ?? "/tmp/snapfifo";
const FFMPEG_BIN      = process.env.FFMPEG_BIN        ?? "/usr/bin/ffmpeg";
const SNAPSERVER_URL  = process.env.SNAPSERVER_URL    ?? "http://localhost:1780";
const SAMPLE_RATE     = 48000;
const CHANNELS        = 2;
const SILENCE_PAD_MS  = 300;   // lejátszás után ennyi ms csend a "kattanás" elkerülésére

// ── Eseménytípusok ─────────────────────────────────────────────────────────
export interface SnapcastEvents {
  jobStarted:   (job: SnapJob) => void;
  jobFinished:  (job: SnapJob, reason: "done" | "interrupted" | "error") => void;
  queueChanged: (queue: SnapJob[]) => void;
  error:        (err: Error) => void;
}

// ── Service ───────────────────────────────────────────────────────────────────
class SnapcastServiceClass extends EventEmitter {
  private queue:       SnapJob[]     = [];
  private currentJob:  SnapJob | null = null;
  private ffmpeg:      ChildProcess | null = null;
  private _running     = false;

  // ── Publikus API ──────────────────────────────────────────────────────────

  /**
   * Hang lejátszása Snapcaston keresztül.
   * Visszatér a job ID-val.
   */
  play(params: {
    type:       SnapJobType;
    source:     SnapAudioSource;
    tenantId:   string;
    title?:     string;
    text?:      string;
    persistent?: boolean;
  }): string {
    const job: SnapJob = {
      id:         randomUUID(),
      type:       params.type,
      source:     params.source,
      tenantId:   params.tenantId,
      title:      params.title,
      text:       params.text,
      priority:   SNAP_PRIORITY[params.type],
      queuedAt:   new Date(),
      persistent: params.persistent ?? false,
    };

    console.log(`[Snapcast] ➕ Job queued: ${job.type} id=${job.id}`);

    // BELL: azonnali megszakítás, sor elejére
    if (job.type === "BELL") {
      this.interruptCurrent("interrupted");
      this.queue.unshift(job);
    }
    // TTS: megszakítja a RADIO-t, de ha BELL játszik, sor elejére (BELL mögé)
    else if (job.type === "TTS") {
      if (this.currentJob?.type === "RADIO") {
        this.interruptCurrent("interrupted");
        this.queue.unshift(job);
      } else if (this.currentJob?.type === "BELL") {
        // BELL játszik → TTS a sor elejére (BELL után indul)
        this.queue.unshift(job);
      } else {
        this.queue.push(job);
      }
    }
    // RADIO: csak a sor végére, nem szakít meg semmit
    else {
      // Ha van persistent RADIO, cseréljük ki
      const existingRadioIdx = this.queue.findIndex(j => j.type === "RADIO" && j.persistent);
      if (existingRadioIdx !== -1) {
        this.queue.splice(existingRadioIdx, 1, job);
      } else {
        this.queue.push(job);
      }
    }

    this.emit("queueChanged", [...this.queue]);
    this.processQueue();
    return job.id;
  }

  /**
   * Azonnali leállítás – minden törlése.
   */
  stop(): void {
    console.log("[Snapcast] 🛑 Stop – minden lejátszás leállítva");
    this.queue = [];
    this.interruptCurrent("interrupted");
    this.emit("queueChanged", []);
  }

  /**
   * Csak a rádió leállítása (TTS/Bell folytatódik).
   */
  stopRadio(): void {
    // Sor-ból töröljük a RADIO jobokat
    this.queue = this.queue.filter(j => j.type !== "RADIO");
    if (this.currentJob?.type === "RADIO") {
      this.interruptCurrent("interrupted");
    }
    this.emit("queueChanged", [...this.queue]);
  }

  /**
   * Aktuális státusz lekérdezése.
   */
  getStatus(): SnapStatus {
    return {
      running:       this._running,
      currentJob:    this.currentJob,
      queueLength:   this.queue.length,
      ffmpegPid:     this.ffmpeg?.pid ?? null,
      fifoPath:      FIFO_PATH,
      snapserverUrl: SNAPSERVER_URL,
    };
  }

  /**
   * Ellenőrzi, hogy a snapserver elérhető-e.
   */
  async isSnapserverOnline(): Promise<boolean> {
    try {
      const r = await fetch(`${SNAPSERVER_URL}/jsonrpc`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ id: 1, jsonrpc: "2.0", method: "Server.GetStatus" }),
        signal:  AbortSignal.timeout(2000),
      });
      return r.ok;
    } catch {
      return false;
    }
  }

  // ── Belső logika ──────────────────────────────────────────────────────────

  private processQueue(): void {
    // Ha már fut valami (és nem lett megszakítva), várunk
    if (this.currentJob !== null) return;
    if (this.queue.length === 0) return;

    const job = this.queue.shift()!;
    this.emit("queueChanged", [...this.queue]);
    this.startJob(job);
  }

  private startJob(job: SnapJob): void {
    if (!existsSync(FIFO_PATH)) {
      console.error(`[Snapcast] ❌ FIFO nem létezik: ${FIFO_PATH}`);
      this.emit("error", new Error(`FIFO not found: ${FIFO_PATH}`));
      this.currentJob = null;
      this.processQueue();
      return;
    }

    this.currentJob = job;
    this._running   = true;
    console.log(`[Snapcast] ▶ Start: ${job.type} | ${this.describeSource(job.source)}`);
    this.emit("jobStarted", job);

    const args = this.buildFfmpegArgs(job.source);
    console.log(`[Snapcast] ffmpeg ${args.join(" ")}`);

    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.ffmpeg = proc;

    proc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      // Csak hibás sorok logolása (ffmpeg nagyon verbose)
      if (line.includes("Error") || line.includes("error") || line.includes("Invalid")) {
        console.error(`[Snapcast/ffmpeg] ${line}`);
      }
    });

    proc.on("close", (code, signal) => {
      const wasJob = this.currentJob;
      this.ffmpeg     = null;
      this.currentJob = null;
      this._running   = false;

      if (!wasJob) return;

      const reason = signal ? "interrupted" : (code === 0 ? "done" : "error");
      console.log(`[Snapcast] ⏹ Job ${reason}: ${wasJob.type} id=${wasJob.id} (code=${code} signal=${signal})`);
      this.emit("jobFinished", wasJob, reason);

      // Persistent RADIO job újraindítása ha természetesen ért véget (stream szakadt)
      if (wasJob.persistent && wasJob.type === "RADIO" && reason === "error") {
        console.log("[Snapcast] 🔄 Radio stream újraindítás 3s múlva...");
        setTimeout(() => {
          if (this.currentJob === null) {
            this.queue.unshift(wasJob);
            this.processQueue();
          }
        }, 3000);
        return;
      }

      // Csend pad a következő hang előtt (kattanás elkerülés)
      if (this.queue.length > 0) {
        setTimeout(() => this.processQueue(), SILENCE_PAD_MS);
      } else {
        this.processQueue();
      }
    });

    proc.on("error", (err: Error) => {
      console.error("[Snapcast] ffmpeg spawn hiba:", err);
      this.ffmpeg     = null;
      this.currentJob = null;
      this._running   = false;
      this.emit("error", err);
      this.processQueue();
    });
  }

  private interruptCurrent(reason: "interrupted"): void {
    if (this.ffmpeg && this.currentJob) {
      console.log(`[Snapcast] ✂️ Megszakítás: ${this.currentJob.type} id=${this.currentJob.id}`);
      this.ffmpeg.kill("SIGTERM");
      // currentJob és ffmpeg cleanup a "close" event handlerben történik
    }
  }

  // ── ffmpeg args builder ───────────────────────────────────────────────────

  private buildFfmpegArgs(source: SnapAudioSource): string[] {
    const outputArgs = [
      "-f",  "s16le",          // raw PCM, signed 16-bit little-endian
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      FIFO_PATH,               // output: named pipe
    ];

    if (source.type === "file") {
      // Lokális fájl (bell MP3)
      // -re: valós idejű lejátszási sebesség (ne gyorsabban töltse a FIFO-t)
      return [
        "-re",
        "-i", source.path,
        "-vn",                  // videó stream kihagyása
        ...outputArgs,
        "-y",                   // felülírás (FIFO esetén szükséges)
      ];
    }

    if (source.type === "url") {
      // TTS MP3 URL vagy egyéb HTTP forrás
      return [
        "-re",
        "-reconnect",       "1",
        "-reconnect_at_eof","1",
        "-reconnect_streamed","1",
        "-i", source.url,
        "-vn",
        ...outputArgs,
        "-y",
      ];
    }

    if (source.type === "stream") {
      // Élő rádióstream – reconnect agresszívabb
      return [
        "-re",
        "-reconnect",            "1",
        "-reconnect_at_eof",     "1",
        "-reconnect_streamed",   "1",
        "-reconnect_delay_max",  "5",
        "-i", source.url,
        "-vn",
        "-bufsize", "8192k",    // nagyobb buffer stream esetén
        ...outputArgs,
        "-y",
      ];
    }

    throw new Error(`Ismeretlen source type: ${(source as any).type}`);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private describeSource(source: SnapAudioSource): string {
    if (source.type === "file")   return `file:${source.path}`;
    if (source.type === "url")    return `url:${source.url}`;
    if (source.type === "stream") return `stream:${source.url}`;
    return "unknown";
  }
}

// Singleton
export const SnapcastService = new SnapcastServiceClass();