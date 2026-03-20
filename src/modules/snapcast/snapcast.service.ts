// src/modules/snapcast/snapcast.service.ts
// ─────────────────────────────────────────────────────────────────────────────
//  SnapcastService – prioritásos pause/resume motor
//
//  Prioritások:
//    0 = BELL     (legmagasabb)
//    1 = TTS
//    2 = RADIO    (legalacsonyabb)
//
//  Megszakítás logika:
//    Magasabb prioritású job érkezésekor az aktív job PAUSE-ba kerül
//    (lejátszott idő elmentve), a magasabb lejátszik, majd az alacsonyabb
//    RESUME-ol onnan ahol megállt.
//
//    File/MP3 URL: ffmpeg -ss {elapsedSec} seek-kel folytatható
//    Élő stream:   reconnect az aktuális élő pozícióhoz (nincs seek)
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
const SILENCE_PAD_MS  = 300;   // hangok között ennyi ms csend (kattanás ellen)

// ── Pausolt job állapot ───────────────────────────────────────────────────────
interface PausedJob {
  job:        SnapJob;
  elapsedSec: number;   // eddig lejátszott idő (file/MP3 URL esetén seek-hez)
  pausedAt:   Date;
}

// ── Service ───────────────────────────────────────────────────────────────────
class SnapcastServiceClass extends EventEmitter {
  private queue:        SnapJob[]   = [];   // várakozó jobok
  private currentJob:   SnapJob | null = null;
  private pausedStack:  PausedJob[] = [];   // megszakított jobok vereme (LIFO)
  private ffmpeg:       ChildProcess | null = null;
  private _running      = false;
  private jobStartedAt: Date | null = null; // aktív job indulási ideje

  // ── Publikus API ──────────────────────────────────────────────────────────

  play(params: {
    type:        SnapJobType;
    source:      SnapAudioSource;
    tenantId:    string;
    title?:      string;
    text?:       string;
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

    console.log(`[Snapcast] ➕ Job: ${job.type} id=${job.id}`);

    if (this.currentJob === null && this.queue.length === 0 && this.pausedStack.length === 0) {
      // Teljesen üres állapot → azonnal indul
      this.startJob(job);
      return job.id;
    }

    if (this.currentJob !== null && job.priority < this.currentJob.priority) {
      // Magasabb prioritású érkezett → aktív job pause
      this.pauseCurrent();
      // A killCurrent async (close event), ezért a sor elejére tesszük
      this.queue.unshift(job);
      this.emit("queueChanged", [...this.queue]);
      return job.id;
    }

    // Ugyanolyan vagy alacsonyabb prioritás → sorba
    this.enqueue(job);
    return job.id;
  }

  stop(): void {
    console.log("[Snapcast] 🛑 Stop – minden lejátszás törölve");
    this.queue       = [];
    this.pausedStack = [];
    this.killCurrent();
    this.emit("queueChanged", []);
  }

  stopRadio(): void {
    this.queue       = this.queue.filter(j => j.type !== "RADIO");
    this.pausedStack = this.pausedStack.filter(p => p.job.type !== "RADIO");
    if (this.currentJob?.type === "RADIO") {
      this.killCurrent();
    }
    this.emit("queueChanged", [...this.queue]);
  }

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

  private enqueue(job: SnapJob): void {
    if (job.type === "RADIO") {
      // RADIO: ha már van a sorban, cseréljük ki; a pause veremben is
      const qIdx = this.queue.findIndex(j => j.type === "RADIO");
      if (qIdx !== -1) {
        this.queue.splice(qIdx, 1, job);
      } else {
        this.queue.push(job);
      }
      // Ha a pause veremben van RADIO, frissítjük (új URL-lel folytatódik)
      const pIdx = this.pausedStack.findIndex(p => p.job.type === "RADIO");
      if (pIdx !== -1) {
        this.pausedStack[pIdx] = { job, elapsedSec: 0, pausedAt: new Date() };
      }
    } else {
      // TTS/BELL: prioritás szerint szúrjuk be
      const insertAt = this.queue.findIndex(j => j.priority > job.priority);
      if (insertAt === -1) {
        this.queue.push(job);
      } else {
        this.queue.splice(insertAt, 0, job);
      }
    }
    this.emit("queueChanged", [...this.queue]);
  }

  private pauseCurrent(): void {
    if (!this.currentJob || !this.jobStartedAt) return;

    const elapsedSec = (Date.now() - this.jobStartedAt.getTime()) / 1000;
    const paused: PausedJob = {
      job:        this.currentJob,
      elapsedSec: Math.max(0, elapsedSec - (SILENCE_PAD_MS / 1000)),
      pausedAt:   new Date(),
    };

    console.log(
      `[Snapcast] ⏸ Pause: ${paused.job.type} id=${paused.job.id}` +
      ` elapsed=${elapsedSec.toFixed(1)}s`,
    );

    this.pausedStack.push(paused);
    this.killCurrent();
  }

  private resumeFromStack(): void {
    if (this.pausedStack.length === 0) return;

    const paused = this.pausedStack.pop()!;
    console.log(
      `[Snapcast] ▶ Resume: ${paused.job.type} id=${paused.job.id}` +
      ` from=${paused.elapsedSec.toFixed(1)}s`,
    );

    const resumedJob: SnapJob = {
      ...paused.job,
      source: this.applySeek(paused.job.source, paused.elapsedSec),
    };

    this.startJob(resumedJob);
  }

  private applySeek(source: SnapAudioSource, elapsedSec: number): SnapAudioSource {
    // Élő stream: nincs seek, reconnect az aktuális pozícióhoz
    if (source.type === "stream") return source;
    // File vagy URL: seek pozíció beágyazva a source-ba
    return { ...source, _seekSec: elapsedSec } as any;
  }

  private processQueue(): void {
    if (this.currentJob !== null) return;

    // Ha van pausolt job és a sor üres vagy a pausolt job magasabb/egyenlő prioritású
    if (this.pausedStack.length > 0) {
      const topPaused  = this.pausedStack[this.pausedStack.length - 1];
      const nextQueued = this.queue[0];

      if (!nextQueued || nextQueued.priority >= topPaused.job.priority) {
        setTimeout(() => this.resumeFromStack(), SILENCE_PAD_MS);
        return;
      }
    }

    if (this.queue.length === 0) return;

    const job = this.queue.shift()!;
    this.emit("queueChanged", [...this.queue]);
    setTimeout(() => this.startJob(job), SILENCE_PAD_MS);
  }

  private startJob(job: SnapJob): void {
    if (!existsSync(FIFO_PATH)) {
      console.error(`[Snapcast] ❌ FIFO nem létezik: ${FIFO_PATH}`);
      this.emit("error", new Error(`FIFO not found: ${FIFO_PATH}`));
      this.processQueue();
      return;
    }

    this.currentJob   = job;
    this.jobStartedAt = new Date();
    this._running     = true;

    console.log(`[Snapcast] ▶ Start: ${job.type} | ${this.describeSource(job.source)}`);
    this.emit("jobStarted", job);

    const args = this.buildFfmpegArgs(job.source);
    // stdout pipe → FIFO (shell redirect nem működik node spawn-ból deploy userként)
    const proc = spawn(
      "/bin/bash",
      ["-c", `${FFMPEG_BIN} ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} > ${FIFO_PATH}`],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    this.ffmpeg = proc;

    proc.stderr?.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line.includes("Error") || line.includes("error") || line.includes("Invalid")) {
        console.error(`[Snapcast/ffmpeg] ${line}`);
      }
    });

