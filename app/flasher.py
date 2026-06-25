"""Per-device flashing workflow.

Translates the `process_device()` function from the original bash script into an
async state machine that emits structured events for the UI.
"""
from __future__ import annotations

import os
import re
import shlex
import time
from pathlib import Path
from typing import Awaitable, Callable

from . import adb
from .events import (
    ALL_STAGES,
    DeviceFinishedEvent,
    DeviceStartedEvent,
    Event,
    LogEvent,
    OPTIONAL_STAGES,
    SetupSummaryEvent,
    Stage,
    StageEvent,
)
from .parser import SetupOutputParser

EmitFn = Callable[[Event], Awaitable[None]]

SETUP_SCRIPT_NAME = "unoq-setup.sh"
PROPERTIES_FILE_NAME = "properties.msgpack"
PROPERTIES_TARGET_PATH = "/var/lib/arduino-app-cli/properties.msgpack"
APPS_TARGET_DIR = "/home/arduino/ArduinoApps/"
REMOTE_SETUP_SCRIPT_PATH = f"/home/arduino/.{SETUP_SCRIPT_NAME}"
REMOTE_ENV_PATH = "/home/arduino/.env"

PASSWORD_SUCCESS_RE = re.compile(
    r"password updated successfully"
    r"|all authentication tokens updated successfully"
    r"|passwd: password changed",
    re.IGNORECASE,
)
PASSWORD_NEEDS_CURRENT_RE = re.compile(
    r"current password|authentication failure|password unchanged",
    re.IGNORECASE,
)
PASSWORD_TOKEN_ERROR_RE = re.compile(
    r"authentication token manipulation error", re.IGNORECASE
)


class FlasherContext:
    """Per-run configuration shared across all devices."""

    def __init__(
        self,
        app_folder: Path | None,
        setup_script: Path,
        env_file: Path | None,
        unoq_default_password: str | None,
        project_root: Path,
        post_update_cmd: str | None = None,
    ) -> None:
        self.app_folder = app_folder
        self.setup_script = setup_script
        self.env_file = env_file
        self.unoq_default_password = unoq_default_password
        self.project_root = project_root
        self.post_update_cmd = post_update_cmd

    @property
    def properties_file(self) -> Path | None:
        if self.app_folder is not None:
            candidate = self.app_folder / PROPERTIES_FILE_NAME
            if candidate.is_file():
                return candidate
        candidate2 = self.project_root / PROPERTIES_FILE_NAME
        if candidate2.is_file():
            return candidate2
        return None


