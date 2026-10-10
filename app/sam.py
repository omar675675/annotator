"""Safe loading + inference for an optional SAM3 segmentation model.

Two ways to use it:
- box prompts: mask exactly the object inside each box (used for the
  detection model's boxes and for boxes drawn by hand)
- text prompts: find and mask every object matching a phrase
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

logger = logging.getLogger("annotator.sam")


class SamWrapper:
    def __init__(self, model_path: str, confidence_threshold: float):
        self.model = None
        self.processor = None
        self.load_error: str | None = None
        self._lock = threading.Lock()
        # Embedding the image is the slow part, so keep the last one around —
        # repeated prompts on the same image reuse it.
        self._state = None
        self._state_key = None

        if not model_path:
            logger.info("No sam_model_path set — segmentation disabled.")
            return

        try:
            import torch
            from sam3.model.sam3_image_processor import Sam3Processor
            from sam3.model_builder import build_sam3_image_model

            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            self.model = build_sam3_image_model(
                checkpoint_path=model_path,
                load_from_HF=False,
                device=self.device,
                enable_inst_interactivity=True,
            )
            self.processor = Sam3Processor(
                self.model, device=self.device, confidence_threshold=confidence_threshold
            )
            logger.info("Loaded SAM model '%s' on %s", model_path, self.device)
        except Exception as e:
            logger.warning("Could not load SAM model at '%s' (%s). Segmentation disabled.", model_path, e)
            self.load_error = f"SAM failed to load from '{model_path}' ({e}), so segmentation is off."
            if isinstance(e, ImportError):
                self.load_error += " Check the app was started with the venv that has SAM3 installed."
            self.model = None
            self.processor = None

    @property
    def available(self) -> bool:
        return self.model is not None

    def _autocast(self):
        import torch

        return torch.autocast(self.device, dtype=torch.bfloat16, enabled=self.device == "cuda")

    def _set_image(self, image_path: str):
        from PIL import Image, ImageOps

        path = Path(image_path)
        key = (str(path.resolve()), path.stat().st_mtime)
        if key != self._state_key:
            # exif_transpose so pixel coords match what the browser shows
            image = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
            self._state = self.processor.set_image(image)
            self._state_key = key
        return self._state

    def segment_boxes(
        self, image_path: str, boxes: list[dict], mask_index: int | None = None
    ) -> list[list[list[float]] | None]:
        """One polygon (or None) per normalized {x, y, w, h} box.

        By default SAM gives its single best mask. With mask_index, SAM
        proposes 3 masks per box (e.g. whole vest / part of it) ranked by
        its own score, and the mask_index-th one is used — so a bad mask can
        be swapped for the next candidate."""
        if not self.available or not boxes:
            return [None] * len(boxes)
        import numpy as np

        try:
            with self._lock, self._autocast():
                state = self._set_image(image_path)
                img_w, img_h = state["original_width"], state["original_height"]
                polygons = []
                for b in boxes:
                    xyxy = np.array([
                        (b["x"] - b["w"] / 2) * img_w, (b["y"] - b["h"] / 2) * img_h,
                        (b["x"] + b["w"] / 2) * img_w, (b["y"] + b["h"] / 2) * img_h,
                    ])
                    masks, scores, _ = self.model.predict_inst(
                        state, box=xyxy, multimask_output=mask_index is not None
                    )
                    if mask_index is None:
                        mask = masks[0]
                    else:
                        ranked = np.argsort(-scores)
                        mask = masks[ranked[mask_index % len(ranked)]]
                    polygons.append(mask_to_polygon(mask > 0.5))
                return polygons
        except Exception as e:
            logger.warning("Box segmentation failed on '%s' (%s).", image_path, e)
            return [None] * len(boxes)

    def segment_text(self, image_path: str, prompt: str) -> list[list[list[float]]]:
        """Polygons for every object matching the text prompt."""
        if not self.available or not prompt.strip():
            return []
        try:
            with self._lock, self._autocast():
                state = self._set_image(image_path)
                self.processor.reset_all_prompts(state)
                output = self.processor.set_text_prompt(state=state, prompt=prompt.strip())
                masks = output["masks"].squeeze(1).cpu().numpy()
                self.processor.reset_all_prompts(state)
        except Exception as e:
            logger.warning("Text segmentation failed on '%s' (%s).", image_path, e)
            return []
        polygons = [mask_to_polygon(m) for m in masks]
        return [p for p in polygons if p is not None]


def mask_to_polygon(mask) -> list[list[float]] | None:
    """Outline of a boolean HxW mask as normalized [x, y] points.

    A YOLO-seg line holds one polygon, so when an object shows up in several
    pieces (e.g. a vest split by an arm) the pieces are joined with thin
    connecting lines, the same way Ultralytics converts COCO masks. Specks
    under 2% of the mask's area are dropped."""
    import cv2
    import numpy as np
    from ultralytics.data.converter import merge_multi_segment

    h, w = mask.shape
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)
    total_area = sum(cv2.contourArea(c) for c in contours)
    pieces = []
    for contour in contours:
        if cv2.contourArea(contour) < 0.02 * total_area:
            break
        epsilon = max(1.0, 0.002 * cv2.arcLength(contour, True))
        points = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
        if len(points) >= 3:
            pieces.append(points)
    if not pieces:
        return None
    points = pieces[0] if len(pieces) == 1 else np.concatenate(merge_multi_segment(pieces))
    return [[float(x) / w, float(y) / h] for x, y in points]
