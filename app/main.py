"""FastAPI app for the browser-based YOLO bbox annotator."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import load_config
from app.model import ModelWrapper
from app.sam import SamWrapper
from app.schemas import BoxRect, ClassMapRequest, SaveRequest, TextPromptRequest
from app.store import Store, box_outline, polygon_bounds

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger("annotator")

app = FastAPI(title="Annotator")

config = load_config()
model = ModelWrapper(config.model_path, config.confidence_threshold)
sam = SamWrapper(config.sam_model_path, config.sam_confidence_threshold)

# Resolve the class list: manual (from config) or pulled from the model.
if config.classes:
    classes: list[str] = config.classes
elif model.available:
    classes = [model.names[i] for i in sorted(model.names)]
    config.set_classes(classes)
    logger.info("No classes set in config.yaml — pulled classes from model: %s", classes)
else:
    logger.error(
        "No classes defined and no detection model to pull them from. "
        "Set 'classes' in config.yaml (required when using SAM without a detection model), "
        "or point 'model_path' at a detection model."
    )
    raise SystemExit(1)

store = Store(config.dataset_dir, config.annotated_dir)

detection_cache: dict[str, list[dict]] = {}

# --- class remap resolution -------------------------------------------------

resolved_mapping: dict[str, str | None] = {}
needs_classmap_review = False

if model.available:
    model_names_in_order = [model.names[i] for i in sorted(model.names)]
    for name in model_names_in_order:
        if name in config.class_map:
            resolved_mapping[name] = config.class_map[name]
        else:
            match = next((c for c in classes if c.lower() == name.lower()), None)
            resolved_mapping[name] = match
            if match is None:
                needs_classmap_review = True


def class_index(target_class_name: str | None) -> int | None:
    if target_class_name is None:
        return None
    try:
        return classes.index(target_class_name)
    except ValueError:
        return None


def detections_to_boxes(raw_detections: list[dict]) -> list[dict]:
    boxes = []
    for det in raw_detections:
        target_name = resolved_mapping.get(det["model_class_name"])
        idx = class_index(target_name)
        if idx is None:
            continue
        boxes.append({"class_id": idx, "x": det["x"], "y": det["y"], "w": det["w"], "h": det["h"]})
    return boxes


def get_boxes_for_pending(filename: str) -> list[dict]:
    # An autosaved draft (from a previous session that never finalized this
    # image) takes priority over re-running the model from scratch.
    draft = store.read_label(filename)
    if draft is not None:
        return draft
    if filename not in detection_cache:
        raw = model.predict(str(store.pending_image_path(filename)))
        detection_cache[filename] = raw
    return detections_to_boxes(detection_cache[filename])


def add_masks(image_path: Path, boxes: list[dict]) -> list[dict]:
    """With SAM on, every box without a polygon (a detection, or a box from an
    older box-only label) gets one: SAM masks what's inside the box, and the
    box snaps to fit the mask."""
    if not sam.available:
        return boxes
    missing = [b for b in boxes if not b.get("polygon")]
    for b, polygon in zip(missing, sam.segment_boxes(str(image_path), missing)):
        if polygon:
            b.update(polygon_bounds(polygon), polygon=polygon)
    return boxes


def boxes_for_saving(image_path: Path, body: SaveRequest) -> list[dict]:
    """With SAM on, labels are YOLO-seg, so every saved object needs a
    polygon — the box outline is used if SAM found nothing."""
    boxes = add_masks(image_path, [b.model_dump() for b in body.boxes])
    if sam.available:
        for b in boxes:
            if not b.get("polygon"):
                b["polygon"] = box_outline(b)
    return boxes


MIXED_DATASET_NOTE = (
    "A mix of boxes and masks is fine for training detection, but segmentation training will drop all masks."
)


def warnings() -> list[str]:
    """Problems worth showing in the dashboard, not just the terminal."""
    found = []
    if sam.load_error:
        found.append(sam.load_error)

    # labels on disk in the other format from what this session saves mixes the dataset
    counts = store.count_label_formats()
    if sam.available and counts["boxes"]:
        n = counts["boxes"]
        found.append(
            f"{n} label {'file is' if n == 1 else 'files are'} boxes only, but SAM is on, "
            f"so new labels are saved as masks. {MIXED_DATASET_NOTE}"
        )
    if not sam.available and counts["masks"]:
        n = counts["masks"]
        found.append(
            f"{n} label {'file has' if n == 1 else 'files have'} masks, but SAM is off, "
            f"so new labels are saved as boxes. {MIXED_DATASET_NOTE}"
        )

    clashes = store.clashing_names()
    if clashes:
        example = " and ".join(clashes[0])
        found.append(
            f"{len(clashes)} image {'name clashes' if len(clashes) > 1 else 'name clash'} (e.g. {example}): "
            "images with the same name share one label file, so their labels overwrite each other. "
            "Rename one image of each pair."
        )
    return found


def image_path_for(source: str, filename: str) -> Path:
    path = store.annotated_image_path(filename) if source == "annotated" else store.pending_image_path(filename)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Image not found.")
    return path


# --- API ---------------------------------------------------------------------


@app.get("/api/state")
def get_state():
    pending = store.list_pending()
    annotated = store.list_annotated()
    return {
        "model_loaded": model.available,
        "sam_loaded": sam.available,
        "model_path": config.model_path,
        "classes": classes,
        "pending_count": len(pending),
        "annotated_count": len(annotated),
        "needs_classmap_review": needs_classmap_review,
        "warnings": warnings(),
    }


@app.get("/api/classmap")
def get_classmap():
    model_names_in_order = [model.names[i] for i in sorted(model.names)] if model.available else []
    return {
        "model_names": model_names_in_order,
        "mapping": resolved_mapping,
        "target_classes": classes,
    }


@app.put("/api/classmap")
def put_classmap(body: ClassMapRequest):
    global needs_classmap_review
    for name, target in body.mapping.items():
        resolved_mapping[name] = target
    config.set_class_map(resolved_mapping)
    needs_classmap_review = False
    detection_cache.clear()
    return {"ok": True, "mapping": resolved_mapping}


@app.get("/api/queue")
def get_queue():
    pending = store.list_pending()
    return {
        "pending": pending,
        "pending_count": len(pending),
        "annotated_count": len(store.list_annotated()),
        "last_filename": store.get_last_filename(),
    }


@app.get("/api/image/{filename}")
def get_image_meta(filename: str):
    if not store.pending_image_path(filename).exists():
        raise HTTPException(status_code=404, detail="Image not found in pending dataset.")
    boxes = add_masks(store.pending_image_path(filename), get_boxes_for_pending(filename))
    store.set_last_filename(filename)
    return {"filename": filename, "classes": classes, "boxes": boxes}


@app.get("/api/image/{filename}/file")
def get_image_file(filename: str):
    path = store.pending_image_path(filename)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Image not found in pending dataset.")
    return FileResponse(path)


@app.post("/api/image/{filename}/autosave")
def autosave_image(filename: str, body: SaveRequest):
    """Writes the label for a still-pending image without finalizing it —
    protects in-progress edits without moving the image out of the queue."""
    if not store.pending_image_path(filename).exists():
        raise HTTPException(status_code=404, detail="Image not found in pending dataset.")
    boxes = [b.model_dump() for b in body.boxes]
    store.write_label(filename, boxes)
    return {"ok": True}


@app.post("/api/image/{filename}/save")
def save_image(filename: str, body: SaveRequest):
    """Finalizes an image: writes its label and moves it into annotated_dir."""
    if not store.pending_image_path(filename).exists():
        raise HTTPException(status_code=404, detail="Image not found in pending dataset.")
    boxes = boxes_for_saving(store.pending_image_path(filename), body)
    store.save_annotation(filename, boxes)
    detection_cache.pop(filename, None)
    pending = store.list_pending()
    return {
        "ok": True,
        "pending_count": len(pending),
        "annotated_count": len(store.list_annotated()),
    }


@app.delete("/api/image/{filename}")
def delete_image(filename: str):
    if not store.pending_image_path(filename).exists():
        raise HTTPException(status_code=404, detail="Image not found in pending dataset.")
    store.delete_pending(filename)
    store.discard_label(filename)  # drop any autosaved draft — nothing to finalize now
    detection_cache.pop(filename, None)
    pending = store.list_pending()
    return {
        "ok": True,
        "pending_count": len(pending),
        "annotated_count": len(store.list_annotated()),
    }


@app.get("/api/annotated")
def get_annotated_list():
    annotated = store.list_annotated()
    return {"annotated": annotated, "annotated_count": len(annotated)}


@app.get("/api/annotated/{filename}")
def get_annotated_meta(filename: str):
    if not store.annotated_image_path(filename).exists():
        raise HTTPException(status_code=404, detail="Image not found in annotated set.")
    boxes = add_masks(store.annotated_image_path(filename), store.read_label(filename) or [])
    return {"filename": filename, "classes": classes, "boxes": boxes}


@app.get("/api/annotated/{filename}/file")
def get_annotated_file(filename: str):
    path = store.annotated_image_path(filename)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Image not found in annotated set.")
    return FileResponse(path)


@app.post("/api/annotated/{filename}/save")
def save_annotated_edit(filename: str, body: SaveRequest):
    """Re-editing an already-annotated image updates its label in place —
    the image stays put, only the label file changes."""
    if not store.annotated_image_path(filename).exists():
        raise HTTPException(status_code=404, detail="Image not found in annotated set.")
    boxes = boxes_for_saving(store.annotated_image_path(filename), body)
    store.write_label(filename, boxes)
    return {"ok": True}


@app.post("/api/{source}/{filename}/segment-box")
def segment_box(source: Literal["image", "annotated"], filename: str, body: BoxRect):
    """Masks the object inside one box (normalized x, y, w, h)."""
    if not sam.available:
        raise HTTPException(status_code=400, detail="No SAM model loaded.")
    path = image_path_for(source, filename)
    polygon = sam.segment_boxes(str(path), [body.model_dump()], mask_index=body.mask_index)[0]
    return {"polygon": polygon}


@app.post("/api/{source}/{filename}/segment-text")
def segment_text(source: Literal["image", "annotated"], filename: str, body: TextPromptRequest):
    """Finds and masks every object matching a text prompt."""
    if not sam.available:
        raise HTTPException(status_code=400, detail="No SAM model loaded.")
    path = image_path_for(source, filename)
    polygons = sam.segment_text(str(path), body.prompt)
    return {"objects": [{**polygon_bounds(p), "polygon": p} for p in polygons]}


# --- static frontend ----------------------------------------------------------

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


class NoCacheStaticFiles(StaticFiles):
    """This is a small local dev tool that gets edited and restarted often —
    stale cached HTML/JS/CSS causes confusing mismatches, so never cache."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-store"
        return response


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-store"})


app.mount("/static", NoCacheStaticFiles(directory=STATIC_DIR), name="static")
