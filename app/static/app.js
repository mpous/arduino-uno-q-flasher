// Arduino UNO Q Flasher — frontend logic.
// Single page; no build step.

const STAGES = [
    "push_app",
    "push_setup_script",
    "push_env",
    "chmod_script",
    "change_password",
    "push_properties",
    "run_setup",
    "post_update",
];

const DEVICE_POLL_MS = 5000;

const state = {
    upload: null,        // { upload_id, folder_name, file_count }
    folderFiles: null,   // FileList from the picker
    devices: [],         // [{ serial, state }]
    cards: new Map(),    // serial -> { card, logEl, progressEl, stageEl, badgeEl, retryBtn, skipInputs }
    runId: null,
    ws: null,
    wifiOk: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- bootstrap ----------

async function init() {
    await refreshHealth();
    await refreshDevices();
    wireControls();
    setInterval(refreshDevices, DEVICE_POLL_MS);
}

async function refreshHealth() {
    try {
        const r = await fetch("/api/health");
        const j = await r.json();
        const el = $("#health");
        if (!j.adb_available) {
            el.className = "health bad";
            el.textContent = `ADB not found: ${j.adb_error}`;
        } else {
            el.className = "health ok";
            const pw = j.password_configured ? "device pw set" : "no device pw";
            el.textContent = `ADB ready · ${pw}`;
        }
        state.wifiOk = j.wifi_ssid_configured && j.wifi_password_configured;
        renderWifiBanner(j);
        updateStartButton();
    } catch (e) {
        const el = $("#health");
        el.className = "health bad";
        el.textContent = "backend unreachable";
    }
}

function renderWifiBanner(health) {
    const banner = $("#wifi-banner");
    const text = $("#wifi-banner-text");
    if (!health.wifi_ssid_configured && !health.wifi_password_configured) {
        text.textContent = "WiFi SSID and password not set — devices will fail at setup.";
        banner.hidden = false;
    } else if (!health.wifi_ssid_configured) {
        text.textContent = "WiFi SSID not set — devices will fail at setup.";
        banner.hidden = false;
    } else if (!health.wifi_password_configured) {
        text.textContent = "WiFi password not set — devices will fail at setup.";
        banner.hidden = false;
    } else {
        banner.hidden = true;
    }
}

async function refreshDevices() {
    try {
        const r = await fetch("/api/devices");
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            $("#device-count").textContent = j.detail || `error: ${r.status}`;
            return;
        }
        const j = await r.json();
        state.devices = j.devices;
        renderDeviceGrid();
        $("#device-count").textContent = `${state.devices.length} device(s) detected`;
        updateStartButton();
    } catch (e) {
        $("#device-count").textContent = "error fetching devices";
    }
}

function renderDeviceGrid() {
    const grid = $("#devices-grid");
    const tpl = $("#device-card-template");
    const seen = new Set();
    const runActive = state.runId !== null;

    for (const d of state.devices) {
        seen.add(d.serial);
        if (state.cards.has(d.serial)) continue;  // keep existing card + logs

        const node = tpl.content.firstElementChild.cloneNode(true);
        node.dataset.serial = d.serial;
        node.querySelector(".device-serial").textContent = d.serial;

        const badgeEl = node.querySelector(".status-badge");
        const progressEl = node.querySelector(".progress-fill");
        const stageEl = node.querySelector(".current-stage");
        const logEl = node.querySelector(".log-panel");
        const retryBtn = node.querySelector(".retry-btn");
        const identifyBtn = node.querySelector(".identify-btn");
        const elapsedEl = node.querySelector(".elapsed");
        const failureEl = node.querySelector(".failure-reason");
        const summaryEl = node.querySelector(".summary-panel");
        const skipInputs = Array.from(node.querySelectorAll(".skip-toggle"));

        retryBtn.addEventListener("click", () => retryDevice(d.serial));
        identifyBtn.addEventListener("click", () => identifyDevice(d.serial));

        grid.appendChild(node);
        state.cards.set(d.serial, {
            card: node, badgeEl, progressEl, stageEl, logEl, retryBtn, identifyBtn,
            elapsedEl, failureEl, summaryEl, skipInputs,
        });
    }

    // Remove cards for devices that disappeared — but only when idle. Mid-run
    // we keep them visible (with their logs) even if adb briefly drops them.
    if (!runActive) {
        for (const serial of Array.from(state.cards.keys())) {
            if (!seen.has(serial)) {
                const c = state.cards.get(serial);
                c.card.remove();
                state.cards.delete(serial);
            }
        }
    }
}

