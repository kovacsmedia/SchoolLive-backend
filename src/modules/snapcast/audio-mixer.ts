// src/modules/snapcast/audio-mixer.ts
//
// Tenantonkénti folyamatos PCM mixer.
//
// A mixer mindenkor 20ms-enként pontosan BYTES_PER_TICK byte PCM-et küld a snap
// FIFO-ba: ha nincs aktív forrás, csendet; ha van, ffmpegből dekódolt s16le PCM-et,
// szoftveres volume rampával (fade-in/out). A snap stream tehát soha nem szakad
// meg: a snapserver mindig kap data-t, a kliensek puffere nem ürül ki.
//
// Prioritás-kezelés:
//   • beérkező magasabb prioritású job → 1mp fade-out a jelenlegin → 200ms csend →
//     a megszakított job a pausedStack-be kerül (resumeBytes-szal) → új job indul
//     200ms fade-innel.
//   • ffmpeg természetes vége (vagy hiba) → a queue/pausedStack alapján lépünk
//     tovább (resume).
//   • stopAll/stopByType → killActive (csak natív kill, nincs pausedStack push).
//
// A "resumeBytes" a már kiküldött PCM bytek száma; ebből számítjuk a -ss seek
// másodpercet, így a forrás onnan folytatódik, ahol megszakadt.

import { spawn, ChildProcess } from "child_process";
import { createWriteStream, WriteStream, existsSync } from "fs";
import { EventEmitter } from "events";

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "/usr/bin/ffmpeg";

// ── Audio paraméterek ───────────────────────────────────────────────────────
// Meg kell egyezniük a snapserver konfig sample-rate / channels / format-jával.
const SAMPLE_RATE      = 48000;
const CHANNELS         = 2;
const BYTES_PER_SAMPLE = 2;                              // s16le
const FRAME_BYTES      = CHANNELS * BYTES_PER_SAMPLE;    // 4

// ── Tick pacing ─────────────────────────────────────────────────────────────
const TICK_MS          = 20;                             // 20ms == snapserver chunk_ms
const FRAMES_PER_TICK  = (SAMPLE_RATE * TICK_MS) / 1000; // 960
const BYTES_PER_TICK   = FRAMES_PER_TICK * FRAME_BYTES;  // 3840

// ── Fade és gap ────────────────────────────────────────────────────────────
const FADE_OUT_MS         = 1000;
const FADE_OUT_TICKS      = FADE_OUT_MS / TICK_MS;       // 50
const FADE_IN_MS          = 200;
const FADE_IN_TICKS       = FADE_IN_MS / TICK_MS;        // 10
const POST_FADE_GAP_MS    = 200;
const POST_FADE_GAP_TICKS = POST_FADE_GAP_MS / TICK_MS;  // 10

// ── Buffer védelem ─────────────────────────────────────────────────────────
// Max ~4mp PCM puffer per forrás; ha túl gyorsan ad ffmpeg, a régit eldobjuk.
const MAX_BUFFER_BYTES = BYTES_PER_TICK * 200;

// ────────────────────────────────────────────────────────────────────────────
// Public típusok
// ────────────────────────────────────────────────────────────────────────────

export type MixerJobType = "BELL" | "TTS" | "RADIO";

export interface MixerSource {
  type: "file" | "url" | "stream";
  path?: string;
  url?:  string;
}

export interface MixerJob {
  id:           string;
  jobType:      MixerJobType;
  source:       MixerSource;
  priority:     number;                  // kisebb = magasabb prio (BELL=0, TTS=1, RADIO=2)
  title?:       string;
  text?:        string;
  resumeBytes?: number;                  // resume offset PCM-byte-ban
}

export type SourceEndReason = "done" | "interrupted" | "error" | "stopped";

