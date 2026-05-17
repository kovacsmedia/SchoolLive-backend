// src/modules/snapcast/snapcast.service.ts
//
// Multi-tenant snapcast facade.
//
// Tenantonként:
// • saját snapPort-ú snapserver PM2 alatt,
// • saját FIFO,
// • saját TenantAudioMixer,
// • saját JSON-RPC kapcsolat a per-kliens volume/mute vezérléshez.
//
// Fontos:
// A lejátszás indítása előtt megvárjuk, hogy a célzott snap kliensek
// látszódjanak, majd beállítjuk a mute/unmute állapotot.
// Csak ezután indul a tényleges audio mixer job.

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import {
  TenantAudioMixer,
  MixerJob,
  MixerJobType,
  MixerSource,
  MixerStatus,
  SourceEndReason,
} from "./audio-mixer";
import {
  SnapJobType,
  SnapAudioSource,
  SNAP_PRIORITY,
} from "./snapcast.types";
import {
  rpcPing,
  rpcUnmuteAll,
  rpcListClients,
  rpcSetClientVolume,
} from "./snapcast-rpc";
import { randomUUID } from "crypto";

const SNAPSERVER_BIN = process.env.SNAPSERVER_BIN ?? "/usr/bin/snapserver";

const SNAP_BASE_DIR = "/opt/schoollive/snapcast";
const FIFO_DIR = `${SNAP_BASE_DIR}/fifos`;
const CONFIG_DIR = `${SNAP_BASE_DIR}/configs`;

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

const httpPort = (snapPort: number) => snapPort + 1000;

/**
 * Frontend slider (0..10) → lineáris audio gain.
 *
 * Decibel-egyenletes mapping:
 *   slider=10 → 0 dB    (gain = 1.000, max amplitúdó)
 *   slider=9  → -4 dB   (gain ≈ 0.631)
 *   slider=8  → -8 dB   (gain ≈ 0.398)
 *   slider=7  → -12 dB  (gain ≈ 0.251)
 *   slider=6  → -16 dB  (gain ≈ 0.158)
 *   slider=5  → -20 dB  (gain = 0.100)
 *   slider=4  → -24 dB  (gain ≈ 0.063)
 *   slider=3  → -28 dB  (gain ≈ 0.040)
 *   slider=2  → -32 dB  (gain ≈ 0.025)
 *   slider=1  → -36 dB  (gain ≈ 0.016)
 *   slider=0  → mute    (gain = 0)
 *
 * A -36 dB-es alsó limit szándékos: ez a klasszikus PA-rendszer alsó
 * határa, amin alul a háttérzene gyakorlatilag csendnek érződik (~1/64
 * amplitúdó), de a bemondás max-loud láncon át tisztán hallható.
 * 4 dB/lépés egyenletes osztás → auditívan szabályos lépcsőzet.
 */
function sliderToLinearGain(slider: number): number {
  if (!Number.isFinite(slider) || slider <= 0) return 0;
  if (slider >= 10) return 1;
  // dB = (slider - 10) × (36/9) = (slider - 10) × 4, gain = 10^(dB/20)
  const db = (slider - 10) * 4;
  return Math.pow(10, db / 20);
}

// ── Per-tenant engine ───────────────────────────────────────────────────────

class TenantSnapEngine {
  readonly tenantId: string;
  readonly snapPort: number;
  readonly fifoPath: string;
  readonly cfgPath: string;

  private mixer: TenantAudioMixer | null = null;
  private snapOnline = false;
  private inited = false;
  private configChangedOnInit = false;

  private jobs = new Map<string, MixerJob>();
  private jobTargets = new Map<string, string[] | undefined>();

