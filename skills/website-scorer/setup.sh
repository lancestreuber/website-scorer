#!/usr/bin/env bash
set -e

# ── Website Scorer Setup Script ────────────────────────────────────────────────
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SKILL_DIR}/../.." && pwd)"

echo "=================================================="
echo "  Website Scorer — Setup"
echo "  Skill dir : ${SKILL_DIR}"
echo "  Root dir  : ${ROOT_DIR}"
echo "=================================================="

# 1. Check Node.js version
echo ""
echo "[1/5] Checking Node.js version..."
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed. Install Node.js >= 18 and re-run setup."
  exit 1
fi

NODE_VERSION=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
if [ "${NODE_VERSION}" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required. Current version: $(node --version)"
  echo "Run: nvm install 18 && nvm use 18"
  exit 1
fi
echo "  Node.js $(node --version) — OK"

# 2. Create required directories
echo ""
echo "[2/5] Creating required directories..."
mkdir -p "${ROOT_DIR}/data/inputs"
mkdir -p "${ROOT_DIR}/data/outputs"
mkdir -p "${ROOT_DIR}/data/logs"
mkdir -p "${ROOT_DIR}/keys"
echo "  ${ROOT_DIR}/data/inputs   — OK"
echo "  ${ROOT_DIR}/data/outputs  — OK"
echo "  ${ROOT_DIR}/data/logs     — OK"
echo "  ${ROOT_DIR}/keys          — OK"

# 3. Create .env if it doesn't exist
echo ""
echo "[3/5] Checking .env file..."
ENV_FILE="${ROOT_DIR}/keys/.env"
if [ -f "${ENV_FILE}" ]; then
  echo "  .env already exists — skipping"
else
  echo "PAGESPEED_API_KEY=YOUR_KEY_HERE" > "${ENV_FILE}"
  echo "  Created ${ENV_FILE}"
fi

# 4. Install npm dependencies
echo ""
echo "[4/5] Installing npm dependencies..."
cd "${SKILL_DIR}"
npm install
echo "  Dependencies installed — OK"

# 5. Smoke test
echo ""
echo "[5/5] Running smoke test..."
set +e
SMOKE_OUTPUT=$(node "${SKILL_DIR}/pipeline.js" --csv /dev/null --out /dev/null 2>&1)
SMOKE_EXIT=$?
set -e

if echo "${SMOKE_OUTPUT}" | grep -q "Could not parse CSV\|empty\|missing required\|No such file\|PAGESPEED_API_KEY"; then
  echo "  Smoke test passed (clean error output, no crash) — OK"
else
  # If it exited non-zero with any output, that's still a "pass" for the smoke test
  # as long as it didn't produce a JS stack trace as the first output
  if echo "${SMOKE_OUTPUT}" | grep -q "at Module\|at Object\.<anonymous>"; then
    echo "  WARNING: Unexpected stack trace during smoke test:"
    echo "${SMOKE_OUTPUT}" | head -5
  else
    echo "  Smoke test output:"
    echo "${SMOKE_OUTPUT}" | head -3
    echo "  Smoke test completed (exit ${SMOKE_EXIT})"
  fi
fi

echo ""
echo "=================================================="
echo "  Setup complete!"
echo ""
echo "  NEXT STEP: Add your PageSpeed API key:"
echo "  ${ENV_FILE}"
echo ""
echo "  Get a free key at:"
echo "  https://developers.google.com/speed/docs/insights/v5/get-started"
echo ""
echo "  Then run:"
echo "  node ${SKILL_DIR}/pipeline.js \\"
echo "    --csv ${ROOT_DIR}/data/inputs/your_leads.csv \\"
echo "    --out ${ROOT_DIR}/data/outputs/your_leads_scored.csv"
echo "=================================================="
