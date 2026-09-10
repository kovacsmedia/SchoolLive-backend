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

// TAIL_SILENCE_MS: a forrás UTOLSÓ mintája után ennyi csendet írunk ki
// KÉZZEL a FIFO-ra, mielőtt az idle csendlánc visszaveszi a szót.
//
// MIÉRT: a csengetés végén a hang "darabosan" állt le. A job ffmpeg-je a
// `-re` miatt real-time ütemben ír, tehát a fájl utolsó mintája nagyjából
// akkor kerül a pipe-ba, amikor meg is szólal – a snap szerver és a
// kliensek pufferében viszont még ott a hang farka, amit onnan még ki kell
// játszani. Amint a forrás elfogy, a FIFO-n rés keletkezik (a SIGCONT
// kézbesítése + az ffmpeg újraütemezése nem azonnali), a snap szerver
// "No data" miatt idle-be megy, és a kliensek a még pufferelt farkat
// megszaggatva vagy félbevágva játsszák le.
//
// 3 mp csend bőven fedi a snap szerver + kliens puffert (~1-1,5 s), így a
// hang vége végig folytonos adatfolyamon érkezik és tisztán cseng ki.
//
// MINDHÁROM forrástípus végén lefut – csengetés (BELL), üzenet (TTS) és
// rádió (RADIO) egyaránt –, mert a puffer-kiürülés nem a tartalomtól függ,
// hanem attól, hogy elfogy az adat a FIFO-n.
//
// Ezt SZÁNDÉKOSAN nem ffmpeg-filterrel (apad) oldjuk meg: egy nem támogatott
// filter-opció az ffmpeg indulását buktatná, az pedig ELMARADT CSENGETÉST
// jelentene. A Buffer-írás nem tud így elhasalni.
const TAIL_SILENCE_MS = 3000;

// A tail-csend ugyanazt a darabolást és nulla-puffert használja, mint az
// idle csend (ld. SILENCE_CHUNK) – a különbség csak annyi, hogy ez véges.
const TAIL_SILENCE_BYTES =
  Math.round(BYTES_PER_SEC * TAIL_SILENCE_MS / 1000 / FRAME_BYTES) * FRAME_BYTES;