// ---------- controls ----------

function wireControls() {
    $("#folder-input").addEventListener("change", onFolderPicked);
    $("#refresh-btn").addEventListener("click", () => {
        refreshHealth();
        refreshDevices();
    });
    $("#start-btn").addEventListener("click", startRun);
    $("#retry-failed-btn").addEventListener("click", retryAllFailed);
    $("#open-settings-btn").addEventListener("click", openSettings);
    $("#close-settings-btn").addEventListener("click", () => {
        $("#settings-panel").hidden = true;
    });
    $("#save-settings-btn").addEventListener("click", saveSettings);
}

async function openSettings() {
    const panel = $("#settings-panel");
    panel.hidden = false;
    try {
        const r = await fetch("/api/settings");
        const j = await r.json();
        $("#setting-ssid").value = j.UNOQ_WIFI_SSID || "";
        $("#setting-wifi-pw").placeholder = j.UNOQ_WIFI_PASSWORD_set ? "(set — leave blank to keep)" : "••••••••";
        $("#setting-device-pw").placeholder = j.UNOQ_DEFAULT_PASSWORD_set ? "(set — leave blank to keep)" : "••••••••";
    } catch (e) {
        $("#settings-status").textContent = `load failed: ${e}`;
    }
}

async function saveSettings() {
    const body = {};
    const ssid = $("#setting-ssid").value;
    const wifiPw = $("#setting-wifi-pw").value;
    const devPw = $("#setting-device-pw").value;
    // Only send non-empty values; empty means "don't touch".
    if (ssid !== "") body.UNOQ_WIFI_SSID = ssid;
    if (wifiPw !== "") body.UNOQ_WIFI_PASSWORD = wifiPw;
    if (devPw !== "") body.UNOQ_DEFAULT_PASSWORD = devPw;
    if (Object.keys(body).length === 0) {
        $("#settings-status").textContent = "nothing to save";
        return;
    }
    try {
        const r = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            $("#settings-status").textContent = `save failed: ${j.detail || r.status}`;
            return;
        }
        $("#settings-status").textContent = "saved";
        $("#setting-wifi-pw").value = "";
        $("#setting-device-pw").value = "";
        await refreshHealth();
    } catch (e) {
        $("#settings-status").textContent = `save error: ${e}`;
    }
}

async function onFolderPicked(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    state.folderFiles = files;
    const rootName = (files[0].webkitRelativePath || files[0].name).split("/")[0];
    $("#folder-info").textContent = `${rootName} — uploading ${files.length} files…`;
    renderEimList(null);  // hide while uploading

    const fd = new FormData();
    fd.append("folder_name", rootName);
    for (const f of files) {
        fd.append("files", f, f.name);
        fd.append("paths", f.webkitRelativePath || f.name);
    }
    try {
        const r = await fetch("/api/upload", { method: "POST", body: fd });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            $("#folder-info").textContent = `upload failed: ${j.detail || r.status}`;
            return;
        }
        const j = await r.json();
        state.upload = j;
        const mb = approxSize(files);
        $("#folder-info").textContent = `${j.folder_name} · ${j.file_count} files · ${mb}`;
        renderEimList(j.eim_files || []);
        updateStartButton();
    } catch (err) {
        $("#folder-info").textContent = `upload error: ${err}`;
    }
}

