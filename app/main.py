"""FastAPI app: HTTP routes + WebSocket endpoint.

Routes:
  GET  /                       -> serves index.html
  GET  /api/health             -> simple liveness + adb status
  GET  /api/devices            -> list online devices via adb
  POST /api/upload             -> receive folder upload (multipart, many files)
  POST /api/runs               -> start a new run for selected devices
  POST /api/runs/{id}/devices/{serial}/retry  -> retry a device
  WS   /ws/runs/{id}           -> stream events for a run
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import adb
from .env_file import MANAGED_KEYS, read_env, write_env
from .events import OPTIONAL_STAGES, Stage, StartRunRequest
from .flasher import FlasherContext, SETUP_SCRIPT_NAME
from .runs import Registry

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
UPLOADS_DIR = PROJECT_ROOT / ".uploads"

registry = Registry(uploads_dir=UPLOADS_DIR)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load .env from project root so UNOQ_DEFAULT_PASSWORD is available.
    env_path = PROJECT_ROOT / ".env"
    if env_path.exists():
        load_dotenv(env_path)
    _sweep_old_uploads(UPLOADS_DIR, max_age_hours=24)
    yield


def _sweep_old_uploads(uploads_dir: Path, max_age_hours: int) -> None:
    """Delete any staged upload directories older than max_age_hours."""
    import shutil
    import time

    if not uploads_dir.exists():
        return
    cutoff = time.time() - max_age_hours * 3600
    for child in uploads_dir.iterdir():
        try:
            if child.is_dir() and child.stat().st_mtime < cutoff:
                shutil.rmtree(child, ignore_errors=True)
        except OSError:
            pass


app = FastAPI(title="Arduino UNO Q Flasher", lifespan=lifespan)


# ----- static -----

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


# ----- API -----


@app.get("/api/health")
async def health() -> dict:
    try:
        adb_bin = adb.adb_path()
        adb_ok = True
        adb_error = None
    except adb.AdbNotFoundError as e:
        adb_bin = None
        adb_ok = False
        adb_error = str(e)
    return {
        "ok": True,
        "adb_available": adb_ok,
        "adb_path": adb_bin,
        "adb_error": adb_error,
        "password_configured": bool(os.environ.get("UNOQ_DEFAULT_PASSWORD")),
        "wifi_ssid_configured": bool(os.environ.get("UNOQ_WIFI_SSID")),
        "wifi_password_configured": bool(os.environ.get("UNOQ_WIFI_PASSWORD")),
    }


class SettingsBody(BaseModel):
    UNOQ_WIFI_SSID: str | None = None
    UNOQ_WIFI_PASSWORD: str | None = None
    UNOQ_DEFAULT_PASSWORD: str | None = None


@app.get("/api/settings")
async def get_settings() -> dict:
    """Return current managed-key values. Passwords are masked to a bool."""
    env_path = PROJECT_ROOT / ".env"
    on_disk = read_env(env_path)
    return {
        "UNOQ_WIFI_SSID": on_disk.get("UNOQ_WIFI_SSID")
        or os.environ.get("UNOQ_WIFI_SSID")
        or "",
        "UNOQ_WIFI_PASSWORD_set": bool(
            on_disk.get("UNOQ_WIFI_PASSWORD") or os.environ.get("UNOQ_WIFI_PASSWORD")
        ),
        "UNOQ_DEFAULT_PASSWORD_set": bool(
            on_disk.get("UNOQ_DEFAULT_PASSWORD")
            or os.environ.get("UNOQ_DEFAULT_PASSWORD")
        ),
    }


@app.post("/api/settings")
async def update_settings(body: SettingsBody) -> dict:
    """Write any provided keys into the project .env (preserves other keys)."""
    updates: dict[str, str] = {}
    for key in MANAGED_KEYS:
        val = getattr(body, key, None)
        if val is not None:  # empty string is a valid "clear"
            updates[key] = val
    if not updates:
        raise HTTPException(status_code=400, detail="no settings provided")
    env_path = PROJECT_ROOT / ".env"
    write_env(env_path, updates)
    return {"ok": True, "updated": list(updates.keys())}


@app.get("/api/devices")
async def devices() -> dict:
    try:
        ds = await adb.list_devices()
    except adb.AdbNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"devices": [{"serial": d.serial, "state": d.state} for d in ds]}


# Blink the red user LED ~3s to physically identify the board on a bench full
# of UNO Qs. We must (1) set the LED's trigger to `none` so kernel triggers
# (heartbeat/timer/etc.) stop overriding manual brightness writes, and (2)
# write `max_brightness` (typically 255) rather than `1`. Runs as the
# `arduino` user via adb shell.
IDENTIFY_BLINK_CMD = (
    "LED=/sys/class/leds/red:user; "
    "if [ ! -e \"$LED/brightness\" ]; then "
    "  echo \"LED node $LED not found; checking alternatives:\"; "
    "  ls /sys/class/leds/ 2>/dev/null; "
    "  exit 1; "
    "fi; "
    "echo none | tee \"$LED/trigger\" >/dev/null 2>&1 || true; "
    "MAX=$(cat \"$LED/max_brightness\" 2>/dev/null || echo 255); "
    "for i in 1 2 3 4 5; do "
    "  echo \"$MAX\" | tee \"$LED/brightness\" >/dev/null; sleep 0.3; "
    "  echo 0 | tee \"$LED/brightness\" >/dev/null; sleep 0.3; "
    "done"
)


@app.post("/api/devices/{serial}/identify")
async def identify_device(serial: str) -> dict:
    try:
        rc, out = await adb.shell(serial, IDENTIFY_BLINK_CMD)
    except adb.AdbNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    if rc != 0:
        raise HTTPException(
            status_code=502, detail=f"adb shell exited {rc}: {out[:200]}"
        )
    return {"ok": True}


@app.post("/api/upload")
async def upload(
    folder_name: str = Form(...),
    paths: list[str] = Form(...),
    files: list[UploadFile] = File(...),
) -> dict:
    """Receive an entire folder.

    The frontend sends, in order, one `files` entry and one `paths` entry per file,
    where `paths[i]` is the file's `webkitRelativePath` (folder/subdir/file.ext).
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files uploaded.")
    if len(paths) != len(files):
        raise HTTPException(
            status_code=400,
            detail=f"paths/files length mismatch: {len(paths)} vs {len(files)}",
        )

    upload_id, base = registry.new_upload_dir()
    folder_root = base / _sanitize(folder_name)
    folder_root.mkdir(parents=True, exist_ok=True)

    for f, rel in zip(files, paths):
        rel = (rel or "").replace("\\", "/").lstrip("/")
        # webkitRelativePath includes the top folder name. Strip it so we don't
        # double-nest under folder_root.
        parts = rel.split("/")
        if parts and parts[0] == folder_name:
            parts = parts[1:]
        rel_clean = "/".join(parts)
        if not rel_clean or ".." in Path(rel_clean).parts:
            continue
        dest = folder_root / rel_clean
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as out:
            while True:
                chunk = await f.read(1024 * 1024)
                if not chunk:
                    break
                out.write(chunk)

    registry.register_upload(upload_id, folder_root, folder_name)
    file_count = 0
    eim_files: list[dict] = []
    for p in folder_root.rglob("*"):
        if not p.is_file():
            continue
        file_count += 1
        if p.suffix.lower() == ".eim":
            eim_files.append(
                {
                    "path": p.relative_to(folder_root).as_posix(),
                    "size_bytes": p.stat().st_size,
                }
            )
    eim_files.sort(key=lambda e: e["path"])
    return {
        "upload_id": upload_id,
        "folder_name": folder_name,
        "file_count": file_count,
        "eim_files": eim_files,
    }


