# Annotator

A browser tool for labelling a folder of images in YOLO format. You can use
it fully by hand, or let a model do the first pass and fix what it got wrong:

- a YOLO detection model to pre-draw boxes
- SAM3 to turn objects into masks (segmentation)
- both together

What the app does depends on which models you point it at. Each setup is
explained below.

## Setup

```
pip install -r requirements.txt
```

That covers the app and SAM3's dependencies. If you want segmentation, SAM3
itself is installed separately from its repo, and its weights go in
`models/`:

```
pip install --no-deps /path/to/sam3
cp /path/to/sam3/sam3.pt models/
```

`--no-deps` matters. SAM3 asks for `numpy<2`, which would downgrade numpy
under Ultralytics. It runs fine on numpy 2.

Run the app with the same Python environment you installed into. If SAM
can't load (wrong venv, missing file), the app still starts, just without
segmentation, and a yellow banner over the image tells you why.

## Run

```
python main.py
```

Then open http://127.0.0.1:8000

## Config

Everything is set in `config.yaml`:

```yaml
model_path: ""                 # YOLO detection model (.pt), optional
sam_model_path: ""             # SAM3 weights, e.g. models/sam3.pt, optional
dataset_dir: "dataset/images"  # images to label
annotated_dir: "annotated"     # finished images and labels go here
classes: []                    # your class names, in order
confidence_threshold: 0.25     # for the detection model
sam_confidence_threshold: 0.5  # for SAM text prompts
class_map: {}                  # filled in by the app
```

Leave a model path empty (`""`) to turn that model off. Restart the app after
changing the config.

## The four setups

### No model

```yaml
model_path: ""
sam_model_path: ""
```

Plain manual labelling. Images open with no boxes, you draw them yourself and
pick a class for each one. Labels are saved as boxes.

`classes` has to be set, since there's no model to read class names from.

<!-- screenshot: no model -->
<img width="1600" height="747" alt="no models" src="https://github.com/user-attachments/assets/65795c91-b645-446f-b3ef-b02f141fbc2d" />


### Detection model only

```yaml
model_path: models/your-model.pt
sam_model_path: ""
```

When an image opens, the model runs on it and its boxes are drawn for you.
You fix, delete or add boxes, then move on. Labels are saved as boxes.

- Detections below `confidence_threshold` are dropped.
- If `classes` is empty, the model's own class names are used and written
  into the config.
- If your class names don't match the model's, a window opens on start so you
  can say which of your classes each model class should become, or drop it.
  You can reopen it any time with the ⚙ button. For example, the model says
  `hardhat` and you want `helmet`.
- The model only runs on images that don't already have a label. If you've
  started an image before, you get your saved boxes back, not a fresh
  prediction.

<!-- screenshot: detection model only -->
<img width="1600" height="747" alt="ppemodel" src="https://github.com/user-attachments/assets/a2f8a69c-fcab-421a-bf9e-2b4d0fdf8c66" />


### SAM model only

```yaml
model_path: ""
sam_model_path: models/sam3.pt
```

There's no detector, so you tell SAM what to look for. A "Segment by text"
box appears in the sidebar. Type what you want and press Enter:

```
helmet, vest
```

- Commas split it into separate searches. Each word finds every match in the
  image.
- A word goes to the class with the same name. Case, spaces and underscores
  don't matter, so `no helmet` finds `no_helmet`.
- If a word isn't one of your classes (say `hardhat`), the app asks which
  class it belongs to. It only asks once. The answer is saved in your browser
  and shows as a small tag under the box. Click the × on the tag to forget it.
- Matches that overlap something already labelled are skipped, so running
  the same prompt twice doesn't double up.

The last prompt you ran keeps running on every new image in the Pending tab,
so you can go through a whole folder by just pressing →. The line under the
box shows what's being run. Run a different prompt to change it, or press
**Stop** to turn it off. It doesn't run on the Annotated tab.

You can also draw a box by hand and SAM will mask whatever is inside it.

