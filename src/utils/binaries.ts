// src/utils/binaries.ts
//
// KÜLSŐ PROGRAMOK FELOLDÁSA – egy helyen.
//
// MIÉRT: a yt-dlp útvonalát korábban KÉT hely oldotta fel külön-külön
// (radio.routes.ts és radio.scheduler.ts), és a kettő nem is egyezett: a
// routes figyelte a `YT_DLP_BIN` környezeti változót, a napi frissítő NEM.
// Egy egyedi telepítésen tehát a rendszer az egyik binárist használta, a napi
// `--update` viszont egy MÁSIKAT frissített – a hiba csendes, és csak
// hónapok múlva, egy YouTube-formátumváltásnál derült volna ki.
//
// A környezeti változó MINDIG erősebb a keresésnél. A jelölt-lista csak
// kényelmi tartalék arra az esetre, ha nincs beállítva.

import { existsSync } from "fs";

/** Az első létező útvonal, vagy a PATH-ra hagyatkozó puszta név. */
function firstExisting(candidates: string[], fallback: string): string {
  return candidates.find(p => existsSync(p)) ?? fallback;
}

/**
 * yt-dlp bináris. `YT_DLP_BIN` felülírja.
 *
 * A jelöltek között szándékosan szerepel a `deploy` felhasználó saját
 * telepítése: a yt-dlp gyakran frissül, és a csomagkezelős változat
 * jellemzően elavult a YouTube-formátumokhoz képest.
 */
export function resolveYtDlp(): string {
  return process.env.YT_DLP_BIN ?? firstExisting([
    "/home/deploy/.local/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ], "yt-dlp");
}
