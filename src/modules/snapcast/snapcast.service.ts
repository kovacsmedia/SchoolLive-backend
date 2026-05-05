// src/modules/snapcast/snapcast.service.ts
//
// Multi-tenant snapcast facade. Tenantonként:
//   • saját snapPort-ú snapserver (PM2 alatt indítva, ha kell)
//   • saját FIFO (/opt/schoollive/snapcast/fifos/snapfifo-<port>)
//   • saját TenantAudioMixer, ami a FIFO-ba pumpál folyamatos PCM-et
//   • saját JSON-RPC kapcsolat a per-kliens volume/mute vezérléshez
//
// Az ffmpeg-alapú mixelést és a fade/resume logikát a TenantAudioMixer csinálja.
// Ez a fájl már csak a snapserver életciklusát + a hozzá tartozó RPC műveleteket
// menedzseli, és proxy-ként továbbítja a play()/stop() hívásokat.

import { execSync }                                           from "child_process";
import { existsSync, mkdirSync, writeFileSync }               from "fs";
import {
  TenantAudioMixer,
  MixerJob, MixerJobType, MixerSource, MixerStatus,
  SourceEndReason,
} from "./audio-mixer";
import {
  SnapJobType,
  SnapAudioSource,
  SNAP_PRIORITY,
} from "./snapcast.types";
import {
  rpcPing, rpcUnmuteAll, rpcListClients,
} from "./snapcast-rpc";
import { randomUUID }                                         from "crypto";

const SNAPSERVER_BIN = process.env.SNAPSERVER_BIN ?? "/usr/bin/snapserver";
const SNAP_BASE_DIR  = "/opt/schoollive/snapcast";
const FIFO_DIR       = `${SNAP_BASE_DIR}/fifos`;
const CONFIG_DIR     = `${SNAP_BASE_DIR}/configs`;
const SAMPLE_RATE    = 48000;
const CHANNELS       = 2;

const httpPort = (snapPort: number) => snapPort + 1000;

// ── Per-tenant engine ───────────────────────────────────────────────────────
class TenantSnapEngine {
  readonly tenantId: string;
  readonly snapPort: number;
  readonly fifoPath: string;
  readonly cfgPath:  string;

  private mixer:     TenantAudioMixer | null = null;
  private snapOnline = false;
  private inited     = false;
  private jobs       = new Map<string, MixerJob>();   // id → job (státuszhoz)

  constructor(tenantId: string, snapPort: number) {
    this.tenantId = tenantId;
    this.snapPort = snapPort;
    this.fifoPath = `${FIFO_DIR}/snapfifo-${snapPort}`;
    this.cfgPath  = `${CONFIG_DIR}/snapserver-${snapPort}.conf`;
  }

  async init(): Promise<void> {
    if (this.inited) return;
    mkdirSync(FIFO_DIR,   { recursive: true });
    mkdirSync(CONFIG_DIR, { recursive: true });
    this.ensureFifo();
    this.writeConfig();
    await this.ensureSnapserver();

    // Mixer indítása + folyamatos stream a FIFO-ba
    this.mixer = new TenantAudioMixer(this.tenantId, this.fifoPath);
    this.mixer.on("source:start", (e: any) => this.onSourceStart(e));
    this.mixer.on("source:end",   (e: any) => this.onSourceEnd(e));
    this.mixer.start();

    // Korábbi RPC mute állapotok törlése (az előző session muteAllClients()-ei
    // tartósan némíthatják a snap klienseket, ha nem volt közbülső unmute).
    void rpcUnmuteAll(httpPort(this.snapPort)).then(n => {
      if (n > 0) console.log(`[Snap:${this.snapPort}] 🔊 startup unmute: ${n} kliens`);
    }).catch(() => {});

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
    const cfg = [
      `[server]`, `threads = -1`, ``,
      `[stream]`,
      `port = ${this.snapPort}`,
      `source = pipe://${this.fifoPath}?name=SL-${this.snapPort}&sampleformat=${SAMPLE_RATE}:16:${CHANNELS}&codec=pcm&chunk_ms=20`,
      ``, `[http]`, `enabled = true`, `port = ${httpPort(this.snapPort)}`,
      ``, `[tcp]`, `enabled = false`,
    ].join("\n");
    writeFileSync(this.cfgPath, cfg);
  }

  private async ensureSnapserver(): Promise<void> {
    if (await rpcPing(httpPort(this.snapPort))) {
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
      // Várjunk amíg felpörög
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300));
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

