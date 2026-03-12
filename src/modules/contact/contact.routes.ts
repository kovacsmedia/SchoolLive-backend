// src/modules/contact/contact.routes.ts
import { Router, Request, Response } from "express";
import * as net from "node:net";
import * as tls from "node:tls";

const router = Router();

// Egyszerű SMTP küldő – külső csomag nélkül
function sendSmtp(opts: {
  host: string; port: number; secure: boolean;
  user: string; pass: string;
  from: string; to: string; subject: string;
  html: string; text: string;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const boundary = "sl_" + Date.now().toString(36);
    const crlf = "\r\n";
    const headers = [
      `From: "SchoolLive Form" <${opts.from}>`,
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ].join(crlf);
    const body = [
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      "",
      b64(opts.text),
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      "",
      b64(opts.html),
      `--${boundary}--`,
    ].join(crlf);
    const msg = headers + crlf + crlf + body;

    const lines: string[] = [];
    let step = 0;

    const sock: net.Socket = opts.secure
      ? (tls.connect(opts.port, opts.host, { servername: opts.host }) as unknown as net.Socket)
      : net.createConnection(opts.port, opts.host);

    sock.setEncoding("utf8");
    sock.setTimeout(10000);
    sock.on("timeout", () => { sock.destroy(); reject(new Error("SMTP timeout")); });
    sock.on("error", reject);

    sock.on("data", (chunk: string) => {
      lines.push(chunk.trim());
      const line = lines[lines.length - 1];
      const code = parseInt(line.slice(0, 3));
      if (isNaN(code)) return;

      if (step === 0 && code === 220) { sock.write(`EHLO schoollive.hu${crlf}`); step++; }
      else if (step === 1 && (code === 250 || code === 220)) {
        // may get multiline 250; wait for last line (no dash after code)
        if (line[3] === "-") return; // still multiline
        sock.write(`AUTH LOGIN${crlf}`); step++;
      }
      else if (step === 2 && code === 334) { sock.write(b64(opts.user) + crlf); step++; }
      else if (step === 3 && code === 334) { sock.write(b64(opts.pass) + crlf); step++; }
      else if (step === 4 && code === 235) { sock.write(`MAIL FROM:<${opts.from}>${crlf}`); step++; }
      else if (step === 5 && code === 250) { sock.write(`RCPT TO:<${opts.to}>${crlf}`); step++; }
      else if (step === 6 && code === 250) { sock.write(`DATA${crlf}`); step++; }
      else if (step === 7 && code === 354) { sock.write(msg + crlf + "." + crlf); step++; }
      else if (step === 8 && code === 250) { sock.write(`QUIT${crlf}`); step++; }
      else if (step === 9 && code === 221) { sock.destroy(); resolve(); }
      else if (code >= 400) { sock.destroy(); reject(new Error(`SMTP error ${code}: ${line}`)); }
    });
  });
}

// POST /contact – publikus endpoint
router.post("/", async (req: Request, res: Response) => {
  const { name, institution, email, phone } = req.body ?? {};
  if (!name || !email) return res.status(400).json({ error: "Név és e-mail cím kötelező." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Érvénytelen e-mail cím." });

  const smtpUser = process.env.SMTP_USER || "form@schoollive.hu";
  const html = `
<div style="font-family:Arial,sans-serif;max-width:560px;padding:32px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0">
  <h2 style="color:#1e293b;margin:0 0 20px">📬 Új érdeklődő – SchoolLive</h2>
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:9px 12px;background:#fff;border:1px solid #e2e8f0;font-weight:700;color:#475569;width:130px">Név</td>
        <td style="padding:9px 12px;background:#fff;border:1px solid #e2e8f0">${name}</td></tr>
    <tr><td style="padding:9px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;color:#475569">Intézmény</td>
        <td style="padding:9px 12px;background:#f8fafc;border:1px solid #e2e8f0">${institution || "–"}</td></tr>
    <tr><td style="padding:9px 12px;background:#fff;border:1px solid #e2e8f0;font-weight:700;color:#475569">E-mail</td>
        <td style="padding:9px 12px;background:#fff;border:1px solid #e2e8f0"><a href="mailto:${email}">${email}</a></td></tr>
    <tr><td style="padding:9px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;color:#475569">Telefon</td>
        <td style="padding:9px 12px;background:#f8fafc;border:1px solid #e2e8f0">${phone || "–"}</td></tr>
  </table>
  <p style="margin-top:20px;font-size:12px;color:#94a3b8">Beküldve: ${new Date().toLocaleString("hu-HU",{timeZone:"Europe/Budapest"})}</p>
</div>`;

  const text = `Új érdeklődő\n\nNév: ${name}\nIntézmény: ${institution||"–"}\nE-mail: ${email}\nTelefon: ${phone||"–"}`;

  try {
    await sendSmtp({
      host:    process.env.SMTP_HOST    || "smtp.kovacsmedia.hu",
      port:    parseInt(process.env.SMTP_PORT || "587"),
      secure:  process.env.SMTP_SECURE  === "true",
      user:    smtpUser,
      pass:    process.env.SMTP_PASS    || "",
      from:    smtpUser,
      to:      "info@kovacsmedia.hu",
      subject: "SchoolLive érdeklődő",
      html, text,
    });
    console.log(`[CONTACT] Elküldve: ${name} <${email}>`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[CONTACT] SMTP hiba:", err);
    return res.status(500).json({ error: "Az e-mail küldése nem sikerült. Kérjük, próbálja újra." });
  }
});

export default router;