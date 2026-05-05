// src/modules/snapcast/audio-mixer.ts
//
// v2 — data-driven megközelítés (2026-05-06)
//
// A v1-es setInterval-alapú megoldás 50 Hz-es timer-jitter miatt periodikus
// underrun-okat okozott (a Node.js timer ±2 ms-t csúszik), ami ~20 ms-es
// csendes szakaszokat injektált a PCM-be 50 Hz-es periódussal → pontosan az
// a "kompozit videójel" karakterű zaj. A gyökérok: a setInterval clock és az
// ffmpeg output clock nem szinkronizáltak.
//
// Javítás: az aktív forrás saját stdout 'data' event-jei hajtják a FIFO-ba
// írást (ahogy a régi kód pipe()-pal csinálta), semmi közbülső buffer,
// semmi timer. A fade/gain a beérkező chunkokra alkalmazzuk szoftveresen,
// byte-hossszal mért haladás alapján (nem idővel).
// A setInterval csak csendet ír, amikor nincs aktív forrás, és kezeli a
// fade-out utáni 200 ms-es átmeneti csendet.
//
// Logika:
//   • play(job):
//       – ha nincs current → startSource() azonnal
//       – ha magasabb prio → beginFadeOut() az aktivon, queue elejére
//       – egyébként → insertByPriority()
//   • startSource(): ffmpeg spawn; stdout.data → applyGain → fifoStream.write
//       – fade-in: az első FADE_IN_BYTES-ig emelkedő gain
//       – fade-out: amikor kezdeményezzük, egyre csökkenő gain; 0-nál kill
//   • killActive("interrupted"): pausedStack-be kerül a resumeBytes-szal
//   • gap: POST_FADE_GAP_MS csendet a silenceTimer tölt ki, majd advance()
//   • advance(): queue → resume stack → csend

import { spawn, ChildProcess }          from "child_process";
import { createWriteStream, WriteStream, existsSync } from "fs";
import { EventEmitter }                 from "events";

const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "/usr/bin/ffmpeg";

// ── Audio konstansok ────────────────────────────────────────────────────────
const SAMPLE_RATE      = 48000;
const CHANNELS         = 2;
const BYTES_PER_SAMPLE = 2;                           // s16le
const FRAME_BYTES      = CHANNELS * BYTES_PER_SAMPLE; // 4 byte/frame
const BYTES_PER_SEC    = SAMPLE_RATE * FRAME_BYTES;   // 192 000 byte/s

// ── Fade/gap paraméterek (byte-ban számolva, nem időben) ───────────────────
const FADE_OUT_BYTES    = Math.round(BYTES_PER_SEC * 1.0);   // 1 s fade-out
const FADE_IN_BYTES     = Math.round(BYTES_PER_SEC * 0.2);   // 200 ms fade-in
const POST_FADE_GAP_MS  = 200;                                // csend fade-out után

// ── Csend tick: csak "nincs aktív forrás" állapotban ───────────────────────
const SILENCE_TICK_MS  = 20;
const SILENCE_TICK_BUF = Buffer.alloc(
  Math.round(BYTES_PER_SEC * SILENCE_TICK_MS / 1000)
);  // ~3840 byte zérus

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
  priority:     number;          // kisebb = magasabb prio (BELL=0, TTS=1, RADIO=2)
  title?:       string;
  text?:        string;
  resumeBytes?: number;          // resume offset PCM-byte-ban
}

export type SourceEndReason = "done" | "interrupted" | "error" | "stopped";

export interface MixerStatus {
  fifoPath:   string;
  ticking:    boolean;
  current:    null | { jobType: MixerJobType; title?: string; bytesWritten: number; fadingOut: boolean; fadingIn: boolean };
  paused:     Array<{ jobType: MixerJobType; title?: string; resumeBytes: number }>;
  queue:      Array<{ jobType: MixerJobType; title?: string }>;
  inGap:      boolean;
}

// ────────────────────────────────────────────────────────────────────────────
// Belső állapot
// ────────────────────────────────────────────────────────────────────────────

interface ActiveSource {
  job:              MixerJob;
  proc:             ChildProcess;
  bytesWritten:     number;           // eddig FIFO-ba ment byte-ok
  // Fade-in: az első FADE_IN_BYTES-ig 0 → 1 gain
  fadeInActive:     boolean;
  // Fade-out: indításkor rögzítjük a bytesWritten-t
  fadeOutStart:     number | null;    // bytesWritten a fade-out kezdetén
  killed:           boolean;          // SIGTERM már elment
}

interface PausedSource {
  job:         MixerJob;
  resumeBytes: number;
  pausedAt:    number;
}