    proc.on("close", (code, signal) => {
      const wasJob = this.currentJob;
      this.ffmpeg       = null;
      this.currentJob   = null;
      this.jobStartedAt = null;
      this._running     = false;

      if (!wasJob) return;

      const reason = signal ? "interrupted" : (code === 0 ? "done" : "error");
      console.log(`[Snapcast] ⏹ ${reason}: ${wasJob.type} id=${wasJob.id}`);
      this.emit("jobFinished", wasJob, reason);

      // Persistent RADIO stream hiba esetén újraindítás
      if (wasJob.persistent && wasJob.type === "RADIO" && reason === "error") {
        console.log("[Snapcast] 🔄 Radio stream újraindítás 3s múlva...");
        setTimeout(() => {
          if (this.currentJob === null) {
            this.startJob(wasJob);
          }
        }, 3000);
        return;
      }

      this.processQueue();
    });

    proc.on("error", (err: Error) => {
      console.error("[Snapcast] spawn hiba:", err);
      this.ffmpeg       = null;
      this.currentJob   = null;
      this.jobStartedAt = null;
      this._running     = false;
      this.emit("error", err);
      this.processQueue();
    });
  }

  private killCurrent(): void {
    if (this.ffmpeg) {
      this.ffmpeg.kill("SIGTERM");
      // currentJob cleanup a close event handlerben
    } else {
      this.currentJob   = null;
      this.jobStartedAt = null;
      this._running     = false;
    }
  }

  // ── ffmpeg args builder ───────────────────────────────────────────────────

  private buildFfmpegArgs(source: SnapAudioSource & { _seekSec?: number }): string[] {
    const seekSec = (source as any)._seekSec as number | undefined;

    const outputArgs = [
      "-f",  "s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "-",    // stdout
    ];

    const seekArgs = seekSec && seekSec > 0.5
      ? ["-ss", seekSec.toFixed(3)]
      : [];

    if (source.type === "file") {
      return [
        "-re",
        ...seekArgs,
        "-i", source.path,
        "-vn",
        ...outputArgs,
        "-y",
      ];
    }

    if (source.type === "url") {
      return [
        "-re",
        "-reconnect",         "1",
        "-reconnect_at_eof",  "1",
        "-reconnect_streamed","1",
        ...seekArgs,
        "-i", source.url,
        "-vn",
        ...outputArgs,
        "-y",
      ];
    }

    if (source.type === "stream") {
      return [
        "-re",
        "-reconnect",           "1",
        "-reconnect_at_eof",    "1",
        "-reconnect_streamed",  "1",
        "-reconnect_delay_max", "5",
        "-i", source.url,
        "-vn",
        "-bufsize", "8192k",
        ...outputArgs,
        "-y",
      ];
    }

    throw new Error(`Ismeretlen source type: ${(source as any).type}`);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private describeSource(source: SnapAudioSource & { _seekSec?: number }): string {
    const seek = (source as any)._seekSec
      ? ` @${((source as any)._seekSec as number).toFixed(1)}s`
      : "";
    if (source.type === "file")   return `file:${source.path}${seek}`;
    if (source.type === "url")    return `url:${source.url}${seek}`;
    if (source.type === "stream") return `stream:${source.url}`;
    return "unknown";
  }
}

// Singleton
export const SnapcastService = new SnapcastServiceClass();