  // STOP_PLAYBACK broadcast késleltetése a snap drain idejére: a `source:end`
  // event után ennyivel megy ki, hogy a kliens snap puffere lejátssza a hang
  // végét MIELŐTT a Linux/Windows app.py snap-restart-ot triggerelne.
  // Ha közben új forrás indul (source:start), törlődik – csak forrás-csere
  // történt, nem teljes stop, a HUD-ot a NOW_PLAYING_INFO frissíti.
  //
  // A 3000ms safety margin van a queue-/pausedStack-resume-okra: a mixer
  // `POST_SILENCE_MS=500 + PRE_SILENCE_MS=1000 = 1500ms` időt vesz fel egy
  // resume elindításához. Ha a STOP timer is 1500ms volt, race volt a kettő
  // között → STOP broadcast ment ki radio-resume közben, a kliens snapclient
  // restart-tal válaszolt → ~0.5s audio gap. 3000ms-szel mindig az `advance`
  // és `startSource` után fut (akkor m.current már beállt → guard catches).
  private stopBroadcastTimer: NodeJS.Timeout | null = null;
  private static readonly STOP_BROADCAST_DELAY_MS = 3000;

  constructor(tenantId: string, snapPort: number) {
    this.tenantId = tenantId;
    this.snapPort = snapPort;
    this.fifoPath = `${FIFO_DIR}/snapfifo-${snapPort}`;
    this.cfgPath = `${CONFIG_DIR}/snapserver-${snapPort}.conf`;
  }

  async init(): Promise<void> {
    if (this.inited) return;

    mkdirSync(FIFO_DIR, { recursive: true });
    mkdirSync(CONFIG_DIR, { recursive: true });

    this.ensureFifo();
    this.writeConfig();

    await this.ensureSnapserver();

    this.mixer = new TenantAudioMixer(this.tenantId, this.fifoPath);
    this.mixer.on("source:start", (e: any) => this.onSourceStart(e));
    this.mixer.on("source:end", (e: any) => this.onSourceEnd(e));
    this.mixer.start();

    // Startupkor tisztítjuk az esetleg beragadt snapserver mute állapotot.
    void rpcUnmuteAll(httpPort(this.snapPort))
      .then((n) => {
        if (n > 0) {
          console.log(`[Snap:${this.snapPort}] startup unmute: ${n} kliens`);
        }
      })
      .catch(() => {});

    this.inited = true;
  }

  private ensureFifo(): void {
    if (existsSync(this.fifoPath)) return;

    try {
      execSync(`mkfifo ${this.fifoPath} && chmod 666 ${this.fifoPath}`);
      console.log(`[Snap:${this.snapPort}] FIFO létrehozva: ${this.fifoPath}`);
    } catch (e) {
      console.error(`[Snap:${this.snapPort}] FIFO hiba:`, e);
    }
  }

  private writeConfig(): void {
    // Opus@192 kbps: ~8x kisebb hálózati terhelés mint PCM@1.5 Mbps,
    // gyakorlatilag transzparens audio minőség. Ezt minden hivatalos
    // snapclient (linux/windows) és minden Opus-képes saját kliens dekódolja.
    // FIGYELEM: a PCM-only saját klienseink (Android, ESP32) ettől a
    // beállítástól nem fognak hangot lejátszani, amíg át nem állnak Opus-ra.
    const cfg = [
      `[server]`,
      `threads = -1`,
      ``,
      `[stream]`,
      `port = ${this.snapPort}`,
      `source = pipe://${this.fifoPath}?name=SL-${this.snapPort}&sampleformat=${SAMPLE_RATE}:16:${CHANNELS}&codec=opus&bitrate=192&chunk_ms=20`,
      ``,
      `[http]`,
      `enabled = true`,
      `port = ${httpPort(this.snapPort)}`,
      ``,
      `[tcp]`,
      `enabled = false`,
    ].join("\n");

    // Csak akkor írjuk és jelöljük "változott"-nak, ha a tartalom valóban más.
    // Így a futó snapservert csak akkor kell pm2-vel újraindítani, ha a
    // konfiguráció (pl. codec=opus váltás) ténylegesen módosult.
    let previous: string | null = null;
    if (existsSync(this.cfgPath)) {
      try {
        previous = readFileSync(this.cfgPath, "utf8");
      } catch {
        previous = null;
      }
    }

    if (previous !== cfg) {
      writeFileSync(this.cfgPath, cfg);
      this.configChangedOnInit = true;

      console.log(
        `[Snap:${this.snapPort}] config frissítve (${previous === null ? "új" : "változott"}): ${this.cfgPath}`
      );
    }
  }

