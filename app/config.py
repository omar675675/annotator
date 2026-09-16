"""Loads and persists config.yaml."""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

TEMPLATE = """model_path: ""
dataset_dir: "images"
annotated_dir: "annotated"
classes: []
confidence_threshold: 0.25
class_map: {}
"""

CONFIG_PATH = Path("config.yaml")


@dataclass
class Config:
    model_path: str
    dataset_dir: str
    annotated_dir: str
    classes: list[str]
    confidence_threshold: float
    class_map: dict[str, str | None]
    path: Path = field(default=CONFIG_PATH)

    def save(self) -> None:
        data = {
            "model_path": self.model_path,
            "dataset_dir": self.dataset_dir,
            "annotated_dir": self.annotated_dir,
            "classes": self.classes,
            "confidence_threshold": self.confidence_threshold,
            "class_map": self.class_map,
        }
        with self.path.open("w") as f:
            yaml.safe_dump(data, f, sort_keys=False)

    def set_classes(self, classes: list[str]) -> None:
        self.classes = classes
        self.save()

    def set_class_map(self, class_map: dict[str, str | None]) -> None:
        self.class_map = class_map
        self.save()


def _fail(message: str) -> None:
    print(f"\nConfig error: {message}\n", file=sys.stderr)
    print("Expected config.yaml, for example:\n", file=sys.stderr)
    print(TEMPLATE, file=sys.stderr)
    sys.exit(1)


def load_config(path: Path = CONFIG_PATH) -> Config:
    if not path.exists():
        _fail(f"'{path}' not found.")

    try:
        raw = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as e:
        _fail(f"'{path}' is not valid YAML: {e}")

    dataset_dir = raw.get("dataset_dir")
    if not dataset_dir:
        _fail("'dataset_dir' is required — set it to the folder of images you want to annotate.")

    return Config(
        model_path=(raw.get("model_path") or "").strip(),
        dataset_dir=dataset_dir,
        annotated_dir=raw.get("annotated_dir") or "annotated",
        classes=list(raw.get("classes") or []),
        confidence_threshold=float(raw.get("confidence_threshold", 0.25)),
        class_map=dict(raw.get("class_map") or {}),
        path=path,
    )