  enqueue(params: {
    type:     SnapJobType;
    source:   SnapAudioSource;
    title?:   string;
    text?:    string;
    deviceIdsToUnmute?: string[];     // fordított targeting: ezeket emeljük 100-ra
  }): string {
    if (!this.mixer) {
      console.warn(`[Snap:${this.snapPort}] mixer nincs init-elve`);
      return "";
    }

    const job: MixerJob = {
      id:       randomUUID(),
      jobType:  params.type as MixerJobType,
      source:   sourceToMixer(params.source),
      priority: SNAP_PRIORITY[params.type],
      title:    params.title,
      text:     params.text,
    };
    this.jobs.set(job.id, job);

    // Minden lejátszás előtt unmute-oljuk az összes snap klienst.
    // Az Android TARGET_BUFFER_MS=1000ms puffert tart, ez alatt az
    // RPC call (~100ms) biztosan lefut → a kliensek hallani fogják a hangot.
    //
    // Miért kell ez? A snap server tárolja a per-kliens beállításokat
    // (muted=true a korábbi session-ökből). Ha startup-kor nem volt
    // csatlakozva a kliens, az rpcUnmuteAll() ott 0-t talált, és a
    // tárolt muted=true megmaradt. Ez a hívás fix: minden hangindítás
    // előtt biztosan tiszta állapotot csinál.
    //
    // TODO: per-device targeting (rpcSetUnmutedSet) ha az Android snap
    // HELLO ID-ja = device.id lesz (jelenleg MAC-cím alapú az ID).
    void rpcUnmuteAll(httpPort(this.snapPort)).then(n => {
      if (n > 0) console.log(`[Snap:${this.snapPort}] 🔊 unmute all: ${n} kliens`);
    }).catch(() => {});

    this.mixer.enqueue(job);
    return job.id;
  }

  stopAll(): void {
    this.mixer?.stopAll();
  }

  stopByType(type: SnapJobType): void {
    this.mixer?.stopByType(type as MixerJobType);
    // Ha volt valami, ami most ér véget, a source:end újranémít.
  }

  // ── Eseményekre reagálás ────────────────────────────────────────────────

  private onSourceStart(_e: { jobId: string; jobType: MixerJobType }): void {
    // Diagnosztika + ismételt unmute: a snap kliens néha néhány 100ms-cel
    // KÉSŐBB csatlakozik, mint ahogy az enqueue-kori rpcUnmuteAll fut.
    // Megoldjuk: 0ms, 500ms, 1500ms időpontokban ellenőrizzük és unmute-oljuk.
    const port = httpPort(this.snapPort);
    for (const delay of [0, 500, 1500]) {
      setTimeout(() => {
        // A console.log az async hívás ELŐTT: mindenképp lefut,
        // így látjuk hogy a callback egyáltalán meg lett-e hívva.
        console.log(`[Snap:${this.snapPort}] onStart @${delay}ms – RPC hívás...`);
        rpcListClients(port)
          .then(clients => {
            console.log(`[Snap:${this.snapPort}] onStart @${delay}ms: ${clients.length} snap kliens`);
            if (clients.length > 0) {
              return rpcUnmuteAll(port).then(n => {
                console.log(`[Snap:${this.snapPort}] 🔊 unmute @${delay}ms: ${n} kliens`);
              });
            }
          })
          .catch(err => {
            console.log(`[Snap:${this.snapPort}] onStart @${delay}ms: RPC hiba – ${err.message}`);
          });
      }, delay);
    }
  }

  private onSourceEnd(e: { jobId: string; jobType: MixerJobType; reason: SourceEndReason; bytesEmitted: number }): void {
    this.jobs.delete(e.jobId);
    // Snap RPC per-kliens muting egyelőre kikapcsolva (lásd TODO fentebb).
  }

  getStatus() {
    const m: MixerStatus | null = this.mixer?.getStatus() ?? null;
    let activeJobId: string | null = null;
    if (m?.current) {
      const wanted = m.current.jobType;
      for (const [id, job] of this.jobs.entries()) {
        if (job.jobType === wanted) { activeJobId = id; break; }
      }
    }
    return {
      tenantId:   this.tenantId,
      snapPort:   this.snapPort,
      snapOnline: this.snapOnline,
      mixer:      m,
      activeJobId,
    };
  }
}

function sourceToMixer(s: SnapAudioSource): MixerSource {
  if (s.type === "file")   return { type: "file",   path: s.path };
  if (s.type === "url")    return { type: "url",    url:  s.url  };
  if (s.type === "stream") return { type: "stream", url:  s.url  };
  throw new Error(`Ismeretlen SnapAudioSource: ${JSON.stringify(s)}`);
}

// ── Multi-tenant facade ─────────────────────────────────────────────────────
class SnapcastServiceClass {
  private engines = new Map<string, TenantSnapEngine>();

  private async getSnapPort(tenantId: string): Promise<number | null> {
    try {
      const { prisma } = await import("../../prisma/client");
      const t = await prisma.tenant.findUnique({
        where:  { id: tenantId },
        select: { snapPort: true },
      });
      return t?.snapPort ?? null;
    } catch { return null; }
  }

  private async getEngine(tenantId: string): Promise<TenantSnapEngine | null> {
    if (this.engines.has(tenantId)) return this.engines.get(tenantId)!;
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

  /** Új job a tenant snap streamjére. A `deviceIdsToUnmute` listában szereplő
   *  eszközök snap-kliensei a lejátszás idejére 100%-ra állítódnak; a többi
   *  marad némítva (default). */
  async play(params: {
    type:              SnapJobType;
    source:            SnapAudioSource;
    tenantId:          string;
    title?:            string;
    text?:             string;
    deviceIdsToUnmute?: string[];
    persistent?:       boolean;            // legacy: kompatibilitás miatt
  }): Promise<string> {
    const eng = await this.getEngine(params.tenantId);
    if (!eng) return "";
    return eng.enqueue({
      type:               params.type,
      source:             params.source,
      title:              params.title,
      text:               params.text,
      deviceIdsToUnmute:  params.deviceIdsToUnmute,
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
    return [...this.engines.values()].map(e => e.getStatus());
  }
}

export const SnapcastService = new SnapcastServiceClass();
