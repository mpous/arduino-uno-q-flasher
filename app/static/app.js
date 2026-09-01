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
    "prune_docker_images",
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

    runFinalStatusText: null,
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
    $("#wifi-check-all-btn")?.addEventListener("click", wifiCheckAllDevices);
    $("#run-btn").addEventListener("click", () => startRun());
    $("#save-settings-btn").addEventListener("click", saveSettings);
    $("#skip-step-wifi").addEventListener("change", onSkipWifiToggle);
    $("#skip-step-folder").addEventListener("change", onSkipFolderToggle);
    for (const id of [
        "#run-step-wifi",
        "#run-step-app",
        "#run-step-setup",
        "#run-step-prune",
        "#run-step-post-update",
    ]) {
        const el = $(id);
        if (el) el.addEventListener("change", updateStartButtons);
    }
    $("#post-update-cmd")?.addEventListener("input", updateStartButtons);
    for (const btn of $$(".pw-toggle")) {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePasswordVisibility(btn);
        });
    }
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
        const wifiCheckBtn = node.querySelector(".wifi-check-btn");
        const wifiBadgeEl = node.querySelector(".wifi-badge");
        const elapsedEl = node.querySelector(".elapsed");
        const failureEl = node.querySelector(".failure-reason");
        const summaryEl = node.querySelector(".summary-panel");
        const skipInputs = Array.from(node.querySelectorAll(".skip-toggle"));

        const logFollowState = { follow: true };
        logEl.addEventListener("scroll", () => {
            const nearBottom =
                (logEl.scrollTop + logEl.clientHeight) >= (logEl.scrollHeight - 12);
            logFollowState.follow = nearBottom;
        });

        retryBtn.addEventListener("click", () => retryDevice(d.serial));
        identifyBtn.addEventListener("click", () => identifyDevice(d.serial));
        wifiCheckBtn.addEventListener("click", () => wifiCheckDevice(d.serial));

        grid.appendChild(node);
        state.cards.set(d.serial, {
            card: node, badgeEl, progressEl, stageEl, logEl, retryBtn, identifyBtn,
            wifiCheckBtn, wifiBadgeEl, elapsedEl, failureEl, summaryEl, skipInputs, logFollowState,
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
    const doWifi = !!$("#run-step-wifi")?.checked;
    const doApp = !!$("#run-step-app")?.checked;
    const doSetup = !!$("#run-step-setup")?.checked;
    const doPost = !!$("#run-step-post-update")?.checked;
    const doPrune = !!$("#run-step-prune")?.checked;
    const postCmd = (($("#post-update-cmd")?.value) || "").trim();

    const step1ok = state.wifiOk || state.skipStep1;
    const step2ok = haveFolder || state.skipStep2;

    const needsStep1Inputs = doWifi && !state.skipStep1;
    const needsStep2Inputs = doApp && !state.skipStep2;
    const needsPostCommand = doPost;
    const ready = haveDevices
        && idle
        && (!needsStep1Inputs || step1ok)
        && (!needsStep2Inputs || step2ok)
        && (!needsPostCommand || postCmd.length > 0);

    const btn = $("#run-btn");
    btn.disabled = !ready;
    if (ready) {
        const selected = ["run setup"];
        if (doWifi && !state.skipStep1) selected.unshift("WiFi/password");
        if (doApp && !state.skipStep2) selected.unshift("app push");
        if (!doSetup) selected.splice(selected.indexOf("run setup"), 1);
        if (doPrune) selected.push("docker prune");
        if (doPost) selected.push("post-update");
        if (selected.length === 0) selected.push("no-op");
        btn.title = `Run selected steps: ${selected.join(", ")}`;
    } else if (!idle) {
        btn.title = "A run is in progress";
    } else if (!haveDevices) {
        btn.title = "Connect at least one UNO Q";
    } else {
        btn.title = missingFor({
            haveDevices,
            step1ok,
            step2ok,
            idle,
            needsStep1Inputs,
            needsStep2Inputs,
            needsPostCommand,
            postCmd,
        });
    }

    updateRunStepState();
}

function missingFor({
    haveDevices,
    step1ok,
    step2ok,
    idle,
    needsStep1Inputs,
    needsStep2Inputs,
    needsPostCommand,
    postCmd,
}) {
    if (!idle) return "A run is in progress";
    const missing = [];
    if (!haveDevices) missing.push("connect at least one UNO Q");
    if (needsStep1Inputs && !step1ok) missing.push("configure WiFi or uncheck Step 1 in Run");
    if (needsStep2Inputs && !step2ok) missing.push("choose a folder or uncheck Step 2 in Run");
    if (needsPostCommand && !postCmd) missing.push("set Post-update command or uncheck Step 5 in Run");
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
        stateEl.textContent = `running on ${n} board${n === 1 ? "" : "s"}`;
        return;
    }
    if (n === 0) {
        step.dataset.status = "pending";
        stateEl.textContent = "no boards detected";
        return;
    }
    const doWifi = !!$("#run-step-wifi")?.checked;
    const doApp = !!$("#run-step-app")?.checked;
    const doSetup = !!$("#run-step-setup")?.checked;
    const doPrune = !!$("#run-step-prune")?.checked;
    const doPost = !!$("#run-step-post-update")?.checked;
    const ready = (!doWifi || state.wifiOk || state.skipStep1);
    step.dataset.status = ready ? "ready" : "pending";
    const selected = [];
    if (doWifi && !state.skipStep1) selected.push("step 1");
    if (doApp && !state.skipStep2) selected.push("step 2");
    if (doSetup) selected.push("step 3");
    if (doPrune) selected.push("step 4");
    if (doPost) selected.push("step 5");
    if (selected.length === 0) selected.push("no-op");
    stateEl.textContent = `${n} board${n === 1 ? "" : "s"} · ${selected.join(", ")}`;
}

