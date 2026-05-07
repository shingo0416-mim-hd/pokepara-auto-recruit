#!/bin/bash
set -euo pipefail

# このスクリプトのあるディレクトリを基準にプロジェクトルートを特定
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Node のパスを動的に取得
NODE_BIN_DIR=$(dirname "$(which node)")
export PATH="$NODE_BIN_DIR:$PATH"

# ログタイムスタンプを日本時間に統一
export TZ="Asia/Tokyo"

cd "$PROJECT_ROOT"

LOG_DIR="logs"
SCREENSHOT_DIR="screenshots/recruit"
RETENTION_DAYS=7

# Purge log files and screenshots older than one week
if [ -d "$LOG_DIR" ]; then
  find "$LOG_DIR" -type f -mtime +"$RETENTION_DAYS" -print -delete || true
fi

if [ -d "$SCREENSHOT_DIR" ]; then
  find "$SCREENSHOT_DIR" -type f -name '*.png' -mtime +"$RETENTION_DAYS" -print -delete || true
fi

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR"/recruit.$(date +'%Y%m%d').log

echo "==== [$(date '+%F %T')] recruit.spec.ts start ====" | tee -a "$LOG_FILE"

PW_TEST_DISABLE_COLORS=1 npx playwright test \
  tests/recruit.spec.ts \
  --project="Google Chrome" \
  --reporter=list | tee -a "$LOG_FILE"

EXIT_CODE=${PIPESTATUS[0]}
echo "==== [$(date '+%F %T')] end (exit=$EXIT_CODE) ====" | tee -a "$LOG_FILE"

exit $EXIT_CODE