function renderEimList(eimFiles) {
    const wrap = $("#eim-info");
    const ul = $("#eim-list");
    ul.innerHTML = "";
    if (eimFiles == null) {
        wrap.hidden = true;
        return;
    }
    wrap.hidden = false;
    if (eimFiles.length === 0) {
        const li = document.createElement("li");
        li.className = "eim-empty";
        li.textContent = "no .eim files found in this folder";
        ul.appendChild(li);
        return;
    }
    for (const e of eimFiles) {
        const li = document.createElement("li");
        const name = document.createElement("span");
        name.className = "eim-name";
        name.textContent = e.path;
        const size = document.createElement("span");
        size.className = "eim-size";
        size.textContent = formatBytes(e.size_bytes);
        li.appendChild(name);
        li.appendChild(size);
        ul.appendChild(li);
    }
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function approxSize(files) {
    let total = 0;
    for (const f of files) total += f.size;
    if (total < 1024) return `${total} B`;
    if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`;
    return `${(total / (1024 * 1024)).toFixed(1)} MB`;
}

function updateStartButton() {
    const ready =
        state.devices.length > 0 &&
        state.runId === null &&
        state.wifiOk;
    $("#start-btn").disabled = !ready;
    let title = "";
    if (!state.wifiOk) title = "Configure WiFi credentials first";
    else if (state.devices.length === 0) title = "Connect at least one UNO Q";
    else if (!state.upload) title = "No app folder selected — will run setup + post-update only";
    $("#start-btn").title = title;
}

// ---------- runs ----------

async function startRun() {
    if (state.devices.length === 0) return;
    const devices = state.devices.map((d) => {
        const skip = collectSkip(d.serial);
        return { serial: d.serial, skip_stages: skip };
    });
    const postUpdateCmd = ($("#post-update-cmd").value || "").trim();
    resetAllCards();
    const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            upload_id: state.upload ? state.upload.upload_id : null,
            devices,
            post_update_cmd: postUpdateCmd || null,
        }),
    });
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        $("#run-status").textContent = `start failed: ${j.detail || r.status}`;
        return;
    }
    const j = await r.json();
    state.runId = j.run_id;
    $("#run-status").textContent = `run ${j.run_id} in progress…`;
    $("#start-btn").disabled = true;
    $("#retry-failed-btn").disabled = true;
    openWs(j.run_id);
}

function collectSkip(serial) {
    const card = state.cards.get(serial);
    if (!card) return [];
    return card.skipInputs.filter((i) => i.checked).map((i) => i.dataset.stage);
}

async function retryDevice(serial) {
    if (!state.runId) return;
    const skip = collectSkip(serial);
    resetCard(serial);
    const r = await fetch(`/api/runs/${state.runId}/devices/${serial}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skip_stages: skip }),
    });
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        appendLog(serial, `retry failed: ${j.detail || r.status}`, "err");
    }
}

async function retryAllFailed() {
    if (!state.runId) return;
    for (const [serial, card] of state.cards) {
        if (card.badgeEl.dataset.status === "failed") {
            await retryDevice(serial);
        }
    }
}

async function identifyDevice(serial) {
    const c = state.cards.get(serial);
    if (!c) return;
    const btn = c.identifyBtn;
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Blinking…";
    try {
        const r = await fetch(`/api/devices/${encodeURIComponent(serial)}/identify`, {
            method: "POST",
        });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            appendLog(serial, `identify failed: ${j.detail || r.status}`, "err");
        }
    } catch (err) {
        appendLog(serial, `identify error: ${err}`, "err");
    } finally {
        btn.disabled = false;
        btn.textContent = prevText;
    }
}

// ---------- WebSocket ----------

