#!/bin/bash

# ── Timer & error tracking ────────────────────────────────────────────────────
START_TIME=$(date +%s)
ERRORS=()

log() {
    echo "[UNOQ-SETUP] $1"
}

add_error() {
    ERRORS+=("$1")
    log "ERROR: $1"
}

print_summary() {
    END_TIME=$(date +%s)
    ELAPSED=$((END_TIME - START_TIME))
    MINS=$((ELAPSED / 60))
    SECS=$((ELAPSED % 60))
    echo ""
    echo "╔══════════════════════════════════════════════════╗"
    echo "║              UNOQ-SETUP SUMMARY                  ║"
    echo "╠══════════════════════════════════════════════════╣"
    printf "║  Total time : %02dm %02ds%-32s║\n" "$MINS" "$SECS" ""
    if [ ${#ERRORS[@]} -eq 0 ]; then
        echo "║  Status     : SUCCESS                            ║"
    else
        printf "║  Status     : FAILED (%d error(s))%-17s║\n" "${#ERRORS[@]}" ""
        echo "╠══════════════════════════════════════════════════╣"
        echo "║  Errors:                                         ║"
        for ERR in "${ERRORS[@]}"; do
            printf "║    • %-44s║\n" "$ERR"
        done
    fi
    echo "╚══════════════════════════════════════════════════╝"
}

# Always print summary on exit (normal or error)
trap print_summary EXIT

# ── Load environment variables ────────────────────────────────────────────────
if [ -f /home/arduino/.env ]; then
    log "Loading /home/arduino/.env file..."
    set -a
    . /home/arduino/.env
    set +a
    env | grep UNOQ_
else
    log "/home/arduino/.env file not found."
fi

log "Checking WiFi credentials..."
if [ -z "$UNOQ_WIFI_SSID" ] || [ -z "$UNOQ_WIFI_PASSWORD" ]; then
    add_error "UNOQ_WIFI_SSID and UNOQ_WIFI_PASSWORD environment variables must be set."
    exit 1
fi

CURRENT_USER=$(whoami)
log "Current user: $CURRENT_USER"
if [ "$CURRENT_USER" != "arduino" ]; then
    add_error "Current user is not arduino, this device is too far out of date or the user has been modified. Please flash the latest image from https://docs.arduino.cc/tutorials/uno-q/update-image/ and run this setup script again."
    exit 1
fi

log "Updating PATH..."
export PATH=$PATH:/usr/bin:/bin:/usr/local/bin

# ── WiFi ──────────────────────────────────────────────────────────────────────

# On UNO Q the WiFi radio is sometimes soft-blocked (rfkill) and/or disabled in
# NetworkManager after a fresh image boot, so `nmcli dev wifi connect` returns
# "No Wi-Fi device found." even though the hardware is present. Explicitly
# unblock + enable the radio first, then wait for a wifi-type device to appear
# via nmcli (the module can take a few seconds to register).
log "Unblocking WiFi radio (rfkill) and enabling it via NetworkManager..."
rfkill unblock wifi 2>/dev/null || log "rfkill unblock wifi failed (rfkill may be absent)"
nmcli radio wifi on 2>/dev/null || log "nmcli radio wifi on failed"

log "Waiting for a WiFi interface to appear (up to 30s)..."
WIFI_DEV_WAIT=30
WIFI_DEV_COUNT=0
WIFI_DEV_READY=0
while [ "$WIFI_DEV_COUNT" -lt "$WIFI_DEV_WAIT" ]; do
    if nmcli -t -f DEVICE,TYPE device 2>/dev/null | grep -q ':wifi$'; then
        log "WiFi interface detected after ${WIFI_DEV_COUNT}s."
        WIFI_DEV_READY=1
        break
    fi
    WIFI_DEV_COUNT=$((WIFI_DEV_COUNT + 1))
    sleep 1
done
if [ "$WIFI_DEV_READY" -ne 1 ]; then
    log "WARNING: no WiFi interface after ${WIFI_DEV_WAIT}s. Attempting connect anyway."
fi

log "Checking if WiFi is already connected..."
CURRENT_SSID=$(nmcli -t -f active,ssid dev wifi | grep '^yes:' | cut -d':' -f2)
if [ "$CURRENT_SSID" = "$UNOQ_WIFI_SSID" ]; then
    log "Already connected to WiFi SSID: $UNOQ_WIFI_SSID"
else
    log "Rescanning available WiFi networks..."
    nmcli dev wifi rescan 2>/dev/null || true

    log "Connecting to WiFi..."
    wifi_command="nmcli dev wifi connect $UNOQ_WIFI_SSID password $UNOQ_WIFI_PASSWORD"
    log "WiFi command: $wifi_command"

    # Increased retries to cover both "radio not up yet" and "SSID not seen in
    # the first scan". Total budget: up to 10 * 3s = 30s.
    WIFI_RETRY_MAX=10
    WIFI_RETRY_DELAY=3
    WIFI_ATTEMPT=1
    WIFI_CONNECTED=0

    while [ "$WIFI_ATTEMPT" -le "$WIFI_RETRY_MAX" ]; do
        WIFI_OUTPUT=$(nmcli dev wifi connect "$UNOQ_WIFI_SSID" password "$UNOQ_WIFI_PASSWORD" 2>&1)
        WIFI_EXIT_CODE=$?

        if [ "$WIFI_EXIT_CODE" -eq 0 ]; then
            WIFI_CONNECTED=1
            break
        fi

        if echo "$WIFI_OUTPUT" | grep -Fq "No Wi-Fi device found."; then
            log "No Wi-Fi device found (attempt ${WIFI_ATTEMPT}/${WIFI_RETRY_MAX}); rechecking radio and retrying in ${WIFI_RETRY_DELAY}s..."
            rfkill unblock wifi 2>/dev/null || true
            nmcli radio wifi on 2>/dev/null || true
            sleep "$WIFI_RETRY_DELAY"
            WIFI_ATTEMPT=$((WIFI_ATTEMPT + 1))
            continue
        fi

        if echo "$WIFI_OUTPUT" | grep -Fq "No network with SSID"; then
            log "SSID '$UNOQ_WIFI_SSID' not seen (attempt ${WIFI_ATTEMPT}/${WIFI_RETRY_MAX}); rescanning and retrying in ${WIFI_RETRY_DELAY}s..."
            nmcli dev wifi rescan 2>/dev/null || true
            sleep "$WIFI_RETRY_DELAY"
            WIFI_ATTEMPT=$((WIFI_ATTEMPT + 1))
            continue
        fi

        add_error "WiFi connection failed: $WIFI_OUTPUT"
        break
    done

    if [ "$WIFI_CONNECTED" -ne 1 ]; then
        if [ "$WIFI_ATTEMPT" -gt "$WIFI_RETRY_MAX" ]; then
            add_error "WiFi connection failed after ${WIFI_RETRY_MAX} attempts. Last output: $WIFI_OUTPUT"
        fi
        exit 1
    fi
fi

# ── DNS ───────────────────────────────────────────────────────────────────────
log "Setting DNS to Google DNS (updates weren't working without this)..."
CON_NAME=$(nmcli -t -f NAME connection show --active | head -n 1)
nmcli connection modify "$CON_NAME" ipv4.dns "8.8.8.8"
nmcli connection up "$CON_NAME"

log "Testing DNS resolution..."
nslookup downloads.arduino.cc || log "DNS resolution failed, please check network settings."

# ── Wait for internet ─────────────────────────────────────────────────────────
log "Waiting for internet connectivity (HTTP check)..."
MAX_WAIT=60
COUNT=0
until curl -s --max-time 5 --head https://downloads.arduino.cc > /dev/null 2>&1; do
    COUNT=$((COUNT + 1))
    if [ "$COUNT" -ge "$MAX_WAIT" ]; then
        add_error "Internet connectivity timeout after ${MAX_WAIT}s"
        exit 1
    fi
    log "Not reachable yet, retrying... (${COUNT}/${MAX_WAIT})"
    sleep 1
done
log "Internet connectivity confirmed."

# ── App brick permissions ─────────────────────────────────────────────────────
log "Installing app brick (setting permissions for models)..."
chmod +x /home/arduino/ArduinoApps/example-arduino-app-lab-object-detection-using-flask/models/rubber-ducky-linux-aarch64.eim \
    || add_error "chmod failed: rubber-ducky-linux-aarch64.eim"
chmod +x /home/arduino/ArduinoApps/example-arduino-app-lab-object-detection-using-flask/models/rubber-ducky-fomo-linux-aarch64.eim \
    || add_error "chmod failed: rubber-ducky-fomo-linux-aarch64.eim"

# ── System update ─────────────────────────────────────────────────────────────
log "Running arduino-app-cli system update..."
if ! arduino-app-cli system update --yes; then
   add_error "arduino-app-cli system update failed"
fi