// ---------- runs ----------

async function startRun() {
    if (state.devices.length === 0) return;
    state.runFinalStatusText = null;

    const doWifi = !!$("#run-step-wifi")?.checked;
    const doApp = !!$("#run-step-app")?.checked;
    const doSetup = !!$("#run-step-setup")?.checked;
    const doPostUpdate = !!$("#run-step-post-update")?.checked;
    const doPrune = !!$("#run-step-prune")?.checked;

    const baseSkip = [];
    if (!doWifi || state.skipStep1) baseSkip.push(...SKIP_STEP_WIFI_STAGES);
    if (!doApp || state.skipStep2) baseSkip.push("push_app", ...SKIP_STEP_FOLDER_STAGES);
    if (!doSetup) baseSkip.push("push_setup_script", "chmod_script", "run_setup");
    if (!doPostUpdate) baseSkip.push("post_update");

    const devices = state.devices.map((d) => {
        const userSkip = collectSkip(d.serial);
        const skip = Array.from(new Set([...baseSkip, ...userSkip]));
        return { serial: d.serial, skip_stages: skip };
    });

    const postUpdateCmd = doPostUpdate
        ? (($("#post-update-cmd").value || "").trim())
        : "";
    const pruneDockerBeforePostUpdate = doPrune;

    // Only send upload when Step 2 is selected and not skipped.
    const sendUpload = doApp && !state.skipStep2 && state.upload;

    resetAllCards();

    const r = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            upload_id: sendUpload ? state.upload.upload_id : null,
            devices,
            post_update_cmd: postUpdateCmd || null,
            prune_docker_before_post_update: pruneDockerBeforePostUpdate,
        }),
    });
    if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        $("#run-status").textContent = `start failed: ${j.detail || r.status}`;
        return;
    }
    const j = await r.json();
    state.runId = j.run_id;
    $("#run-status").textContent = `Run ${j.run_id} in progress…`;
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