export interface MixerStatus {
  fifoPath: string;
  ticking:  boolean;
  current:  null | {
    jobType:       MixerJobType;
    title?:        string;
    bytesEmitted:  number;
    bufferedBytes: number;
    fadingOut:     boolean;
    fadingIn:      boolean;
  };
  paused: Array<{ jobType: MixerJobType; title?: string; resumeBytes: number }>;
  queue:  Array<{ jobType: MixerJobType; title?: string }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Belső állapot
// ────────────────────────────────────────────────────────────────────────────

interface ActiveSource {
  job:                MixerJob;
  proc:               ChildProcess;
  buffer:             Buffer[];        // dekódolt PCM darabok (FIFO queue)
  bufferedBytes:      number;
  bytesEmitted:       number;          // hány PCM byte-ot adtunk ki
  fadeOutStartBytes:  number | null;   // bytesEmitted a fade-out kezdetén
  ffmpegEnded:        boolean;
  ffmpegEndedReason:  SourceEndReason | null;
  fadeOutTicks:       number;          // 0 = nincs, >0 = aktív
  fadeInTicks:        number;
  postFadeGapTicks:   number;          // fade-out után csend
  startedAt:          number;
}

interface PausedSource {
  job:         MixerJob;
  resumeBytes: number;
  pausedAt:    number;
}

// ────────────────────────────────────────────────────────────────────────────
// Maga a mixer
// ────────────────────────────────────────────────────────────────────────────

export class TenantAudioMixer extends EventEmitter {
  readonly tenantId: string;
  readonly fifoPath: string;

  private fifoStream:  WriteStream | null = null;
  private active:      ActiveSource | null = null;
  private pausedStack: PausedSource[]      = [];
  private queue:       MixerJob[]          = [];
  private tickTimer:   ReturnType<typeof setInterval> | null = null;
  private running     = false;
  private writeBlocked = false;

  // Újrahasznosítható bufferek: tick-enként új allokáció helyett.
  private readonly silenceBuf:    Buffer;
  private readonly fadeScratch:   Buffer;

  constructor(tenantId: string, fifoPath: string) {
    super();
    this.tenantId    = tenantId;
    this.fifoPath    = fifoPath;
    this.silenceBuf  = Buffer.alloc(BYTES_PER_TICK, 0);
    this.fadeScratch = Buffer.alloc(BYTES_PER_TICK);
  }

  // ── Életciklus ──────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    if (!existsSync(this.fifoPath)) {
      console.warn(`[Mixer:${this.tenantId}] FIFO nincs: ${this.fifoPath}`);
      return;
    }
    this.openFifo();
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.running   = true;
    console.log(`[Mixer:${this.tenantId}] ▶ folyamatos stream INDUL → ${this.fifoPath}`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.killActive("stopped");
    this.queue       = [];
    this.pausedStack = [];
    if (this.fifoStream) { try { this.fifoStream.destroy(); } catch {} this.fifoStream = null; }
    console.log(`[Mixer:${this.tenantId}] ⏹ stream LEÁLLÍTVA`);
  }

  private openFifo(): void {
    try {
      // O_WRONLY a FIFO-ra blokkolódhat amíg a snapserver megnyitja olvasásra.
      // A kernel oldja fel amint a snapserver fut, így a writeStream kész lesz.
      this.fifoStream = createWriteStream(this.fifoPath, { flags: "w" });
      this.fifoStream.on("error", (err) => {
        console.error(`[Mixer:${this.tenantId}] FIFO write hiba: ${err.message}`);
      });
      this.fifoStream.on("drain", () => { this.writeBlocked = false; });
    } catch (e: any) {
      console.error(`[Mixer:${this.tenantId}] FIFO open hiba: ${e.message}`);
    }
  }

  // ── Publikus API ────────────────────────────────────────────────────────

  /** Új job felvétele a műsortervbe. */
  enqueue(job: MixerJob): void {
    console.log(`[Mixer:${this.tenantId}] ➕ ${job.jobType} (prio=${job.priority}) | ${this.desc(job)}`);

    // Üres állapot → azonnal indul
    if (!this.active) {
      this.startSource(job);
      return;
    }

    // Magasabb prioritású → fade-out a jelenlegin, az új a queue elejére
    if (job.priority < this.active.job.priority) {
      this.queue.unshift(job);
      this.beginFadeOut();
      return;
    }

    // Ugyanolyan / alacsonyabb prioritású → prio szerint a queue-ba
    this.insertByPriority(job);
  }

  /** Mindent leállít. */
  stopAll(): void {
    this.queue       = [];
    this.pausedStack = [];
    this.killActive("stopped");
  }

  /** Csak adott típust állít le (queue + pausedStack + esetleg current). */
  stopByType(jobType: MixerJobType): void {
    this.queue       = this.queue.filter(j => j.jobType !== jobType);
    this.pausedStack = this.pausedStack.filter(p => p.job.jobType !== jobType);
    if (this.active?.job.jobType === jobType) this.killActive("stopped");
  }

