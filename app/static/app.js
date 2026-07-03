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

// Stages Update All skips: everything except push_setup_script, chmod_script,
// run_setup. The user wants Update All to "just rerun the setup script" (no
// app push, no env push, no password change, no properties, no post-update).
const UPDATE_SKIP_STAGES = [
    "push_env",
    "change_password",
    "push_properties",
    "post_update",
];

// Stages skipped when "Skip Step 1" (WiFi creds) toggle is on.
const SKIP_STEP_WIFI_STAGES = ["push_env", "change_password"];

// Stages skipped when "Skip Step 2" (app folder) toggle is on. push_app is
// also implicitly skipped because the request goes out with upload_id=null.
const SKIP_STEP_FOLDER_STAGES = ["push_properties"];

const DEVICE_POLL_MS = 5000;

const state = {
    upload: null,
    folderFiles: null,
    devices: [],
    cards: new Map(),
    runId: null,
    ws: null,
    wifiOk: false,
    skipStep1: false,
    skipStep2: false,

    runTotal: 0,
    runCompleted: 0,
    runMode: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ---------- bootstrap ----------

async function init() {
    wireControls();
    await populateSettingsForm();
    await refreshHealth();
    await refreshDevices();
    setInterval(refreshDevices, DEVICE_POLL_MS);
}

function wireControls() {
    $("#folder-input").addEventListener("change", onFolderPicked);
    $("#refresh-btn").addEventListener("click", () => {
        refreshHealth();
        refreshDevices();
    });
    $("#run-btn").addEventListener("click", () => startRun(currentMode()));
    $("#save-settings-btn").addEventListener("click", saveSettings);
    $("#skip-step-wifi").addEventListener("change", onSkipWifiToggle);
    $("#skip-step-folder").addEventListener("change", onSkipFolderToggle);
    for (const r of $$('input[name="run-mode"]')) {
        r.addEventListener("change", () => {
            updateStartButtons();
            renderRunButtonLabel();
        });
    }
    for (const btn of $$(".pw-toggle")) {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePasswordVisibility(btn);
        });
    }
    renderRunButtonLabel();
}

function currentMode() {
    const checked = document.querySelector('input[name="run-mode"]:checked');
    return checked ? checked.value : "start";
}

function renderRunButtonLabel() {
    const btn = $("#run-btn");
    if (!btn) return;
    btn.textContent = currentMode() === "update"
        ? "Update all boards"
        : "Run on all boards";
}

function togglePasswordVisibility(btn) {
    const target = document.getElementById(btn.dataset.target);
    if (!target) return;
    const nowShowing = target.type === "password";
    target.type = nowShowing ? "text" : "password";
    btn.dataset.showing = nowShowing ? "true" : "false";
    const which = target.id === "setting-wifi-pw" ? "WiFi password" : "device password";
    btn.setAttribute("aria-label", (nowShowing ? "Hide " : "Show ") + which);
}

function onSkipWifiToggle(e) {
    state.skipStep1 = e.target.checked;
    renderWifiStepFromState();
    updateStartButtons();
}

function onSkipFolderToggle(e) {
    state.skipStep2 = e.target.checked;
    renderFolderStepFromState();
    updateStartButtons();
}

// ---------- health & WiFi step ----------

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
        renderWifiStep(j);
        updateStartButtons();
    } catch (e) {
        const el = $("#health");
        el.className = "health bad";
        el.textContent = "backend unreachable";
    }
}

function renderWifiStep(health) {
    state.wifiHealth = health;
    renderWifiStepFromState();
}

function renderWifiStepFromState() {
    const step = $("#step-wifi");
    const stateEl = $("#step-wifi-state");
    if (state.skipStep1) {
        step.dataset.status = "skipped";
        stateEl.textContent = "skipped — board keeps existing WiFi";
        return;
    }
    const h = state.wifiHealth || {};
    const ssidSet = !!h.wifi_ssid_configured;
    const pwSet = !!h.wifi_password_configured;
    if (ssidSet && pwSet) {
        step.dataset.status = "configured";
        stateEl.textContent = "✓ configured";
    } else if (!ssidSet && !pwSet) {
        step.dataset.status = "warning";
        stateEl.textContent = "SSID + password needed";
    } else if (!ssidSet) {
        step.dataset.status = "warning";
        stateEl.textContent = "SSID needed";
    } else {
        step.dataset.status = "warning";
        stateEl.textContent = "password needed";
    }
}

