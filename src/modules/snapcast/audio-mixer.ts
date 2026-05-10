// src/modules/snapcast/audio-mixer.ts
//
// SchoolLive backend audio mixer
//
// Stabil, data-driven megközelítés:
// - aktív forrás esetén az ffmpeg stdout ír közvetlenül a FIFO-ba;
// - nincs 5 mp warmup;
// - nincs saját PCM pumpa;
// - nincs előretöltött csend;
// - csendet csak akkor írunk, amikor nincs aktív forrás;
// - a FIFO megnyitása előtt a running flag már true.

import { spawn, ChildProcess } from "child_process";
import { createWriteStream, WriteStream, existsSync } from "fs";
import { EventEmitter } from "events";

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "/usr/bin/ffmpeg";

// ── Audio konstansok ────────────────────────────────────────────────────────

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // s16le
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE; // 4 byte/frame
const BYTES_PER_SEC = SAMPLE_RATE * FRAME_BYTES; // 192000 byte/s

// ── Fade/gap paraméterek ────────────────────────────────────────────────────

const FADE_OUT_BYTES = Math.round(BYTES_PER_SEC * 1.0); // 1 s fade-out
const FADE_IN_BYTES = Math.round(BYTES_PER_SEC * 0.2); // 200 ms fade-in
const POST_FADE_GAP_MS = 200;

// ── Pre/post silence ────────────────────────────────────────────────────────
//
// PRE_SILENCE_MS: minden új job előtt ennyi csend megy a FIFO-ba a tényleges
// hang előtt. Ez fedi a klienseken átfutó unmute / volume RPC-ket
// (különösen a python klienseket, amik kill+restart-tal alkalmazzák a
// volume változást), így a hang eleje nem vágódik le.
//
// A source:start event a csend ELEJÉN tüzel, így a snapcast.service.ts
// célzási retry mechanizmusa (0/500/1500 ms) mind a csend alatt fut le.
//
// POST_SILENCE_MS: a job vége után ennyi csend, hogy a kliensek pufferei
// kiürülhessenek mielőtt egy újabb forrás indulna ugyanitt.
const PRE_SILENCE_MS = 1000;
const POST_SILENCE_MS = 500;

// ── Csend tick: csak akkor fut tényleges írás, ha nincs aktív forrás ─────────

const SILENCE_TICK_MS = 20;
const SILENCE_TICK_BUF = Buffer.alloc(
  Math.round((BYTES_PER_SEC * SILENCE_TICK_MS) / 1000)
);

// ────────────────────────────────────────────────────────────────────────────
// Public típusok
// ────────────────────────────────────────────────────────────────────────────

export type MixerJobType = "BELL" | "TTS" | "RADIO";

export interface MixerSource {
  type: "file" | "url" | "stream";
  path?: string;
  url?: string;
}

export interface MixerJob {
  id: string;
  jobType: MixerJobType;
  source: MixerSource;
  priority: number; // kisebb = magasabb prio
  title?: string;
  text?: string;
  resumeBytes?: number;
}

export type SourceEndReason = "done" | "interrupted" | "error" | "stopped";

export interface MixerStatus {
  fifoPath: string;
  ticking: boolean;
  current: null | {
    jobType: MixerJobType;
    title?: string;
    bytesWritten: number;
    fadingOut: boolean;
    fadingIn: boolean;
  };
  pending: null | {
    jobType: MixerJobType;
    title?: string;
  };
  paused: Array<{
    jobType: MixerJobType;
    title?: string;
    resumeBytes: number;
  }>;
  queue: Array<{
    jobType: MixerJobType;
    title?: string;
  }>;
  inGap: boolean;
  inPreSilence: boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Belső állapot
// ────────────────────────────────────────────────────────────────────────────

interface ActiveSource {
  job: MixerJob;
  proc: ChildProcess;
  bytesWritten: number;

  fadeInActive: boolean;
  fadeOutStart: number | null;
  killed: boolean;
}

interface PausedSource {
  job: MixerJob;
  resumeBytes: number;
  pausedAt: number;
}

interface PendingStart {
  job: MixerJob;
  timer: ReturnType<typeof setTimeout>;
}

// ────────────────────────────────────────────────────────────────────────────

export class TenantAudioMixer extends EventEmitter {
  readonly tenantId: string;
  readonly fifoPath: string;