  private async ensureSnapserver(): Promise<void> {
    const alreadyRunning = await rpcPing(httpPort(this.snapPort));

    if (alreadyRunning) {
      // Ha fut, de a config most változott (pl. új codec=opus deploy után),
      // pm2-vel újraindítjuk, hogy biztosan az új beállításokkal menjen.
      if (this.configChangedOnInit) {
        console.log(
          `[Snap:${this.snapPort}] config változott, snapserver pm2 restart`
        );

        try {
          execSync(
            `sudo -u deploy pm2 restart snapserver-${this.snapPort}`,
            { stdio: "pipe" }
          );
        } catch (e) {
          console.error(`[Snap:${this.snapPort}] PM2 restart hiba:`, e);
        }

        // Várjuk meg, hogy az RPC újra válaszoljon.
        for (let i = 0; i < 20; i++) {
          await sleep(300);

          if (await rpcPing(httpPort(this.snapPort))) {
            this.snapOnline = true;
            console.log(
              `[Snap:${this.snapPort}] snapserver újraindult új configgal`
            );
            return;
          }
        }

        console.warn(
          `[Snap:${this.snapPort}] restart után RPC nem válaszol`
        );
        return;
      }

      this.snapOnline = true;
      console.log(`[Snap:${this.snapPort}] Snapserver már fut`);
      return;
    }

    try {
      execSync(
        `sudo -u deploy pm2 start ${SNAPSERVER_BIN} --name snapserver-${this.snapPort} ` +
          `-- --config ${this.cfgPath}`,
        { stdio: "pipe" }
      );

      for (let i = 0; i < 10; i++) {
        await sleep(300);

        if (await rpcPing(httpPort(this.snapPort))) {
          this.snapOnline = true;
          console.log(`[Snap:${this.snapPort}] PM2 snapserver elindult`);
          return;
        }
      }

      console.warn(`[Snap:${this.snapPort}] PM2 indítva, de RPC nem válaszol`);
    } catch (e) {
      console.error(`[Snap:${this.snapPort}] PM2 hiba:`, e);
    }
  }

  async isOnline(): Promise<boolean> {
    this.snapOnline = await rpcPing(httpPort(this.snapPort));
    return this.snapOnline;
  }

  // ── Műsorvezérlés ───────────────────────────────────────────────────────

  async enqueue(params: {
    type: SnapJobType;
    source: SnapAudioSource;
    title?: string;
    text?: string;
    deviceIdsToUnmute?: string[];
  }): Promise<string> {
    if (!this.mixer) {
      console.warn(`[Snap:${this.snapPort}] mixer nincs init-elve`);
      return "";
    }

    const job: MixerJob = {
      id: randomUUID(),
      jobType: params.type as MixerJobType,
      source: sourceToMixer(params.source),
      priority: SNAP_PRIORITY[params.type],
      title: params.title,
      text: params.text,
    };

    this.jobs.set(job.id, job);
    this.jobTargets.set(job.id, params.deviceIdsToUnmute);

    await this.prepareClientsForPlayback(params.deviceIdsToUnmute);

    this.mixer.enqueue(job);
    return job.id;
  }