  getStatus(): MixerStatus {
    return {
      fifoPath: this.fifoPath,
      ticking:  this.running,
      current:  this.active ? {
        jobType:       this.active.job.jobType,
        title:         this.active.job.title,
        bytesEmitted:  this.active.bytesEmitted,
        bufferedBytes: this.active.bufferedBytes,
        fadingOut:     this.active.fadeOutTicks > 0 || this.active.postFadeGapTicks > 0,
        fadingIn:      this.active.fadeInTicks > 0,
      } : null,
      paused: this.pausedStack.map(p => ({
        jobType:     p.job.jobType,
        title:       p.job.title,
        resumeBytes: p.resumeBytes,
      })),
      queue: this.queue.map(j => ({ jobType: j.jobType, title: j.title })),
    };
  }

  // ── Belső műsorvezérlés ─────────────────────────────────────────────────

  private insertByPriority(job: MixerJob): void {
    const i = this.queue.findIndex(q => q.priority > job.priority);
    if (i === -1) this.queue.push(job);
    else          this.queue.splice(i, 0, job);
  }

  private beginFadeOut(): void {
    if (!this.active) return;
    if (this.active.fadeOutTicks > 0) return; // már fade-elünk
    this.active.fadeOutStartBytes = this.active.bytesEmitted;
    this.active.fadeOutTicks      = FADE_OUT_TICKS;
    this.active.postFadeGapTicks  = POST_FADE_GAP_TICKS;
    console.log(`[Mixer:${this.tenantId}] ↘ fade-out: ${this.active.job.jobType}`);
  }

