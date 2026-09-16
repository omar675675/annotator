# Annotator

A small browser-based tool for drawing YOLO bounding boxes on a folder of
images. It can optionally pre-populate boxes using a YOLO detection `.pt`
model — if you don't have one, it just works as a manual annotator.

Right now only detection models (YOLO) are supported. There's no SAM or
prompt-based (text/click) model support yet.

## Setup

```
pip install -r requirements.txt
```

Edit `config.yaml`:

```yaml
model_path: ""                 # optional: path to a YOLO .pt detection model
dataset_dir: "images"          # folder of images to annotate
annotated_dir: "annotated"     # where finished images/labels go
classes: []                    # your classes, or leave empty to pull from the model
confidence_threshold: 0.25
class_map: {}                  # filled in automatically
```

- No `model_path` → pure manual annotation, nothing crashes.
- `model_path` set, `classes` empty → classes are pulled from the model automatically.
- `model_path` set, `classes` set and they don't match the model's own classes →
  the app shows a one-time mapping screen so you can point each model class at
  one of your classes (or ignore it).

## Run

```
python main.py
```

Then open http://127.0.0.1:8000

## Usage

1. Point `dataset_dir` at a folder of images you want to label.
2. Open the app in your browser — it loads one image at a time.
3. If a model is configured, boxes are pre-drawn for you; otherwise draw
   your own by dragging on the image.
4. Adjust/delete boxes, assign classes, then submit.

## Output

- Finished images move to `annotated/images/`, their YOLO-format labels to
  `annotated/labels/` (`class_id x_center y_center width height`, normalized,
  class ids index into your `classes` list).
- Deleted images are permanently removed from `dataset_dir`.

## Repo layout

```
app/        FastAPI backend (routes, config, model wrapper, storage)
static/     Frontend (HTML/JS/CSS) served by the backend
models/     YOLO .pt weights
dataset/    Source images to annotate (gitignored)
annotated/  Output images/labels (gitignored contents, folders tracked)
```
