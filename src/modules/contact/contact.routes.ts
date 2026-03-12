// src/modules/contact/contact.routes.ts
import { Router, Request, Response } from "express";
import nodemailer from "nodemailer";

const router = Router();

// POST /contact – nincs authentikáció, publikus endpoint
router.post("/", async (req: Request, res: Response) => {
  const { name, institution, email, phone } = req.body ?? {};

  if (!name || !email) {
    return res.status(400).json({ error: "Név és e-mail cím kötelező." });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Érvénytelen e-mail cím." });
  }

  try {
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST   || "smtp.kovacsmedia.hu",
      port:   parseInt(process.env.SMTP_PORT  || "587"),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER || "form@schoollive.hu",
        pass: process.env.SMTP_PASS || "",
      },
    });

    const html = `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0">
        <div style="margin-bottom:24px">
          <img src="https://schoollive.hu/brand/schoollive-logo.svg" alt="SchoolLive" style="width:140px" />
        </div>
        <h2 style="color:#1e293b;font-size:20px;margin:0 0 20px">📬 Új érdeklődő a SchoolLive rendszer iránt</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:10px 12px;background:#fff;border:1px solid #e2e8f0;font-weight:700;color:#475569;width:140px">Név</td>
              <td style="padding:10px 12px;background:#fff;border:1px solid #e2e8f0;color:#1e293b">${name}</td></tr>
          <tr><td style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;color:#475569">Intézmény</td>
              <td style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#1e293b">${institution || "–"}</td></tr>
          <tr><td style="padding:10px 12px;background:#fff;border:1px solid #e2e8f0;font-weight:700;color:#475569">E-mail</td>
              <td style="padding:10px 12px;background:#fff;border:1px solid #e2e8f0"><a href="mailto:${email}" style="color:#3b82f6">${email}</a></td></tr>
          <tr><td style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;font-weight:700;color:#475569">Telefon</td>
              <td style="padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;color:#1e293b">${phone || "–"}</td></tr>
        </table>
        <p style="margin-top:24px;font-size:12px;color:#94a3b8">Beküldve: ${new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}</p>
      </div>
    `;

    await transporter.sendMail({
      from:    `"SchoolLive Form" <${process.env.SMTP_USER || "form@schoollive.hu"}>`,
      to:      "info@kovacsmedia.hu",
      subject: "SchoolLive érdeklődő",
      html,
      text: `Új érdeklődő\n\nNév: ${name}\nIntézmény: ${institution || "–"}\nE-mail: ${email}\nTelefon: ${phone || "–"}\n\nBeküldve: ${new Date().toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}`,
    });

    console.log(`[CONTACT] Érdeklődő e-mail elküldve: ${name} <${email}>`);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[CONTACT] E-mail küldés sikertelen:", err);
    return res.status(500).json({ error: "Az e-mail küldése nem sikerült. Kérjük, próbálja újra." });
  }
});

export default router;