function renderFolderStepFromState() {
    const step = $("#step-folder");
    const stateEl = $("#step-folder-state");
    if (state.skipStep2) {
        step.dataset.status = "skipped";
        stateEl.textContent = "skipped — board keeps existing apps";
        return;
    }
    if (state.upload) {
        step.dataset.status = "configured";
        const mb = state.folderFiles ? approxSize(state.folderFiles) : "";
        stateEl.textContent = mb
            ? `${state.upload.folder_name} · ${state.upload.file_count} files · ${mb}`
            : `${state.upload.folder_name} · ${state.upload.file_count} files`;
    } else {
        step.dataset.status = "optional";
        stateEl.textContent = "none";
    }
}

// ---------- settings (always-visible inline form in Step 1) ----------

async function populateSettingsForm() {
    try {
        const r = await fetch("/api/settings");
        const j = await r.json();
        // Pre-populate all three fields with the actual saved values so the
        // user can (a) verify them with the show/hide button, and (b) edit
        // in-place. Passwords stay masked as type="password" until revealed.
        $("#setting-ssid").value = j.UNOQ_WIFI_SSID || "";
        $("#setting-wifi-pw").value = j.UNOQ_WIFI_PASSWORD || "";
        $("#setting-device-pw").value = j.UNOQ_DEFAULT_PASSWORD || "";
        $("#setting-wifi-pw").placeholder = j.UNOQ_WIFI_PASSWORD_set
            ? "(set — click show to reveal)" : "••••••••";
        $("#setting-device-pw").placeholder = j.UNOQ_DEFAULT_PASSWORD_set
            ? "(set — click show to reveal)" : "••••••••";
        renderEnvFilePath(j);
    } catch (e) {
        $("#settings-status").textContent = `load failed: ${e}`;
    }
}

function renderEnvFilePath(j) {
    const el = $("#env-file-path");
    if (!el) return;
    const path = j.env_file_path;
    if (!path) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    el.innerHTML = "";
    const label = document.createElement("span");
    label.className = "env-label";
    label.textContent = j.env_file_exists ? "stored at" : "will be created at";
    const value = document.createElement("span");
    value.textContent = path;
    el.appendChild(label);
    el.appendChild(value);
}

async function saveSettings() {
    // Fields are pre-populated with the saved values, so we send whatever's
    // currently in them. An intentionally-cleared field will overwrite the
    // stored value with an empty string.
    const body = {
        UNOQ_WIFI_SSID: $("#setting-ssid").value,
        UNOQ_WIFI_PASSWORD: $("#setting-wifi-pw").value,
        UNOQ_DEFAULT_PASSWORD: $("#setting-device-pw").value,
    };
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
        $("#settings-status").textContent = "saved ✓";
        await refreshHealth();
        await populateSettingsForm();
        setTimeout(() => {
            $("#settings-status").textContent = "";
        }, 1500);
    } catch (e) {
        $("#settings-status").textContent = `save error: ${e}`;
    }
}

// ---------- devices ----------

async function refreshDevices() {
    try {
        const r = await fetch("/api/devices");
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            updateRunStepState(j.detail || `error: ${r.status}`);
            return;
        }
        const j = await r.json();
        state.devices = j.devices;
        renderDeviceGrid();
        updateStartButtons();
    } catch (e) {
        updateRunStepState("error fetching devices");
    }
}

function renderDeviceGrid() {
    const grid = $("#devices-grid");
    const tpl = $("#device-card-template");
    const seen = new Set();
    const runActive = state.runId !== null;

    for (const d of state.devices) {
        seen.add(d.serial);
        if (state.cards.has(d.serial)) continue;

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

// ---------- folder picker (Step 2) ----------

async function onFolderPicked(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    state.folderFiles = files;
    const rootName = (files[0].webkitRelativePath || files[0].name).split("/")[0];
    state.upload = null;
    $("#step-folder-state").textContent = `${rootName} — uploading ${files.length} files…`;
    $("#step-folder").dataset.status = "optional";
    renderEimList(null);

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
            $("#step-folder-state").textContent = `upload failed: ${j.detail || r.status}`;
            $("#step-folder").dataset.status = "warning";
            return;
        }
        const j = await r.json();
        state.upload = j;
        renderFolderStepFromState();
        renderEimList(j.eim_files || []);
        updateStartButtons();
    } catch (err) {
        $("#step-folder-state").textContent = `upload error: ${err}`;
        $("#step-folder").dataset.status = "warning";
    }
}

