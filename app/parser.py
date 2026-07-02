"""Parse the device-side unoq-setup.sh output during run_setup.

Two things we extract from the stream:

1. The box-drawn summary at the end:

       ╔══════════════════════════════════════════════════╗
       ║              UNOQ-SETUP SUMMARY                  ║
       ╠══════════════════════════════════════════════════╣
       ║  Total time : 02m 14s                            ║
       ║  Status     : FAILED (2 error(s))                ║
       ╠══════════════════════════════════════════════════╣
       ║  Errors:                                         ║
       ║    • WiFi connection failed: ...                 ║
       ║    • arduino-app-cli system update failed        ║
       ╚══════════════════════════════════════════════════╝

2. Named failure modes that map to a clear, actionable UI state:
   - "this device is too far out of date" -> needs reflash
   - "WiFi connection failed" / "No Wi-Fi device found" -> wifi failure
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

TIME_RE = re.compile(r"Total time\s*:\s*(\d+)m\s*(\d+)s")
STATUS_RE = re.compile(r"Status\s*:\s*(SUCCESS|FAILED)")
ERROR_BULLET_RE = re.compile(r"║\s*•\s*(.*?)\s*║?\s*$")

OUT_OF_DATE_RE = re.compile(r"too far out of date", re.IGNORECASE)
# WiFi failure signals we treat as recoverable by re-pushing local .env:
#   - "WiFi connection failed" / "No Wi-Fi device found"  (nmcli errors, incl.
#     "No network with SSID 'X' found")
#   - "UNOQ_WIFI_SSID and UNOQ_WIFI_PASSWORD environment variables must be set"
#     (device .env missing or empty vars)
#   - "/home/arduino/.env file not found"  (device .env absent altogether)
WIFI_FAIL_RE = re.compile(
    r"WiFi connection failed"
    r"|No Wi-Fi device found"
    r"|UNOQ_WIFI_SSID.*must be set"
    r"|/home/arduino/\.env file not found",
    re.IGNORECASE,
)
SYSTEM_UPDATE_FAIL_RE = re.compile(
    r"arduino-app-cli system update failed", re.IGNORECASE
)


@dataclass
class ParseResult:
    status: str | None = None  # "SUCCESS" / "FAILED"
    elapsed_seconds: int | None = None
    errors: list[str] = field(default_factory=list)


@dataclass
class FailureHint:
    """A short, UI-friendly reason for a failed run."""
    code: str          # e.g. "out_of_date"
    message: str       # e.g. "Device too far out of date — reflash required."


REFLASH_URL = "https://docs.arduino.cc/tutorials/uno-q/update-image/"


class SetupOutputParser:
    """Fed line-by-line. Call `finish()` to retrieve what was parsed."""

    def __init__(self) -> None:
        self._in_box = False
        self._in_errors = False
        self._result = ParseResult()
        self._failure_hint: FailureHint | None = None

    def feed(self, line: str) -> None:
        # 1. Watch for named failure modes anywhere in the stream.
        if self._failure_hint is None:
            if OUT_OF_DATE_RE.search(line):
                self._failure_hint = FailureHint(
                    code="out_of_date",
                    message=(
                        "Device firmware too far out of date — reflash from "
                        f"{REFLASH_URL} and try again."
                    ),
                )
            elif WIFI_FAIL_RE.search(line):
                self._failure_hint = FailureHint(
                    code="wifi_failed",
                    message="WiFi connection failed on device — check SSID/password and range.",
                )
            elif SYSTEM_UPDATE_FAIL_RE.search(line):
                self._failure_hint = FailureHint(
                    code="system_update_failed",
                    message="arduino-app-cli system update failed on device.",
                )

        # 2. Track summary box state.
        if "UNOQ-SETUP SUMMARY" in line:
            self._in_box = True
            return
        if not self._in_box:
            return

        # End of box.
        if line.startswith("╚"):
            self._in_box = False
            self._in_errors = False
            return

        # Section separator.
        if line.startswith("╠"):
            return

        m = TIME_RE.search(line)
        if m:
            self._result.elapsed_seconds = int(m.group(1)) * 60 + int(m.group(2))
            return

        m = STATUS_RE.search(line)
        if m:
            self._result.status = m.group(1)
            return

        if "Errors:" in line:
            self._in_errors = True
            return

        if self._in_errors:
            m = ERROR_BULLET_RE.search(line)
            if m:
                err = m.group(1).rstrip()
                if err:
                    self._result.errors.append(err)

    def finish(self) -> tuple[ParseResult | None, FailureHint | None]:
        """Return the summary (if a box was seen) and any failure hint detected."""
        result = self._result if self._result.status is not None else None
        return result, self._failure_hint
