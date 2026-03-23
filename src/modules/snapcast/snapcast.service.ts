// src/modules/snapcast/snapcast.service.ts
// Multi-tenant, per-tenant FIFO + snapserver, WAV stream, prioritásos queue

import { spawn, ChildProcess, execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { EventEmitter }  from "events";
import { randomUUID }    from "crypto";
import {
  SnapJob, SnapJobType, SnapStatus,
  SnapAudioSource, SNAP_PRIORITY,
} from "./snapcast.types";

const FFMPEG_BIN     = process.env.FFMPEG_BIN     ?? "/usr/bin/ffmpeg";
const SNAPSERVER_BIN = process.env.SNAPSERVER_BIN ?? "/usr/bin/snapserver";
const SNAP_BASE_DIR  = "/opt/schoollive/snapcast";
const FIFO_DIR       = `${SNAP_BASE_DIR}/fifos`;
const CONFIG_DIR     = `${SNAP_BASE_DIR}/configs`;
const SAMPLE_RATE    = 48000;
const CHANNELS       = 2;
const SILENCE_PAD_MS = 300;
const httpPort       = (p: number) => p + 1000;

interface PausedJob { job: SnapJob; elapsedSec: number; pausedAt: Date; }

// ── Per-tenant engine ─────────────────────────────────────────────────────────
class TenantSnapEngine extends EventEmitter {
  readonly tenantId:  string;
  readonly snapPort:  number;
  readonly fifoPath:  string;
  readonly cfgPath:   string;

  private queue:        SnapJob[]   = [];
  private currentJob:   SnapJob | null = null;
  private pausedStack:  PausedJob[] = [];
  private ffmpeg:       ChildProcess | null = null;
  private _running      = false;
  private jobStartedAt: Date | null = null;
  private _snapOnline   = false;

  constructor(tenantId: string, snapPort: number) {
    super();
    this.tenantId = tenantId;
    this.snapPort = snapPort;
    this.fifoPath = `${FIFO_DIR}/snapfifo-${snapPort}`;
    this.cfgPath  = `${CONFIG_DIR}/snapserver-${snapPort}.conf`;
  }

  async init(): Promise<void> {
    mkdirSync(FIFO_DIR,   { recursive: true });
    mkdirSync(CONFIG_DIR, { recursive: true });
    this.ensureFifo();
    this.writeConfig();
    await this.ensureSnapserver();
  }

  private ensureFifo(): void {
    if (!existsSync(this.fifoPath)) {
      try {
        execSync(`mkfifo ${this.fifoPath} && chmod 666 ${this.fifoPath}`);
        console.log(`[Snap:${this.snapPort}] FIFO: ${this.fifoPath}`);
      } catch (e) { console.error(`[Snap:${this.snapPort}] FIFO hiba:`, e); }
    }
  }

  private writeConfig(): void {
    const cfg = [
      `[server]`, `threads = -1`, ``,
      `[stream]`,
      `port = ${this.snapPort}`,   // ← EZ HIÁNYZOTT
      `source = pipe://${this.fifoPath}?name=SL-${this.snapPort}&sampleformat=${SAMPLE_RATE}:16:${CHANNELS}&codec=pcm&chunk_ms=20`,
      ``, `[http]`, `enabled = true`, `port = ${httpPort(this.snapPort)}`,
      ``, `[tcp]`, `enabled = false`,
    ].join("\n");
    writeFileSync(this.cfgPath, cfg);
  }

  private async ensureSnapserver(): Promise<void> {
    try {
      const r = await fetch(`http://localhost:${httpPort(this.snapPort)}/jsonrpc`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "Server.GetStatus" }),
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) { this._snapOnline = true; return; }
    } catch {}
    try {
      execSync(
        `sudo -u deploy pm2 start ${SNAPSERVER_BIN} --name snapserver-${this.snapPort} ` +
        `-- --config ${this.cfgPath}`,
        { stdio: "pipe" }
      );
      await new Promise(r => setTimeout(r, 2000));
      this._snapOnline = true;
      console.log(`[Snap:${this.snapPort}] PM2 snapserver elindítva`);
    } catch (e) { console.error(`[Snap:${this.snapPort}] PM2 hiba:`, e); }
  }

  async isOnline(): Promise<boolean> {
    try {
      const r = await fetch(`http://localhost:${httpPort(this.snapPort)}/jsonrpc`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "Server.GetStatus" }),
        signal: AbortSignal.timeout(2000),
      });
      this._snapOnline = r.ok;
    } catch { this._snapOnline = false; }
    return this._snapOnline;
  }

  play(params: {
    type:        SnapJobType;
    source:      SnapAudioSource;
    title?:      string;
    text?:       string;
    persistent?: boolean;
  }): string {
    const job: SnapJob = {
      id: randomUUID(), tenantId: this.tenantId,
      type: params.type, source: params.source,
      title: params.title, text: params.text,
      priority: SNAP_PRIORITY[params.type],
      queuedAt: new Date(), persistent: params.persistent ?? false,
    };
    console.log(`[Snap:${this.snapPort}] ➕ ${job.type}`);
    if (!this.currentJob && !this.queue.length && !this.pausedStack.length) {
      this.startJob(job); return job.id;
    }
    if (this.currentJob && job.priority < this.currentJob.priority) {
      this.pauseCurrent(); this.queue.unshift(job); return job.id;
    }
    this.enqueue(job); return job.id;
  }

  stop(): void { this.queue = []; this.pausedStack = []; this.killCurrent(); }
  stopRadio(): void {
    this.queue       = this.queue.filter(j => j.type !== "RADIO");
    this.pausedStack = this.pausedStack.filter(p => p.job.type !== "RADIO");
    if (this.currentJob?.type === "RADIO") this.killCurrent();
  }

  private enqueue(job: SnapJob): void {
    if (job.type === "RADIO") {
      const qi = this.queue.findIndex(j => j.type === "RADIO");
      if (qi !== -1) this.queue.splice(qi, 1, job); else this.queue.push(job);
      const pi = this.pausedStack.findIndex(p => p.job.type === "RADIO");
      if (pi !== -1) this.pausedStack[pi] = { job, elapsedSec: 0, pausedAt: new Date() };
    } else {
      const i = this.queue.findIndex(j => j.priority > job.priority);
      if (i === -1) this.queue.push(job); else this.queue.splice(i, 0, job);
    }
  }

  private pauseCurrent(): void {
    if (!this.currentJob || !this.jobStartedAt) return;
    const elapsedSec = (Date.now() - this.jobStartedAt.getTime()) / 1000;
    this.pausedStack.push({ job: this.currentJob,
      elapsedSec: Math.max(0, elapsedSec - SILENCE_PAD_MS / 1000), pausedAt: new Date() });
    this.killCurrent();
  }

  private resumeFromStack(): void {
    if (!this.pausedStack.length) return;
    const p = this.pausedStack.pop()!;
    this.startJob({ ...p.job, source: this.applySeek(p.job.source, p.elapsedSec) });
  }

  private applySeek(src: SnapAudioSource, s: number): SnapAudioSource {
    if (src.type === "stream") return src;
    return { ...src, _seekSec: s } as any;
  }

  private processQueue(): void {
    if (this.currentJob) return;
    if (this.pausedStack.length) {
      const top = this.pausedStack[this.pausedStack.length - 1];
      const nxt = this.queue[0];
      if (!nxt || nxt.priority >= top.job.priority) {
        setTimeout(() => this.resumeFromStack(), SILENCE_PAD_MS); return;
      }
    }
    if (!this.queue.length) return;
    const job = this.queue.shift()!;
    setTimeout(() => this.startJob(job), SILENCE_PAD_MS);
  }

  private startJob(job: SnapJob): void {
    if (!existsSync(this.fifoPath)) { this.ensureFifo(); this.processQueue(); return; }
    this.currentJob = job; this.jobStartedAt = new Date(); this._running = true;
    console.log(`[Snap:${this.snapPort}] ▶ ${job.type} | ${this.desc(job.source)}`);

    const args = this.buildArgs(job.source);
    const cmd  = `${FFMPEG_BIN} ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} > ${this.fifoPath}`;
    const proc = spawn("/bin/bash", ["-c", cmd], { stdio: ["ignore","ignore","pipe"] });
    this.ffmpeg = proc;

    proc.stderr?.on("data", (d: Buffer) => {
      const l = d.toString().trim();
      if (l.includes("Error") || l.includes("error") || l.includes("Invalid"))
        console.error(`[Snap:${this.snapPort}/ffmpeg] ${l}`);
    });
    proc.on("close", (code, signal) => {
      const was = this.currentJob;
      this.ffmpeg = null; this.currentJob = null; this.jobStartedAt = null; this._running = false;
      if (!was) return;
      const reason = signal ? "interrupted" : code === 0 ? "done" : "error";
      console.log(`[Snap:${this.snapPort}] ⏹ ${reason}: ${was.type}`);
      if (was.persistent && was.type === "RADIO" && reason === "error") {
        setTimeout(() => { if (!this.currentJob) this.startJob(was); }, 3000); return;
      }
      this.processQueue();
    });
    proc.on("error", (err) => {
      console.error(`[Snap:${this.snapPort}] spawn hiba:`, err);
      this.ffmpeg = null; this.currentJob = null; this.jobStartedAt = null; this._running = false;
      this.processQueue();
    });
  }

  private killCurrent(): void {
    if (this.ffmpeg) this.ffmpeg.kill("SIGTERM");
    else { this.currentJob = null; this.jobStartedAt = null; this._running = false; }
  }

  private buildArgs(src: SnapAudioSource & { _seekSec?: number }): string[] {
    const ss  = (src as any)._seekSec as number | undefined;
    const sk  = ss && ss > 0.5 ? ["-ss", ss.toFixed(3)] : [];
    const out = ["-f","s16le","-ar",String(SAMPLE_RATE),"-ac",String(CHANNELS),"-","-y"];
    if (src.type === "file")
      return ["-re", ...sk, "-i", src.path, "-vn", ...out];
    if (src.type === "url")
      return ["-re","-reconnect","1","-reconnect_at_eof","1","-reconnect_streamed","1",...sk,"-i",src.url,"-vn",...out];
    if (src.type === "stream")
      return ["-re","-reconnect","1","-reconnect_at_eof","1","-reconnect_streamed","1",
              "-reconnect_delay_max","5","-i",src.url,"-vn","-bufsize","8192k",...out];
    throw new Error(`Ismeretlen source: ${(src as any).type}`);
  }

  private desc(src: SnapAudioSource & { _seekSec?: number }): string {
    const sk = (src as any)._seekSec ? ` @${((src as any)._seekSec as number).toFixed(1)}s` : "";
    if (src.type === "file")   return `file:${src.path}${sk}`;
    if (src.type === "url")    return `url:${src.url}${sk}`;
    if (src.type === "stream") return `stream:${src.url}`;
    return "unknown";
  }

  getStatus() {
    return { tenantId: this.tenantId, snapPort: this.snapPort, running: this._running,
             snapOnline: this._snapOnline, currentJob: this.currentJob, queueLength: this.queue.length };
  }
}

