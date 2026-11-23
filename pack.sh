#!/usr/bin/env bash
# 打包 Chrome 扩展为 CRX + ZIP（Windows 环境，用 PowerShell 压缩，无需 zip 命令）。
#
# 用法：
#   ./pack.sh                                   # 私钥缺失时自动生成，输出 longshot.crx + longshot.zip
#   PRIVATE_KEY_FILE=/path/to/my.pem ./pack.sh
#
# - CRX：内部分发（企业策略安装 / 拖入 chrome://extensions）。
# - ZIP：Chrome 应用商店上架用（商店不需要 crx）。
# - 私钥决定扩展 ID，务必妥善保管；换钥 = 换 ID。
#
# 重要：私钥必须放在扩展目录【之外】。Chrome 加载/打包扩展时会扫描扩展根目录，
# 一旦发现 *.pem 就会弹出「此扩展程序包含密钥文件……您最好不要执行此操作」的警告。
set -euo pipefail

CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
# 默认放到扩展目录同级的 screenshot-keys/ 下，避免被 Chrome 扫到
DEFAULT_KEY_DIR="$(dirname "$PWD")/screenshot-keys"
KEY_FILE="${PRIVATE_KEY_FILE:-$DEFAULT_KEY_DIR/longshot.pem}"
OUT_CRX="${OUTPUT:-longshot.crx}"
OUT_ZIP="${ZIP_NAME:-longshot.zip}"

[ -x "$CHROME" ] || { echo "未找到 Chrome：$CHROME（可用 CHROME=路径 覆盖）"; exit 1; }
case "$KEY_FILE" in
  "$PWD"/*) echo "警告：私钥位于扩展目录内，Chrome 会提示「包含密钥文件」。建议移到目录之外。" >&2 ;;
esac
mkdir -p "$(dirname "$KEY_FILE")" 

WIN() { cygpath -w "$1"; }

# 1) 组装干净暂存目录（只含运行所需文件，排除测试/文档/私钥）
STAGE_WIN=$(powershell -NoProfile -Command "(New-Object -ComObject Scripting.FileSystemObject).GetSpecialFolder(2).Path + '\\longshot-stage-' + [guid]::NewGuid().ToString('N')")
STAGE=$(cygpath -u "$STAGE_WIN")
trap 'powershell -NoProfile -Command "Remove-Item -Recurse -Force \"\$env:TEMP\\longshot-stage-*\" -ErrorAction SilentlyContinue" >/dev/null 2>&1' EXIT

mkdir -p "$STAGE/src"
cp manifest.json package.json "$STAGE/"
cp -r src/. "$STAGE/src/"
find "$STAGE" -type f \( -name '*.test.js' -o -name '*.md' \) -delete

# 2) ZIP（Compress-Archive 需要 .zip 后缀）
rm -f "$OUT_ZIP"
powershell -NoProfile -Command "Compress-Archive -Path '$(WIN "$STAGE")\\*' -DestinationPath '$(WIN "$PWD")\\$OUT_ZIP' -Force"
echo "OK  $OUT_ZIP  （Chrome 应用商店上架用）"

# 3) CRX（Chrome --pack-extension 签名）
# 与 ZIP 一样只签干净的 STAGE 目录：签源目录会把 tests/、文档、旧产物和根目录
# 杂物一起打进 CRX，导致内部版与上架版内容不一致。
# Chrome 按被签目录的路径输出 <目录>.crx / <目录>.pem，签完再搬走产物。
rm -f "$STAGE.crx" "$STAGE.pem" "$OUT_CRX"

KEY_ARGS=()
if [ -f "$KEY_FILE" ]; then
  # KEY_FILE 可能是绝对路径（默认在扩展目录之外），拼接前先判断
  case "$KEY_FILE" in
    /*) KEY_WIN=$(WIN "$KEY_FILE") ;;
    *)  KEY_WIN=$(WIN "$PWD/$KEY_FILE") ;;
  esac
  KEY_ARGS=("--pack-extension-key=$KEY_WIN")
  echo "使用私钥：$KEY_FILE"
fi

"$CHROME" \
  --pack-extension="$(WIN "$STAGE")" \
  --no-message-box \
  ${KEY_ARGS[@]+"${KEY_ARGS[@]}"} >/dev/null 2>&1 || true
sleep 2

if [ -f "$STAGE.crx" ]; then
  mv -f "$STAGE.crx" "$OUT_CRX"
fi
# Chrome 生成的新私钥收拢到约定位置（扩展目录之外）
NEW_KEY="$STAGE.pem"
if [ -f "$NEW_KEY" ] && [ ! -f "$KEY_FILE" ]; then
  mv -f "$NEW_KEY" "$KEY_FILE"
  echo "OK  $KEY_FILE  （新生成的扩展 ID 私钥，请妥善保管）"
elif [ -f "$NEW_KEY" ]; then
  rm -f "$NEW_KEY"
fi

if [ -f "$OUT_CRX" ]; then
  echo "OK  $OUT_CRX  （内部分发用，$(wc -c < "$OUT_CRX") 字节）"
else
  echo "FAIL CRX 打包失败（Chrome 未生成文件）" >&2
  echo "  排查：确认私钥路径有效、Chrome 未在运行" >&2
  echo "  手动方式：chrome://extensions → 开发者模式 →「打包扩展程序」" >&2
  exit 1
fi
