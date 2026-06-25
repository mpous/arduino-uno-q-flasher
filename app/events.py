from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

Stage = Literal[
    "push_app",
    "push_setup_script",
    "push_env",
    "chmod_script",
    "change_password",
    "push_properties",
    "run_setup",
    "post_update",
]

ALL_STAGES: tuple[Stage, ...] = (
    "push_app",
    "push_setup_script",
    "push_env",
    "chmod_script",
    "change_password",
    "push_properties",
    "run_setup",
    "post_update",
)

# Stages the user can toggle off from the UI. The others are required.
OPTIONAL_STAGES: frozenset[Stage] = frozenset(
    {"push_env", "change_password", "push_properties", "post_update"}
)

DeviceStatus = Literal["idle", "running", "success", "failed", "skipped"]
StageStatus = Literal["started", "completed", "failed", "skipped"]


class StageEvent(BaseModel):
    type: Literal["stage"] = "stage"
    device: str
    stage: Stage
    status: StageStatus
    message: str | None = None


class LogEvent(BaseModel):
    type: Literal["log"] = "log"
    device: str
    stage: Stage | None = None
    line: str
    stream: Literal["stdout", "stderr", "info"] = "info"


class DeviceStartedEvent(BaseModel):
    type: Literal["device_started"] = "device_started"
    device: str


class DeviceFinishedEvent(BaseModel):
    type: Literal["device_finished"] = "device_finished"
    device: str
    result: Literal["success", "failed"]
    elapsed_seconds: float | None = None
    failure_reason: str | None = None  # short, UI-friendly reason


class SetupSummaryEvent(BaseModel):
    """Structured summary parsed from the on-device unoq-setup.sh output box."""

    type: Literal["setup_summary"] = "setup_summary"
    device: str
    status: Literal["SUCCESS", "FAILED"]
    elapsed_seconds: int | None = None  # from "Total time : 02m 14s"
    errors: list[str] = []


class RunFinishedEvent(BaseModel):
    type: Literal["run_finished"] = "run_finished"
    successful: list[str]
    failed: list[str]


Event = (
    StageEvent
    | LogEvent
    | DeviceStartedEvent
    | DeviceFinishedEvent
    | SetupSummaryEvent
    | RunFinishedEvent
)


class DeviceConfig(BaseModel):
    serial: str
    skip_stages: list[Stage] = []


class StartRunRequest(BaseModel):
    upload_id: str | None = None
    devices: list[DeviceConfig]
    post_update_cmd: str | None = None


class DeviceState(BaseModel):
    serial: str
    status: DeviceStatus = "idle"
    current_stage: Stage | None = None
    stages: dict[str, StageStatus] = {}
    skip_stages: list[Stage] = []
    elapsed_seconds: float | None = None
    failure_reason: str | None = None