  private startSource(job: MixerJob): void {
    const args = this.buildFfmpegArgs(job);
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    const src: ActiveSource = {
      job, proc,
      buffer:            [],
      bufferedBytes:     0,
      bytesEmitted:      0,
      fadeOutStartBytes: null,
      ffmpegEnded:       false,
      ffmpegEndedReason: null,
      fadeOutTicks:      0,
      fadeInTicks:       FADE_IN_TICKS,  // mindig 200ms fade-in
      postFadeGapTicks:  0,
      startedAt:         Date.now(),
    };
    this.active = src;

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (this.active !== src) return;
      // KRITIKUS: a Node Readable a 'data'-ban kiadott Buffer-t belső
      // pool-ból veszi (Buffer.allocUnsafePool) és újrahasznosíthatja.
      // Ha sima referenciát rakunk a queue-ba, a következő olvasás
      // FELÜLÍRHATJA ugyanazt a memóriát → torzult / kevert PCM jut
      // a snap streamre → érdes statikus zaj. Saját, független másolat
      // kell.
      const safe = Buffer.from(chunk);
      // Buffer korlát: ha túl sok PCM gyűlt fel, a legrégebbit eldobjuk
      while (src.bufferedBytes + safe.length > MAX_BUFFER_BYTES && src.buffer.length > 0) {
        const drop = src.buffer.shift()!;
        src.bufferedBytes -= drop.length;
      }
      src.buffer.push(safe);
      src.bufferedBytes += safe.length;
    });

    proc.stderr?.on("data", (d: Buffer) => {
      const txt = d.toString();
      if (/error|invalid|fail/i.test(txt)) {
        const first = txt.split("\n").find(l => l.trim()) ?? txt;
        console.error(`[Mixer:${this.tenantId}/ffmpeg:${job.jobType}] ${first}`);
      }
    });

    proc.on("close", (code) => {
      if (this.active !== src) return;
      src.ffmpegEnded = true;
      if (src.ffmpegEndedReason === null) {
        src.ffmpegEndedReason = code === 0 ? "done" : "error";
      }
    });

    proc.on("error", (err) => {
      console.error(`[Mixer:${this.tenantId}] ffmpeg spawn hiba: ${err.message}`);
      if (this.active === src) {
        src.ffmpegEnded = true;
        src.ffmpegEndedReason = "error";
      }
    });

    this.emit("source:start", { jobId: job.id, jobType: job.jobType, title: job.title });
    console.log(`[Mixer:${this.tenantId}] ▶ start: ${job.jobType} | ${this.desc(job)}` +
                (job.resumeBytes ? ` | resume@${(job.resumeBytes / (SAMPLE_RATE * FRAME_BYTES)).toFixed(2)}s` : ""));
  }

  private killActive(reason: SourceEndReason): void {
    if (!this.active) return;
    const a = this.active;
    a.ffmpegEndedReason = reason;
    try { a.proc.kill("SIGTERM"); } catch {}
    this.active = null;
    this.emit("source:end", {
      jobId:       a.job.id,
      jobType:     a.job.jobType,
      reason,
      bytesEmitted: a.bytesEmitted,
    });
  }

  /** A fade-out lejárt vagy ffmpeg természetesen ért véget → eldől, hogy
   *  pausedStack-be teszi-e (interrupted), vagy sem. */
  private finishActive(reason: SourceEndReason): void {
    if (!this.active) return;
    const a = this.active;
    try { a.proc.kill("SIGTERM"); } catch {}

    if (reason === "interrupted") {
      // Resume offset = a fade-out KEZDETÉN állt bytesEmitted (nem a fade vége),
      // hogy a fade-elt szakaszt is lejátsszuk visszatéréskor.
      const baseBytes = a.fadeOutStartBytes ?? a.bytesEmitted;
      const resumeBytes = (a.job.resumeBytes ?? 0) + baseBytes;
      // Stream típust nem érdemes pausedStack-be tenni - nem seekelhető élő stream.
      if (a.job.source.type !== "stream") {
        this.pausedStack.push({ job: a.job, resumeBytes, pausedAt: Date.now() });
        console.log(`[Mixer:${this.tenantId}] ⏸ pause: ${a.job.jobType} @ ${(resumeBytes / (SAMPLE_RATE * FRAME_BYTES)).toFixed(2)}s`);
      } else {
        console.log(`[Mixer:${this.tenantId}] ⏸→drop stream (nem seekelhető): ${a.job.jobType}`);
      }
    } else {
      console.log(`[Mixer:${this.tenantId}] ⏹ ${reason}: ${a.job.jobType}`);
    }

    this.active = null;
    this.emit("source:end", {
      jobId:        a.job.id,
      jobType:      a.job.jobType,
      reason,
      bytesEmitted: a.bytesEmitted,
    });
    this.advance();
  }

  /** Mi következik? Magasabb prio queue-ban → indítsd. Egyébként pausedStack. */
  private advance(): void {
    const top = this.pausedStack.length ? this.pausedStack[this.pausedStack.length - 1] : null;
    const nxt = this.queue[0];

    if (nxt && (!top || nxt.priority < top.job.priority)) {
      this.queue.shift();
      this.startSource(nxt);
      return;
    }
    if (top) {
      this.pausedStack.pop();
      this.startSource({ ...top.job, resumeBytes: top.resumeBytes });
      return;
    }
    // Semmi - csendben maradunk (a tick továbbra is silenceBuf-ot ad ki)
  }

  // ── Tick: 20ms-enként pontosan egy chunk PCM ─────────────────────────────

  private tick(): void {
    if (!this.fifoStream) return;

    // 1. Ha az aktív ffmpeg lefutott és a buffer is kiürült → finishActive
    if (this.active && this.active.ffmpegEnded && this.active.bufferedBytes === 0) {
      this.finishActive(this.active.ffmpegEndedReason ?? "done");
    }

    // 2. Mit írunk ki?
    let out: Buffer;

    if (!this.active) {
      out = this.silenceBuf;
    } else if (this.active.postFadeGapTicks > 0) {
      // Fade-out után csend ablak
      this.active.postFadeGapTicks--;
      out = this.silenceBuf;
      if (this.active.postFadeGapTicks === 0) {
        // Most jut véglegesen pausedStack-be
        this.finishActive("interrupted");
      }
    } else {
      const got = this.readFromActiveOrNull();
      if (got === null) {
        // Underrun (ffmpeg még nem küldött elég PCM-et). Csendet adunk ki,
        // de a fade tickeket NEM fogyasztjuk – majd ha jön valódi PCM,
        // azon hallatszik a fade.
        out = this.silenceBuf;
      } else {
        out = got;
        if (this.active && this.active.fadeOutTicks > 0) {
          const startGain = this.active.fadeOutTicks / FADE_OUT_TICKS;
          this.active.fadeOutTicks--;
          const endGain   = this.active.fadeOutTicks / FADE_OUT_TICKS;
          out = this.applyFade(out, startGain, endGain);
        } else if (this.active && this.active.fadeInTicks > 0) {
          const total     = FADE_IN_TICKS;
          const startGain = (total - this.active.fadeInTicks) / total;
          this.active.fadeInTicks--;
          const endGain   = (total - this.active.fadeInTicks) / total;
          out = this.applyFade(out, startGain, endGain);
        }
      }
    }

    // 3. Írás
    if (this.writeBlocked) return; // backpressure miatt skip - drain után jó
    const ok = this.fifoStream.write(out);
    if (ok === false) this.writeBlocked = true;
  }

  /** Tényleges PCM a bufferből vagy null underrun esetén. */
  private readFromActiveOrNull(): Buffer | null {
    const a = this.active!;
    if (a.bufferedBytes < BYTES_PER_TICK) return null;

    // alloc (nem allocUnsafe) – ha bármi okból a copy nem teljes, a buffer
    // 0-val van inicializálva, nem random memóriával.
    const out = Buffer.alloc(BYTES_PER_TICK);
    let written = 0;
    while (written < BYTES_PER_TICK && a.buffer.length > 0) {
      const head = a.buffer[0];
      const take = Math.min(BYTES_PER_TICK - written, head.length);
      head.copy(out, written, 0, take);
      written += take;
      if (take === head.length) a.buffer.shift();
      else                      a.buffer[0] = head.subarray(take);
    }
    a.bufferedBytes -= written;
    a.bytesEmitted  += written;
    return out;
  }

  /** Lineáris volume ramp s16le sztereo PCM-en. startGain → endGain a chunk
   *  hosszán át. Reusable scratch buffer-be ír, majd szeletet ad vissza. */
  private applyFade(pcm: Buffer, startGain: number, endGain: number): Buffer {
    if (startGain >= 0.999 && endGain >= 0.999) return pcm;
    const out = this.fadeScratch;
    const totalFrames = Math.floor(pcm.length / FRAME_BYTES);
    for (let i = 0; i < totalFrames; i++) {
      const t = totalFrames > 1 ? i / (totalFrames - 1) : 1;
      const g = startGain + (endGain - startGain) * t;
      const off = i * FRAME_BYTES;
      const l = pcm.readInt16LE(off);
      const r = pcm.readInt16LE(off + 2);
      out.writeInt16LE(clampI16(Math.round(l * g)), off);
      out.writeInt16LE(clampI16(Math.round(r * g)), off + 2);
    }
    // Másolat, mert a scratch-et a következő tick-ben felülírjuk.
    return Buffer.from(out.subarray(0, totalFrames * FRAME_BYTES));
  }

  // ── ffmpeg argumentumok ─────────────────────────────────────────────────

  private buildFfmpegArgs(job: MixerJob): string[] {
    const src = job.source;
    const resumeSec = job.resumeBytes
      ? job.resumeBytes / (SAMPLE_RATE * FRAME_BYTES)
      : 0;
    const seek = resumeSec > 0.5 ? ["-ss", resumeSec.toFixed(3)] : [];

    const out = [
      "-f",  "s16le",
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      "pipe:1",
    ];

    if (src.type === "file" && src.path) {
      // -re: pacing, hogy az ffmpeg ne feszítse szét a buffert egy nagy fájl elején.
      return ["-hide_banner", "-loglevel", "error", "-re", ...seek, "-i", src.path, "-vn", ...out];
    }
    if (src.type === "url" && src.url) {
      return [
        "-hide_banner", "-loglevel", "error",
        "-re",
        "-reconnect",         "1",
        "-reconnect_streamed","1",
        ...seek,
        "-i", src.url,
        "-vn",
        ...out,
      ];
    }
    if (src.type === "stream" && src.url) {
      return [
        "-hide_banner", "-loglevel", "error",
        "-reconnect",          "1",
        "-reconnect_at_eof",   "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max","5",
        "-i", src.url,
        "-vn",
        ...out,
      ];
    }
    throw new Error(`Ismeretlen source: ${JSON.stringify(src)}`);
  }

  private desc(j: MixerJob): string {
    if (j.source.type === "file")   return `file:${j.source.path}`;
    if (j.source.type === "url")    return `url:${(j.source.url ?? "").slice(0, 60)}`;
    if (j.source.type === "stream") return `stream:${(j.source.url ?? "").slice(0, 60)}`;
    return "unknown";
  }
}

function clampI16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}
