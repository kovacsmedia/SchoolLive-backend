// src/services/translate.service.ts
// TTS üzenet-fordítás: Google Cloud Translation v2 REST API-n keresztül.
// Forrásnyelv NINCS megadva a kérésben (auto-detect) — a felhasználó
// bármilyen nyelven beírhatja a szöveget, csak a célnyelv számít.

import { env } from "../config/env";

const TRANSLATE_ENDPOINT = "https://translation.googleapis.com/language/translate2";

export async function translateText(text: string, targetLang: string): Promise<string> {
  if (!env.GOOGLE_TRANSLATE_API_KEY) {
    throw new Error("GOOGLE_TRANSLATE_API_KEY nincs beállítva ezen a node-on");
  }

  const url = `${TRANSLATE_ENDPOINT}?key=${encodeURIComponent(env.GOOGLE_TRANSLATE_API_KEY)}`;

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ q: text, target: targetLang, format: "text" }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Google Translate hiba (${res.status}): ${body.slice(0, 400)}`);
  }

  const data = await res.json() as {
    data?: { translations?: { translatedText?: string }[] };
  };

  const translated = data?.data?.translations?.[0]?.translatedText;
  if (typeof translated !== "string" || translated.length === 0) {
    throw new Error("Google Translate: üres/érvénytelen válasz");
  }

  return translated;
}
