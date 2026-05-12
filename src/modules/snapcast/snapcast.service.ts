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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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
    //
    // Buffer + dryout megfontolások:
    //
    // 1) [server] buffer = 1500
    //    A snapserver a client_settings üzenetben elküldi a klienseknek a
    //    jitter buffer méretét (buf_ms). Az ESP klienseink alapja 1000 ms
    //    volt, ami szoros idle→playing átmenetnél kevésnek bizonyult: a
    //    snapserver 376 ms-os resync-jét nem tudta lenyelni glitch nélkül,
    //    így ~500 ms-os megakadás keletkezett a TTS elején.
    //    1500 ms-ra emelve a kliens 50%-kal több toleranciát kap, a kezdeti
    //    átmenetek nem érik el a buffer alját.
    //
    // 2) dryout_ms (pipe:// source paraméter)
    //    A snapcast pipe:// source 120 ms-ig vár adatra, utána idle-be megy.
    //    A 120 ms threshold hardkódolt a snapserver-ben (nem dryout_ms-szel
    //    szabályozható). A dryout_ms a "csendes átmeneti buffer" méretét
    //    állítja a state-váltás után. Túl nagy érték (5000) NEM oldotta meg
    //    az idle→playing resync-et, ezért visszatérünk a default 2000-re
    //    (a paramétert explicit ki sem írjuk).
    const cfg = [
      `[server]`,
      `threads = -1`,
      `buffer = 1500`,
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

    const wanted = new Set(deviceIdsToUnmute ?? []);

    if (wanted.size === 0) {
      await Promise.allSettled(
        clients.map((c: any) => rpcSetClientVolume(port, c.id, 100, false))
      );

      console.log(`[Snap:${this.snapPort}] minden kliens unmute: ${clients.length}`);
      return;
    }

    await Promise.allSettled(
      clients.map((c: any) => {
        const shouldPlay = wanted.has(c.id);
        return rpcSetClientVolume(
          port,
          c.id,
          shouldPlay ? 100 : 0,
          !shouldPlay
        );
      })
    );

    console.log(
      `[Snap:${this.snapPort}] célzás beállítva: ${[...wanted].join(", ")}`
    );
  }

  stopAll(): void {
    this.mixer?.stopAll();
  }

  stopByType(type: SnapJobType): void {
    this.mixer?.stopByType(type as MixerJobType);
  }

  // ── Eseményekre reagálás ────────────────────────────────────────────────

  private onSourceStart(e: { jobId: string; jobType: MixerJobType }): void {
    const targets = this.jobTargets.get(e.jobId);

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
    this.jobs.delete(e.jobId);
    this.jobTargets.delete(e.jobId);
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
}

function sourceToMixer(s: SnapAudioSource): MixerSource {
  if (s.type === "file") return { type: "file", path: s.path };
  if (s.type === "url") return { type: "url", url: s.url };
  if (s.type === "stream") return { type: "stream", url: s.url };

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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const SnapcastService = new SnapcastServiceClass();