// ── Háttér csend (idle silence) ─────────────────────────────────────────────
//
// A snap FIFO-t SOHA nem hagyhatjuk adat nélkül: ha a snapserver nem kap
// mintát időben, "we are late"-et állapít meg, ELŐRE TOLJA az időbélyeg-
// alapját, és minden kliens kemény újraszinkronra kényszerül – ez a hallható
// koppanás/megbicsaklás.
//
// TÖRTÉNET ÉS INDOKLÁS (2026-09-10):
//
//  1. Eredetileg egy `setInterval(20ms)` Node-timer írta a csendet. A Node
//     event-loop akadozására (GC, egyéb munka) érzékeny volt: a timer
//     csúszott, a FIFO éhen maradt.
//
//  2. Ezt egy külön `ffmpeg -re -f lavfi -i anullsrc` subprocess váltotta,
//     amit job indulásakor SIGSTOP, job végén SIGCONT vezérelt. Ez két új,
//     SÚLYOSABB hibát hozott:
//
//     a) A `-re` PONTOSAN valós időben ír, a snapserver PONTOSAN valós időben
//        olvas – a csőben tehát NULLA tartalék halmozódik fel. Az írónak
//        nincs előnye, így bármilyen apró megcsúszás (épp a forrásváltáskor,
//        amikor a Node egyszerre intézi a snapcast célzó RPC-ket, a
//        process-spawnt és az event-emitteket) AZONNAL éhezteti az olvasót.
//        A klienseken pontosan ez látszott:
//          `RESYNCING HARD 2: age -650000us` a csengetés indulásakor ÉS a
//          rádió visszatérésekor, mindkétszer azonos nagyságrendben.
//
//     b) A SIGSTOP alatt a `-re` óra tovább ketyeg, tehát a subprocess a job
//        teljes hosszával "lemarad". SIGCONT után végtelen behozó üzemmódba
//        kerül, és onnantól folyamatosan blokkolt írásban áll – ilyenkor egy
//        SIGSTOP félbevágott (nem frame-határon lévő) írást hagyhat a csőben,
//        ami tartós csatorna-elcsúszást okoz.
//
//  3. MOSTANI MEGOLDÁS: a csendet megint a Node írja, de NEM timerrel, hanem
//     a write-drain visszahívásból láncolva. Az ütemezést így a FIFO
//     ELLENNYOMÁSA adja, azaz pontosan a snapserver olvasási üteme:
//       • elfutni nem tud (a write blokkol, ha tele a cső),
//       • lemaradni nem tud (amint van hely, azonnal ír),
//       • és a cső VÉGIG TELE marad – ez a teli cső (+ a Node stream 64 kB-os
//         puffere) az a ~680 ms tartalék, ami elnyeli az író akadozását.
//
//     Ráadásul így EGYETLEN író van a FIFO-n (a Node stream), tehát a
//     frame-elcsúszás fogalmilag lehetetlen, és tenantonként eggyel kevesebb
//     ffmpeg processz fut.
//
// A csendet 40 ms-os darabokban írjuk: elég kicsi, hogy egy induló job
// legfeljebb ennyit várjon a szó átvételére, és elég nagy, hogy a
// write-callback forgalom elhanyagolható maradjon (25 hívás/mp/tenant).
const SILENCE_CHUNK_MS = 40;
const SILENCE_CHUNK_BYTES =
  Math.round(BYTES_PER_SEC * SILENCE_CHUNK_MS / 1000 / FRAME_BYTES) * FRAME_BYTES;