  private async prepareClientsForPlayback(
    deviceIdsToUnmute?: string[]
  ): Promise<void> {
    const port = httpPort(this.snapPort);
    const wanted = new Set(deviceIdsToUnmute ?? []);

    const timeoutMs = 3000;
    const pollMs = 150;
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      try {
        const clients = await rpcListClients(port);

        if (clients.length === 0) {
          await sleep(pollMs);
          continue;
        }

        const connectedIds = new Set(clients.map((c: any) => c.id));

        const allWantedConnected =
          wanted.size === 0 ||
          [...wanted].every((id) => connectedIds.has(id));

        if (!allWantedConnected) {
          const missing = [...wanted].filter((id) => !connectedIds.has(id));

          console.log(
            `[Snap:${this.snapPort}] várakozás célzott kliensekre: ${missing.join(", ")}`
          );

          await sleep(pollMs);
          continue;
        }

        await this.applyTargetingToClients(deviceIdsToUnmute);

        // Rövid stabilizálás, hogy a mute/unmute állapot biztosan átérjen
        // a snapserveren keresztül, mielőtt a hang elindul.
        await sleep(500);
        return;
      } catch {
        await sleep(pollMs);
      }
    }

    console.warn(
      `[Snap:${this.snapPort}] kliens readiness timeout, lejátszás indul így is`
    );

