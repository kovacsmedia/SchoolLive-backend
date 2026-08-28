#!/usr/bin/env bash
#
# Section F — Postgres HA: PgBouncer célpont szinkronizálása a mindenkori
# primary-re.
#
# FONTOS, amit ez a szkript SZÁNDÉKOSAN NEM csinál: nincs benne semmilyen
# replikációs, promóciós vagy split-brain-döntési logika. A tényleges
# failovert 100%-ban a pg_auto_failover (monitor + pg_autoctl) végzi — ez a
# szkript csak egy MÁR ELDÖNTÖTT állapotot olvas ki (`pg_autoctl show state`,
# a helyi node saját, a `pg_autoctl create postgres --monitor ...`-nál már
# beállított monitor-kapcsolatán keresztül — nincs külön hitelesítő adat) és
# ír át egy lokális proxy-konfigot (PgBouncer). A Node app DATABASE_URL-je
# ezért MINDIG "postgresql://...@localhost:6432/..." marad, sosem változik.
#
# Legrosszabb eset hiba esetén: átmenetileg elavult célpont, ami sima
# kapcsolódási hibaként jelentkezik, és a köv. timer-körben magától
# helyreáll — nincs benne semmi, ami adatvesztést vagy split-braint okozhatna.
#
# Systemd timer futtatja (lásd pgbouncer-target-sync.timer), 5-10
# másodpercenként, minden app-node-on (ahol a lokális PgBouncer fut).
set -euo pipefail

LOG_TAG="[PGBOUNCER-SYNC]"

# Node-specifikus beállítások — SZÁNDÉKOSAN külön, git-ben NEM követett
# fájlban (lásd ops/README-cluster-ha.md), mert a PGDATA-útvonal a Postgres
# csomag/telepítés módjától függ (pl. Debian/Ubuntu csomagból induló
# klaszternél tipikusan /var/lib/postgresql/<verzió>/main).
LOCAL_CONF="/opt/schoollive/backend/ops/pg-ha.local.env"
if [ -f "$LOCAL_CONF" ]; then
  # shellcheck disable=SC1090
  . "$LOCAL_CONF"
fi

PGDATA="${PGDATA:-/var/lib/postgresql/16/main}"
PGBOUNCER_INI="${PGBOUNCER_INI:-/etc/pgbouncer/pgbouncer.ini}"
PGBOUNCER_DB_ALIAS="${PGBOUNCER_DB_ALIAS:-schoollive}"
PGBOUNCER_DB_NAME="${PGBOUNCER_DB_NAME:-schoollive}"
PGBOUNCER_ADMIN_USER="${PGBOUNCER_ADMIN_USER:-pgbouncer_admin}"
STATE_FILE="${STATE_FILE:-/opt/schoollive/backend/ops/.pgbouncer-target-sync.last}"

if ! command -v pg_autoctl >/dev/null 2>&1; then
  echo "$LOG_TAG HIBA: pg_autoctl nem található a PATH-on" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "$LOG_TAG HIBA: jq nem található (apt install jq)" >&2
  exit 1
fi

STATE_JSON="$(pg_autoctl show state --pgdata "$PGDATA" --json 2>/dev/null || true)"
if [ -z "$STATE_JSON" ]; then
  echo "$LOG_TAG HIBA: 'pg_autoctl show state' nem adott választ — a monitor elérhetetlen, vagy a PGDATA rossz ($PGDATA)" >&2
  exit 1
fi

# MEGJEGYZÉS: a `reported_state` mezőnév pg_auto_failover verziók között
# stabil (dokumentált, publikus API), de ha a telepített verzió eltérő JSON
# alakot ad, először ellenőrizd kézzel:
#   pg_autoctl show state --pgdata "$PGDATA" --json | jq .
# és igazítsd a lenti jq szűrőt a valós mezőnevekhez.
PRIMARY_HOST="$(echo "$STATE_JSON" | jq -r '[.[] | select(.reported_state=="primary")][0].host // empty')"
PRIMARY_PORT="$(echo "$STATE_JSON" | jq -r '[.[] | select(.reported_state=="primary")][0].port // empty')"

if [ -z "$PRIMARY_HOST" ] || [ -z "$PRIMARY_PORT" ]; then
  echo "$LOG_TAG HIBA: nem sikerült kiolvasni a jelenlegi primary host:port-ot a state-ből" >&2
  exit 1
fi

NEW_TARGET="${PRIMARY_HOST}:${PRIMARY_PORT}"
LAST_TARGET=""
if [ -f "$STATE_FILE" ]; then
  LAST_TARGET="$(cat "$STATE_FILE")"
fi

if [ "$NEW_TARGET" = "$LAST_TARGET" ]; then
  # Nincs változás — csendben kilépünk (a timer logban ez nem zajos).
  exit 0
fi

echo "$LOG_TAG Primary változás észlelve: '${LAST_TARGET:-<nincs>}' → '$NEW_TARGET'"

if [ ! -f "$PGBOUNCER_INI" ]; then
  echo "$LOG_TAG HIBA: $PGBOUNCER_INI nem található" >&2
  exit 1
fi

# A [databases] szekció adott alias-sorának cseréje egy pontos, egysoros
# definícióra. A meglévő sort (ha van) töröljük, majd a `[databases]` fejléc
# után beszúrjuk az újat — így nem számít, ha korábban más host/port állt ott.
TMP_INI="$(mktemp)"
awk -v alias="$PGBOUNCER_DB_ALIAS" -v dbname="$PGBOUNCER_DB_NAME" -v host="$PRIMARY_HOST" -v port="$PRIMARY_PORT" '
  BEGIN { inserted = 0 }
  $0 ~ "^" alias " *=" { next }  # régi sor kihagyása
  /^\[databases\]/ {
    print
    print alias " = host=" host " port=" port " dbname=" dbname
    inserted = 1
    next
  }
  { print }
  END {
    if (!inserted) {
      print "[databases]"
      print alias " = host=" host " port=" port " dbname=" dbname
    }
  }
' "$PGBOUNCER_INI" > "$TMP_INI"

mv "$TMP_INI" "$PGBOUNCER_INI"
echo "$LOG_TAG $PGBOUNCER_INI frissítve"

# RELOAD az admin konzolon keresztül (unix socket, peer/trust auth — lásd
# README a pgbouncer_admin beállításához). Az ÚJ célpont az ÚJ szerver-
# kapcsolatokra azonnal érvényes; a már nyitott pool-kapcsolatok a
# PgBouncer saját, beépített logikája szerint cserélődnek (nincs itt semmi
# egyedi kód).
psql -h /var/run/postgresql -p 6432 -U "$PGBOUNCER_ADMIN_USER" pgbouncer -c "RELOAD" >/dev/null

echo "$NEW_TARGET" > "$STATE_FILE"
echo "$LOG_TAG Kész — PgBouncer célpont: $NEW_TARGET"