async def flash_device(
    serial: str,
    ctx: FlasherContext,
    skip_stages: set[Stage],
    emit: EmitFn,
) -> bool:
    """Run the full 7-stage workflow for one device.

    Returns True on success, False on failure. Errors in optional stages do not
    fail the run; errors in required stages do.
    """
    start_time = time.monotonic()
    parser = SetupOutputParser()

    await emit(DeviceStartedEvent(device=serial))

    async def log(line: str, stream: str = "info", stage: Stage | None = None) -> None:
        await emit(LogEvent(device=serial, stage=stage, line=line, stream=stream))  # type: ignore[arg-type]

    async def line_cb_for(stage: Stage):
        async def cb(line: str, stream: str) -> None:
            await emit(LogEvent(device=serial, stage=stage, line=line, stream=stream))  # type: ignore[arg-type]

        return cb

    async def line_cb_run_setup(line: str, stream: str) -> None:
        # Feed the parser AND forward the line as a normal log event.
        parser.feed(line)
        await emit(LogEvent(device=serial, stage="run_setup", line=line, stream=stream))  # type: ignore[arg-type]

    async def fail(reason: str | None = None) -> bool:
        await _emit_summary(serial, parser, emit)
        result, hint = parser.finish()
        await emit(
            DeviceFinishedEvent(
                device=serial,
                result="failed",
                elapsed_seconds=round(time.monotonic() - start_time, 1),
                failure_reason=(hint.message if hint else reason),
            )
        )
        return False

    async def run_stage(
        stage: Stage,
        action: Callable[[], Awaitable[bool]],
        *,
        required: bool,
    ) -> bool:
        if stage in skip_stages:
            if stage not in OPTIONAL_STAGES:
                await log(
                    f"Cannot skip required stage '{stage}'. Running anyway.",
                    stream="info",
                    stage=stage,
                )
            else:
                await emit(StageEvent(device=serial, stage=stage, status="skipped"))
                return True

        await emit(StageEvent(device=serial, stage=stage, status="started"))
        try:
            ok = await action()
        except Exception as exc:  # noqa: BLE001
            await log(f"Exception in stage {stage}: {exc}", stream="stderr", stage=stage)
            ok = False

        if ok:
            await emit(StageEvent(device=serial, stage=stage, status="completed"))
            return True
        await emit(StageEvent(device=serial, stage=stage, status="failed"))
        return not required

    # 1. push app folder (skipped silently if no folder was provided — useful
    # for "maintenance" runs that only update WiFi / system / post-update).
    if ctx.app_folder is None:
        await emit(StageEvent(device=serial, stage="push_app", status="skipped"))
        await log(
            "No app folder selected; skipping app push.",
            stage="push_app",
        )
    else:
        async def stage_push_app() -> bool:
            cb = await line_cb_for("push_app")
            rc, _ = await adb.push(serial, ctx.app_folder, APPS_TARGET_DIR, cb)
            return rc == 0

        if not await run_stage("push_app", stage_push_app, required=True):
            return await fail("Failed to push app folder.")

    # 2. push setup script
    async def stage_push_script() -> bool:
        cb = await line_cb_for("push_setup_script")
        rc, _ = await adb.push(serial, ctx.setup_script, REMOTE_SETUP_SCRIPT_PATH, cb)
        return rc == 0

    if not await run_stage("push_setup_script", stage_push_script, required=True):
        return await fail("Failed to push setup script.")

    # 3. push .env (skip silently if not present)
    async def stage_push_env() -> bool:
        if ctx.env_file is None:
            await log(".env not present locally; skipping.", stage="push_env")
            return True
        cb = await line_cb_for("push_env")
        rc, _ = await adb.push(serial, ctx.env_file, REMOTE_ENV_PATH, cb)
        return rc == 0

    if not await run_stage("push_env", stage_push_env, required=True):
        return await fail("Failed to push .env.")

    # 4. chmod the setup script
    async def stage_chmod() -> bool:
        cb = await line_cb_for("chmod_script")
        rc, _ = await adb.shell(
            serial, f"chmod +x {REMOTE_SETUP_SCRIPT_PATH}", cb
        )
        return rc == 0

    if not await run_stage("chmod_script", stage_chmod, required=True):
        return await fail("Failed to chmod setup script.")

    # 5. change password (optional, can be skipped)
    async def stage_password() -> bool:
        return await _change_password(serial, ctx, line_cb_for, log)

    # password failure does NOT fail the device, matching the bash script
    await run_stage("change_password", stage_password, required=False)

    # 6. push properties (optional) — must happen BEFORE run_setup so the on-device
    # setup wizard sees the "done" markers and doesn't block.
    async def stage_push_properties() -> bool:
        props = ctx.properties_file
        if props is None:
            await log(
                f"{PROPERTIES_FILE_NAME} not found locally. Skipping.",
                stage="push_properties",
            )
            return True
        cb = await line_cb_for("push_properties")
        rc, _ = await adb.push(serial, props, PROPERTIES_TARGET_PATH, cb)
        return rc == 0

    await run_stage("push_properties", stage_push_properties, required=False)

    # 7. run remote setup script (parsed for summary + failure hints)
    async def stage_run_setup() -> bool:
        rc, _ = await adb.shell(
            serial,
            f"source /etc/profile; bash {REMOTE_SETUP_SCRIPT_PATH}",
            line_cb_run_setup,
        )
        return rc == 0

    if not await run_stage("run_setup", stage_run_setup, required=True):
        return await fail("Remote setup script failed.")

    # If the on-device summary itself reported FAILED, treat the device as failed
    # even though adb's exit code was 0 (the script's `trap print_summary EXIT`
    # always prints the summary and then exits 0 if `exit 1` already ran above,
    # but on success the box says SUCCESS).
    await _emit_summary(serial, parser, emit)
    result, hint = parser.finish()
    if result is not None and result.status == "FAILED":
        await emit(
            DeviceFinishedEvent(
                device=serial,
                result="failed",
                elapsed_seconds=round(time.monotonic() - start_time, 1),
                failure_reason=(hint.message if hint else "Device-side setup reported FAILED."),
            )
        )
        return False

    # 8. post-update command (optional). Failure here is non-fatal — the device
    # is already flashed; this just installs example deps / runs final setup.
    async def stage_post_update() -> bool:
        if not ctx.post_update_cmd:
            await log(
                "No post-update command configured; skipping.",
                stage="post_update",
            )
            return True
        cb = await line_cb_for("post_update")
        rc, _ = await adb.shell(
            serial,
            f"source /etc/profile; {ctx.post_update_cmd}",
            cb,
        )
        return rc == 0

    await run_stage("post_update", stage_post_update, required=False)

    await emit(
        DeviceFinishedEvent(
            device=serial,
            result="success",
            elapsed_seconds=round(time.monotonic() - start_time, 1),
        )
    )
    return True