    await this.applyTargetingToClients(deviceIdsToUnmute).catch(() => {});
  }

  private async applyTargetingToClients(
    deviceIdsToUnmute?: string[]
  ): Promise<void> {
    const port = httpPort(this.snapPort);
    const clients = await rpcListClients(port);

    if (clients.length === 0) return;

    // A `rpcSetClientVolume` mindkét paramétert (percent + muted) ki KELL
    // küldje a snap-RPC szabványa miatt – ezért nem írhatjuk csak a muted
    // bitet. A trükk: az adott eszköz user-által-beállított volume-ját
    // (Device.volume, 0..10 skála) használjuk percent-ként (×10 → 0..100).
    // Így a unmute NEM hangosít maxra; csak elveszi a mute flag-et a
    // user-beállította szinten. Ez egyezik a "kliens-volume = állandó"
    // elvével: a snap-server-side RPC volume soha nem írja felül a
    // user-szintet.
    const { prisma } = await import("../../prisma/client");
    const deviceIds  = clients.map((c: any) => String(c.id));
    const devices    = await prisma.device.findMany({
      where:  { tenantId: this.tenantId, id: { in: deviceIds } },
      select: { id: true, volume: true },
    });
    const userPercentByDevice = new Map<string, number>();
    for (const d of devices) {
      const v = typeof d.volume === "number" ? d.volume : 5;
      userPercentByDevice.set(d.id, Math.max(0, Math.min(100, v * 10)));
    }
    const userPercent = (deviceId: string): number =>
      userPercentByDevice.get(deviceId) ?? 50; // unknown device → 50% default

    const wanted = new Set(deviceIdsToUnmute ?? []);

    if (wanted.size === 0) {
      // Nincs explicit szűkítés → minden kliens unmute, saját user-volume-on
      await Promise.allSettled(
        clients.map((c: any) =>
          rpcSetClientVolume(port, c.id, userPercent(c.id), false)
        )
      );

      console.log(`[Snap:${this.snapPort}] minden kliens unmute (user-volume): ${clients.length}`);
      return;
    }

    await Promise.allSettled(
      clients.map((c: any) => {
        const shouldPlay = wanted.has(c.id);
        return rpcSetClientVolume(
          port,
          c.id,
          shouldPlay ? userPercent(c.id) : 0,
          !shouldPlay
        );
      })
    );

    console.log(
      `[Snap:${this.snapPort}] célzás beállítva: ${[...wanted].join(", ")} (user-volume preserved)`
    );
  }

  stopAll(): void {
    this.mixer?.stopAll();
  }

  stopByType(type: SnapJobType): void {
    this.mixer?.stopByType(type as MixerJobType);
  }

  /** Live radio gain forwarding a TenantAudioMixer-be. */
  setRadioGain(gain: number): void {
    this.mixer?.setRadioGain(gain);
  }

  getRadioGain(): number {
    return this.mixer?.getRadioGain() ?? 1.0;
  }

  // ── Eseményekre reagálás ────────────────────────────────────────────────

  private onSourceStart(e: {
    jobId: string;
    jobType: MixerJobType;
    isResume?: boolean;
  }): void {
    const targets = this.jobTargets.get(e.jobId);

    // Forrás-csere: ha volt pending STOP_PLAYBACK broadcast a snap drainből,
    // töröljük – nem áll meg a stream, csak váltunk forrást.
    if (this.stopBroadcastTimer) {
      clearTimeout(this.stopBroadcastTimer);
      this.stopBroadcastTimer = null;
    }

    const job = this.jobs.get(e.jobId);
    if (job) {
      const targetDeviceIds = this.jobTargets.get(e.jobId) ?? null;

      // ── RESUME: fresh STOP + PREPARE+PLAY a klienseknek ──────────────────
      //
      // User-requested architektúra: az "üzenet után stop-ot küldünk a
      // klienseknek, és a play resume-t új lejátszásként indítjuk". Ez
      // tisztább, mert minden resume ugyanolyan PREPARE+PLAY flow-n megy
      // át, mint a friss play, így a kliens-side `_snap_muted` és
      // overlay-state nem ragad meg az előző forráson.
      //
      // Stream esetén ez úgyis stream-újranyitás (ffmpeg reconnect), file
      // esetén a `resumeBytes` mellett az ffmpeg `-ss` szegmentálja a
      // folytatást. Soft fade-in (500ms file, 1000ms stream) lágyan indul.
      if (e.isResume) {
        const url = (job.source as any).url as string | undefined;
        const action: "TTS" | "PLAY_URL" | "BELL" =
          e.jobType === "RADIO" ? "PLAY_URL" : (e.jobType as "TTS" | "BELL");

        import("../../sync/SyncEngine").then(({ SyncEngine }) => {
          // 1. Előző (interrupted) forrásból maradt HUD/lokális mute törlése.
          SyncEngine.broadcastImmediate(this.tenantId, {
            action:    "STOP_PLAYBACK",
            commandId: `${e.jobId}:resume-stop`,
            reason:    "resume",
          });

          // 2. Új lejátszás-ként dispatcheljük (PREPARE + PLAY). 200ms várás
          //    hogy a STOP_PLAYBACK feldolgozása megtörténjen a kliensen
          //    (overlay-clear, mute-reset), mielőtt a friss PREPARE módosít.
          //    Ha a forrás URL hiányzik (pl. BELL file-source), fallback
          //    NOW_PLAYING_INFO-ra.
          setTimeout(() => {
            if (!url) {
              SyncEngine.broadcastImmediate(this.tenantId, {
                action:           "NOW_PLAYING_INFO",
                commandId:        `${e.jobId}:resume-info`,
                title:            job.title ?? "",
                text:             job.text,
                jobType:          e.jobType,
                sourceType:       job.source.type,
                targetDeviceIds,
              });
              return;
            }
            SyncEngine.dispatchSync({
              tenantId:        this.tenantId,
              commandId:       `${e.jobId}:resume`,
              action,
              url,
              text:            job.text,
              title:           job.title,
              targetDeviceIds: targetDeviceIds ?? undefined,
              snapcastActive:  this.snapOnline,
            }).catch(err =>
              console.error(`[Snap:${this.snapPort}] resume dispatchSync hiba:`, err)
            );
          }, 200);
        }).catch(() => {});
      } else {
        // ── NEM resume: NOW_PLAYING_INFO HUD-frissítés ─────────────────────
        //
        // Friss forrás-start: a route-szintű dispatchSync már elindított egy
        // PREPARE+PLAY-t, ez csak HUD-meta (forrás-csere a snap-pipe-on).
        //
        // Több mező megy ki:
        //   • title           – rövid kontextus (radio név, "Csengetés HH:MM",
        //                       TTS első ~200 karaktere ékezetesen)
        //   • text            – TTS-nél a TELJES felolvasandó szöveg
        //   • targetDeviceIds – az aktuális forrás-célzás (null → ALL)
        import("../../sync/SyncEngine").then(({ SyncEngine }) => {
          SyncEngine.broadcastImmediate(this.tenantId, {
            action:           "NOW_PLAYING_INFO",
            commandId:        `${e.jobId}:start`,
            title:            job.title ?? "",
            text:             job.text,
            jobType:          e.jobType,
            sourceType:       job.source.type,
            targetDeviceIds,
          });
        }).catch(() => {});
      }
    }

    // Nem unmute-olunk vakon mindenkit.
    // Ugyanazt a célzást alkalmazzuk újra néhány késleltetett pillanatban,
    // hogy a késve megjelenő kliensek se maradjanak rossz állapotban.
    for (const delay of [0, 500, 1500]) {
      setTimeout(() => {
        this.applyTargetingToClients(targets).catch(() => {
          // snapserver esetleg átmenetileg nem válaszol
        });
      }, delay);
    }
  }

  private onSourceEnd(e: {
    jobId: string;
    jobType: MixerJobType;
    reason: SourceEndReason;
    bytesWritten: number;
  }): void {
    // CSAK akkor töröljük a `jobs` és `jobTargets` map-eket, ha a job
    // TÉNYLEGESEN véget ért – "interrupted" (pl. magasabb prio audio
    // megszakította fade-outtal) esetén a job a pausedStack-en él tovább,
    // és resume-on az EREDETI targeting (deviceIdsToUnmute) kell, hogy
    // a snap server megfelelően mute-olja a nem-célzott eszközöket.
    //
    // Korábban itt minden reason-on töröltünk → resume után az `onSourceStart`
    // `jobTargets.get(jobId) === undefined` → applyTargetingToClients(undefined)
    // ami MINDEN klienst unmute-elt – ezért szólalt meg a netrádió a
    // nem-célzott eszközökön (pl. ESP-n) a resume-kor.
    if (e.reason !== "interrupted") {
      this.jobs.delete(e.jobId);
      this.jobTargets.delete(e.jobId);
    }

    // Késleltetett STOP_PLAYBACK broadcast: 3 sec késéssel megy ki, hogy a
    // kliens snap puffere lejátsza a hang utolsó pillanatait MIELŐTT a
    // Linux/Windows app.py snap-restart-ot indít. Ha közben új forrás indul
    // (source:start), a timer törlődik – nem áll le a stream, csak váltás.
    // Interrupted esetén is megy a setTimeout, de az onSourceStart úgyis
    // törli, ha a paused job pár száz ms múlva újra-aktiválódik.
    if (this.stopBroadcastTimer) clearTimeout(this.stopBroadcastTimer);
    this.stopBroadcastTimer = setTimeout(() => {
      this.stopBroadcastTimer = null;
      // Védő ellenőrzés: ha közben elindult egy új forrás VAGY paused-stackből
      // resume vár, ne küldjünk stopot. A `paused.length > 0` az pausedStack-
      // beli radio resume-okat fedi – korábban csak current/pending volt
      // figyelve, ami timing-race-be került a 1500ms STOP timer és a
      // 500+1000=1500ms resume között.
      const m = this.mixer?.getStatus();
      if (m && (m.current || m.pending || (m.paused && m.paused.length > 0))) return;

      import("../../sync/SyncEngine").then(({ SyncEngine }) => {
        SyncEngine.broadcastImmediate(this.tenantId, {
          action:    "STOP_PLAYBACK",
          commandId: `${e.jobId}:drained`,
          jobType:   e.jobType,
          reason:    e.reason,
        });
      }).catch(err => console.error(`[Snap:${this.tenantId}] STOP broadcast hiba:`, err));
    }, TenantSnapEngine.STOP_BROADCAST_DELAY_MS);
  }

  getStatus() {
    const m: MixerStatus | null = this.mixer?.getStatus() ?? null;

    let activeJobId: string | null = null;

    if (m?.current) {
      const wanted = m.current.jobType;

      for (const [id, job] of this.jobs.entries()) {
        if (job.jobType === wanted) {
          activeJobId = id;
          break;
        }
      }
    }

    return {
      tenantId: this.tenantId,
      snapPort: this.snapPort,
      snapOnline: this.snapOnline,
      mixer: m,
      activeJobId,
    };
  }

  /**
   * Tenant teljes shutdown: mixer leállítása, pm2 snapserver stop+delete,
   * config + FIFO unlink. Tenant hard-delete-ekor hívandó.
   *
   * Hibatűrő: minden részlépést try/catch-be tesszük, a logot megőrizzük, de
   * a teljes folyamatot nem dobjuk meg, mert a Tenant DB-cascade-nek le KELL
   * futnia, akkor is, ha a snapserver külső erőforrásait nem sikerült törölni
   * (pl. PM2 nem fut, vagy a config file már nem létezik).
   */
  async shutdown(): Promise<void> {
    console.log(`[Snap:${this.snapPort}] shutdown indul (tenant=${this.tenantId})`);

    // 1. Mixer: stopAll → ffmpeg kill, queue/pausedStack clear.
    try {
      this.mixer?.stopAll();
    } catch (e) {
      console.error(`[Snap:${this.snapPort}] mixer stopAll hiba:`, e);
    }

    // 2. PM2 process: stop + delete. A "delete" után a process már nem
    //    indul újra automatikusan a pm2 resurrect-en.
    try {
      execSync(`sudo -u deploy pm2 delete snapserver-${this.snapPort}`, {
        stdio: "pipe",
      });
      console.log(`[Snap:${this.snapPort}] PM2 process törölve`);
    } catch (e) {
      // Nem létező process: pm2 hibakódot ad, ezt elnyeljük.
      console.warn(`[Snap:${this.snapPort}] PM2 delete (vagy nem futott): ${(e as Error).message?.split("\n")[0] ?? e}`);
    }

    // 3. Config fájl és FIFO unlink.
    for (const f of [this.cfgPath, this.fifoPath]) {
      try {
        if (existsSync(f)) {
          unlinkSync(f);
          console.log(`[Snap:${this.snapPort}] törölve: ${f}`);
        }
      } catch (e) {
        console.error(`[Snap:${this.snapPort}] unlink hiba (${f}):`, e);
      }
    }

    this.snapOnline = false;
    this.inited = false;
  }
}

