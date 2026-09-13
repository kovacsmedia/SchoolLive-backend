-- RadioSchedule: internetrádió-ütemezés.
--
-- Eddig minden ütemezés egy letöltött RadioFile-ra mutatott. Egy internetrádió
-- viszont élő stream: nincs mit letölteni, és nincs ismert hossza. Ezért:
--   • radioFileId → NULLABLE (streamnél nincs fájl),
--   • streamUrl   → a stream címe,
--   • streamTitle → a megjelenítendő állomásnév.
-- Egy sorban a kettő közül pontosan az egyik van kitöltve.
--
-- A stream magától soha nem ér véget, ezért ilyen ütemezésnél az `endsAt`
-- (ld. migration_add_radioschedule_endsat.sql) a gyakorlatban kötelező –
-- enélkül kézi leállításig szól.
--
-- FIGYELEM: a repó `prisma/migrations` mappája nem szabályos Prisma-migráció-
-- szerkezetű (csak laza .sql fájlok), ezért a deploybeli `prisma migrate
-- deploy` EZT NEM alkalmazza automatikusan. Kézzel kell lefuttatni a DB-n,
-- a backend deploy ELŐTT.
--
-- A szerveren a `deploy` user a gazda (övé a /opt/schoollive/backend és a
-- .env, ő indítja a PM2-t), ezért az ő nevében, az ő .env-jéből olvasva.
-- A DATABASE_URL Prisma-specifikus paramétereket is tartalmaz (schema,
-- connection_limit, pgbouncer, pool_timeout), amiket a psql nem ismer
-- ("invalid URI query parameter") – ezért azokat kiszedjük, a libpq által
-- értett paramétereket (pl. sslmode) viszont meghagyjuk:
--
--   sudo -u deploy bash -lc 'cd /opt/schoollive/backend \
--     && set -a && . ./.env && set +a \
--     && PSQL_URL=$(printf "%s" "$DATABASE_URL" \
--          | sed -E "s/[?&](schema|connection_limit|pgbouncer|pool_timeout|socket_timeout)=[^&]*//g" \
--          | sed -E "s/^([^?&]*)&/\1?/") \
--     && psql "$PSQL_URL" -f prisma/migrations/migration_add_radioschedule_stream.sql'
--
-- Az IF NOT EXISTS / DROP NOT NULL miatt többször is lefuttatható.
-- Multi-node telepítésnél ELÉG EGY node-on: a Postgres közös.

ALTER TABLE "RadioSchedule" ALTER COLUMN "radioFileId" DROP NOT NULL;
ALTER TABLE "RadioSchedule" ADD COLUMN IF NOT EXISTS "streamUrl"   TEXT;
ALTER TABLE "RadioSchedule" ADD COLUMN IF NOT EXISTS "streamTitle" TEXT;
