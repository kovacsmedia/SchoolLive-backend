// src/modules/contact/contact.routes.ts
import { Router, Request, Response } from "express";
import nodemailer from "nodemailer";

const router = Router();

// POST /contact – publikus endpoint
router.post("/", async (req: Request, res: Response) => {
  const { name, institution, email, phone } = req.body ?? {};
  if (!name || !email) return res.status(400).json({ error: "Név és e-mail cím kötelező." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Érvénytelen e-mail cím." });

  const smtpUser = process.env.SMTP_USER || "info@schoollive.hu";
  const smtpPass = process.env.SMTP_PASS || "";
  const smtpHost = process.env.SMTP_HOST || "mail.schoollive.hu";
  const smtpPort = parseInt(process.env.SMTP_PORT || "587");
  const smtpSecure = smtpPort === 465;

  const transporter = nodemailer.createTransport({
    host:   smtpHost,
    port:   smtpPort,
    secure: smtpSecure,
    auth:   { user: smtpUser, pass: smtpPass },
    tls:    { rejectUnauthorized: false },
  });

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
  <p style="margin-top:20px;font-size:12px;color:#94a3b8">Beküldve: ${new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}</p>
</div>`;

  const text = `Új érdeklődő\n\nNév: ${name}\nIntézmény: ${institution || "–"}\nE-mail: ${email}\nTelefon: ${phone || "–"}`;

  try {
    await transporter.sendMail({
      from:    `"SchoolLive" <${smtpUser}>`,
      to:      "info@kovacsmedia.hu",
      subject: "SchoolLive érdeklődő",
      text,
      html,
    });
    console.log(`[CONTACT] Elküldve: ${name} <${email}>`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[CONTACT] SMTP hiba:", err);
    return res.status(500).json({ error: "Az e-mail küldése nem sikerült. Kérjük, próbálja újra." });
  }
});

export default router;