# Arduino UNO Q Flasher (Web UI)

A web app that flashes multiple Arduino UNO Q boards in parallel over `adb`,
with live per-device logs and real-time status. Replaces the original
`unoq-flash-all.sh` bash workflow.

<img width="800" alt="Arduino UNO Q flasher UI" src="https://github.com/user-attachments/assets/f795a71a-c1b4-4a7b-a440-304114787171" />


## Prerequisites

### Hardware

* [Amazon Basics 10 Port USB A Hub](https://www.amazon.es/-/en/Amazon-Basics-10-Port-Power-Adapter/dp/B076YRSWGW)
* 10 USB-A to USB-C cables

### Software

- **Python 3.11+**
- **adb** (Android platform-tools) on your `PATH`
  - macOS: `brew install android-platform-tools`
  - Windows: download from <https://developer.android.com/studio/releases/platform-tools>
  - Linux: `sudo apt install adb`
- **`unoq-setup.sh`** present at the project root (pushed to each device).
- Optional **`.env`** at the project root with:
  ```
  UNOQ_DEFAULT_PASSWORD=your-new-password
  ```
- Optional **`properties.msgpack`** at the project root or inside the chosen
  app folder. If present, it is pushed to:
  - `/home/arduino/.local/share/arduino-app-cli/properties.msgpack`
  - `/tmp/properties.msgpack`

## Install & run

```bash
# Ensure Python 3.11+ is used for the venv (required by this project).
# macOS (Homebrew) if missing: brew install python@3.11
python3.11 -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate

# Optional but recommended: modern editable-install support
python -m pip install --upgrade pip
pip install -e .
python -m app
```

Open <http://localhost:8000>.

## Using the UI

1. **Connect** your UNO Q boards via USB. The device grid auto-refreshes every
   5 seconds — newly plugged boards appear without needing to click anything.
   You can also click **Refresh devices** to force an immediate poll, or
   **Check WiFi on all boards** to run a quick connectivity test fleet-wide.
2. (Optional) On each device card:
   - Click **Identify** to blink that board's red user LED for ~3 seconds.
   - Click **WiFi Check** to run a per-board network check (SSID, route, DNS,
     and HTTP reachability).
   - Watch the WiFi badge update (`WiFi ?` / `WiFi OK` / `WiFi Fail`).
3. Click **Choose app folder** and pick the folder you want pushed to
   `/home/arduino/ArduinoApps/` on each device. The folder is uploaded once
   and reused for all selected devices. The UI lists any `.eim` model files
   found inside the folder so you can sanity-check the bundle before flashing.
4. (Optional) Edit **Post-update commands** as a multiline textbox.
   - One command per line.
   - Blank lines are ignored.
   - Lines starting with `#` are treated as comments.
   - Commands run in order and stop on first failure.
5. In **Step 3 / Run**, select exactly which steps to run using checkboxes
   (Step 1..Step 5) for this batch.
6. (Optional) Per device, tick **skip password**, **skip properties**, and/or
   **skip post-update** for fine-grained overrides.
7. Click **Run selected steps on all boards**. Each device card shows:
   - status badge (idle / running / success / failed)
   - progress bar across the workflow stages (selected steps show as run,
     skipped ones are marked skipped)
   - live-tailing log panel
8. If a device fails, click **Retry** on its card.

The staged upload is removed from disk automatically once the run finishes.

## Workflow (per device)

The web app has a 9-stage workflow. Any stage can be skipped by Step 3
selection (or per-device skip toggles where applicable):

1. `push_app` — push chosen folder to `/home/arduino/ArduinoApps/`
2. `push_setup_script` — push `unoq-setup.sh` to `/home/arduino/.unoq-setup.sh`
3. `push_env` — push `.env` (if present locally)
4. `chmod_script` — make the setup script executable
5. `change_password` — set the arduino user's password from `UNOQ_DEFAULT_PASSWORD`
   (skippable; handles the "already-changed" case gracefully)
6. `push_properties` — push `properties.msgpack` to
   `/home/arduino/.local/share/arduino-app-cli/` and `/tmp/` so on-device
   setup-wizard markers are in place before setup runs (skippable; skipped if absent)
7. `run_setup` — execute the remote setup script (WiFi, DNS, system update)
8. `prune_docker_images` — optional cleanup of unused Docker/Podman images and
   stopped containers before post-update (disabled by default)
9. `post_update` — run configured post-update commands on the device, one line
   at a time. Failures here are logged but do not mark the device as failed,
   since the flash itself is already done.

## ADB parallelism — how many boards can I flash at once?

There are three different limits to keep in mind:

| Limit | Where | Practical impact |
| --- | --- | --- |
| **adb server transports** | `adb` itself | Historical 16-device cap; raised to 128 in platform-tools r30+. Not the bottleneck for typical fleets. |
| **USB host controller** | Your motherboard | Spec allows 127 devices per controller; each shares 480 Mbps (USB 2.0) or 5 Gbps (USB 3.x). A typical PC has 2–4 controllers. |
| **Bus bandwidth + power** | Your hubs | UNO Q draws real current. Bus-powered hubs sag past ~4 boards. Use **powered** hubs, and prefer splitting boards across multiple host ports / controllers. |

The Python side (`asyncio.gather` in `app/runs.py`) imposes no extra cap — every
device gets its own `adb` subprocess and they run concurrently. The wall-clock
bottleneck for this app is **parallel `adb push`**, which shares the USB
controller's bandwidth: 10 boards on one USB 2.0 controller will each get a
fraction of the ~30–40 MB/s the bus can push.

**Rule of thumb**: 8–16 boards per host machine is comfortable. For 32+
either split across multiple machines or add a PCIe USB controller and
distribute boards across separate controllers.
