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

const FADE_OUT_BYTES = Math.round(BYTES_PER_SEC * 1.0); // 1 s fade-out (mindenre)
// Default fade-in értékek source.type szerint:
//   - "file" / "url" (bell, TTS, lokális rádió fájl) → 0 (azonnal teljes)
//   - "stream"      (internet rádió)               → 1 sec
// A `MixerJob.fadeInMs` opcionális mezővel a hívó felülírhatja per-job.
const FADE_IN_BYTES_STREAM = Math.round(BYTES_PER_SEC * 1.0);
const FADE_IN_BYTES_NONE   = 0;
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
// 2000 ms: bőven lefedi a `applyTargetingToClients` retry-sorozatát
// (0/500/1500 ms), a snap szerver ControlServer socket-cleanup-ját, és a
// stabilizáláshoz használt sleep(500)-at.
//
// POST_SILENCE_MS: a job vége után ennyi csend, hogy a kliensek pufferei
// kiürülhessenek mielőtt egy újabb forrás indulna ugyanitt.
// PRE_SILENCE_MS: az új job ffmpeg-startja előtti csend. A snap server
// puffer + a kliens-célzás RPC-i mind elférnek 1 sec alatt – 2 sec felesleges
// volt. Forrás-csere esetén a hang-rés ezzel kb. 1 sec-re csökken, a kliens
// snap pufferből kihúzható.
const PRE_SILENCE_MS = 1000;
const POST_SILENCE_MS = 500;

// ── Háttér silence ffmpeg subprocess ─────────────────────────────────────────
//
// Egy ffmpeg subprocess folyamatosan ír real-time (-re flag) csendet
// (anullsrc forrást) a snap FIFO-ra. A Node event loop blokkolása NEM
// érinti a snap szerver FIFO-olvasását, mert a kernel közvetlenül viszi
// a PCM-et az ffmpeg-ből a snap szerverbe.
//
// Job indulásakor SIGSTOP-pal megáll, a Node-middleware (a meglévő fade-rel)
// veszi át az írást a fifoStream-re. Job végén SIGCONT-tal újraindul.
// Soha nem ír párhuzamosan a fifoStream-mel — a SIGSTOP atomic.
//
// A korábbi setInterval(20ms) tickSilence Node-on át írt, ami a Node main
// loop GC-szüneteire és egyéb blokkolásokra érzékeny volt: 120 ms+ csúszás
// = snap szerver "No data since 120 ms" → idle → 400+ ms onResync ugrás
// a klienseken (audible glitch a TTS elején).
const SILENCE_FFMPEG_ARGS = (fifoPath: string) => [
  "-hide_banner",
  "-loglevel", "error",
  "-re",
  "-f", "lavfi",
  "-i", `anullsrc=channel_layout=stereo:sample_rate=${SAMPLE_RATE}`,
  "-f", "s16le",
  "-ar", String(SAMPLE_RATE),
  "-ac", String(CHANNELS),
  "-y",
  fifoPath,
];

// ────────────────────────────────────────────────────────────────────────────
// Public típusok
// ────────────────────────────────────────────────────────────────────────────

export type MixerJobType = "BELL" | "TTS" | "RADIO";

export interface MixerSource {
  type: "file" | "url" | "stream";
  path?: string;
  url?: string;
  // Pre-gain érték 0..1 (lineáris). A `buildFfmpegArgs` egy `volume=X`
  // filter-szegmenst illeszt be a chain elejére, így csak ezt a forrást
  // érinti. Csengetésre/üzenetekre nincs hatás (külön job-ok, külön gain).
  volume?: number;
}