  private fifoStream: WriteStream | null = null;

  private active: ActiveSource | null = null;
  private pending: PendingStart | null = null;
  private pausedStack: PausedSource[] = [];
  private queue: MixerJob[] = [];

  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;

  private running = false;
  private inGap = false;

  constructor(tenantId: string, fifoPath: string) {
    super();
    this.tenantId = tenantId;
    this.fifoPath = fifoPath;
  }

  // ── Életciklus ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;

    if (!existsSync(this.fifoPath)) {
      console.warn(`[Mixer:${this.tenantId}] FIFO nincs: ${this.fifoPath}`);
      return;
    }

    // Fontos: ez az openFifo() előtt legyen,
    // mert az openFifo() elején ellenőrizzük a running állapotot.
    this.running = true;

    this.openFifo();

    this.silenceTimer = setInterval(
      () => this.tickSilence(),
      SILENCE_TICK_MS
    );

    console.log(`[Mixer:${this.tenantId}] ▶ stream INDUL → ${this.fifoPath}`);
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }

    if (this.gapTimer) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }

    this.cancelPending("stopped");
    this.killActive("stopped");

    this.queue = [];
    this.pausedStack = [];

    try {
      this.fifoStream?.destroy();
    } catch {
      // ignore
    }

    this.fifoStream = null;

    console.log(`[Mixer:${this.tenantId}] ⏹ stream LEÁLLÍTVA`);
  }

  private openFifo(): void {
    if (!this.running) return;

    try {
      const stream = createWriteStream(this.fifoPath, { flags: "w" });

      stream.once("error", (e) => {
        console.error(
          `[Mixer:${this.tenantId}] FIFO hiba (${e.message}) → 1s múlva újranyitás`
        );

        if (this.fifoStream === stream) {
          this.fifoStream = null;
        }

        // Az esetleges későbbi async stream hibákat elnyeljük,
        // hogy ne legyen unhandled exception.
        stream.removeAllListeners("error");
        stream.on("error", () => {
          // ignore
        });

        if (this.running) {
          setTimeout(() => this.openFifo(), 1000);
        }
      });

      stream.once("open", () => {
        console.log(`[Mixer:${this.tenantId}] FIFO stream megnyitva írásra`);
      });

      this.fifoStream = stream;
    } catch (e: any) {
      console.error(`[Mixer:${this.tenantId}] FIFO open hiba: ${e.message}`);

      if (this.running) {
        setTimeout(() => this.openFifo(), 2000);
      }
    }
  }

  // ── Publikus API ────────────────────────────────────────────────────────

  enqueue(job: MixerJob): void {
    console.log(
      `[Mixer:${this.tenantId}] ➕ ${job.jobType} (prio=${job.priority}) | ${this.desc(job)}`
    );

    // Sem aktív forrás, sem pending start, sem gap → pre-silence-szel indítunk.
    if (!this.active && !this.pending && !this.inGap) {
      this.beginPendingStart(job);
      return;
    }

    // Magasabb prioritású hang megszakítja az aktuálisat fade-outtal.
    if (this.active && job.priority < this.active.job.priority) {
      this.queue.unshift(job);
      this.beginFadeOut();
      return;
    }

    // Magasabb prioritású hang felülír egy még meg nem szólalt pending jobot.
    // A felülírt job a queue elejére kerül, hogy később még szóljon.
    // Nem tüzelünk source:end-et, mert a job továbbra is élő — csak később indul.
    if (this.pending && job.priority < this.pending.job.priority) {
      const old = this.pending.job;

      clearTimeout(this.pending.timer);
      this.pending = null;

      this.queue.unshift(old);

      console.log(
        `[Mixer:${this.tenantId}] ↩ pending átugorva magasabb prio miatt: ` +
          `${old.jobType} → ${job.jobType}`
      );

      this.beginPendingStart(job);
      return;
    }

    this.insertByPriority(job);
  }

  // ── Pre-silence indítás ─────────────────────────────────────────────────
  //
  // A pending fázis alatt nincs aktív forrás, így a tickSilence() automatikusan
  // ír 0-kat a FIFO-ba. A source:start event ITT tüzel, hogy a snapcast.service.ts
  // célzási retry-jei (0/500/1500 ms) mind a csend alatt fussanak le, mielőtt
  // a tényleges PCM elkezdődik.
  private beginPendingStart(job: MixerJob): void {
    this.emit("source:start", {
      jobId: job.id,
      jobType: job.jobType,
      title: job.title,
    });

    console.log(
      `[Mixer:${this.tenantId}] ⏳ pre-silence ${PRE_SILENCE_MS}ms: ${job.jobType} | ${this.desc(job)}`
    );

    const timer = setTimeout(() => {
      // Védelem: ha közben leálltunk vagy a pending kicserélődött, ne indítsunk.
      if (!this.running) return;
      if (!this.pending || this.pending.job.id !== job.id) return;

      const j = this.pending.job;
      this.pending = null;

      this.startSource(j);
    }, PRE_SILENCE_MS);

    this.pending = { job, timer };
  }

  stopAll(): void {
    if (this.gapTimer) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }

    this.inGap = false;
    this.queue = [];
    this.pausedStack = [];

    this.cancelPending("stopped");
    this.killActive("stopped");
  }

  stopByType(jobType: MixerJobType): void {
    this.queue = this.queue.filter((j) => j.jobType !== jobType);
    this.pausedStack = this.pausedStack.filter(
      (p) => p.job.jobType !== jobType
    );

    if (this.pending?.job.jobType === jobType) {
      this.cancelPending("stopped");
    }

    if (this.active?.job.jobType === jobType) {
      this.killActive("stopped");
    }
  }

  // Aktív pending start törlése. Tüzeli a source:end eseményt, hogy a
  // service.ts a job memóriát (jobs map, jobTargets map) tisztítsa.
  private cancelPending(reason: SourceEndReason): void {
    if (!this.pending) return;

    const { job, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;

    this.emit("source:end", {
      jobId: job.id,
      jobType: job.jobType,
      reason,
      bytesWritten: 0,
    });

    console.log(
      `[Mixer:${this.tenantId}] ✖ pending törölve (${reason}): ${job.jobType}`
    );
  }

  getStatus(): MixerStatus {
    return {
      fifoPath: this.fifoPath,
      ticking: this.running,
      current: this.active
        ? {
            jobType: this.active.job.jobType,
            title: this.active.job.title,
            bytesWritten: this.active.bytesWritten,
            fadingOut: this.active.fadeOutStart !== null,
            fadingIn: this.active.fadeInActive,
          }
        : null,
      pending: this.pending
        ? {
            jobType: this.pending.job.jobType,
            title: this.pending.job.title,
          }
        : null,
      paused: this.pausedStack.map((p) => ({
        jobType: p.job.jobType,
        title: p.job.title,
        resumeBytes: p.resumeBytes,
      })),
      queue: this.queue.map((j) => ({
        jobType: j.jobType,
        title: j.title,
      })),
      inGap: this.inGap,
      inPreSilence: this.pending !== null,
    };
  }

  // ── Csend-timer: csak ha nincs aktív forrás ─────────────────────────────

  private tickSilence(): void {
    if (this.active) return;
    if (!this.fifoStream) return;

    try {
      this.fifoStream.write(SILENCE_TICK_BUF);
    } catch {
      // ignore
    }
  }

  // ── Forrás indítás ───────────────────────────────────────────────────────

  private startSource(job: MixerJob): void {
    const args = this.buildFfmpegArgs(job);

    const proc = spawn(FFMPEG_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const src: ActiveSource = {
      job,
      proc,
      bytesWritten: 0,
      fadeInActive: true,
      fadeOutStart: null,
      killed: false,
    };

    this.active = src;

    if (!proc.stdout) {
      console.error(
        `[Mixer:${this.tenantId}] ⚠️ proc.stdout NULL → ffmpeg nem kommunikál!`
      );
    }

    proc.stdout?.on("data", (raw: Buffer) => {
      if (this.active !== src || src.killed) return;

      const chunk = Buffer.from(raw);

      const gain = this.computeGain(src, chunk.length);

      if (gain < 1) {
        this.applyGain(chunk, gain);
      }

      const fifoExists = !!this.fifoStream;
      const ok = fifoExists ? this.fifoStream!.write(chunk) : false;

      const isFirst = src.bytesWritten === 0;

      if (isFirst) {
        console.log(
          `[Mixer:${this.tenantId}] PCM első chunk: ${chunk.length}B → ` +
            `fifoStream=${fifoExists ? "OK" : "NULL"}, write_ok=${ok}, gain=${gain.toFixed(2)}`
        );
      }

      if (!ok) {
        if (!fifoExists) {
          if (!(src as any)._warnedNoFifo) {
            console.error(
              `[Mixer:${this.tenantId}] ❌ fifoStream NULL → ffmpeg PCM eldobva!`
            );
            (src as any)._warnedNoFifo = true;
          }
        } else {
          proc.stdout?.pause();

          this.fifoStream?.once("drain", () => {
            if (!src.killed) {
              proc.stdout?.resume();
            }
          });
        }
      }

      src.bytesWritten += chunk.length;

      if (
        src.fadeOutStart !== null &&
        src.bytesWritten - src.fadeOutStart >= FADE_OUT_BYTES
      ) {
        this.onFadeOutComplete(src);
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      const txt = d.toString();

      if (/error|invalid|fail/i.test(txt)) {
        console.error(
          `[Mixer:${this.tenantId}/ffmpeg:${job.jobType}] ${
            txt.split("\n").find((l) => l.trim()) ?? txt
          }`
        );
      }
    });

    proc.on("close", (code) => {
      if (this.active !== src || src.killed) return;

      const reason: SourceEndReason = code === 0 ? "done" : "error";

      console.log(
        `[Mixer:${this.tenantId}] ⏹ ${reason}: ${src.job.jobType} ` +
          `(összesen ${src.bytesWritten} B = ${(src.bytesWritten / BYTES_PER_SEC).toFixed(2)}s PCM kiírva)`
      );

      this.active = null;

      this.emit("source:end", {
        jobId: src.job.id,
        jobType: src.job.jobType,
        reason,
        bytesWritten: src.bytesWritten,
      });

      this.scheduleAdvance(reason === "error" ? POST_FADE_GAP_MS : POST_SILENCE_MS);
    });

    proc.on("error", (err) => {
      console.error(`[Mixer:${this.tenantId}] spawn hiba: ${err.message}`);

      if (this.active === src) {
        this.active = null;

        this.emit("source:end", {
          jobId: src.job.id,
          jobType: src.job.jobType,
          reason: "error" as SourceEndReason,
          bytesWritten: src.bytesWritten,
        });

        this.scheduleAdvance(POST_FADE_GAP_MS);
      }
    });

    console.log(
      `[Mixer:${this.tenantId}] ▶ start: ${job.jobType} | ${this.desc(job)}` +
        (job.resumeBytes
          ? ` | resume@${(job.resumeBytes / BYTES_PER_SEC).toFixed(2)}s`
          : "")
    );
  }

  // ── Fade logika ──────────────────────────────────────────────────────────

  private computeGain(src: ActiveSource, chunkLen: number): number {
    if (src.fadeOutStart !== null) {
      const done = src.bytesWritten - src.fadeOutStart;

      const start = Math.max(0, 1 - done / FADE_OUT_BYTES);
      const end = Math.max(0, 1 - (done + chunkLen) / FADE_OUT_BYTES);

      return (start + end) / 2;
    }

    if (src.fadeInActive) {
      const prog = src.bytesWritten / FADE_IN_BYTES;

      if (prog >= 1) {
        src.fadeInActive = false;
        return 1;
      }

      const start = prog;
      const end = Math.min(1, (src.bytesWritten + chunkLen) / FADE_IN_BYTES);

      if (end >= 1) {
        src.fadeInActive = false;
      }

      return (start + end) / 2;
    }

    return 1;
  }

  /**
   * s16le sztereó in-place gain.
   */
  private applyGain(buf: Buffer, gain: number): void {
    if (gain <= 0) {
      buf.fill(0);
      return;
    }

    if (gain >= 1) return;

    const frames = Math.floor(buf.length / FRAME_BYTES);

    for (let i = 0; i < frames; i++) {
      const off = i * FRAME_BYTES;

      const l = buf.readInt16LE(off);
      const r = buf.readInt16LE(off + 2);

      buf.writeInt16LE(clamp16(Math.round(l * gain)), off);
      buf.writeInt16LE(clamp16(Math.round(r * gain)), off + 2);
    }
  }

  private beginFadeOut(): void {
    if (!this.active || this.active.fadeOutStart !== null) return;

    this.active.fadeOutStart = this.active.bytesWritten;

    console.log(`[Mixer:${this.tenantId}] ↘ fade-out: ${this.active.job.jobType}`);
  }

  private onFadeOutComplete(src: ActiveSource): void {
    if (src.killed) return;

    src.killed = true;

    try {
      src.proc.kill("SIGTERM");
    } catch {
      // ignore
    }

    const resumeBytes =
      (src.job.resumeBytes ?? 0) +
      (src.fadeOutStart !== null ? src.fadeOutStart : src.bytesWritten);

    if (src.job.source.type !== "stream") {
      this.pausedStack.push({
        job: src.job,
        resumeBytes,
        pausedAt: Date.now(),
      });

      console.log(
        `[Mixer:${this.tenantId}] ⏸ pause: ${src.job.jobType} @ ${(resumeBytes / BYTES_PER_SEC).toFixed(2)}s`
      );
    } else {
      console.log(
        `[Mixer:${this.tenantId}] ⏸→drop stream (nem seekelhető): ${src.job.jobType}`
      );
    }

    this.active = null;

    this.emit("source:end", {
      jobId: src.job.id,
      jobType: src.job.jobType,
      reason: "interrupted" as SourceEndReason,
      bytesWritten: src.bytesWritten,
    });

    this.scheduleAdvance(POST_FADE_GAP_MS);
  }

  private killActive(reason: SourceEndReason): void {
    if (!this.active) return;

    const src = this.active;

    src.killed = true;

    try {
      src.proc.kill("SIGTERM");
    } catch {
      // ignore
    }

    this.active = null;

    this.emit("source:end", {
      jobId: src.job.id,
      jobType: src.job.jobType,
      reason,
      bytesWritten: src.bytesWritten,
    });
  }

  // ── Advance / queue kezelés ─────────────────────────────────────────────

  private scheduleAdvance(delayMs: number): void {
    if (this.gapTimer) {
      clearTimeout(this.gapTimer);
    }

    this.inGap = delayMs > 0;

    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      this.inGap = false;
      this.advance();
    }, delayMs);
  }

  private advance(): void {
    const top = this.pausedStack.length
      ? this.pausedStack[this.pausedStack.length - 1]
      : null;

    const nxt = this.queue[0];

    if (nxt && (!top || nxt.priority < top.job.priority)) {
      this.queue.shift();
      this.beginPendingStart(nxt);
      return;
    }

    if (top) {
      this.pausedStack.pop();

      this.beginPendingStart({
        ...top.job,
        resumeBytes: top.resumeBytes,
      });

      return;
    }

    // Semmi nincs soron: a csend-timer veszi át.
  }

  private insertByPriority(job: MixerJob): void {
    const i = this.queue.findIndex((q) => q.priority > job.priority);

    if (i === -1) {
      this.queue.push(job);
    } else {
      this.queue.splice(i, 0, job);
    }
  }

  // ── ffmpeg argumentumok ─────────────────────────────────────────────────

  private buildFfmpegArgs(job: MixerJob): string[] {
    const src = job.source;
    const resumeSec = job.resumeBytes ? job.resumeBytes / BYTES_PER_SEC : 0;
    const seek = resumeSec > 0.5 ? ["-ss", resumeSec.toFixed(3)] : [];

    const out = [
      "-f",
      "s16le",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      String(CHANNELS),
      "pipe:1",
    ];

    if (src.type === "file" && src.path) {
      return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        ...seek,
        "-i",
        src.path,
        "-vn",
        ...out,
      ];
    }

    if (src.type === "url" && src.url) {
      return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-re",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        ...seek,
        "-i",
        src.url,
        "-vn",
        ...out,
      ];
    }

    if (src.type === "stream" && src.url) {
      return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-reconnect",
        "1",
        "-reconnect_at_eof",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-i",
        src.url,
        "-vn",
        ...out,
      ];
    }

    throw new Error(`Ismeretlen source: ${JSON.stringify(src)}`);
  }

  private desc(j: MixerJob): string {
    if (j.source.type === "file") {
      return `file:${j.source.path}`;
    }

    if (j.source.type === "url") {
      return `url:${(j.source.url ?? "").slice(0, 60)}`;
    }

    if (j.source.type === "stream") {
      return `stream:${(j.source.url ?? "").slice(0, 60)}`;
    }

    return "unknown";
  }
}

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}