function renderEimList(eimFiles) {
    const wrap = $("#eim-info");
    const ul = $("#eim-list");
    ul.innerHTML = "";
    if (eimFiles == null || eimFiles.length === 0) {
        wrap.hidden = eimFiles == null;
        if (eimFiles && eimFiles.length === 0) {
            wrap.hidden = false;
            const li = document.createElement("li");
            li.className = "eim-empty";
            li.textContent = "no .eim files";
            ul.appendChild(li);
        }
        return;
    }
    wrap.hidden = false;
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
    return formatBytes(total);
}

// ---------- Step 3: run buttons ----------

function updateStartButtons() {
    const haveDevices = state.devices.length > 0;
    const haveFolder = !!state.upload;
    const idle = state.runId === null;
    const mode = currentMode();

    const step1ok = state.wifiOk || state.skipStep1;
    const step2ok = haveFolder || state.skipStep2;

    // In "update" mode we don't push WiFi creds/app/properties, so only devices
    // being connected matters. In "start" (full setup) mode we need steps 1+2
    // to be satisfied (or skipped).
    const ready = mode === "update"
        ? (haveDevices && idle)
        : (haveDevices && idle && step1ok && step2ok);

    const btn = $("#run-btn");
    btn.disabled = !ready;
    if (ready) {
        btn.title = mode === "update"
            ? "Re-run setup script on all boards (no app push, no WiFi change)"
            : "Push app (if not skipped), configure WiFi, run setup + post-update";
    } else if (!idle) {
        btn.title = "A run is in progress";
    } else if (!haveDevices) {
        btn.title = "Connect at least one UNO Q";
    } else {
        btn.title = missingFor(mode, haveDevices, step1ok, step2ok, idle);
    }

    updateRunStepState();
}

function missingFor(mode, haveDevices, step1ok, step2ok, idle) {
    if (!idle) return "A run is in progress";
    const missing = [];
    if (!haveDevices) missing.push("connect at least one UNO Q");
    if (mode !== "update") {
        if (!step1ok) missing.push("configure WiFi or check 'Skip' in Step 1");
        if (!step2ok) missing.push("choose a folder or check 'Skip' in Step 2");
    }
    return missing.length ? "Needed: " + missing.join("; ") : "";
}

function updateRunStepState(override) {
    const step = $("#step-run");
    const stateEl = $("#step-run-state");
    if (override) {
        stateEl.textContent = override;
        step.dataset.status = "warning";
        return;
    }
    const n = state.devices.length;
    if (state.runId !== null) {
        step.dataset.status = "ready";
        stateEl.textContent = `running on ${state.runTotal} board${state.runTotal === 1 ? "" : "s"}`;
        return;
    }
    if (n === 0) {
        step.dataset.status = "pending";
        stateEl.textContent = "no boards detected";
        return;
    }
    const ready = state.wifiOk;
    step.dataset.status = ready ? "ready" : "pending";
    const folderPart = state.upload
        ? `folder: ${state.upload.folder_name}`
        : "no folder";
    stateEl.textContent = `${n} board${n === 1 ? "" : "s"} · ${folderPart}`;
}

// ---------- runs ----------