@app.post("/api/runs")
async def start_run(req: StartRunRequest) -> dict:
    upload = None
    app_folder: Path | None = None
    if req.upload_id:
        upload = registry.get_upload(req.upload_id)
        if upload is None:
            raise HTTPException(status_code=404, detail="upload_id not found")
        app_folder = upload.folder
    if not req.devices:
        raise HTTPException(status_code=400, detail="no devices selected")

    setup_script = PROJECT_ROOT / SETUP_SCRIPT_NAME
    if not setup_script.is_file():
        raise HTTPException(
            status_code=500,
            detail=f"{SETUP_SCRIPT_NAME} not found at project root: {setup_script}",
        )

    env_file = PROJECT_ROOT / ".env"
    ctx = FlasherContext(
        app_folder=app_folder,
        setup_script=setup_script,
        env_file=env_file if env_file.is_file() else None,
        unoq_default_password=os.environ.get("UNOQ_DEFAULT_PASSWORD"),
        project_root=PROJECT_ROOT,
        post_update_cmd=(req.post_update_cmd or "").strip() or None,
    )
    run = registry.create_run(ctx, upload)

    device_configs: list[tuple[str, set[Stage]]] = [
        (d.serial, {s for s in d.skip_stages if s in OPTIONAL_STAGES})
        for d in req.devices
    ]

    asyncio.create_task(registry.run_devices(run, device_configs))
    return {"run_id": run.run_id}


class RetryBody(BaseModel):
    skip_stages: list[Stage] = []


@app.post("/api/runs/{run_id}/devices/{serial}/retry")
async def retry_device(
    run_id: str, serial: str, body: RetryBody | None = None
) -> dict:
    run = registry.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    # If the run originally had a folder but its staged copy was cleaned up,
    # we can't retry the push_app step. Folderless runs (app_folder is None)
    # are always retryable — push_app will just be skipped again.
    if (
        run.ctx.app_folder is not None
        and run.upload is None
        and not run.ctx.app_folder.exists()
    ):
        raise HTTPException(
            status_code=410,
            detail="staged upload was cleaned up; please re-upload the folder.",
        )
    skip: set[Stage] = set()
    if body is not None:
        skip = {s for s in body.skip_stages if s in OPTIONAL_STAGES}
    await registry.retry_device(run, serial, skip)
    return {"ok": True}


# ----- WebSocket -----


@app.websocket("/ws/runs/{run_id}")
async def ws_run(ws: WebSocket, run_id: str) -> None:
    await ws.accept()
    run = registry.get_run(run_id)
    if run is None:
        await ws.send_json({"type": "error", "message": "run not found"})
        await ws.close()
        return

    q = registry.subscribe(run)
    try:
        # Stream events until the run finishes AND the queue is drained.
        while True:
            try:
                ev = await asyncio.wait_for(q.get(), timeout=1.0)
            except asyncio.TimeoutError:
                if run.finished.is_set() and q.empty():
                    break
                continue
            await ws.send_json(ev.model_dump())
    except WebSocketDisconnect:
        pass
    finally:
        registry.unsubscribe(run, q)
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


def _sanitize(name: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-._" else "_" for c in name)
    return safe or "app"
