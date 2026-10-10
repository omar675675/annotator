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


def polygon_bounds(polygon: list[list[float]]) -> dict:
    """Normalized center-format box that tightly fits a normalized polygon."""
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    left, right, top, bottom = min(xs), max(xs), min(ys), max(ys)
    return {"x": (left + right) / 2, "y": (top + bottom) / 2, "w": right - left, "h": bottom - top}


def box_outline(box: dict) -> list[list[float]]:
    """A box's four corners as a normalized polygon."""
    left, top = box["x"] - box["w"] / 2, box["y"] - box["h"] / 2
    right, bottom = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    return [[left, top], [right, top], [right, bottom], [left, bottom]]


class Store:
    def __init__(self, dataset_dir: str, annotated_dir: str):
        self.dataset_dir = Path(dataset_dir)
        self.annotated_images_dir = Path(annotated_dir) / "images"
        self.annotated_labels_dir = Path(annotated_dir) / "labels"
        self.state_path = Path(annotated_dir) / ".annotator_state.json"
        # label file name -> "masks" | "boxes"; read from disk once, then kept
        # up to date as labels are written, so counting stays cheap
        self._label_formats: dict[str, str] | None = None
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
        """Written as YOLO-seg lines (class x1 y1 x2 y2 ...) if any object has
        a polygon, otherwise as YOLO box lines. Never both in one file —
        Ultralytics skips images whose label mixes the two, so in a file
        with polygons a plain box is written as its 4-corner outline."""
        label_path = self.label_path_for(filename)
        as_polygons = any(b.get("polygon") for b in boxes)
        lines = []
        for b in boxes:
            polygon = b.get("polygon") or (box_outline(b) if as_polygons else None)
            if polygon:
                coords = " ".join(f"{x:.6f} {y:.6f}" for x, y in polygon)
                lines.append(f"{b['class_id']} {coords}")
            else:
                lines.append(f"{b['class_id']} {b['x']:.6f} {b['y']:.6f} {b['w']:.6f} {b['h']:.6f}")
        label_path.write_text("\n".join(lines) + ("\n" if lines else ""))
        if self._label_formats is not None:
            if lines:
                self._label_formats[label_path.name] = "masks" if as_polygons else "boxes"
            else:
                self._label_formats.pop(label_path.name, None)

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
            if len(parts) == 5:
                class_id, x, y, w, h = parts
                boxes.append({
                    "class_id": int(class_id),
                    "x": float(x), "y": float(y), "w": float(w), "h": float(h),
                })
            elif len(parts) >= 7 and len(parts) % 2 == 1:
                values = [float(v) for v in parts[1:]]
                polygon = [[values[i], values[i + 1]] for i in range(0, len(values), 2)]
                boxes.append({"class_id": int(parts[0]), **polygon_bounds(polygon), "polygon": polygon})
        return boxes

    def count_label_formats(self) -> dict:
        """How many label files hold masks (polygons) vs plain boxes."""
        if self._label_formats is None:
            self._label_formats = {}
            for path in self.annotated_labels_dir.glob("*.txt"):
                lines = [line.split() for line in path.read_text().splitlines() if line.strip()]
                if lines:
                    self._label_formats[path.name] = "masks" if any(len(p) > 5 for p in lines) else "boxes"
        counts = {"masks": 0, "boxes": 0}
        for fmt in self._label_formats.values():
            counts[fmt] += 1
        return counts

    def clashing_names(self) -> list[list[str]]:
        """Groups of images that would share one label file: the same name with
        different extensions (a.jpg + a.png), or the same file in both the
        dataset and annotated folders. YOLO names labels by image stem, so
        their labels overwrite each other."""
        by_stem: dict[str, list[str]] = {}
        for name in self.list_pending():
            by_stem.setdefault(Path(name).stem, []).append(str(self.pending_image_path(name)))
        for name in self.list_annotated():
            by_stem.setdefault(Path(name).stem, []).append(str(self.annotated_image_path(name)))
        return [paths for paths in by_stem.values() if len(paths) > 1]

    def discard_label(self, filename: str) -> None:
        label_path = self.label_path_for(filename)
        if label_path.exists():
            label_path.unlink()
        if self._label_formats is not None:
            self._label_formats.pop(label_path.name, None)

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
