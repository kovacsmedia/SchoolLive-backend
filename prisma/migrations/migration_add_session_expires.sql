-- Futtatás:
-- sudo -u postgres psql -d schoollive -c "ALTER TABLE \"User\" ADD COLUMN IF NOT EXISTS \"sessionExpiresAt\" TIMESTAMPTZ;"
--
-- A single-session ellenőrzés (auth.service.ts login()) eddig a `lastSeenAt`
-- + 60mp inaktivitási heurisztikával döntötte el, hogy egy meglévő session
-- "még élhet"-e. Ez hibás volt: a `lastSeenAt` csak addig frissülhet, amíg a
-- token ÉRVÉNYES (authJwt.ts csak sikeres jwt.verify után írja) – tehát egy
-- aktívan használt fül épp a lejárat pillanatáig friss `lastSeenAt`-et
-- hagyhat maga után, a 60mp-es grace pedig ehhez képest önkényes, a tényleges
-- token-lejárattól független plusz várakozást ad hozzá.
--
-- A `sessionExpiresAt` a bejelentkezéskor (és minden /auth/refresh hívásnál)
-- kiszámolt, tényleges JWT exp időpontja – a login() mostantól ehhez képest
-- dönt: ha `now >= sessionExpiresAt`, a régi session garantáltan lejárt,
-- azonnal engedjük az új bejelentkezést, nincs extra várakozás.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "sessionExpiresAt" TIMESTAMPTZ;
