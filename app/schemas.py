from __future__ import annotations

from pydantic import BaseModel


class BoxIn(BaseModel):
    class_id: int
    x: float
    y: float
    w: float
    h: float


class SaveRequest(BaseModel):
    boxes: list[BoxIn]


class ClassMapRequest(BaseModel):
    mapping: dict[str, str | None]