async function wifiCheckDevice(serial) {
    const c = state.cards.get(serial);
    if (!c) return;
    const btn = c.wifiCheckBtn;
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Checking…";
    setWifiBadge(c, "unknown", "checking...");
    appendLog(serial, "--- wifi check started ---", "info");
    try {
        const r = await fetch(`/api/devices/${encodeURIComponent(serial)}/wifi-check`, {
            method: "POST",
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
            appendLog(serial, `wifi check failed: ${j.detail || r.status}`, "err");
            return;
        }

        const out = String(j.output || "").trim();
        if (out) {
            for (const line of out.split("\n")) {
                appendLog(serial, line, "info");
            }
        }
        appendLog(
            serial,
            j.ok
                ? "--- wifi check passed ---"
                : `--- wifi check failed (exit ${j.exit_code}) ---`,
            j.ok ? "info" : "err",
        );
        if (j.ok) {
            setWifiBadge(c, "pass", "connectivity check passed");
        } else {
            setWifiBadge(c, "fail", `connectivity check failed (exit ${j.exit_code})`);
        }
    } catch (err) {
        setWifiBadge(c, "fail", "connectivity check error");
        appendLog(serial, `wifi check error: ${err}`, "err");
    } finally {
        btn.disabled = false;
        btn.textContent = prevText;
    }
}

async function wifiCheckAllDevices() {
    const btn = $("#wifi-check-all-btn");
    if (!btn) return;
    const serials = state.devices.map((d) => d.serial).filter((s) => state.cards.has(s));
    if (serials.length === 0) {
        $("#run-status").textContent = "No connected boards to check";
        return;
    }

    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = `Checking ${serials.length} board${serials.length === 1 ? "" : "s"}…`;

    const results = await Promise.allSettled(serials.map((serial) => wifiCheckDevice(serial)));
    const passed = serials.filter((serial) => {
        const c = state.cards.get(serial);
        return c?.wifiBadgeEl?.dataset?.status === "pass";
    }).length;
    const failed = serials.length - passed;

    const rejected = results.filter((r) => r.status === "rejected").length;
    $("#run-status").textContent = rejected > 0
        ? `WiFi checks complete: ${passed} passed, ${failed} failed (${rejected} request error${rejected === 1 ? "" : "s"})`
        : `WiFi checks complete: ${passed} passed, ${failed} failed`;

    btn.disabled = false;
    btn.textContent = prevText;
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
        if (state.runId !== null && !state.runFinalStatusText) {
            $("#run-status").textContent =
                `run ${runId} disconnected before completion`; 
        } else if (state.runFinalStatusText) {
            $("#run-status").textContent = state.runFinalStatusText;
        }
        state.runId = null;
        for (const serial of state.cards.keys()) stopLiveTimer(serial);
        updateStartButtons();
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
            c.summaryEl.hidden = false;
            c.summary = makeSummaryState();
            c.summary.overallStatus = "running";
            c.summary.overallText = "running";
            c.summary.phase = "starting update";
            renderSummary(c);
            startLiveTimer(ev.device);
            break;
        }
        case "device_retry": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            // A new attempt is about to begin — clear the previous attempt's
            // FAILED summary/reason so the card doesn't look done. Keep the
            // live timer running (elapsed accumulates across attempts).
            c.badgeEl.dataset.status = "running";
            c.badgeEl.textContent = `retry ${ev.attempt}/${ev.max_attempts}`;
            c.failureEl.hidden = true;
            c.summaryEl.hidden = false;
            c.summary = makeSummaryState();
            c.summary.overallStatus = "running";
            c.summary.overallText = "running";
            c.summary.phase = `retrying (${ev.attempt}/${ev.max_attempts})`;
            c.progressEl.style.width = "0%";
            c.stageEl.textContent = "retrying…";
            renderSummary(c);
            appendLog(
                ev.device,
                `--- retry attempt ${ev.attempt}/${ev.max_attempts}${ev.reason ? " · " + ev.reason : ""} ---`,
                "info",
            );
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
            updateSummaryFromStage(c, ev.stage, ev.status);
            renderSummary(c);
            appendLog(ev.device, `[${ev.stage}] ${ev.status}`, "stage");
            break;
        }
        case "log": {
            const cls = ev.stream === "stderr" ? "err" : "";
            const prefix = ev.stage ? `[${ev.stage}] ` : "";
            const c = state.cards.get(ev.device);
            if (c) {
                collectSummaryWarnings(c, ev);
                renderSummary(c);
            }
            appendLog(ev.device, prefix + ev.line, cls);
            break;
        }
        case "setup_summary": {
            const c = state.cards.get(ev.device);
            if (!c) return;
            c.summaryEl.hidden = false;
            c.summary.setupStatus = ev.status;
            c.summary.setupTime = ev.elapsed_seconds;
            c.summary.setupErrors = Array.isArray(ev.errors) ? ev.errors : [];
            c.summary.phase = ev.status === "SUCCESS"
                ? "setup script succeeded, continuing"
                : "setup script reported failure";
            renderSummary(c);
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
            c.summaryEl.hidden = false;
            c.summary.overallStatus = ev.result;
            c.summary.overallText = ev.result === "success" ? "complete" : "failed";
            c.summary.phase = ev.result === "success"
                ? "all stages finished"
                : `failed${ev.failure_reason ? ": " + ev.failure_reason : ""}`;
            if (c.summary.postUpdate.status === "pending") {
                c.summary.postUpdate = {
                    status: "skipped",
                    text: "not run",
                };
            }
            renderSummary(c);
            break;
        }
        case "run_finished": {
            state.runFinalStatusText =
                `run complete · ${ev.successful.length} ok, ${ev.failed.length} failed`;
            $("#run-status").textContent = state.runFinalStatusText;
            state.runId = null;
            updateStartButtons();
            break;
        }
    }
}

function makeSummaryState() {
    return {
        overallStatus: "running",
        overallText: "running",
        phase: "waiting for first stage",
        setupStatus: "—",
        setupTime: null,
        setupErrors: [],
        postUpdate: {
            status: "pending",
            text: "pending",
        },
        warnings: [],
    };
}

