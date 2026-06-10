// src/modules/snapcast/snap-stream-proxy.ts
//
// WebSocket ↔ TCP híd a böngészős webplayerhez.
//
// A snapserver natív kliens-protokollja TCP (binary, 26-byte header + payload),
// amit egy böngésző nem tud nyitni. Ez a proxy egy WebSocket endpointot ad
// (`/snap-stream?token=...`), és minden frame-et byte-pontosan átfordít a
// loopback-on futó snapserver TCP socketjére (és vissza). Így a böngészős
// kliens (`src/lib/snapWsClient.ts`) az Android/Python kliensekkel azonos
// protokollon dolgozik:
//
//   böngésző                proxy                 snapserver
//   ──────── ──WS──> [WS↔TCP] ──TCP──> ──────────
//                    127.0.0.1:<snapPort>
//
// Auth: JWT (PLAYER role), tenantId+userId-ből feloldjuk a Device-rekordot
// (a kliens a saját Device.id-jét küldi snap-HELLO-ban; ezt önállóan teszi
// fel a browser-kliens). A snapPort a tenant rekordból jön.

import http from "http";
import net from "net";
import WS from "ws";
import jwt from "jsonwebtoken";
import { env } from "../../config/env";
import { prisma } from "../../prisma/client";

const SNAP_HOST = process.env.SNAP_HOST_INTERNAL ?? "127.0.0.1";

/**
 * `noServer:true` WSS, amit a `server.ts` központi upgrade-dispatcherje
 * `handleUpgrade()`-gel etet a `/snap-stream` path-ra érkező kéréseknél.
 */
export function createSnapStreamWss(): InstanceType<typeof WS.WebSocketServer> {
  const wss = new WS.WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WS, req: http.IncomingMessage) => {
    void handleSnapStreamConnection(ws, req);
  });

  return wss;
}

async function handleSnapStreamConnection(
  ws: WS,
  req: http.IncomingMessage
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token") ?? "";

  if (!token) {
    ws.close(4001, "Missing token");
    return;
  }

  let payload: any;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET);
  } catch {
    ws.close(4002, "Invalid token");
    return;
  }

  const tenantId: string | undefined = payload.tenantId ?? payload.tid;
  const userId: string | undefined = payload.sub;

  if (!tenantId) {
    ws.close(4003, "Missing tenantId");
    return;
  }

  // Tenant snapPort feloldása.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { snapPort: true },
  }).catch(() => null);

  if (!tenant?.snapPort) {
    ws.close(4004, "No snapPort configured for tenant");
    return;
  }

  // Loopback TCP a tenant snapserverhez.
  const tcp = net.connect({
    host: SNAP_HOST,
    port: tenant.snapPort,
  });
  tcp.setNoDelay(true);

  let wsOpen = true;
  let tcpOpen = false;

  tcp.on("connect", () => {
    tcpOpen = true;
    console.log(
      `[SnapStreamProxy] 🔌 connected user=${userId} tenant=${tenantId} → ${SNAP_HOST}:${tenant.snapPort}`
    );
  });

  tcp.on("data", (chunk: Buffer) => {
    if (!wsOpen) return;
    try {
      ws.send(chunk, { binary: true });
    } catch {
      // ignore: a WS close eseménye úgyis kitakarít
    }
  });

  tcp.on("close", () => {
    tcpOpen = false;
    if (wsOpen) {
      try { ws.close(1011, "snap upstream closed"); } catch {}
    }
  });

  tcp.on("error", (err: Error) => {
    console.warn(
      `[SnapStreamProxy] TCP error user=${userId} tenant=${tenantId}: ${err.message}`
    );
    tcpOpen = false;
    if (wsOpen) {
      try { ws.close(1011, "snap upstream error"); } catch {}
    }
  });

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    if (!tcpOpen) return;
    try {
      if (Buffer.isBuffer(data)) {
        tcp.write(data);
      } else if (data instanceof ArrayBuffer) {
        tcp.write(Buffer.from(data));
      } else if (Array.isArray(data)) {
        for (const part of data) {
          tcp.write(part as Buffer);
        }
      }
    } catch {
      // ignore – TCP close esemény úgyis lekezeli
    }
  });

  ws.on("close", () => {
    wsOpen = false;
    try { tcp.destroy(); } catch {}
    console.log(
      `[SnapStreamProxy] 🔌 closed user=${userId} tenant=${tenantId}`
    );
  });

  ws.on("error", () => {
    wsOpen = false;
    try { tcp.destroy(); } catch {}
  });
}
