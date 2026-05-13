// src/utils/text.ts
//
// Szöveg-normalizálás. A frontend ugyanezt csinálja a beíráskor
// (`src/lib/text.ts`), de a backendnél is védjük az adatbázisra menő
// fájlneveket / üzenet-címeket / playlist neveket – ha valamiért egy
// kliens átküldene ékezetes szöveget, az SQL-be már tisztított érték kerül.
//
// FONTOS: a TTS forrásszöveget (Message.text) NEM tisztítjuk, mert a Piper
// modell pontosan az ékezetes magyar betűk alapján mondja ki a szavakat.

/**
 * Eltávolít minden combining diacritic jelet (ékezetek, mellékjelek):
 *   "rádió"     → "radio"
 *   "Csukás"    → "Csukas"
 *   "ÁRVÍZTŰRŐ" → "ARVIZTURO"
 */
export function stripAccents(s: string): string {
  if (!s) return s;
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