// ────────────────────────────────────────────────────────────────────────────

export class TenantAudioMixer extends EventEmitter {
  readonly tenantId: string;
  readonly fifoPath: string;

  private fifoStream:   WriteStream | null = null;
  private active:       ActiveSource | null = null;
  private pausedStack:  PausedSource[]     = [];
  private queue:        MixerJob[]         = [];
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private gapTimer:     ReturnType<typeof setTimeout>  | null = null;
  private running       = false;
  private inGap         = false;   // POST_FADE_GAP_MS csend aktív
  private warmedUp = false;

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
    this.running = true;

    this.openFifo();

    this.silenceTimer = setInterval(() => this.tickSilence(), SILENCE_TICK_MS)
    console.log(`[Mixer:${this.tenantId}] ▶ stream INDUL → ${this.fifoPath}`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.silenceTimer) { clearInterval(this.silenceTimer); this.silenceTimer = null; }
    if (this.gapTimer)     { clearTimeout(this.gapTimer);      this.gapTimer = null; }
    this.killActive("stopped");
    this.queue       = [];
    this.pausedStack = [];
    try { this.fifoStream?.destroy(); } catch {}
    this.fifoStream = null;
    console.log(`[Mixer:${this.tenantId}] ⏹ stream LEÁLLÍTVA`);
  }

  private openFifo(): void {
    if (!this.running) return;
    try {
      const stream = createWriteStream(this.fifoPath, { flags: "w" });

      stream.once("error", (e) => {
        // EPIPE vagy EPOLLHUP: a snapserver bezárta a FIFO olvasó végét
        // (pl. újraindult). Azonnal nullozzuk ki a referenciát, hogy a
        // silenceTimer és az esetlegesen futó ffmpeg data-eventjei ne
        // próbáljanak tovább írni – különben ERR_STREAM_DESTROYED exception
        // árad szét, amit Node.js unhandled-ként kezel → crash.
        console.error(`[Mixer:${this.tenantId}] FIFO hiba (${e.message}) → 1s múlva újranyitás`);

        if (this.fifoStream === stream) this.fifoStream = null;

        // Az összes már-sorban-lévő async write végül ERR_STREAM_DESTROYED-dal
        // tér vissza. Ezeket el kell nyelnünk, hogy ne legyenek unhandled.
        // A stream listeners-eit töröltük a once() trigger után; adjunk vissza
        // egy no-op swallower-t mielőtt bármi más sülne ki.
        stream.removeAllListeners("error");
        stream.on("error", () => { /* elnyelt */ });

        if (this.running) setTimeout(() => this.openFifo(), 1000);
      });

      this.fifoStream = stream;
    } catch (e: any) {
      console.error(`[Mixer:${this.tenantId}] FIFO open hiba: ${e.message}`);
      if (this.running) setTimeout(() => this.openFifo(), 2000);
    }
  }

  // ── Publikus API ────────────────────────────────────────────────────────

  enqueue(job: MixerJob): void {
    console.log(`[Mixer:${this.tenantId}] ➕ ${job.jobType} (prio=${job.priority}) | ${this.desc(job)}`);

  f (!this.active && !this.inGap) {
  if (!this.warmedUp) {
    this.warmedUp = true;
    this.inGap = true;

    console.log(`[Mixer:${this.tenantId}] ⏳ első hang előtt 5s warmup csend`);

    setTimeout(() => {
      this.inGap = false;
      this.startSource(job);
    }, 5000);

    return;
  }

  this.startSource(job);
  return;
  }
    if (this.active && job.priority < this.active.job.priority) {
      this.queue.unshift(job);
      this.beginFadeOut();
      return;
    }
    this.insertByPriority(job);
  }

  stopAll(): void {
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    this.inGap       = false;
    this.queue       = [];
    this.pausedStack = [];
    this.killActive("stopped");
  }

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
        jobType:      this.active.job.jobType,
        title:        this.active.job.title,
        bytesWritten: this.active.bytesWritten,
        fadingOut:    this.active.fadeOutStart !== null,
        fadingIn:     this.active.fadeInActive,
      } : null,
      paused: this.pausedStack.map(p => ({ jobType: p.job.jobType, title: p.job.title, resumeBytes: p.resumeBytes })),
      queue:  this.queue.map(j => ({ jobType: j.jobType, title: j.title })),
      inGap:  this.inGap,
    };
  }

  // ── Csend-timer: csak ha nincs aktív forrás ─────────────────────────────

  private tickSilence(): void {
    if (this.active) return;  // aktív forrás saját maga ír
    if (!this.fifoStream) return;
    try { this.fifoStream.write(SILENCE_TICK_BUF); } catch {}
  }

  // ── Forrás indítás ───────────────────────────────────────────────────────

  private startSource(job: MixerJob): void {
    const args = this.buildFfmpegArgs(job);
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    const src: ActiveSource = {
      job,
      proc,
      bytesWritten:  0,
      fadeInActive:  true,   // mindig 200ms fade-in
      fadeOutStart:  null,
      killed:        false,
    };
    this.active = src;

    if (!proc.stdout) {
      console.error(`[Mixer:${this.tenantId}] ⚠️ proc.stdout NULL → ffmpeg nem kommunikál!`);
    }

    // ── stdout → FIFO, gain alkalmazva per-chunk ───────────────────────────
    proc.stdout?.on("data", (raw: Buffer) => {
      if (this.active !== src || src.killed) return;

      // Saját másolat (Node stream pool újrahasznosítja az eredeti buffert)
      const chunk = Buffer.from(raw);

      // Gain számítás a byte-helyzetből (nem időből → timer-jitter mentes)
      const gain = this.computeGain(src, chunk.length);
      if (gain < 1) this.applyGain(chunk, gain);

      // Közvetlen írás a FIFO-ba; ha backpressure → pause ffmpeg, drain után resume
      const fifoExists = !!this.fifoStream;
      const ok = fifoExists ? this.fifoStream!.write(chunk) : false;

      // Diagnosztika: első chunk és minden ~1MB-ként
      const isFirst = src.bytesWritten === 0;
      if (isFirst) {
        console.log(
          `[Mixer:${this.tenantId}] 🎵 PCM első chunk: ${chunk.length}B → ` +
          `fifoStream=${fifoExists ? "OK" : "NULL"}, write_ok=${ok}, gain=${gain.toFixed(2)}`
        );
      }

      if (!ok) {
        if (!fifoExists) {
          // Csendben eldobtuk az adatot. Logoljuk hogy lássuk!
          if (!(src as any)._warnedNoFifo) {
            console.error(`[Mixer:${this.tenantId}] ❌ fifoStream NULL → ffmpeg PCM eldobva!`);
            (src as any)._warnedNoFifo = true;
          }
        } else {
          proc.stdout?.pause();
          this.fifoStream?.once("drain", () => { if (!src.killed) proc.stdout?.resume(); });
        }
      }

      src.bytesWritten += chunk.length;

      // Fade-out teljesen lezajlott → most öljük meg és lépünk tovább
      if (src.fadeOutStart !== null &&
          (src.bytesWritten - src.fadeOutStart) >= FADE_OUT_BYTES) {
        this.onFadeOutComplete(src);
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      const txt = d.toString();
      if (/error|invalid|fail/i.test(txt)) {
        console.error(`[Mixer:${this.tenantId}/ffmpeg:${job.jobType}] ${txt.split("\n").find(l => l.trim()) ?? txt}`);
      }
    });

    proc.on("close", (code) => {
      if (this.active !== src || src.killed) return;
      // Természetes vég (pl. fájl végére ért)
      const reason: SourceEndReason = code === 0 ? "done" : "error";
      console.log(
        `[Mixer:${this.tenantId}] ⏹ ${reason}: ${src.job.jobType} ` +
        `(összesen ${src.bytesWritten} B = ${(src.bytesWritten / BYTES_PER_SEC).toFixed(2)}s PCM kiírva)`
      );
      this.active = null;
      this.emit("source:end", { jobId: src.job.id, jobType: src.job.jobType, reason, bytesWritten: src.bytesWritten });
      // Rövid gap után advance (csend-timer veszi át közben)
      this.scheduleAdvance(reason === "error" ? POST_FADE_GAP_MS : 50);
    });

    proc.on("error", (err) => {
      console.error(`[Mixer:${this.tenantId}] spawn hiba: ${err.message}`);
      if (this.active === src) {
        this.active = null;
        this.emit("source:end", { jobId: src.job.id, jobType: src.job.jobType, reason: "error" as SourceEndReason, bytesWritten: src.bytesWritten });
        this.scheduleAdvance(POST_FADE_GAP_MS);
      }
    });

    this.emit("source:start", { jobId: job.id, jobType: job.jobType, title: job.title });
    console.log(`[Mixer:${this.tenantId}] ▶ start: ${job.jobType} | ${this.desc(job)}` +
                (job.resumeBytes ? ` | resume@${(job.resumeBytes / BYTES_PER_SEC).toFixed(2)}s` : ""));
  }

  // ── Fade logika ──────────────────────────────────────────────────────────

  private computeGain(src: ActiveSource, chunkLen: number): number {
    // Fade-out: ha megkezdjük, csökken 0-ra FADE_OUT_BYTES alatt
    if (src.fadeOutStart !== null) {
      const done  = src.bytesWritten - src.fadeOutStart;
      const start = Math.max(0, 1 - done / FADE_OUT_BYTES);
      const end   = Math.max(0, 1 - (done + chunkLen) / FADE_OUT_BYTES);
      // Átlagos gain erre a chunkra
      return (start + end) / 2;
    }
    // Fade-in: az első FADE_IN_BYTES-ig 0 → 1
    if (src.fadeInActive) {
      const prog = src.bytesWritten / FADE_IN_BYTES;
      if (prog >= 1) { src.fadeInActive = false; return 1; }
      const start = prog;
      const end   = Math.min(1, (src.bytesWritten + chunkLen) / FADE_IN_BYTES);
      if (end >= 1) src.fadeInActive = false;
      return (start + end) / 2;
    }
    return 1;
  }

  /** s16le sztereó in-place volume ramp. */
  private applyGain(buf: Buffer, gain: number): void {
    if (gain <= 0) { buf.fill(0); return; }
    if (gain >= 1)  return;
    const frames = Math.floor(buf.length / FRAME_BYTES);
    for (let i = 0; i < frames; i++) {
      const off = i * FRAME_BYTES;
      const l   = buf.readInt16LE(off);
      const r   = buf.readInt16LE(off + 2);
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
    try { src.proc.kill("SIGTERM"); } catch {}

    // Resume offset = ahol a fade-out KEZDŐDÖTT (visszajátsszuk a fade-elt részből)
    const resumeBytes = (src.job.resumeBytes ?? 0) +
                        (src.fadeOutStart !== null ? src.fadeOutStart : src.bytesWritten);

    if (src.job.source.type !== "stream") {
      this.pausedStack.push({ job: src.job, resumeBytes, pausedAt: Date.now() });
      console.log(`[Mixer:${this.tenantId}] ⏸ pause: ${src.job.jobType} @ ${(resumeBytes / BYTES_PER_SEC).toFixed(2)}s`);
    } else {
      console.log(`[Mixer:${this.tenantId}] ⏸→drop stream (nem seekelhető): ${src.job.jobType}`);
    }

    this.active = null;
    this.emit("source:end", { jobId: src.job.id, jobType: src.job.jobType, reason: "interrupted" as SourceEndReason, bytesWritten: src.bytesWritten });

    // Gap csend, majd advance
    this.scheduleAdvance(POST_FADE_GAP_MS);
  }

  private killActive(reason: SourceEndReason): void {
    if (!this.active) return;
    const src = this.active;
    src.killed = true;
    try { src.proc.kill("SIGTERM"); } catch {}
    this.active = null;
    this.emit("source:end", { jobId: src.job.id, jobType: src.job.jobType, reason, bytesWritten: src.bytesWritten });
  }

  // ── Advance / queue kezelés ─────────────────────────────────────────────

  private scheduleAdvance(delayMs: number): void {
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.inGap = delayMs > 0;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      this.inGap    = false;
      this.advance();
    }, delayMs);
  }

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
    // Semmi → csend-timer veszi át
  }

  private insertByPriority(job: MixerJob): void {
    const i = this.queue.findIndex(q => q.priority > job.priority);
    if (i === -1) this.queue.push(job);
    else          this.queue.splice(i, 0, job);
  }

  // ── ffmpeg argumentumok ─────────────────────────────────────────────────

  private buildFfmpegArgs(job: MixerJob): string[] {
    const src = job.source;
    const resumeSec = job.resumeBytes ? job.resumeBytes / BYTES_PER_SEC : 0;
    const seek = resumeSec > 0.5 ? ["-ss", resumeSec.toFixed(3)] : [];
    const out  = ["-f","s16le","-ar",String(SAMPLE_RATE),"-ac",String(CHANNELS),"pipe:1"];

    if (src.type === "file" && src.path) {
      return ["-hide_banner","-loglevel","error","-re",...seek,"-i",src.path,"-vn",...out];
    }
    if (src.type === "url" && src.url) {
      return ["-hide_banner","-loglevel","error","-re","-reconnect","1","-reconnect_streamed","1",...seek,"-i",src.url,"-vn",...out];
    }
    if (src.type === "stream" && src.url) {
      return ["-hide_banner","-loglevel","error","-reconnect","1","-reconnect_at_eof","1","-reconnect_streamed","1","-reconnect_delay_max","5","-i",src.url,"-vn",...out];
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

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}