function updateSummaryFromStage(c, stage, status) {
    if (!c.summary) c.summary = makeSummaryState();

    if (stage === "run_setup" && status === "started") {
        c.summary.phase = "running setup script";
    } else if (stage === "run_setup" && (status === "completed" || status === "skipped")) {
        c.summary.phase = "setup script done, finalizing";
    } else if (stage === "run_setup" && status === "failed") {
        c.summary.phase = "setup script failed";
    }

    if (stage === "post_update") {
        if (status === "started") {
            c.summary.postUpdate = { status: "running", text: "running" };
            c.summary.phase = "running post-update";
        } else if (status === "completed") {
            c.summary.postUpdate = { status: "completed", text: "completed" };
            c.summary.phase = "post-update complete";
        } else if (status === "skipped") {
            c.summary.postUpdate = { status: "skipped", text: "skipped" };
        } else if (status === "failed") {
            c.summary.postUpdate = { status: "failed", text: "failed (non-fatal)" };
            if (!c.summary.warnings.includes("post-update command failed (setup can still pass)")) {
                c.summary.warnings.push("post-update command failed (setup can still pass)");
            }
            c.summary.phase = "post-update failed (non-fatal)";
        }
    }

    if (stage === "prune_docker_images") {
        if (status === "started") {
            c.summary.phase = "pruning old docker images";
        } else if (status === "completed") {
            c.summary.phase = "docker prune complete";
        } else if (status === "failed") {
            if (!c.summary.warnings.includes("docker prune failed (continuing)")) {
                c.summary.warnings.push("docker prune failed (continuing)");
            }
            c.summary.phase = "docker prune failed (continuing)";
        }
    }
}

function collectSummaryWarnings(c, ev) {
    if (!ev || !ev.line || ev.stage !== "change_password") return;
    if (!c.summary) c.summary = makeSummaryState();
    const line = String(ev.line).toLowerCase();
    if (
        line.includes("authentication token manipulation error") ||
        line.includes("password unchanged")
    ) {
        const warning = "password change did not complete";
        if (!c.summary.warnings.includes(warning)) c.summary.warnings.push(warning);
    }
}

function renderSummary(c) {
    if (!c || !c.summaryEl) return;
    if (!c.summary) c.summary = makeSummaryState();

    const overallEl = c.summaryEl.querySelector(".summary-overall");
    const phaseEl = c.summaryEl.querySelector(".summary-phase");
    const setupEl = c.summaryEl.querySelector(".summary-status");
    const timeEl = c.summaryEl.querySelector(".summary-time");
    const postEl = c.summaryEl.querySelector(".summary-post-update");
    const warnUl = c.summaryEl.querySelector(".summary-warnings");
    const errUl = c.summaryEl.querySelector(".summary-errors");

    overallEl.dataset.status = c.summary.overallStatus;
    overallEl.textContent = c.summary.overallText;

    phaseEl.textContent = c.summary.phase;

    setupEl.dataset.status = c.summary.setupStatus;
    setupEl.textContent = c.summary.setupStatus;

    const t = c.summary.setupTime;
    timeEl.textContent =
        t == null ? "—" : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;

    postEl.dataset.status = c.summary.postUpdate.status;
    postEl.textContent = c.summary.postUpdate.text;

    warnUl.innerHTML = "";
    for (const warning of c.summary.warnings) {
        const li = document.createElement("li");
        li.textContent = `warning: ${warning}`;
        warnUl.appendChild(li);
    }

    errUl.innerHTML = "";
    for (const err of c.summary.setupErrors || []) {
        const li = document.createElement("li");
        li.textContent = err;
        errUl.appendChild(li);
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
    if (c.logFollowState?.follow !== false) {
        c.logEl.scrollTop = c.logEl.scrollHeight;
    }
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
    if (c.logFollowState) c.logFollowState.follow = true;
    c.retryBtn.hidden = true;
    c.failureEl.hidden = true;
    c.summaryEl.hidden = true;
    c.summary = makeSummaryState();
    if (c.wifiBadgeEl) {
        setWifiBadge(c, "unknown", "No WiFi check yet");
    }
    c.elapsedEl.hidden = true;
    c.elapsedEl.dataset.state = "";
}

function setWifiBadge(card, status, title) {
    if (!card || !card.wifiBadgeEl) return;
    card.wifiBadgeEl.dataset.status = status;
    card.wifiBadgeEl.title = title;
    if (status === "pass") {
        card.wifiBadgeEl.textContent = "WiFi OK";
    } else if (status === "fail") {
        card.wifiBadgeEl.textContent = "WiFi Fail";
    } else {
        card.wifiBadgeEl.textContent = "WiFi ?";
    }
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
