#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo "[chatpulse] Installing dependencies and preparing local files..."
npm run setup

echo "[chatpulse] Starting ChatPulse dev servers..."
npm run dev
