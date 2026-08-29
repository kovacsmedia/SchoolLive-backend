#!/usr/bin/env bash
#
# Lokalizáció (TTS-fordítás) — a 8 idegen nyelvi Piper hangmodell letöltése a
# hivatalos rhasspy/piper-voices Hugging Face repóból.
#
# Idempotens: minden hiányzó modellt letölt, a meglévőket kihagyja. Minden
# app-node-on egyformán futtatandó (kézi lépés — ritkán változó statikus
# asset, NEM a Section E rsync-mirror.sh hatóköre, ld. ops/README-cluster-ha.md).
#
# A `voice` kulcs → fájlnév megfeleltetés a src/services/tts.service.ts
# VOICES map-jével van szinkronban tartva — ha ott változik a fájlnév, itt is
# kell.
#
# MEGJEGYZÉS horvátról: nincs natív horvát Piper-modell, a tts.service.ts
# a szerb (sr_RS-serbski_institut) modellt használja horvát szöveghez is —
# ezért ITT nincs külön horvát letöltés, a szerb fájl kiszolgálja mindkettőt.
set -euo pipefail

MODELS_DIR="${MODELS_DIR:-/opt/schoollive/piper/models}"
BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main"
LOG_TAG="[PIPER-VOICES]"

mkdir -p "$MODELS_DIR"

# lang_dir / region_dir / voice / quality / filename-stem
VOICES=(
  "en en_US amy medium en_US-amy-medium"
  "de de_DE thorsten medium de_DE-thorsten-medium"
  "sk sk_SK lili medium sk_SK-lili-medium"
  "pl pl_PL darkman medium pl_PL-darkman-medium"
  "ro ro_RO mihai medium ro_RO-mihai-medium"
  "uk uk_UA ukrainian_tts medium uk_UA-ukrainian_tts-medium"
  "sr sr_RS serbski_institut medium sr_RS-serbski_institut-medium"
)

fail=0

for entry in "${VOICES[@]}"; do
  read -r lang region voice quality stem <<< "$entry"
  remote_dir="$BASE_URL/$lang/$region/$voice/$quality"

  for ext in onnx onnx.json; do
    dest="$MODELS_DIR/${stem}.${ext}"
    if [ -s "$dest" ]; then
      echo "$LOG_TAG ${stem}.${ext} már megvan — kihagyva"
      continue
    fi
    echo "$LOG_TAG Letöltés: ${stem}.${ext}"
    if ! curl -fL --retry 3 --retry-delay 2 -o "$dest" "$remote_dir/${stem}.${ext}"; then
      echo "$LOG_TAG HIBA: ${stem}.${ext} letöltése sikertelen ($remote_dir/${stem}.${ext})" >&2
      rm -f "$dest"
      fail=1
    fi
  done
done

if [ "$fail" -ne 0 ]; then
  echo "$LOG_TAG Legalább egy modell letöltése sikertelen volt (ld. fent)." >&2
  exit 1
fi

echo "$LOG_TAG Kész — modellek: $MODELS_DIR"
ls -lh "$MODELS_DIR"/*.onnx 2>/dev/null || true
