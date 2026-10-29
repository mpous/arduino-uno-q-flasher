#!/bin/bash

set -euo pipefail

MODEL_ROOT="/var/lib/arduino-app-cli/models"
MODEL_FAMILY="llamacpp"
MODEL_FILE="unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-Q4_0.gguf"
DESTINATION="model-bundles"

if ! command -v adb >/dev/null 2>&1; then
    echo "adb is not available on PATH." >&2
    exit 1
fi

device="${1:-}"
if [ -z "$device" ]; then
    devices=$(adb devices | awk 'NR > 1 && $2 == "device" {print $1}')
    device_count=$(printf '%s\n' "$devices" | awk 'NF {count++} END {print count + 0}')
    if [ "$device_count" -ne 1 ]; then
        echo "Pass the source board serial: $0 SERIAL" >&2
        exit 1
    fi
    device="$devices"
fi

if ! adb -s "$device" shell "test -s '$MODEL_ROOT/$MODEL_FAMILY/$MODEL_FILE' && test -s '$MODEL_ROOT/$MODEL_FAMILY/models.ini'"; then
    echo "Qwen 3.5 0.8B is not completely installed on $device." >&2
    exit 1
fi

rm -rf "$DESTINATION/$MODEL_FAMILY"
mkdir -p "$DESTINATION"
adb -s "$device" pull "$MODEL_ROOT/$MODEL_FAMILY" "$DESTINATION/"

size=$(wc -c < "$DESTINATION/$MODEL_FAMILY/$MODEL_FILE" | tr -d ' ')
if [ "$size" -ne 507154688 ]; then
    echo "Unexpected model size after export: $size bytes" >&2
    exit 1
fi

echo "Exported Qwen 3.5 0.8B model bundle from $device to $DESTINATION/$MODEL_FAMILY."