async def _emit_summary(serial: str, parser: SetupOutputParser, emit: EmitFn) -> None:
    """Emit a SetupSummaryEvent if the parser captured one. Idempotent-ish: only
    called from terminal paths."""
    result, _ = parser.finish()
    if result is None or result.status is None:
        return
    await emit(
        SetupSummaryEvent(
            device=serial,
            status=result.status,  # type: ignore[arg-type]
            elapsed_seconds=result.elapsed_seconds,
            errors=list(result.errors),
        )
    )


async def _change_password(
    serial: str,
    ctx: FlasherContext,
    line_cb_for: Callable[[Stage], Awaitable[Callable[[str, str], Awaitable[None]]]],
    log: Callable[..., Awaitable[None]],
) -> bool:
    new_pw = ctx.unoq_default_password
    if not new_pw:
        await log(
            "UNOQ_DEFAULT_PASSWORD is not set. Skipping password change.",
            stage="change_password",
        )
        return True

    cb = await line_cb_for("change_password")

    async def attempt(cmd: str) -> tuple[int, str]:
        return await adb.shell(serial, cmd, cb)

    pw_q = shlex.quote(new_pw)

    # Attempt 1: no current password
    await log("Changing password (attempt 1: no current password)...", stage="change_password")
    rc, out = await attempt(
        f"printf '%s\\n%s\\n' {pw_q} {pw_q} | passwd arduino"
    )
    combined = out

    if PASSWORD_SUCCESS_RE.search(combined):
        await log("Password changed successfully (no current password required).", stage="change_password")
        return True

    if PASSWORD_NEEDS_CURRENT_RE.search(combined):
        await log("Retrying password change with current password 'arduino'...", stage="change_password")
        rc2, out2 = await attempt(
            f"printf '%s\\n%s\\n%s\\n' 'arduino' {pw_q} {pw_q} | passwd arduino"
        )
        combined = out2
        if PASSWORD_SUCCESS_RE.search(combined):
            await log("Password changed successfully using current password.", stage="change_password")
            return True
        if PASSWORD_TOKEN_ERROR_RE.search(combined):
            await log("Token manipulation error; password may already be changed.", stage="change_password")
            return True
        if re.search(r"password unchanged", combined, re.IGNORECASE):
            await log("Password unchanged; it may already be non-default.", stage="change_password")
            return True
        await log(f"Password change failed. Output: {combined}", stage="change_password", stream="stderr")
        return False

    if PASSWORD_TOKEN_ERROR_RE.search(combined):
        await log("Token manipulation error; password may already be changed.", stage="change_password")
        return True

    await log(
        f"Password change may have already happened or failed. Output: {combined}",
        stage="change_password",
    )
    # Treat as non-fatal, matching original script
    return True
