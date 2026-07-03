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
# via nmcli (the module can take a while to register — up to a minute on cold
# boots).
log "Unblocking WiFi radio (rfkill) and enabling it via NetworkManager..."
rfkill unblock wifi 2>/dev/null || log "rfkill unblock wifi failed (rfkill may be absent)"
rfkill unblock all 2>/dev/null || true
nmcli radio wifi on 2>/dev/null || log "nmcli radio wifi on failed"

diagnose_wifi() {
    log "--- WiFi diagnostics ---"
    log "rfkill list:"
    rfkill list 2>&1 | while IFS= read -r L; do log "  $L"; done
    log "ip link (wl* interfaces):"
    ip -o link show 2>&1 | grep -E 'wl|wlan' | while IFS= read -r L; do log "  $L"; done
    log "nmcli device status:"
    nmcli device status 2>&1 | while IFS= read -r L; do log "  $L"; done
    log "lsmod wifi-ish modules:"
    lsmod 2>&1 | grep -Ei 'wifi|wlan|brcm|mwifiex|nrc|rtl|iwl' | while IFS= read -r L; do log "  $L"; done
    log "-------------------------"
}

log "Waiting for a WiFi interface to appear (up to 60s)..."
WIFI_DEV_WAIT=60
WIFI_DEV_COUNT=0
WIFI_DEV_READY=0
while [ "$WIFI_DEV_COUNT" -lt "$WIFI_DEV_WAIT" ]; do
    if nmcli -t -f DEVICE,TYPE device 2>/dev/null | grep -q ':wifi$'; then
        log "WiFi interface detected after ${WIFI_DEV_COUNT}s."
        WIFI_DEV_READY=1
        break
    fi
    # Kernel may see a wl* interface even if NetworkManager isn't tracking it
    # yet — poke NM to re-scan its devices in that case.
    if [ $((WIFI_DEV_COUNT % 10)) -eq 5 ] \
        && ip -o link show 2>/dev/null | grep -qE 'wl|wlan'; then
        log "Kernel has a wl* interface but nmcli doesn't; nudging NetworkManager..."
        nmcli general reload 2>/dev/null || true
    fi
    WIFI_DEV_COUNT=$((WIFI_DEV_COUNT + 1))
    sleep 1
done
if [ "$WIFI_DEV_READY" -ne 1 ]; then
    log "WARNING: no WiFi interface after ${WIFI_DEV_WAIT}s. Running diagnostics and attempting NM restart..."
    diagnose_wifi
    if command -v systemctl >/dev/null 2>&1; then
        sudo -n systemctl restart NetworkManager 2>/dev/null \
            && log "NetworkManager restarted; waiting up to 15s for wifi device..." \
            || log "Could not restart NetworkManager (no sudo?)."
        WIFI_DEV_COUNT=0
        while [ "$WIFI_DEV_COUNT" -lt 15 ]; do
            if nmcli -t -f DEVICE,TYPE device 2>/dev/null | grep -q ':wifi$'; then
                log "WiFi interface detected after NM restart (${WIFI_DEV_COUNT}s)."
                WIFI_DEV_READY=1
                break
            fi
            WIFI_DEV_COUNT=$((WIFI_DEV_COUNT + 1))
            sleep 1
        done
    fi
fi
if [ "$WIFI_DEV_READY" -ne 1 ]; then
    log "WARNING: still no WiFi interface. Attempting connect anyway."
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

    # Retry budget: up to 15 * 4s = 60s. Covers "radio not up yet", "SSID not
    # seen in the first scan", and slow driver init after a cold boot.
    WIFI_RETRY_MAX=15
    WIFI_RETRY_DELAY=4
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
            rfkill unblock all 2>/dev/null || true
            nmcli radio wifi on 2>/dev/null || true
            # Every 5th attempt: dump diagnostics + try a harder recovery.
            if [ "$WIFI_ATTEMPT" -eq 5 ] || [ "$WIFI_ATTEMPT" -eq 10 ]; then
                diagnose_wifi
                if command -v systemctl >/dev/null 2>&1; then
                    log "Attempting sudo -n systemctl restart NetworkManager..."
                    sudo -n systemctl restart NetworkManager 2>/dev/null \
                        || log "  (restart failed or no sudo)"
                fi
                nmcli general reload 2>/dev/null || true
            fi
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
            diagnose_wifi
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
# Make every .eim model under ArduinoApps executable. Missing files or a missing
# ArduinoApps directory are not errors — many boards / app folders won't have
# any .eim models at all.
log "Setting +x on any .eim models under /home/arduino/ArduinoApps (if any)..."
if [ -d /home/arduino/ArduinoApps ]; then
    EIM_COUNT=0
    EIM_FAILED=0
    while IFS= read -r -d '' EIM_PATH; do
        EIM_COUNT=$((EIM_COUNT + 1))
        if chmod +x "$EIM_PATH" 2>/dev/null; then
            log "chmod +x $EIM_PATH"
        else
            EIM_FAILED=$((EIM_FAILED + 1))
            log "WARN: chmod +x failed for $EIM_PATH (continuing)"
        fi
    done < <(find /home/arduino/ArduinoApps -type f -name '*.eim' -print0 2>/dev/null)
    log "Processed ${EIM_COUNT} .eim file(s); ${EIM_FAILED} chmod failure(s)."
else
    log "No /home/arduino/ArduinoApps directory; skipping .eim permission step."
fi

# ── System update ─────────────────────────────────────────────────────────────
log "Running arduino-app-cli system update..."
if ! arduino-app-cli system update --yes; then
   add_error "arduino-app-cli system update failed"
fi