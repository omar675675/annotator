from __future__ import annotations

from pydantic import BaseModel


class BoxIn(BaseModel):
    class_id: int
    x: float
    y: float
    w: float
    h: float
    polygon: list[list[float]] | None = None


class BoxRect(BaseModel):
    x: float
    y: float
    w: float
    h: float
    mask_index: int | None = None


class TextPromptRequest(BaseModel):
    prompt: str


class SaveRequest(BaseModel):
    boxes: list[BoxIn]


class ClassMapRequest(BaseModel):
    mapping: dict[str, str | None]