// Egyetlen, újrafelhasznált nulla-puffer (s16le csend = csupa 0 byte).
// Egyszerre mindig csak EGY csend-írás van úton, és a tartalmát senki nem
// módosítja, ezért az újrafelhasználás biztonságos.
const SILENCE_CHUNK = Buffer.alloc(SILENCE_CHUNK_BYTES);

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
  // Teljes hossz másodpercben (YouTube-metaadatból vagy RadioFile.durationSec-ből) –
  // csak a `getRadioLiveState()` élő seek-sáv UI-jának adjuk tovább, a lejátszást
  // magát nem befolyásolja.
  durationSec?: number;
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
  // Miért indult a fade-out: "interrupted" = magasabb prio job szakítja meg
  // (a job pausedStack-re kerül, resume-olható), "stopped" = user-initiated
  // STOP_PLAYBACK (nincs resume, a queue-t a hívó már kiürítette). null,
  // amíg nincs fade-out folyamatban.
  fadeOutReason: SourceEndReason | null;
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

  // Felhasználó-kezdeményezett élő szünet (YouTube fül / Hangfájl könyvtár
  // élő seek-sáv "⏸" gombja) — SZÁNDÉKOSAN NEM a `pausedStack`-en tárolva,
  // mert az `advance()` a pausedStack tetejét automatikusan visszaveszi,
  // amint a queue kiürül (ez a helyes viselkedés a prioritás-megszakításnál,
  // de itt egy user által explicit, határozatlan idejű szünetről van szó –
  // csak egy explicit `resumeRadio()` hívás oldja fel).
  private userPausedRadio: { job: MixerJob; resumeBytes: number } | null = null;

  // A futó idle-csend lánc token-je. A `cancelled` flag állítása azonnal
  // megszakítja a láncot – a még úton lévő write callback-je látja meg.
  private silenceLoop: { cancelled: boolean } | null = null;

  // Folyamatban lévő tail-csend kiírás. A `cancelled` flag-et egy új job
  // indulása billenti át (ld. beginPendingStart) – így a csend azonnal
  // abbamarad, és nem tolódik be a következő hang elé.
  private tailSilence: { cancelled: boolean } | null = null;

  private gapTimer: ReturnType<typeof setTimeout> | null = null;

  private running = false;
  private inGap = false;

  // Live radio gain (0..1 lineáris). A frontend slider az `setRadioGain`-en
  // át bármikor módosítja, és a köv. PCM chunk-tól érvényesül RADIO típusú
  // forrásokra. Default 1.0 (= 0 dB, max). A snapserver puffer (~1 sec)
  // miatt a változás kb. 1 másodperc késéssel hallható a klienseken.
  private radioGain: number = 1.0;

  constructor(tenantId: string, fifoPath: string) {
    super();
    this.tenantId = tenantId;
    this.fifoPath = fifoPath;
  }

  /** Live radio gain beállítása (0..1 lineáris). Csak RADIO típusú forrásra
   *  hat – BELL/TTS bemondások mindig saját skálán mennek (max-loud chain). */
  setRadioGain(gain: number): void {
    this.radioGain = Math.max(0, Math.min(1, gain));
  }

  /** Aktuális radio gain lekérdezése (debug / status). */
  getRadioGain(): number {
    return this.radioGain;
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

    // Idle csendlánc – nulla-PCM-et ír a FIFO-ra mindaddig, amíg nincs aktív
    // job. Ütemezés: a FIFO ellennyomása (ld. SILENCE_CHUNK).
    this.startSilenceLoop();

    console.log(`[Mixer:${this.tenantId}] ▶ stream INDUL → ${this.fifoPath}`);
  }

  stop(): void {
    if (!this.running) return;

    this.running = false;

    this.stopSilenceLoop();

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

        // A korábbi csendlánc a lezárt stream-en kilépett (ld. startSilenceLoop
        // őrfeltétele). Újranyitás után MUSZÁJ újraindítani, különben a FIFO
        // némán kiürül, és a snapserver minden kliensnek időbélyeg-ugrást küld.
        // Ha épp szól egy forrás, az írja a FIFO-t – akkor nem nyúlunk hozzá.
        if (this.running && !this.active) {
          this.stopSilenceLoop();
          this.startSilenceLoop();
        }
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
  // A pending fázis alatt nincs aktív forrás, így az idle csendlánc
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
    // Új job jön: a még futó tail-csend azonnal álljon le. Erre a
    // PRE_SILENCE_MS (1 s) pending-fázis bőven elég időt ad, mielőtt az új
    // forrás első PCM chunk-ja megjelenne a FIFO-n.
    this.cancelTailSilence();

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
    if (this.userPausedRadio) this.emitStopped(this.userPausedRadio.job);

    this.queue = [];
    this.pausedStack = [];
    this.userPausedRadio = null;

    this.cancelPending("stopped");
    // 1s fade-out az azonnali SIGKILL helyett – felhasználói STOP-nál a
    // korábbi azonnali vágás a snap-buffer miatt "elnyúlt", hibásnak ható
    // hangként hallatszott a lejátszókon. A fade-out ugyanazt a mechanizmust
    // használja, mint a magasabb prioritású job megszakításkor (beginFadeOut/
    // onFadeOutComplete), csak "stopped" reason-nel (nincs resume).
    this.beginFadeOut("stopped");
  }

  stopByType(jobType: MixerJobType): void {
    // A típushoz tartozó queue- és pausedStack-bejegyzésekre emit-elünk
    // source:end stopped-et, hogy a service.ts ki tudja takarítani őket.
    for (const j of this.queue.filter(q => q.jobType === jobType)) this.emitStopped(j);
    for (const p of this.pausedStack.filter(ps => ps.job.jobType === jobType)) this.emitStopped(p.job);
    if (this.userPausedRadio && this.userPausedRadio.job.jobType === jobType) {
      this.emitStopped(this.userPausedRadio.job);
      this.userPausedRadio = null;
    }

    this.queue       = this.queue.filter((j) => j.jobType !== jobType);
    this.pausedStack = this.pausedStack.filter((p) => p.job.jobType !== jobType);

    if (this.pending?.job.jobType === jobType) {
      this.cancelPending("stopped");
    }

    if (this.active?.job.jobType === jobType) {
      // Ld. stopAll() kommentje – fade-out azonnali SIGKILL helyett.
      this.beginFadeOut("stopped");
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

  // ── Élő RADIO-vezérlés (YouTube fül / Hangfájl könyvtár seek-sáv) ──────────
  //
  // Csak akkor hatnak, ha ÉPP egy RADIO típusú job aktívan szól (vagy user
  // által szüneteltetve van) — ha egy magasabb prioritású BELL/TTS félbeszakította
  // (a RADIO ilyenkor a `pausedStack`-en van, NEM a `userPausedRadio`-ban), a
  // hívó egyértelmű `false`-t kap, nem piszkál bele az interrupt-mechanizmusba.
  //
  // A tekerés/resume ugyanazt a kill+újraindítás-adott-pozícióról mintát
  // használja, mint a meglévő prioritás-megszakítás/resume (ld. advance()) –
  // a snapcast.service.ts onSourceStart(isResume=true) ága ugyanúgy
  // STOP+PREPARE+PLAY-t küld a klienseknek, mint eddig is bell/TTS utáni
  // radio-resume esetén, így nincs szükség új kliens-oldali kódra.

  /** Élő pozíció/állapot RADIO forráshoz (seek-sáv UI-hoz). Null, ha nincs
   *  RADIO se aktívan szóló, se user-paused állapotban. */
  getRadioLiveState(): { active: boolean; paused: boolean; positionSec: number; durationSec?: number; title?: string } | null {
    if (this.active && this.active.job.jobType === "RADIO") {
      // FONTOS: a job.resumeBytes-t is hozzá kell adni, nem csak az AKTUÁLIS
      // ffmpeg-szegmens által eddig kiírt bytesWritten-t – seek/resume után
      // ugyanis egy TELJESEN ÚJ ffmpeg-folyamat indul (bytesWritten=0-ról),
      // az abszolút pozíció ettől a bázistól számítva helyes (ugyanez a
      // minta, mint a `pauseRadio()`-ban lent). Enélkül a seek-sáv minden
      // tekerés/resume után hamisan 0:00-ra ugrott vissza.
      return {
        active: true,
        paused: false,
        positionSec: ((this.active.job.resumeBytes ?? 0) + this.active.bytesWritten) / BYTES_PER_SEC,
        durationSec: this.active.job.durationSec,
        title: this.active.job.title,
      };
    }
    if (this.userPausedRadio) {
      return {
        active: false,
        paused: true,
        positionSec: this.userPausedRadio.resumeBytes / BYTES_PER_SEC,
        durationSec: this.userPausedRadio.job.durationSec,
        title: this.userPausedRadio.job.title,
      };
    }
    return null;
  }

  /** Élő tekerés: ha épp szól, azonnal újraindul az új pozícióról; ha épp
   *  user-paused, csak a mentett pozíciót módosítja (marad paused). */
  seekRadio(positionSec: number): boolean {
    const resumeBytes = Math.max(0, Math.round(positionSec * BYTES_PER_SEC));

    if (this.active && this.active.job.jobType === "RADIO") {
      const job = this.active.job;
      this.killActive("interrupted");
      this.beginPendingStart({ ...job, resumeBytes, isResume: true });
      return true;
    }

    if (this.userPausedRadio) {
      this.userPausedRadio = { ...this.userPausedRadio, resumeBytes };
      return true;
    }

    return false;
  }

  /** Élő szünet: leállítja az aktív RADIO-t, a pozíciót elmenti — NEM a
   *  pausedStack-re (ld. mező-komment), hogy az `advance()` ne vegye
   *  automatikusan vissza. */
  pauseRadio(): boolean {
    if (!this.active || this.active.job.jobType !== "RADIO") return false;

    const src = this.active;
    const resumeBytes = (src.job.resumeBytes ?? 0) + src.bytesWritten;
    this.userPausedRadio = { job: src.job, resumeBytes };

    // Élő szünet: a rádióadás itt ÉR VÉGET, és nem követi másik forrás –
    // tehát ugyanúgy kell a tail-csend, mint a csengetés/üzenet végén,
    // különben a kliensek pufferében maradt hang darabosan szakad meg.
    this.killActive("interrupted", true);
    return true;
  }

  /** Élő folytatás a `userPausedRadio`-ban mentett pozícióról. */
  resumeRadio(): boolean {
    if (!this.userPausedRadio) return false;
    if (this.active || this.pending) return false;

    const { job, resumeBytes } = this.userPausedRadio;
    this.userPausedRadio = null;

    this.beginPendingStart({ ...job, resumeBytes, isResume: true });
    return true;
  }

  // ── Tail-csend (forrás vége) ────────────────────────────────────────────

  /** Egy futó tail-csend megszakítása (új job indul, vagy leállás). */
  private cancelTailSilence(): void {
    if (!this.tailSilence) return;
    this.tailSilence.cancelled = true;
    this.tailSilence = null;
  }

  /**
   * A forrás (BELL / TTS / RADIO) vége után TAIL_SILENCE_MS csend kiírása a
   * FIFO-ra, majd az idle csendlánc átveszi.
   *
   * MIÉRT: a hang utolsó mintája nagyjából akkor kerül a FIFO-ra, amikor meg
   * is szólal – a snapserver és a kliensek pufferében viszont még ott a farka.
   * Ha a forrás elfogytával rés keletkezik, a snapserver "we are late"-et
   * állapít meg, előre tolja az időbélyeg-alapját, és a kliensek a még
   * pufferelt farkat megszaggatva játsszák le.
   *
   * A darabolást és a nulla-puffert az idle csenddel közösen használja
   * (SILENCE_CHUNK): a FIFO ellennyomása adja az ütemet, tehát nem tömünk be
   * 3 másodpercnyi PCM-et egyetlen írással a snapserver puffere elé, és egy
   * közben induló új job legfeljebb egy darabnyit vár.
   */
  private startTailSilence(jobType?: MixerJobType): void {
    this.cancelTailSilence();
    // Egyszerre csak EGY írónk lehet a FIFO-n: az idle lánc most hallgat.
    this.stopSilenceLoop();

    console.log(
      `[Mixer:${this.tenantId}] 🔇 tail-csend ${TAIL_SILENCE_MS}ms` +
      (jobType ? ` (${jobType} vege)` : "")
    );

    const token = { cancelled: false };
    this.tailSilence = token;

    let written = 0;
    let done    = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);

      if (this.tailSilence === token) this.tailSilence = null;
      // Ha közben elindult egy forrás, AZ írja a FIFO-t – az idle lánc
      // ilyenkor maradjon néma, különben ketten írnának ugyanoda.
      if (!this.active) this.startSilenceLoop();
    };

    // Biztonsági háló: ha egy FIFO-írás soha nem tér vissza (nincs olvasó a
    // másik végén), a lánc megállna, és az idle csend SOHA nem indulna újra –
    // onnantól néma lenne a tenant streamje. A csengetés nem maradhat el.
    const watchdog = setTimeout(() => {
      console.warn(`[Mixer:${this.tenantId}] tail-csend időtúllépés – idle csend felengedve`);
      finish();
    }, TAIL_SILENCE_MS + 2000);

    const step = (): void => {
      const stream = this.fifoStream;

      if (
        token.cancelled ||
        !this.running ||
        !stream ||
        stream.destroyed ||
        this.active !== null ||
        written >= TAIL_SILENCE_BYTES
      ) {
        finish();
        return;
      }

      const n = Math.min(SILENCE_CHUNK_BYTES, TAIL_SILENCE_BYTES - written);
      written += n;

      try {
        stream.write(
          n === SILENCE_CHUNK_BYTES ? SILENCE_CHUNK : SILENCE_CHUNK.subarray(0, n),
          () => step()
        );
      } catch (e: any) {
        console.warn(`[Mixer:${this.tenantId}] tail-csend írás hiba: ${e.message}`);
        finish();
      }
    };

    step();
  }

  // ── Idle csend életciklus ───────────────────────────────────────────────

  /**
   * Idle csend indítása: nulla-PCM írása a FIFO-ra, a write-drain
   * visszahívásból láncolva. Az ütemezést a FIFO ellennyomása adja (ld. a
   * SILENCE_CHUNK fölötti indoklást), tehát sem elfutni, sem lemaradni nem tud.
   *
   * Idempotens: ha már fut egy lánc, nem indít másodikat.
   */
  private startSilenceLoop(): void {
    if (this.silenceLoop) return;

    const token = { cancelled: false };
    this.silenceLoop = token;

    const step = (): void => {
      const stream = this.fifoStream;

      if (token.cancelled || !this.running || !stream || stream.destroyed) {
        if (this.silenceLoop === token) this.silenceLoop = null;
        return;
      }

      try {
        stream.write(SILENCE_CHUNK, () => step());
      } catch (e: any) {
        // A FIFO újranyitás alatt lehet átmenetileg írhatatlan. NEM adhatjuk
        // fel: a csend hiánya = a snapserver éhezése = koppanás minden
        // kliensen. Rövid szünet után újrapróbáljuk.
        console.warn(`[Mixer:${this.tenantId}] csend-írás hiba: ${e.message} – 100ms múlva újra`);
        setTimeout(() => { if (!token.cancelled) step(); }, 100);
      }
    };

    step();
  }

  /** Az idle-csend lánc leállítása. */
  private stopSilenceLoop(): void {
    if (!this.silenceLoop) return;
    this.silenceLoop.cancelled = true;
    this.silenceLoop = null;
  }

  /**
   * Job indulása előtt: a csendlánc leáll, hogy a job PCM-je vegye át a szót.
   *
   * SZÁNDÉKOSAN nem a `startSource()` elején hívjuk, hanem a job-ffmpeg ELSŐ
   * PCM chunk-jának érkezésekor – így a spawn + ffmpeg-init latency (50-200 ms)
   * alatt is folyamatosan megy a csend a FIFO-ra.
   *
   * Mivel ugyanaz a Node stream az egyetlen író, a váltás sorrendhelyes és
   * frame-pontos: legfeljebb egy már beadott 40 ms-os csenddarab kerül még a
   * job hangja elé.
   */
  private pauseSilence(): void {
    this.stopSilenceLoop();
  }

  /** Job vége után: a csendlánc folytatja, hogy a snapserver folyamatosan
   *  kapjon adatot a FIFO-ról (ne legyen "we are late" → időbélyeg-ugrás). */
  private resumeSilence(): void {
    this.startSilenceLoop();
  }

  // ── Forrás indítás ───────────────────────────────────────────────────────

  private startSource(job: MixerJob): void {
    // KRITIKUS: az idle csendlánc megállítását NEM itt rögtön,
    // hanem a job-ffmpeg ELSŐ PCM chunk-jának érkezésekor csináljuk.
    // Így a csendlánc a job-ffmpeg startup latency-je (spawn + ffmpeg init +
    // first chunk = 50-200 ms) ALATT IS folyamatosan ír csendet a FIFO-ra.
    // Soha nincs "no data" rés.
    //
    // Mindkettő UGYANARRA a Node stream-re ír, ezért a váltás sorrendhelyes és
    // frame-pontos: a job első chunk-ja garantáltan a már beadott csenddarabok
    // UTÁN kerül a FIFO-ra, sosem közéjük.

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
      fadeOutReason: null,
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

      // Effektív gain = fade-gain × (RADIO esetén) live radioGain.
      // A `radioGain` futás közben módosítható (lásd `setRadioGain`), így a
      // frontend slider azonnal hat a már szóló streamre is. A snap-szerver
      // ~1 sec buffer-je miatt a változás ~1s késéssel hallható a klienseken.
      const fadeGain = this.computeGain(src, chunk.length);
      const liveGain = src.job.jobType === "RADIO" ? this.radioGain : 1.0;
      const gain     = fadeGain * liveGain;

      if (gain !== 1) {
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

      // Job véget ért. ELŐBB kiírjuk a tail-csendet (TAIL_SILENCE_MS), hogy a
      // snap szerver és a kliensek pufferében maradt hang-farok folytonos
      // adatfolyamon, szakadás nélkül csenghessen ki – enélkül a csengetés
      // vége darabosan állt le. Az idle csendlánc ezután veszi vissza a
      // szót; ha közben új job indul, a tail-csend azonnal megszakad.
      this.startTailSilence(src.job.jobType);

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

  private beginFadeOut(reason: SourceEndReason = "interrupted"): void {
    if (!this.active) return;

    if (this.active.fadeOutStart !== null) {
      // Már fut egy fade-out (pl. magasabb prio job szakította meg épp).
      // Ha most egy explicit STOP jön, a reasont "stopped"-ra frissítjük,
      // hogy onFadeOutComplete ne pause-olja resume-olhatóként, hanem
      // véglegesen lezárja (a queue-t a stopAll()/stopByType() már
      // kiürítette, szóval amúgy sem lenne mire resume-olni).
      if (reason === "stopped") this.active.fadeOutReason = "stopped";
      return;
    }

    this.active.fadeOutStart  = this.active.bytesWritten;
    this.active.fadeOutReason = reason;

    console.log(`[Mixer:${this.tenantId}] ↘ fade-out (${reason}): ${this.active.job.jobType}`);
  }

  private onFadeOutComplete(src: ActiveSource): void {
    if (src.killed) return;

    src.killed = true;

    try {
      src.proc.kill("SIGTERM");
    } catch {
      // ignore
    }

    this.active = null;

    if (src.fadeOutReason === "stopped") {
      // User-initiated STOP_PLAYBACK: nincs resume/pause – a stopAll()/
      // stopByType() már kiürítette a queue-t és a pausedStack-et, mielőtt
      // a fade-out elindult. Csak lezárjuk a job-ot és folytatjuk a háttér-
      // silence-t (mint killActive), NEM advance-elünk a queue-ra.
      // Tail-csenddel, hogy a fade-out vége is folytonosan csengjen ki.
      this.startTailSilence(src.job.jobType);

      this.emit("source:end", {
        jobId:        src.job.id,
        jobType:      src.job.jobType,
        reason:       "stopped" as SourceEndReason,
        bytesWritten: src.bytesWritten,
      });

      console.log(`[Mixer:${this.tenantId}] ⏹ fade-out kész (stopped): ${src.job.jobType}`);
      return;
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

    this.emit("source:end", {
      jobId: src.job.id,
      jobType: src.job.jobType,
      reason: "interrupted" as SourceEndReason,
      bytesWritten: src.bytesWritten,
    });

    this.scheduleAdvance(POST_FADE_GAP_MS);
  }

  /**
   * @param drainTail ha true, az idle csendlánc helyett a tail-csend
   *        indul (ld. startTailSilence). Csak ott igaz, ahol a leállítást
   *        NEM követi azonnal új forrás – különben két írónk lenne a FIFO-n.
   */
  private killActive(reason: SourceEndReason, drainTail = false): void {
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

    const jobType = src.job.jobType;
    this.active = null;

    // Job végén/megszakításnál az idle csendlánc folytatja az írást.
    if (drainTail) this.startTailSilence(jobType);
    else           this.resumeSilence();

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
     * Per-jobType audio processing:
     *
     *   BELL / TTS  (bemondás / csengő – "announcement"):
     *     Cél: a snap pipe-on dominánsabb amplitudón szóljanak, hogy a
     *     háttérzenénél (rádió, amit a radioGain slider eltunkol) észre-
     *     vehetőek legyenek. NEM kényszerítjük max-amplitudóra (= a
     *     korábbi +6 dB makeup túl agresszív volt), csak közelítjük.
     *     A `loudnorm` filter SZÁNDÉKOSAN nincs (single-pass módban
     *     timing-jittert okozott), helyette egyszerű compressor + makeup
     *     gain + brick-wall limiter. Sub-ms processing latency.
     *
     *     "Transparent leveling" – csak a legnagyobb csúcsokat fogja, soft
     *     knee, minimális makeup → nincs hallható kompresszor-artefakt /
     *     pumping. A TTS rendered fájl már -12 LUFS-en van, itt csak
     *     egyenletesítjük a dinamikát + brick-wall limiter biztonsági okból.
     *       acompressor: threshold=-12dB (csak a hangos csúcsok), ratio=2
     *                    (alig kompresszál), knee=4dB (soft transition),
     *                    makeup=+2dB (alig boost), slow attack=20ms
     *       alimiter:    limit=0.97 (-0.26 dBFS), klipping-stop
     *
     *   RADIO  (netrádió / háttérzene):
     *     A hangerő-szabályzás NEM ffmpeg pre-gain-en megy (mert az nem
     *     módosítható futás közben az ffmpeg újraindítása nélkül), hanem
     *     a `this.radioGain` mező alapján a chunk-write step-ben (`computeGain`
     *     × `radioGain`). Így a frontend slider azonnal hat a már szóló
     *     streamre. Tipikus használat: slider=7 (~-12 dB, "negyed hangerő")
     *     a háttérzenéhez, slider=10 (0 dB, max) a hangos lejátszáshoz.
     *
     *     A `source.volume` mező is működik per-call pre-gain-ként, de ez
     *     legacy (a slider már a setRadioGain-en megy). Ha explicit
     *     source.volume = X érkezik a play() hívásban, azt is alkalmazzuk
     *     (kompatibilitás miatt), de a live slider-állítás felülírja.
     */
    const ANNOUNCEMENT_FILTER =
      "acompressor=threshold=-12dB:ratio=2:attack=20:release=200:knee=4:makeup=2," +
      "alimiter=level_in=1:level_out=1:limit=0.97";

    // Forrás-szintű pre-gain (volume= ffmpeg filter, csak ha explicit
    // source.volume van megadva). RADIO esetén a live `radioGain` mező
    // a futtatható szabályzó (nem itt, hanem a chunk-write step-ben).
    const explicitVolume = typeof src.volume === "number"
      ? Math.max(0, Math.min(2, src.volume))
      : null;
    const preGain = explicitVolume !== null && explicitVolume !== 1
      ? `volume=${explicitVolume.toFixed(2)}`
      : null;

    const chain: string[] = [];
    if (preGain) chain.push(preGain);
    if (job.jobType === "BELL" || job.jobType === "TTS") {
      // Bemondás/csengő: max-loud (de nem agresszív) chain a snap pipe-on.
      chain.push(ANNOUNCEMENT_FILTER);
    }

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

    // A `-re` (valós idejű olvasás) SZÁNDÉKOSAN nincs egyik ágon sem: az
    // ütemezést a FIFO ellennyomása adja, ami tartalékot hagy a csőben az
    // író akadozásának elnyelésére. Részletes indoklás a SILENCE_FFMPEG_ARGS
    // fölött. (A `stream` ágon eleve sosem volt.)
    if (src.type === "file" && src.path) {
      return [
        "-hide_banner",
        "-loglevel",
        "error",
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