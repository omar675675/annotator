"""Disk-backed state: which images are pending vs annotated, and label I/O.

There is no database — the filesystem is the source of truth. An image is
"pending" while it lives in dataset_dir, and "done" once it (and its label)
have been moved into annotated_dir/images + annotated_dir/labels.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


class Store:
    def __init__(self, dataset_dir: str, annotated_dir: str):
        self.dataset_dir = Path(dataset_dir)
        self.annotated_images_dir = Path(annotated_dir) / "images"
        self.annotated_labels_dir = Path(annotated_dir) / "labels"
        self.state_path = Path(annotated_dir) / ".annotator_state.json"
        self.dataset_dir.mkdir(parents=True, exist_ok=True)
        self.annotated_images_dir.mkdir(parents=True, exist_ok=True)
        self.annotated_labels_dir.mkdir(parents=True, exist_ok=True)

    def list_pending(self) -> list[str]:
        return sorted(
            p.name for p in self.dataset_dir.iterdir()
            if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
        )

    def list_annotated(self) -> list[str]:
        return sorted(
            p.name for p in self.annotated_images_dir.iterdir()
            if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
        )

    def pending_image_path(self, filename: str) -> Path:
        return self.dataset_dir / filename

    def annotated_image_path(self, filename: str) -> Path:
        return self.annotated_images_dir / filename

    def label_path_for(self, filename: str) -> Path:
        stem = Path(filename).stem
        return self.annotated_labels_dir / f"{stem}.txt"

    def write_label(self, filename: str, boxes: list[dict]) -> None:
        label_path = self.label_path_for(filename)
        lines = [
            f"{b['class_id']} {b['x']:.6f} {b['y']:.6f} {b['w']:.6f} {b['h']:.6f}"
            for b in boxes
        ]
        label_path.write_text("\n".join(lines) + ("\n" if lines else ""))

    def read_label(self, filename: str) -> list[dict] | None:
        """Reads back a label file — an autosaved draft for a still-pending
        image, or the current boxes for an already-annotated one. None if
        no label exists yet."""
        label_path = self.label_path_for(filename)
        if not label_path.exists():
            return None
        boxes = []
        for line in label_path.read_text().splitlines():
            parts = line.split()
            if len(parts) != 5:
                continue
            class_id, x, y, w, h = parts
            boxes.append({
                "class_id": int(class_id),
                "x": float(x), "y": float(y), "w": float(w), "h": float(h),
            })
        return boxes

    def discard_label(self, filename: str) -> None:
        label_path = self.label_path_for(filename)
        if label_path.exists():
            label_path.unlink()

    def save_annotation(self, filename: str, boxes: list[dict]) -> None:
        """Writes the label first, then moves the image — so a failed move
        never loses a completed annotation."""
        self.write_label(filename, boxes)
        src = self.pending_image_path(filename)
        dst = self.annotated_image_path(filename)
        if src.exists():
            shutil.move(str(src), str(dst))

    def delete_pending(self, filename: str) -> None:
        path = self.pending_image_path(filename)
        if path.exists():
            path.unlink()

    def get_last_filename(self) -> str | None:
        """The last image that was viewed, so a restart can resume there."""
        if not self.state_path.exists():
            return None
        try:
            return json.loads(self.state_path.read_text()).get("last_filename")
        except (json.JSONDecodeError, OSError):
            return None

    def set_last_filename(self, filename: str) -> None:
        self.state_path.write_text(json.dumps({"last_filename": filename}))