export interface MixerJob {
  id: string;
  jobType: MixerJobType;
  source: MixerSource;
  priority: number; // kisebb = magasabb prio
  title?: string;
  text?: string;
  resumeBytes?: number;
  // Opcionális per-job fade-in. Ha nincs megadva: stream forrásra 1 sec,
  // egyébként 0 (azonnal teljes amplitúdóval szól – chime, üzenet).
  fadeInMs?: number;
  // Forrás-csere után újraindul-e ez a job (paused stack-ből). Ezt a flag-et
  // a `source:start` event-en továbbítjuk a service-nek, ami eldönti, hogy
  // NOW_PLAYING_INFO-t küldjön (új lejátszás) vagy STOP+PREPARE+PLAY-t
  // (resume → fresh playback a klienseken). A user-request:
  //   "Az üzenet után stop-ot küldhetünk a klienseknek, és a play resume-t
  //    új lejátszásként elindítani"
  // Ez tisztább state-management a klienseken (nincs ragadt _snap_muted).
  isResume?: boolean;
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
  // Per-job fade-in hossz byte-ban. 0 = nincs fade-in (chime/üzenet
  // azonnal teljes amplitúdóval szól). A startSource számítja ki a
  // job.fadeInMs vagy default (stream→1s, egyéb→0) alapján.
  fadeInBytes: number;
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

  private silenceProc: ChildProcess | null = null;
  private silencePaused: boolean = false;

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

    // Háttér silence ffmpeg - real-time csendet pumpál a FIFO-ra mindaddig,
    // amíg nincs aktív job (vagyis a Node middleware nem ír a fifoStream-re).
    this.startSilenceProc();

    console.log(`[Mixer:${this.tenantId}] ▶ stream INDUL → ${this.fifoPath}`);
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;

    this.stopSilenceProc();

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
  // A pending fázis alatt nincs aktív forrás, így a háttér silence ffmpeg
  // subprocess automatikusan írja a csendet a FIFO-ra (real-time, a Node
  // main loop-tól függetlenül).
  //
  // NOTE: a `source:start` event a `startSource`-on tüzel, NEM itt – így a
  // `applyTargetingToClients` (snap-szerver-side mute/unmute) a tényleges
  // PCM-start időpontján fut. Korábban a PRE_SILENCE elején tüzelt, ami a
  // fade-out közben (1 sec snap-buffer-csúszás miatt) hallhatóvá tette az
  // előző (alacsonyabb prio) forrás végét a célzott klienseken az unmute
  // pillanatán. Mostantól az unmute akkor megy ki, amikor a snap-pipe-on
  // már a bell/üzenet PCM kezdődik – a fade-out garantáltan lecsengett a
  // kliens-snap-pufferben.
  private beginPendingStart(job: MixerJob): void {
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

    // Source:end event-et emit-elünk minden eldobandó job-ra, hogy a
    // service.ts a `jobs`/`jobTargets` Map-eket cleanup-olni tudja.
    // ("interrupted" reason-nal nem törölnek, de "stopped"-on igen.)
    for (const j of this.queue) this.emitStopped(j);
    for (const p of this.pausedStack) this.emitStopped(p.job);

    this.queue = [];
    this.pausedStack = [];

    this.cancelPending("stopped");
    this.killActive("stopped");
  }

  stopByType(jobType: MixerJobType): void {
    // A típushoz tartozó queue- és pausedStack-bejegyzésekre emit-elünk
    // source:end stopped-et, hogy a service.ts ki tudja takarítani őket.
    for (const j of this.queue.filter(q => q.jobType === jobType)) this.emitStopped(j);
    for (const p of this.pausedStack.filter(ps => ps.job.jobType === jobType)) this.emitStopped(p.job);

    this.queue       = this.queue.filter((j) => j.jobType !== jobType);
    this.pausedStack = this.pausedStack.filter((p) => p.job.jobType !== jobType);

    if (this.pending?.job.jobType === jobType) {
      this.cancelPending("stopped");
    }

    if (this.active?.job.jobType === jobType) {
      this.killActive("stopped");
    }
  }