// ── Multi-tenant facade ───────────────────────────────────────────────────────
class SnapcastServiceClass {
  private engines = new Map<string, TenantSnapEngine>();

  private async getSnapPort(tenantId: string): Promise<number | null> {
    try {
      const { prisma } = await import("../../prisma/client");
      const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { snapPort: true } });
      return t?.snapPort ?? null;
    } catch { return null; }
  }

  private async getEngine(tenantId: string): Promise<TenantSnapEngine | null> {
    if (this.engines.has(tenantId)) return this.engines.get(tenantId)!;
    const port = await this.getSnapPort(tenantId);
    if (!port) { console.warn(`[Snapcast] Nincs snapPort: ${tenantId}`); return null; }
    const eng = new TenantSnapEngine(tenantId, port);
    this.engines.set(tenantId, eng);
    await eng.init();
    return eng;
  }

  async play(params: {
    type: SnapJobType; source: SnapAudioSource; tenantId: string;
    title?: string; text?: string; persistent?: boolean;
  }): Promise<string> {
    const eng = await this.getEngine(params.tenantId);
    if (!eng) return "";
    return eng.play(params);
  }

  async stop(tenantId: string): Promise<void> {
    (await this.getEngine(tenantId))?.stop();
  }

  async stopRadio(tenantId: string): Promise<void> {
    (await this.getEngine(tenantId))?.stopRadio();
  }

  async isSnapserverOnline(tenantId: string): Promise<boolean> {
    const eng = await this.getEngine(tenantId);
    return eng ? eng.isOnline() : false;
  }

  getStatus(tenantId: string) { return this.engines.get(tenantId)?.getStatus() ?? null; }
  getAllStatus()               { return [...this.engines.values()].map(e => e.getStatus()); }
}

export const SnapcastService = new SnapcastServiceClass();