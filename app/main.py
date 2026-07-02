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
    """Return current managed-key values. Passwords are returned in plaintext
    so the UI can render a show/hide reveal button — the .env file itself is
    plaintext on disk, so exposing it over localhost is not an additional risk.
    Also returns the absolute path of the .env file so the UI can show it."""
    env_path = PROJECT_ROOT / ".env"
    on_disk = read_env(env_path)

    def _val(key: str) -> str:
        return on_disk.get(key) or os.environ.get(key) or ""

    return {
        "UNOQ_WIFI_SSID": _val("UNOQ_WIFI_SSID"),
        "UNOQ_WIFI_PASSWORD": _val("UNOQ_WIFI_PASSWORD"),
        "UNOQ_DEFAULT_PASSWORD": _val("UNOQ_DEFAULT_PASSWORD"),
        # Kept for backwards-compat with older frontends and health checks.
        "UNOQ_WIFI_PASSWORD_set": bool(_val("UNOQ_WIFI_PASSWORD")),
        "UNOQ_DEFAULT_PASSWORD_set": bool(_val("UNOQ_DEFAULT_PASSWORD")),
        "env_file_path": str(env_path),
        "env_file_exists": env_path.exists(),
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


# Blink the red user LED ~5s to physically identify the board on a bench full
# of UNO Qs. Runs over `adb shell` which on UNO Q is the `arduino` user.
#
# UNO Q kernel registers user LEDs at /sys/class/leds/unoq:user-red1 (verified
# on current image). We probe that path first, then a few fallbacks, and dump
# diagnostics if nothing matches.
#
# Gotchas this command handles:
#  - Active kernel `trigger` overrides manual brightness writes; we set it to
#    `none` first.
#  - Brightness must be `max_brightness` (usually 255), not literal 1.
#  - Direct shell `>` redirection sometimes fails on sysfs; fall through to
#    `tee`, then `sudo -n tee` if both fail.
#  - Verify the write actually changed the file before running the blink loop,
#    so a permission failure surfaces clearly instead of silently no-op'ing.
IDENTIFY_BLINK_CMD = r"""
set +e
echo "[identify] whoami: $(whoami)"

LED=""
for c in \
    /sys/class/leds/unoq:user-red1 \
    /sys/class/leds/unoq:user-red \
    /sys/class/unoq:user-red1 \
    /sys/class/unoq:user-red \
    /sys/class/leds/red:user \
    /sys/class/leds/user:red; do
  if [ -e "$c/brightness" ]; then
    LED="$c"
    break
  fi
done

# Glob fallback: any /sys/class/leds/*red* or /sys/class/unoq:*red* with
# a brightness file.
if [ -z "$LED" ]; then
  for g in /sys/class/leds/*red* /sys/class/unoq:*red*; do
    [ -e "$g/brightness" ] && LED="$g" && break
  done
fi

if [ -z "$LED" ]; then
  echo "[identify] no known LED node matched. Diagnostics:"
  echo "[identify] /sys/class/leds/ contents:"
  ls -la /sys/class/leds/ 2>&1
  echo "[identify] /sys/class/ entries matching unoq|red|led:"
  ls /sys/class/ 2>&1 | grep -Ei 'unoq|red|led' || true
  exit 1
fi

echo "[identify] using $LED"

write_sysfs() {
  local file="$1" value="$2"
  if printf '%s' "$value" 2>/dev/null > "$file" 2>/dev/null; then return 0; fi
  if printf '%s\n' "$value" | tee "$file" >/dev/null 2>&1; then return 0; fi
  if printf '%s\n' "$value" | sudo -n tee "$file" >/dev/null 2>&1; then return 0; fi
  return 1
}

write_sysfs "$LED/trigger" none \
  || echo "[identify] could not set trigger to none (continuing anyway)"
MAX=$(cat "$LED/max_brightness" 2>/dev/null || echo 255)
echo "[identify] max_brightness=$MAX"

if ! write_sysfs "$LED/brightness" "$MAX"; then
  echo "[identify] cannot write to $LED/brightness:"
  ls -la "$LED/brightness" 2>&1
  exit 1
fi

# Verify the write actually took (sysfs may accept writes that the driver
# silently discards if the trigger is still active).
READBACK=$(cat "$LED/brightness" 2>/dev/null)
echo "[identify] brightness after first write: $READBACK (expected ~$MAX)"

# Blink loop: 8 toggles @ 0.3s on/off = 4.8s + 0.3s tail = ~5s total.
for i in 1 2 3 4 5 6 7 8; do
  sleep 0.3
  write_sysfs "$LED/brightness" 0
  sleep 0.3
  write_sysfs "$LED/brightness" "$MAX"
done
sleep 0.3
write_sysfs "$LED/brightness" 0
exit 0
"""


@app.post("/api/devices/{serial}/identify")
async def identify_device(serial: str) -> dict:
    try:
        rc, out = await adb.shell(serial, IDENTIFY_BLINK_CMD)
    except adb.AdbNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    if rc != 0:
        # Surface the FULL output (not truncated) so the user can see the
        # actual LED node names on their image.
        raise HTTPException(
            status_code=502,
            detail=f"adb shell exited {rc}.\n{out}",
        )
    return {"ok": True, "output": out}


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