function openWs(runId) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/runs/${runId}`);
    state.ws = ws;
    ws.onmessage = (e) => {
        let ev;
        try { ev = JSON.parse(e.data); } catch { return; }
        handleEvent(ev);
    };
    ws.onclose = () => {
        $("#run-status").textContent = `run ${runId} finished`;
        updateStartButton();
        $("#retry-failed-btn").disabled = !anyFailed();
    };
    ws.onerror = () => {
        appendGlobal("ws error", "err");
    };
}

function anyFailed() {
    for (const [, c] of state.cards) {
        if (c.badgeEl.dataset.status === "failed") return true;
    }
    return false;
}

function handleEvent(ev) {
    switch (ev.type) {
        case "device_started": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            c.badgeEl.dataset.status = "running";
            c.badgeEl.textContent = "running";
            c.retryBtn.hidden = true;
            c.failureEl.hidden = true;
            c.summaryEl.hidden = true;
            c.elapsedEl.hidden = true;
            break;
        }
        case "stage": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            const idx = STAGES.indexOf(ev.stage);
            const pct = ev.status === "completed" || ev.status === "skipped"
                ? ((idx + 1) / STAGES.length) * 100
                : (idx / STAGES.length) * 100;
            c.progressEl.style.width = `${pct}%`;
            c.stageEl.textContent = `${ev.stage} · ${ev.status}`;
            appendLog(ev.device, `[${ev.stage}] ${ev.status}`, "stage");
            break;
        }
        case "log": {
            const cls = ev.stream === "stderr" ? "err" : "";
            const prefix = ev.stage ? `[${ev.stage}] ` : "";
            appendLog(ev.device, prefix + ev.line, cls);
            break;
        }
        case "setup_summary": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            c.summaryEl.hidden = false;
            c.summaryEl.querySelector(".summary-status").dataset.status = ev.status;
            c.summaryEl.querySelector(".summary-status").textContent = ev.status;
            const t = ev.elapsed_seconds;
            c.summaryEl.querySelector(".summary-time").textContent =
                t == null ? "—" : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
            const ul = c.summaryEl.querySelector(".summary-errors");
            ul.innerHTML = "";
            for (const err of ev.errors || []) {
                const li = document.createElement("li");
                li.textContent = err;
                ul.appendChild(li);
            }
            break;
        }
        case "device_finished": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            c.badgeEl.dataset.status = ev.result;
            c.badgeEl.textContent = ev.result;
            c.stageEl.textContent = ev.result;
            if (ev.elapsed_seconds != null) {
                const t = Math.round(ev.elapsed_seconds);
                c.elapsedEl.textContent = `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
                c.elapsedEl.hidden = false;
            }
            if (ev.failure_reason) {
                c.failureEl.textContent = ev.failure_reason;
                c.failureEl.hidden = false;
            }
            if (ev.result === "failed") {
                c.retryBtn.hidden = false;
            } else {
                c.progressEl.style.width = "100%";
            }
            break;
        }
        case "run_finished": {
            $("#run-status").textContent =
                `done · ${ev.successful.length} ok, ${ev.failed.length} failed`;
            $("#retry-failed-btn").disabled = ev.failed.length === 0;
            $("#start-btn").disabled = false;
            break;
        }
    }
}

// ---------- log helpers ----------

function appendLog(serial, line, cls = "") {
    const c = state.cards.get(serial);
    if (!c) return;
    const span = document.createElement("span");
    if (cls === "stage") span.className = "log-stage";
    else if (cls === "err") span.className = "log-err";
    else if (cls === "info") span.className = "log-info";
    span.textContent = line + "\n";
    c.logEl.appendChild(span);
    c.logEl.scrollTop = c.logEl.scrollHeight;
}

function appendGlobal(line, cls = "") {
    console.log(line);
}

function resetAllCards() {
    for (const [serial] of state.cards) resetCard(serial);
}

function resetCard(serial) {
    const c = state.cards.get(serial);
    if (!c) return;
    c.badgeEl.dataset.status = "idle";
    c.badgeEl.textContent = "idle";
    c.progressEl.style.width = "0%";
    c.stageEl.textContent = "—";
    c.logEl.innerHTML = "";
    c.retryBtn.hidden = true;
    c.failureEl.hidden = true;
    c.summaryEl.hidden = true;
    c.elapsedEl.hidden = true;
}

init();
