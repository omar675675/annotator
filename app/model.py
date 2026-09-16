"""Safe loading + inference for an optional YOLO .pt detection model."""
from __future__ import annotations

import logging

logger = logging.getLogger("annotator.model")


class ModelWrapper:
    def __init__(self, model_path: str, confidence_threshold: float):
        self.model = None
        self.names: dict[int, str] = {}
        self.confidence_threshold = confidence_threshold

        if not model_path:
            logger.info("No model_path set — running in manual-only mode.")
            return

        try:
            from ultralytics import YOLO

            self.model = YOLO(model_path)
            self.names = dict(self.model.names)
            logger.info("Loaded model '%s' with classes: %s", model_path, list(self.names.values()))
        except Exception as e:
            logger.warning("Could not load model at '%s' (%s). Falling back to manual-only mode.", model_path, e)
            self.model = None
            self.names = {}

    @property
    def available(self) -> bool:
        return self.model is not None

    def predict(self, image_path: str) -> list[dict]:
        """Returns raw detections as normalized boxes with model-native class ids/names."""
        if not self.available:
            return []
        try:
            results = self.model.predict(
                source=image_path,
                conf=self.confidence_threshold,
                verbose=False,
            )
        except Exception as e:
            logger.warning("Inference failed on '%s' (%s). Returning no boxes.", image_path, e)
            return []

        if not results:
            return []

        result = results[0]
        boxes = []
        if result.boxes is None:
            return boxes

        img_h, img_w = result.orig_shape
        for box in result.boxes:
            cls_id = int(box.cls.item())
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            boxes.append(
                {
                    "model_class_id": cls_id,
                    "model_class_name": self.names.get(cls_id, str(cls_id)),
                    "x": ((x1 + x2) / 2) / img_w,
                    "y": ((y1 + y2) / 2) / img_h,
                    "w": (x2 - x1) / img_w,
                    "h": (y2 - y1) / img_h,
                }
            )
        return boxes
