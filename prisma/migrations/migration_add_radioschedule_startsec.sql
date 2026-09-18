-- Indulási pozíció az ütemezett rádió-lejátszáshoz.
--
-- A felületen a kezelő választhat: "az elejétől" vagy "az aktuális pozíciótól"
-- – az utóbbi a hangtár idővonalán beállított helyről indít. NULL vagy 0 a
-- korábbi viselkedés (a hang elejétől), tehát a meglévő sorok érintetlenek.
--
-- ⚠️ A BACKEND DEPLOY ELŐTT kell futnia. A `prisma migrate deploy` itt no-op
-- (a prisma/migrations nem szabályos Prisma-szerkezet), ezért kézzel:
--
--   sudo -u deploy bash -lc 'cd /opt/schoollive/backend \
--     && set -a && . ./.env && set +a \
--     && PSQL_URL=$(printf "%s" "$DATABASE_URL" \
--          | sed -E "s/[?&](schema|connection_limit|pgbouncer|pool_timeout|socket_timeout)=[^&]*//g" \
--          | sed -E "s/^([^?&]*)&/\1?/") \
--     && psql "$PSQL_URL" -f prisma/migrations/migration_add_radioschedule_startsec.sql'
--
-- Az IF NOT EXISTS miatt többször is lefuttatható.
-- Multi-node telepítésnél ELÉG EGY node-on: a Postgres közös.

ALTER TABLE "RadioSchedule" ADD COLUMN IF NOT EXISTS "startSec" INTEGER;
