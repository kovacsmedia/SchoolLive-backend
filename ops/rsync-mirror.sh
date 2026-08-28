#!/usr/bin/env bash
#
# Section E — node-ok közötti fájlszinkron (hangfájlok).
#
# Additív (NEM --delete) rsync push a saját audio/ és uploads/ könyvtárból
# minden másik cluster-node felé, hogy egy node-váltáskor (rebalance) a
# hangfájlokat ne kelljen közben másolgatni — mindegyik node-on minden
# fájl megvan. Szándékosan nincs --delete: több-irányú rsync törléssel egy
# ismert versenyhelyzet-csapda (egy épp feltöltött fájlt egy másik node
# törlő-köre tévesen eltávolíthatná) — az alkalmazás mindig DB-rekordból
# oldja fel a fájlelérési utat, egy admin-törlés utáni árva fájl legfeljebb
# kozmetikai (lemez-növekedés), NEM helyességi hiba.
#
# Systemd timer futtatja (lásd rsync-mirror.timer), 5 percenként, minden
# app-node-on.
set -euo pipefail

BACKEND_DIR="/opt/schoollive/backend"
NODES_FILE="$BACKEND_DIR/ops/nodes.txt"
ENV_FILE="$BACKEND_DIR/.env"
SSH_KEY="/home/deploy/.ssh/id_ed25519_mesh"
SSH_USER="deploy"
LOG_TAG="[RSYNC-MIRROR]"

if [ ! -f "$ENV_FILE" ]; then
  echo "$LOG_TAG HIBA: $ENV_FILE nem található" >&2
  exit 1
fi

# NODE_HOSTNAME kiolvasása a .env-ből (a saját node önkizárásához).
_raw="$(grep -E '^NODE_HOSTNAME=' "$ENV_FILE" | head -n1 | cut -d= -f2-)"
_raw="${_raw%\"}"; _raw="${_raw#\"}"
SELF_HOST="$(echo "$_raw" | xargs)"
if [ -z "$SELF_HOST" ]; then
  echo "$LOG_TAG HIBA: NODE_HOSTNAME nincs beállítva a .env-ben" >&2
  exit 1
fi

if [ ! -f "$NODES_FILE" ]; then
  echo "$LOG_TAG HIBA: $NODES_FILE nem található" >&2
  exit 1
fi

mkdir -p "$BACKEND_DIR/audio/bells" "$BACKEND_DIR/uploads/radio" "$BACKEND_DIR/uploads/firmware"

fail=0

while IFS= read -r peer; do
  # Üres sor és '#' kommentek kihagyása.
  case "$peer" in
    ""|\#*) continue ;;
  esac
  if [ "$peer" = "$SELF_HOST" ]; then
    continue
  fi

  echo "$LOG_TAG → $peer"

  if ! rsync -az --timeout=60 \
      -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10" \
      "$BACKEND_DIR/audio/" "$SSH_USER@$peer:$BACKEND_DIR/audio/"; then
    echo "$LOG_TAG HIBA: audio/ szinkron sikertelen → $peer" >&2
    fail=1
  fi

  if ! rsync -az --timeout=60 \
      -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10" \
      "$BACKEND_DIR/uploads/" "$SSH_USER@$peer:$BACKEND_DIR/uploads/"; then
    echo "$LOG_TAG HIBA: uploads/ szinkron sikertelen → $peer" >&2
    fail=1
  fi
done < "$NODES_FILE"

if [ "$fail" -ne 0 ]; then
  echo "$LOG_TAG Legalább egy peer szinkronja sikertelen volt (ld. fent) — a köv. timer-körben újra megpróbáljuk." >&2
  exit 1
fi

echo "$LOG_TAG Kész."