async function startRun(mode /* 'start' | 'update' */) {
    if (state.devices.length === 0) return;
    state.runMode = mode;

    let baseSkip;
    if (mode === "update") {
        baseSkip = [...UPDATE_SKIP_STAGES];
    } else {
        baseSkip = [];
        if (state.skipStep1) baseSkip.push(...SKIP_STEP_WIFI_STAGES);
        if (state.skipStep2) baseSkip.push(...SKIP_STEP_FOLDER_STAGES);
    }

    const devices = state.devices.map((d) => {
        const userSkip = collectSkip(d.serial);
        const skip = Array.from(new Set([...baseSkip, ...userSkip]));
        return { serial: d.serial, skip_stages: skip };
    });

    const postUpdateCmd = mode === "update"
        ? ""
        : ($("#post-update-cmd").value || "").trim();

    // Update All never sends the upload. Start All omits it too when step 2
    // is skipped.
    const sendUpload = mode !== "update" && !state.skipStep2 && state.upload;

    resetAllCards();
    showRunProgress(state.devices.length, mode);

    const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            upload_id: sendUpload ? state.upload.upload_id : null,
            devices,
            post_update_cmd: postUpdateCmd || null,
        }),
    });
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        $("#run-status").textContent = `start failed: ${j.detail || r.status}`;
        hideRunProgress();
        return;
    }
    const j = await r.json();
    state.runId = j.run_id;
    $("#run-status").textContent =
        `${mode === "update" ? "Update" : "Run"} ${j.run_id} in progress…`;
    updateStartButtons();
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
    if (state.runMode === "update") {
        for (const s of UPDATE_SKIP_STAGES) {
            if (!skip.includes(s)) skip.push(s);
        }
    }
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

// ---------- aggregate progress bar ----------

function showRunProgress(total, mode) {
    state.runTotal = total;
    state.runCompleted = 0;
    $("#run-progress-bar").hidden = false;
    $("#run-progress-label").textContent =
        mode === "update" ? "Updating boards…" : "Flashing boards…";
    $("#run-progress-counts").textContent = `0/${total}`;
    $("#run-progress-fill").style.width = "0%";
}

function bumpRunProgress() {
    state.runCompleted += 1;
    const pct = state.runTotal === 0 ? 0
        : (state.runCompleted / state.runTotal) * 100;
    $("#run-progress-fill").style.width = `${pct}%`;
    $("#run-progress-counts").textContent =
        `${state.runCompleted}/${state.runTotal}`;
}

function hideRunProgress() {
    setTimeout(() => {
        $("#run-progress-bar").hidden = true;
    }, 2500);
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
        state.runId = null;
        for (const serial of state.cards.keys()) stopLiveTimer(serial);
        updateStartButtons();
        hideRunProgress();
    };
    ws.onerror = () => console.log("ws error");
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
            startLiveTimer(ev.device);
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
            stopLiveTimer(ev.device);
            c.badgeEl.dataset.status = ev.result;
            c.badgeEl.textContent = ev.result;
            c.stageEl.textContent = ev.result;
            if (ev.elapsed_seconds != null) {
                const t = Math.round(ev.elapsed_seconds);
                c.elapsedEl.textContent = formatElapsed(t);
                c.elapsedEl.dataset.state = "final";
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
            bumpRunProgress();
            break;
        }
        case "run_finished": {
            $("#run-status").textContent =
                `done · ${ev.successful.length} ok, ${ev.failed.length} failed`;
            state.runId = null;
            updateStartButtons();
            hideRunProgress();
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

function resetAllCards() {
    for (const [serial] of state.cards) resetCard(serial);
}

function resetCard(serial) {
    const c = state.cards.get(serial);
    if (!c) return;
    stopLiveTimer(serial);
    c.badgeEl.dataset.status = "idle";
    c.badgeEl.textContent = "idle";
    c.progressEl.style.width = "0%";
    c.stageEl.textContent = "—";
    c.logEl.innerHTML = "";
    c.retryBtn.hidden = true;
    c.failureEl.hidden = true;
    c.summaryEl.hidden = true;
    c.elapsedEl.hidden = true;
    c.elapsedEl.dataset.state = "";
}

// ---------- per-device live elapsed timer ----------

function formatElapsed(seconds) {
    const t = Math.max(0, Math.floor(seconds));
    return `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
}

function startLiveTimer(serial) {
    const c = state.cards.get(serial);
    if (!c) return;
    stopLiveTimer(serial);
    const startedAt = performance.now();
    c.elapsedEl.hidden = false;
    c.elapsedEl.dataset.state = "live";
    c.elapsedEl.textContent = formatElapsed(0);
    const timerId = setInterval(() => {
        const secs = (performance.now() - startedAt) / 1000;
        c.elapsedEl.textContent = formatElapsed(secs);
    }, 1000);
    c.timerId = timerId;
}

function stopLiveTimer(serial) {
    const c = state.cards.get(serial);
    if (!c || !c.timerId) return;
    clearInterval(c.timerId);
    c.timerId = null;
}

init();
