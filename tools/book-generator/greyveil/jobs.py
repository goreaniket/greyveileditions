"""Small, transport-neutral status model for book production jobs."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from time import monotonic
from typing import Any
from uuid import uuid4


class GenerationStage(str, Enum):
    QUEUED = "QUEUED"
    IMPORTING = "IMPORTING"
    NORMALIZING = "NORMALIZING"
    VALIDATING_SOURCE = "VALIDATING_SOURCE"
    GENERATING_PDF = "GENERATING_PDF"
    GENERATING_EPUB = "GENERATING_EPUB"
    GENERATING_DOCX = "GENERATING_DOCX"
    VALIDATING_OUTPUTS = "VALIDATING_OUTPUTS"
    COMPLETE = "COMPLETE"
    FAILED = "FAILED"


STAGE_PROGRESS = {
    GenerationStage.QUEUED: 0,
    GenerationStage.IMPORTING: 8,
    GenerationStage.NORMALIZING: 24,
    GenerationStage.VALIDATING_SOURCE: 38,
    GenerationStage.GENERATING_PDF: 52,
    GenerationStage.GENERATING_EPUB: 66,
    GenerationStage.GENERATING_DOCX: 80,
    GenerationStage.VALIDATING_OUTPUTS: 92,
    GenerationStage.COMPLETE: 100,
    GenerationStage.FAILED: 0,
}


@dataclass(frozen=True)
class StageEvent:
    stage: GenerationStage
    progress: int
    occurred_at: str
    elapsed_seconds: float


@dataclass
class GenerationJob:
    """A serializable job record suitable for a future API or worker."""

    id: str = field(default_factory=lambda: uuid4().hex)
    stage: GenerationStage = GenerationStage.QUEUED
    progress: int = 0
    started_at: str = field(default_factory=lambda: utc_now())
    completed_at: str | None = None
    error: str | None = None
    warnings: list[str] = field(default_factory=list)
    history: list[StageEvent] = field(default_factory=list)
    _started_monotonic: float = field(default_factory=monotonic, repr=False)

    def advance(self, stage: GenerationStage) -> None:
        self.stage = stage
        self.progress = STAGE_PROGRESS[stage]
        self.history.append(
            StageEvent(
                stage=stage,
                progress=self.progress,
                occurred_at=utc_now(),
                elapsed_seconds=round(monotonic() - self._started_monotonic, 3),
            )
        )
        if stage == GenerationStage.COMPLETE:
            self.completed_at = utc_now()

    def fail(self, message: str) -> None:
        self.error = message
        self.advance(GenerationStage.FAILED)
        self.completed_at = utc_now()

    def add_warning(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)

    def estimated_remaining_seconds(self) -> float | None:
        """Estimate only from observed stage progress; never invent a countdown."""

        elapsed = monotonic() - self._started_monotonic
        if self.progress <= 0 or self.stage in {GenerationStage.COMPLETE, GenerationStage.FAILED}:
            return None
        return round(max(0.0, elapsed * (100 - self.progress) / self.progress), 1)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "stage": self.stage.value,
            "progress": self.progress,
            "startedAt": self.started_at,
            "completedAt": self.completed_at,
            "error": self.error,
            "warnings": list(self.warnings),
            "estimatedRemainingSeconds": self.estimated_remaining_seconds(),
            "history": [
                {
                    **asdict(event),
                    "stage": event.stage.value,
                }
                for event in self.history
            ],
        }


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
