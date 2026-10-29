#!/bin/bash

set -u

log() {
    local _device="$1"
    local message="$2"
    echo "$message"
}

# Load .env file if present
if [ -f .env ]; then
    echo "Loading .env file..."
    export $(grep -v '^#' .env | xargs)
else
    echo ".env file not found."
fi

# Check if ADB is installed
if ! command -v adb &> /dev/null; then
    echo "ADB not found. Installing via Homebrew..."
    brew install android-platform-tools
else
    echo "ADB is already installed."
fi

# Discover connected UNO Q devices
DEVICES=()
while read -r serial state; do
    if [ "$state" = "device" ] && [ -n "$serial" ]; then
        DEVICES+=("$serial")
    fi
done < <(adb devices | awk 'NR>1 && NF>=2 {print $1" "$2}')

if [ ${#DEVICES[@]} -eq 0 ]; then
    echo "No UNO Q devices found. Please connect at least one device."
    exit 1
else
    echo "Connected devices (${#DEVICES[@]}): ${DEVICES[*]}"
fi

LABEL_WIDTH=0
for device in "${DEVICES[@]}"; do
    current_width=$((${#device} + 2))
    if [ "$current_width" -gt "$LABEL_WIDTH" ]; then
        LABEL_WIDTH="$current_width"
    fi
done

COLOR_RESET=$'\033[0m'
COLORS=(
    $'\033[38;5;39m'
    $'\033[38;5;208m'
    $'\033[38;5;46m'
    $'\033[38;5;201m'
    $'\033[38;5;226m'
    $'\033[38;5;51m'
)

if [ ! -t 1 ]; then
    COLOR_RESET=""
    for idx in "${!COLORS[@]}"; do
        COLORS[$idx]=""
    done
fi

# Path to script for UNO Q
UNOQ_SCRIPT="unoq-setup.sh"

# Clone app brick repo on Mac side if not already present
APP_BRICK_DIR="example-arduino-app-lab-object-detection-using-flask"
PROPERTIES_FILE="properties.msgpack"
PROPERTIES_TARGET_PATH="/var/lib/arduino-app-cli/properties.msgpack"
MODEL_BUNDLE_DIR="model-bundles"
MODELS_TARGET_PATH="/var/lib/arduino-app-cli/models/"
MODEL_STAGING_PATH="/home/arduino/.unoq-model-bundles"
if [ ! -d "$APP_BRICK_DIR" ]; then
    echo "Cloning app brick repository on Mac..."
    git clone https://github.com/edgeimpulse/example-arduino-app-lab-object-detection-using-flask.git
else
    echo "App brick repository already present on Mac."
fi

process_device() {
    local device="$1"
    local command_output=""

    log "$device" "Starting update workflow..."

    if ! adb -s "$device" push "$APP_BRICK_DIR" /home/arduino/ArduinoApps/; then
        log "$device" "Failed to push app brick directory."
        return 1
    fi

    if ! adb -s "$device" push "$UNOQ_SCRIPT" "/home/arduino/.${UNOQ_SCRIPT}"; then
        log "$device" "Failed to push setup script."
        return 1
    fi

    if [ -f .env ]; then
        if ! adb -s "$device" push .env /home/arduino/.env; then
            log "$device" "Failed to push .env file."
            return 1
        fi
    fi

    if ! adb -s "$device" shell "chmod +x /home/arduino/.${UNOQ_SCRIPT}"; then
        log "$device" "Failed to make setup script executable."
        return 1
    fi

    if [ -z "${UNOQ_DEFAULT_PASSWORD:-}" ]; then
        log "$device" "UNOQ_DEFAULT_PASSWORD is not set. Skipping password change."
    else
        log "$device" "Changing password (attempt 1: no current password)..."
        command_output=$(adb -s "$device" shell "printf '%s\n%s\n' '$UNOQ_DEFAULT_PASSWORD' '$UNOQ_DEFAULT_PASSWORD' | passwd arduino" 2>&1)

        if echo "$command_output" | grep -Eqi "password updated successfully|all authentication tokens updated successfully|passwd: password changed"; then
            log "$device" "Password changed successfully (no current password required)."
        elif echo "$command_output" | grep -Eqi "current password|authentication failure|password unchanged"; then
            log "$device" "Retrying password change with current password 'arduino'..."
            command_output=$(adb -s "$device" shell "printf '%s\n%s\n%s\n' 'arduino' '$UNOQ_DEFAULT_PASSWORD' '$UNOQ_DEFAULT_PASSWORD' | passwd arduino" 2>&1)

            if echo "$command_output" | grep -Eqi "password updated successfully|all authentication tokens updated successfully|passwd: password changed"; then
                log "$device" "Password changed successfully using current password."
            elif echo "$command_output" | grep -qi "authentication token manipulation error"; then
                log "$device" "Password change hit token manipulation error; password may already be changed."
            elif echo "$command_output" | grep -qi "password unchanged"; then
                log "$device" "Password unchanged; it may already be non-default."
            else
                log "$device" "Password change failed. Output: $command_output"
            fi
        elif echo "$command_output" | grep -qi "authentication token manipulation error"; then
            log "$device" "Password change hit token manipulation error; password may already be changed."
        else
            log "$device" "Password change may have already happened or failed. Output: $command_output"
        fi
    fi
    
    if ! adb -s "$device" shell "source /etc/profile; bash /home/arduino/.${UNOQ_SCRIPT}"; then
        log "$device" "Remote setup script execution failed."
        return 1
    fi

    if [ -d "$MODEL_BUNDLE_DIR" ]; then
        log "$device" "Restoring offline model bundle..."
        if ! adb -s "$device" shell "rm -rf '$MODEL_STAGING_PATH' && mkdir -p '$MODEL_STAGING_PATH'"; then
            log "$device" "Failed to create model staging directory."
            return 1
        fi
        for model_family in "$MODEL_BUNDLE_DIR"/*; do
            [ -d "$model_family" ] || continue
            if ! adb -s "$device" push "$model_family" "$MODEL_STAGING_PATH/"; then
                log "$device" "Failed to restore $model_family."
                return 1
            fi
        done
        install_models="mkdir -p '$MODELS_TARGET_PATH' && cp -a '$MODEL_STAGING_PATH'/.' '$MODELS_TARGET_PATH' && chown -R arduino:arduino '$MODELS_TARGET_PATH' && rm -rf '$MODEL_STAGING_PATH'"
        if ! adb -s "$device" shell "sudo -n bash -lc \"$install_models\""; then
            sudo_password="${UNOQ_DEFAULT_PASSWORD:-arduino}"
            if ! adb -s "$device" shell "printf '%s\\n' '$sudo_password' | sudo -S -k -p '' bash -lc \"$install_models\""; then
                log "$device" "Failed to install offline model bundle with sudo."
                return 1
            fi
        fi
    else
        log "$device" "$MODEL_BUNDLE_DIR not found locally. Skipping model restore."
    fi

    log "$device" "Update workflow completed successfully."
    if [ -f "$PROPERTIES_FILE" ]; then
        if ! adb -s "$device" push "$PROPERTIES_FILE" "$PROPERTIES_TARGET_PATH"; then
            log "$device" "Failed to push $PROPERTIES_FILE to $PROPERTIES_TARGET_PATH."
            return 1
        fi
    else
        log "$device" "$PROPERTIES_FILE not found locally. Skipping properties file push."
    fi
    return 0
}

echo "Starting parallel update across ${#DEVICES[@]} device(s)..."
PIDS=()

for idx in "${!DEVICES[@]}"; do
    device="${DEVICES[$idx]}"
    color="${COLORS[$((idx % ${#COLORS[@]}))]}"
    (
        set -o pipefail
        process_device "$device" 2>&1 | while IFS= read -r line || [ -n "$line" ]; do
            printf "%b%-*s%b %s\n" "$color" "$LABEL_WIDTH" "[$device]" "$COLOR_RESET" "$line"
        done
    ) &
    PIDS+=("$!")
done

SUCCESSFUL_DEVICES=()
FAILED_DEVICES=()

for idx in "${!PIDS[@]}"; do
    device="${DEVICES[$idx]}"
    pid="${PIDS[$idx]}"

    if wait "$pid"; then
        SUCCESSFUL_DEVICES+=("$device")
    else
        FAILED_DEVICES+=("$device")
    fi
done

echo ""
echo "Update summary:"
echo "  Success (${#SUCCESSFUL_DEVICES[@]}): ${SUCCESSFUL_DEVICES[*]:-none}"
echo "  Failed  (${#FAILED_DEVICES[@]}): ${FAILED_DEVICES[*]:-none}"

if [ ${#FAILED_DEVICES[@]} -gt 0 ]; then
    exit 1
fi

echo "All device updates completed."