  /** Helper: source:end stopped event a service.ts cleanup-jához. */
  private emitStopped(job: MixerJob): void {
    this.emit("source:end", {
      jobId:        job.id,
      jobType:      job.jobType,
      reason:       "stopped" as SourceEndReason,
      bytesWritten: 0,
    });
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

  // ── Silence subprocess életciklus ───────────────────────────────────────

  private startSilenceProc(): void {
    if (this.silenceProc) return;

    const proc = spawn(FFMPEG_BIN, SILENCE_FFMPEG_ARGS(this.fifoPath), {
      stdio: ["ignore", "ignore", "pipe"],
    });

    proc.stderr?.on("data", (d: Buffer) => {
      const txt = d.toString().trim();
      if (txt && !/Stream mapping|Output|Press|frame=|time=|size=/.test(txt)) {
        console.warn(`[Mixer:${this.tenantId}/silence] ${txt}`);
      }
    });

    proc.on("exit", (code, signal) => {
      const wasIntentional = !this.running || signal === "SIGTERM";
      if (this.silenceProc === proc) {
        this.silenceProc = null;
        this.silencePaused = false;
      }

      if (wasIntentional) {
        return;
      }

      // Váratlanul kilőtt - automatikus újraindítás 500 ms múlva,
      // hogy ne pörögjön végtelen crash-loopban.
      console.warn(
        `[Mixer:${this.tenantId}] silence ffmpeg unexpectedly exited (code=${code} signal=${signal}), restart in 500ms`
      );
      setTimeout(() => {
        if (this.running && !this.active) {
          this.startSilenceProc();
        }
      }, 500);
    });

    this.silenceProc = proc;
    this.silencePaused = false;
    console.log(`[Mixer:${this.tenantId}] silence ffmpeg started (pid=${proc.pid})`);
  }

  private stopSilenceProc(): void {
    if (!this.silenceProc) return;

    try {
      // Ha STOP állapotban van, először CONT, hogy a SIGTERM kézbesülhessen.
      if (this.silencePaused) {
        this.silenceProc.kill("SIGCONT");
      }
      this.silenceProc.kill("SIGTERM");
    } catch {
      // ignore
    }

    this.silenceProc = null;
    this.silencePaused = false;
  }

  /** Job indulása előtt: silence ffmpeg megáll, hogy ne ütközzön a
   *  Node-middleware írásával ugyanazon FIFO-ra. */
  private pauseSilence(): void {
    if (!this.silenceProc || this.silencePaused) return;

    try {
      this.silenceProc.kill("SIGSTOP");
      this.silencePaused = true;
    } catch (e: any) {
      console.warn(`[Mixer:${this.tenantId}] silence pause hiba: ${e.message}`);
    }
  }

  /** Job vége után: silence ffmpeg folytatja, hogy a snap szerver folyamatosan
   *  kapjon adatot a FIFO-ról (ne legyen "No data since 120 ms" idle). */
  private resumeSilence(): void {
    if (!this.silenceProc || !this.silencePaused) return;

    try {
      this.silenceProc.kill("SIGCONT");
      this.silencePaused = false;
    } catch (e: any) {
      console.warn(`[Mixer:${this.tenantId}] silence resume hiba: ${e.message}`);
    }
  }

  // ── Forrás indítás ───────────────────────────────────────────────────────

  private startSource(job: MixerJob): void {
    // KRITIKUS: a háttér silence ffmpeg megállítását NEM itt rögtön,
    // hanem a job-ffmpeg ELSŐ PCM chunk-jának érkezésekor csináljuk.
    // Így a silence-ffmpeg a job-ffmpeg startup latency-je (spawn +
    // ffmpeg init + first chunk = 50-200 ms) ALATT IS folyamatosan ír
    // csendet a FIFO-ra. Soha nincs "no data" rés.
    //
    // A first chunk event utáni SIGSTOP atomic, és csak akkor fut, amikor
    // a job-ffmpeg már garantáltan ír.

    // source:start event – a snapcast.service.ts ezzel triggereli a célzott
    // mute/unmute RPC-ket. SZÁNDÉKOSAN a PRE_SILENCE UTÁN, a tényleges
    // PCM-start időpontján: így a kliens-snap-cliens unmute-ja akkor megy
    // ki, amikor a pipe-on már a job (nem az előző fade-out) PCM-je van –
    // a snap-buffer 1 sec-es csúszása mellett is csendet hall a kliens
    // az unmute előtt, nem az előző alacsonyabb prio fade-out végét.
    this.emit("source:start", {
      jobId:    job.id,
      jobType:  job.jobType,
      title:    job.title,
      isResume: job.isResume === true,
    });

    const args = this.buildFfmpegArgs(job);

    const proc = spawn(FFMPEG_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Fade-in byte-szám: explicit override > stream default (1 sec) > 0 (nincs).
    const fadeInBytes = typeof job.fadeInMs === "number"
      ? Math.max(0, Math.round(BYTES_PER_SEC * job.fadeInMs / 1000))
      : (job.source.type === "stream" ? FADE_IN_BYTES_STREAM : FADE_IN_BYTES_NONE);

    const src: ActiveSource = {
      job,
      proc,
      bytesWritten: 0,
      fadeInActive: fadeInBytes > 0,
      fadeInBytes,
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

      const isFirst = src.bytesWritten === 0;

      // KRITIKUS overlap fix:
      // A háttér silence-ffmpeg MOST áll meg, MIELŐTT az első job-PCM chunk
      // a fifoStream-re kerül. Eddig a silence-ffmpeg ír real-time csendet
      // a FIFO-ra (a job-ffmpeg spawn-startup latency-je alatt - 50-200 ms).
      // Egy chunk-frame ATOMIC-an cserélünk forrást.
      if (isFirst) {
        this.pauseSilence();
      }

      const gain = this.computeGain(src, chunk.length);

      if (gain < 1) {
        this.applyGain(chunk, gain);
      }

      const fifoExists = !!this.fifoStream;
      const ok = fifoExists ? this.fifoStream!.write(chunk) : false;

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

      // Job véget ért - a háttér silence ffmpeg folytatja a FIFO-ra írást
      // azonnal, hogy a snap szerver ne érzékelje "No data since 120 ms"-t.
      // Ha a következő job rögtön jön (advance() pending), az újra
      // pauseSilence-t hív - rövid resume/pause cikus elviselhető.
      this.resumeSilence();

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
        this.resumeSilence();

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

    if (src.fadeInActive && src.fadeInBytes > 0) {
      const prog = src.bytesWritten / src.fadeInBytes;

      if (prog >= 1) {
        src.fadeInActive = false;
        return 1;
      }

      const start = prog;
      const end = Math.min(1, (src.bytesWritten + chunkLen) / src.fadeInBytes);

      if (end >= 1) {
        src.fadeInActive = false;
      }

      return (start + end) / 2;
    }

    // fadeInBytes === 0 → azonnal teljes amplitúdó (chime / üzenet)
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

    // Resume-bytes: file/url forrás esetén a megszakítás pontján folytatjuk
    // (ffmpeg -ss). Stream forrás esetén resumeBytes=0 – élő stream-et
    // újra-csatlakozással folytatunk a live pozíción (az aktuális élő adás).
    const isStream   = src.job.source.type === "stream";
    const resumeBytes = isStream
      ? 0
      : (src.job.resumeBytes ?? 0)
        + (src.fadeOutStart !== null ? src.fadeOutStart : src.bytesWritten);

    this.pausedStack.push({
      job: src.job,
      resumeBytes,
      pausedAt: Date.now(),
    });

    console.log(
      `[Mixer:${this.tenantId}] ⏸ pause: ${src.job.jobType}` +
      (isStream
        ? ` (stream → live resume)`
        : ` @ ${(resumeBytes / BYTES_PER_SEC).toFixed(2)}s`)
    );

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

    // User-initiated stop esetén SIGKILL – azonnali, az ffmpeg nem tudja
    // a buffer-ét még pár száz ms-ig kiírni. Fade-out scenariókban a
    // `onFadeOutComplete` SIGTERM-mel megy ettől függetlenül.
    const signal: NodeJS.Signals = reason === "stopped" ? "SIGKILL" : "SIGTERM";
    try {
      src.proc.kill(signal);
    } catch {
      // ignore
    }

    this.active = null;

    // Job végén/megszakításnál a háttér silence ffmpeg folytatja az írást.
    this.resumeSilence();

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

      // Resume: 500ms-os lágy fade-in (a stream-resume már 1s-os default-tal
      // megy, a file-resume eddig 0-val indult – ez okozta a "hirtelen
      // megszólalás" érzést a user-request szerint). Explicit fadeInMs
      // override marad, ha valaki kézzel állította.
      // isResume=true → source:start eseményen jelezzük a service-nek, hogy
      // STOP+PREPARE+PLAY-vel dispatchelje a klienseket fresh playback-ként.
      const RESUME_FADE_IN_MS = 500;
      this.beginPendingStart({
        ...top.job,
        resumeBytes: top.resumeBytes,
        fadeInMs:    top.job.fadeInMs ?? RESUME_FADE_IN_MS,
        isResume:    true,
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

    /*
     * Broadcast-style audio processing chain (opt-in).
     *
     * A jelen állapotban DEFAULT KIKAPCSOLVA, mert a `loudnorm` filter
     * single-pass módban dinamikus belső buffer adagolást végez (FFT-alapú
     * loudness analízis 3 másodperces ablakkal), ami időnként nem pontosan
     * 20 ms-os chunk-okat ad ki - ez minden ~2 másodpercben 100-120 ms-os
     * jittert okozott a klienseken (RESYNCING HARD 2: age -99..-119ms).
     *
     * Bekapcsolás: BACKEND_ENABLE_NORMALIZE=1 env változó. Ekkor egy
     * egyszerűbb chain fut, ami nem tartalmazza a problémás loudnorm-ot:
     *
     *   acompressor = threshold:-18dB ratio:4 attack:20ms release:250ms
     *     Dinamikus tartomány tömörítés. A halk passzázsokat kiemeli,
     *     a hangosakat tompítja.
     *
     *   alimiter = level_in:1 level_out:1 limit:0.95
     *     Brick-wall peak limiter -0.45 dBFS ceiling-gel. Az Opus encoder
     *     előtt megakadályozza a clipping-et.
     *
     * Ez a két filter csekély (sub-ms) processing latency-vel jár, így
     * nem zavarja a snap szerver oldali ütemezést.
     *
     * A loudness normalizációt (EBU R128 / -16 LUFS) később adjuk vissza,
     * amikor megoldjuk a timing jitter problémát (pl. két-passos offline
     * normalizációval a hangfájlok feltöltésekor, vagy más megközelítéssel).
     */
    const AUDIO_NORMALIZE_FILTER =
      "acompressor=threshold=-18dB:ratio=4:attack=20:release=250," +
      "alimiter=level_in=1:level_out=1:limit=0.95";

    // Forrás-szintű pre-gain (csak ha explicit meg van adva). A `volume=`
    // filter értéke 0..1 lineáris, és a snapserver felé NEM küldi tovább,
    // csak a saját ffmpeg stream-jét gyengíti/erősíti. Default érték: 1
    // (= nincs change). Ha 0, néma stream (de a job lefut).
    const v = typeof src.volume === "number" ? Math.max(0, Math.min(1, src.volume)) : null;
    const preGain = v !== null && v !== 1 ? `volume=${v.toFixed(2)}` : null;

    const chain: string[] = [];
    if (preGain) chain.push(preGain);
    if (process.env.BACKEND_ENABLE_NORMALIZE === "1") chain.push(AUDIO_NORMALIZE_FILTER);

    const audioFilter = chain.length > 0 ? ["-af", chain.join(",")] : [];

    const out = [
      ...audioFilter,
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