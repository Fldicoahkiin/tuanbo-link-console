"""Strict, versioned research I/O; diagnostics are never application markers."""

from __future__ import annotations

import math
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

Time = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Section(StrictModel):
    start: Time
    end: Time
    label: str = Field(min_length=1)

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if self.end <= self.start:
            raise ValueError("段落终点必须晚于起点")
        return self

class Event(StrictModel):
    kind: Literal["hit", "roll", "build", "drop", "stop", "ending", "last"]
    start: Time
    end: Time | None = None

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if self.end is not None and self.end <= self.start:
            raise ValueError("事件终点必须晚于起点")
        if self.kind in ("roll", "build", "ending") and self.end is None:
            raise ValueError("区间事件必须指定终点")
        return self


class MusicLabels(StrictModel):
    beats: list[Time] = Field(default_factory=list)
    downbeats: list[Time] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    events: list[Event] = Field(default_factory=list)

    @model_validator(mode="after")
    def ordered(self) -> Self:
        for points in (self.beats, self.downbeats):
            if any(b <= a for a, b in zip(points, points[1:])):
                raise ValueError("拍点必须严格递增且不能重复")
        if any(b.start < a.end for a, b in zip(self.sections, self.sections[1:])):
            raise ValueError("段落必须有序且不能重叠")
        return self

    def check_duration(self, duration: float) -> None:
        positions = self.beats + self.downbeats
        positions += [point for section in self.sections for point in (section.start, section.end)]
        positions += [point for event in self.events for point in (event.start, event.end or event.start)]
        if not math.isfinite(duration) or duration <= 0 or any(t > duration for t in positions):
            raise ValueError("识别或标注时间超出音源范围")


class AudioIdentity(StrictModel):
    source_sha256: Digest
    pcm_sha256: Digest
    sample_rate: Literal[48000]
    sample_count: int = Field(gt=0)
    channels: Literal[2]

    @property
    def duration(self) -> float:
        return self.sample_count / self.sample_rate


class Timings(StrictModel):
    total_seconds: Time
    decode_seconds: Time
    engine_seconds: dict[str, Time]
    cached: bool = False


class AnalysisRun(StrictModel):
    version: Literal[1] = 1
    run_id: str = Field(min_length=1)
    engine_fingerprint: Digest
    device: str = Field(min_length=1)
    audio: AudioIdentity
    timings: Timings
    # These are research outputs, including rejected candidates. Never call them reliable.
    diagnostics: dict[str, MusicLabels]
    publication: Literal["not-validated"] = "not-validated"
    enabled_capabilities: list[str] = Field(default_factory=list, max_length=0)

    @model_validator(mode="after")
    def valid_outputs(self) -> Self:
        for result in self.diagnostics.values():
            result.check_duration(self.audio.duration)
        return self


class Reference(StrictModel):
    labels: MusicLabels
    reviewers: list[str] = Field(min_length=2)
    reviewed: bool
    rhythm_audit_passed: bool

    @model_validator(mode="after")
    def distinct_reviewers(self) -> Self:
        names = {name.strip() for name in self.reviewers}
        if "" in names or len(names) < 2:
            raise ValueError("必须由两名不同的标注者复核")
        return self


class CorpusTrack(StrictModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9_-]+$")
    family: str = Field(min_length=1)
    genre: str = Field(min_length=1)
    split: Literal["train", "calibration", "test"]
    audio_path: str = Field(min_length=1)
    source_sha256: Digest
    duration: Annotated[float, Field(gt=0, allow_inf_nan=False)]
    reference: Reference | None = None


class Corpus(StrictModel):
    version: Literal[1] = 1
    tracks: list[CorpusTrack] = Field(min_length=1)

    @model_validator(mode="after")
    def no_leakage(self) -> Self:
        ids: set[str] = set()
        families: dict[str, str] = {}
        digests: set[str] = set()
        for track in self.tracks:
            if track.id in ids or track.source_sha256 in digests:
                raise ValueError("重复曲目或重复音源不能充当独立样本")
            if track.family in families and families[track.family] != track.split:
                raise ValueError("同曲原版、变速、剪辑不能跨训练/校准/盲测分组")
            ids.add(track.id)
            digests.add(track.source_sha256)
            families[track.family] = track.split
            if track.reference:
                track.reference.labels.check_duration(track.duration)
        return self

