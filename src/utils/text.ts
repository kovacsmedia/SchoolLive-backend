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

/**
 * Feltöltött fájlnév helyreállítása latin1→utf8 mojibake után.
 *
 * MIÉRT KELL: a multipart/form-data `filename` mezőjét a busboy (és rajta
 * keresztül a multer) LATIN1-ként dekódolja, ha a kliens nem küld explicit
 * RFC 5987 `filename*` mezőt. Egy ékezetes név UTF-8 bájtjai így külön
 * karakterekké esnek szét, és a rájuk futó `stripAccents()` már ezt a romlott
 * alakot tisztítja:
 *
 *   "rövidített.mp3"  →(NFD)→  "ro\u0308vidi\u0301tett.mp3"
 *                     →(latin1 mojibake)→  "roÌ\u0088vidiÌ\u0081tett.mp3"
 *                     →(stripAccents)→     "roI\u0088vidiI\u0081tett.mp3"
 *
 * Pontosan ez lett a szerveren a `roIviditettnap-elkoszon.mp3`.
 *
 * ÓVATOSAN javítunk: ha a név MÁR helyesen dekódolt (pl. a kliens küldött
 * `filename*`-ot), akkor a latin1→utf8 átalakítás EL IS RONTANÁ. Ezért csak
 * akkor nyúlunk hozzá, ha a bájtsor tényleg érvényes UTF-8-ként olvasható és
 * a visszaalakítás veszteségmentes.
 */
export function fixUploadFilename(name: string): string {
  if (!name) return name;

  // Ha bármelyik kódpont nem fér egy bájtba, ez nem lehet latin1-mojibake.
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0xff) return name;
  }

  const buf     = Buffer.from(name, "latin1");
  const decoded = buf.toString("utf8");

  // Érvénytelen UTF-8 → a böngésző nem mojibake-elt, hagyjuk békén.
  if (decoded.includes("\uFFFD")) return name;

  // Oda-vissza egyeznie kell, különben nem valódi UTF-8 bájtsor volt.
  if (!Buffer.from(decoded, "utf8").equals(buf)) return name;

  return decoded;
}