function sourceToMixer(s: SnapAudioSource): MixerSource {
  if (s.type === "file")   return { type: "file",   path: s.path, volume: s.volume };
  if (s.type === "url")    return { type: "url",    url:  s.url,  volume: s.volume };
  if (s.type === "stream") return { type: "stream", url:  s.url,  volume: s.volume };

  throw new Error(`Ismeretlen SnapAudioSource: ${JSON.stringify(s)}`);
}

// ── Multi-tenant facade ─────────────────────────────────────────────────────

class SnapcastServiceClass {
  private engines = new Map<string, TenantSnapEngine>();

  private async getSnapPort(tenantId: string): Promise<number | null> {
    try {
      const { prisma } = await import("../../prisma/client");

      const t = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { snapPort: true },
      });

      return t?.snapPort ?? null;
    } catch {
      return null;
    }
  }

  private async getEngine(
    tenantId: string
  ): Promise<TenantSnapEngine | null> {
    if (this.engines.has(tenantId)) {
      return this.engines.get(tenantId)!;
    }

    const port = await this.getSnapPort(tenantId);

    if (!port) {
      console.warn(`[Snapcast] Nincs snapPort: ${tenantId}`);
      return null;
    }

    const eng = new TenantSnapEngine(tenantId, port);
    this.engines.set(tenantId, eng);

    await eng.init();

    return eng;
  }

  /**
   * Új job a tenant snap streamjére.
   *
   * Ha deviceIdsToUnmute meg van adva, csak ezek az eszközök szólnak.
   * Ha nincs megadva, minden csatlakozott kliens szól.
   */
  async play(params: {
    type: SnapJobType;
    source: SnapAudioSource;
    tenantId: string;
    title?: string;
    text?: string;
    deviceIdsToUnmute?: string[];
    persistent?: boolean;
  }): Promise<string> {
    const eng = await this.getEngine(params.tenantId);
    if (!eng) return "";

    return await eng.enqueue({
      type: params.type,
      source: params.source,
      title: params.title,
      text: params.text,
      deviceIdsToUnmute: params.deviceIdsToUnmute,
    });
  }

  async stop(tenantId: string): Promise<void> {
    (await this.getEngine(tenantId))?.stopAll();
  }

  async stopRadio(tenantId: string): Promise<void> {
    (await this.getEngine(tenantId))?.stopByType("RADIO");
  }

  async isSnapserverOnline(tenantId: string): Promise<boolean> {
    const eng = await this.getEngine(tenantId);
    return eng ? eng.isOnline() : false;
  }

  getStatus(tenantId: string) {
    return this.engines.get(tenantId)?.getStatus() ?? null;
  }

  getAllStatus() {
    return [...this.engines.values()].map((e) => e.getStatus());
  }

  /**
   * Live rádió hangerő beállítása sliderről (0..10 skála). A mapping
   * logaritmikus, decibel-egyenletes:
   *   • slider = 10 → 0 dB    (gain = 1.0,   max)
   *   • slider = 1  → -36 dB  (gain ≈ 0.016)
   *   • slider = 0  → mute    (gain = 0)
   * 9 lépés között egyenletes -4 dB osztás.
   *
   * A változás közvetlenül a következő PCM chunk-ra hat, így stream közben
   * is állítható. A snapserver puffer (~1 sec) miatt a klienseken kb.
   * 1 másodperc késéssel hallható.
   *
   * Csak RADIO típusú forrásokra hat – a BELL/TTS bemondások saját
   * max-loud láncon mennek.
   */
  async setRadioVolume(tenantId: string, slider: number): Promise<void> {
    const eng = await this.getEngine(tenantId);
    if (!eng) return;
    const gain = sliderToLinearGain(slider);
    eng.setRadioGain(gain);
  }

  /**
   * Tenant teljes snapserver-cleanup. Hard-delete-kor hívandó MIELŐTT a DB
   * cascade lefutna (mert a snapPort-ot a tenant rekordból olvassuk ki).
   *
   * Két útvonalat kezelünk:
   *  1. Ha a tenant-engine már be van töltve (`engines` Map), arra hívunk
   *     shutdown-ot – ez a leggyakoribb (folyamatos snapserver-rel).
   *  2. Ha nincs engine (sosem volt play() hívás), de a snapPort már ki van
   *     osztva, akkor egy ad-hoc engine-példányt csinálunk csak a cleanup-hoz
   *     (PM2 stop + config/FIFO unlink). A `init()` NEM fut, csak `shutdown()`.
   */
  async dispose(tenantId: string): Promise<void> {
    const loaded = this.engines.get(tenantId);
    if (loaded) {
      await loaded.shutdown();
      this.engines.delete(tenantId);
      return;
    }

    const port = await this.getSnapPort(tenantId);
    if (!port) {
      // Nincs port → soha nem futott snapserver, nincs mit takarítani.
      return;
    }

    // Ad-hoc engine: csak shutdown-ra, init() nélkül. Megpróbáljuk leállítani
    // a (lehetséges) árva PM2 processt és törölni a config + FIFO fájlokat.
    const ad = new TenantSnapEngine(tenantId, port);
    await ad.shutdown();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const SnapcastService = new SnapcastServiceClass();