`classes` has to be set in this mode. Labels are saved as masks (see Output).
SAM needs a GPU in practice, about 4.5 GB of memory.

<!-- screenshot: SAM model only -->
<img width="1600" height="747" alt="sammodel" src="https://github.com/user-attachments/assets/d30d30c1-5fbc-4f5b-b64a-1c60255707b4" />


### Both models

```yaml
model_path: models/your-model.pt
sam_model_path: models/sam3.pt
```

The detector finds the objects, then SAM masks each box it found. So you get
masks with the detector's classes, without typing anything. The text box is
hidden in this mode.

Everything from the detection-only section applies (thresholds, class
mapping). Labels are saved as masks.

<!-- screenshot: both models -->
<img width="1600" height="747" alt="both" src="https://github.com/user-attachments/assets/2311f4cf-79ab-4382-bc66-805e748e67d4" />


### Things that work the same whenever SAM is on

- Drawing, moving, resizing or duplicating a box asks SAM for a new mask, and
  the box shrinks to fit it.
- If a mask is wrong, for example SAM only took half of a vest, right-click
  the box and pick **Next mask**. SAM gives three guesses per box, and this
  cycles through them.
- Old images that only have boxes are shown with masks when you open them.
  On the Annotated tab the file is only rewritten if you actually change
  something, so just looking through them changes nothing.

With SAM off, a mask that's already there moves and stretches along with its
box.

## Using it

There are two tabs:

- **Pending** shows the images in `dataset_dir`. Pressing → or Next saves the
  labels and moves the image into `annotated/images`. Your work is also saved
  as you go, so closing the browser halfway through an image doesn't lose
  anything.
- **Annotated** shows finished images. You can go back and edit them. The
  label is updated in place and the image stays where it is.

The Delete Image button removes the image file from `dataset_dir` for good.
There's no undo.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `B` | Draw tool |
| `D` | Pan tool (hover a box to see just that box) |
| `Esc` | Select tool, or close a menu |
| `Space` (hold) | Pan while held |
| `1`–`9` | Set the class of the selected box, or the class for the next box you draw |
| `Delete` / `Backspace` | Delete the selected box |
| `Shift+Delete` | Delete the current image (no undo) |
| `←` / `→` | Save and go to the previous / next image |
| `S` | Save and go to the next image |
| Mouse wheel | Zoom |
| Right-click a box | Duplicate, delete, or Next mask (with SAM) |

## Output

Finished images go to `annotated/images/` and labels to `annotated/labels/`,
one `.txt` per image with the same name. Class ids are positions in your
`classes` list, starting at 0. All coordinates are 0–1.

Without SAM, each line is a box:

```
class_id x_center y_center width height
```

With SAM, each line is a polygon (YOLO segmentation format):

```
class_id x1 y1 x2 y2 x3 y3 ...
```

A few details about masks:

- An object that SAM sees in two pieces (a vest split by an arm) becomes one
  polygon, with the pieces joined by a thin line. That's how Ultralytics does
  it too.
- A label file never mixes boxes and polygons, because Ultralytics drops those
  images when training. If a file already has polygons, a plain box is saved
  as a 4-point polygon.
- A mix of box files and mask files across the folder is fine for training a
  detection model. For a segmentation model, Ultralytics throws away all the
  masks, so keep it to one format.

### Warning banner

A yellow banner over the image shows up when:

- SAM was configured but failed to load
- the labels folder has masks but SAM is off, or boxes but SAM is on, which
  means you're about to mix formats
- two images would share one label file, like `a.jpg` and `a.png`, or the
  same file sitting in both `dataset_dir` and `annotated/images`. Rename one
  of them, or they'll overwrite each other's labels.

## Repo layout

```
app/        backend (FastAPI): routes, config, YOLO and SAM wrappers, label files
static/     frontend (HTML/JS/CSS)
models/     model weights (.pt files are gitignored)
dataset/    images to label (gitignored)
annotated/  finished images and labels (gitignored)
```
