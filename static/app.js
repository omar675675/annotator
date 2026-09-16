(() => {
  "use strict";

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");

  const el = {
    modelBadge: document.getElementById("modelBadge"),
    pendingTab: document.getElementById("pendingTab"),
    annotatedTab: document.getElementById("annotatedTab"),
    pendingTabCount: document.getElementById("pendingTabCount"),
    annotatedTabCount: document.getElementById("annotatedTabCount"),
    classmapBtn: document.getElementById("classmapBtn"),
    classList: document.getElementById("classList"),
    nextActionBtn: document.getElementById("nextActionBtn"),
    deleteImageBtn: document.getElementById("deleteImageBtn"),
    emptyState: document.getElementById("emptyState"),
    emptyStateTitle: document.getElementById("emptyStateTitle"),
    emptyStateText: document.getElementById("emptyStateText"),
    loadingState: document.getElementById("loadingState"),
    prevBtn: document.getElementById("prevBtn"),
    nextBtn: document.getElementById("nextBtn"),
    toolBadge: document.getElementById("toolBadge"),
    contextMenu: document.getElementById("boxContextMenu"),
    ctxDuplicate: document.getElementById("ctxDuplicate"),
    ctxDelete: document.getElementById("ctxDelete"),
    classPicker: document.getElementById("classPicker"),
    classmapModal: document.getElementById("classmapModal"),
    classmapRows: document.getElementById("classmapRows"),
    classmapSaveBtn: document.getElementById("classmapSaveBtn"),
    classmapCancelBtn: document.getElementById("classmapCancelBtn"),
    confirmDeleteModal: document.getElementById("confirmDeleteModal"),
    confirmDeleteBtn: document.getElementById("confirmDeleteBtn"),
    cancelDeleteBtn: document.getElementById("cancelDeleteBtn"),
    toast: document.getElementById("toast"),
  };

  const HANDLE_SIZE = 6; // visual size — kept small so edges stay precise, Roboflow-style
  const HANDLE_HIT_RADIUS = 9; // generous click tolerance, independent of the visual size
  const MIN_BOX_PX = 5;

  const state = {
    classes: [],
    activeTab: "pending", // "pending" | "annotated"
    queue: [],
    queueIndex: 0,
    pendingCount: 0,
    annotatedCount: 0,
    currentFilename: null,
    image: null,
    imgW: 0,
    imgH: 0,
    boxes: [],
    selectedIndex: null,
    hoverIndex: null, // box under the cursor in Pan/verify mode
    activeClassIndex: 0,
    tool: "select", // "select" | "draw" | "pan"
    zoom: 1,
    panX: 0,
    panY: 0,
    spaceHeld: false,
    drag: null, // {mode, ...}
  };

  function classColor(i) {
    const hue = (i * 360) / Math.max(state.classes.length, 1);
    return `hsl(${hue}, 70%, 55%)`;
  }

  function showToast(message, isError) {
    el.toast.textContent = message;
    el.toast.className = "toast" + (isError ? " error" : "");
    el.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { el.toast.hidden = true; }, 3200);
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || `Request failed (${res.status})`);
    }
    return res.json();
  }

  // --- layout / transform -----------------------------------------------

  function resizeCanvas() {
    const wrap = canvas.parentElement;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    draw();
  }
  window.addEventListener("resize", resizeCanvas);

  function getTransform() {
    if (!state.imgW || !state.imgH) return { scale: 1, offsetX: 0, offsetY: 0 };
    const baseScale = Math.min(canvas.width / state.imgW, canvas.height / state.imgH);
    const scale = baseScale * state.zoom;
    const drawW = state.imgW * scale;
    const drawH = state.imgH * scale;
    const offsetX = (canvas.width - drawW) / 2 + state.panX;
    const offsetY = (canvas.height - drawH) / 2 + state.panY;
    return { scale, offsetX, offsetY };
  }

  function imageToScreen(x, y) {
    const { scale, offsetX, offsetY } = getTransform();
    return { x: offsetX + x * scale, y: offsetY + y * scale };
  }

  function screenToImage(x, y) {
    const { scale, offsetX, offsetY } = getTransform();
    return { x: (x - offsetX) / scale, y: (y - offsetY) / scale };
  }

  function boxPixelRect(box) {
    const cx = box.x * state.imgW, cy = box.y * state.imgH;
    const w = box.w * state.imgW, h = box.h * state.imgH;
    return { left: cx - w / 2, top: cy - h / 2, width: w, height: h };
  }

  function clampPointToImage(pt) {
    return {
      x: Math.max(0, Math.min(pt.x, state.imgW)),
      y: Math.max(0, Math.min(pt.y, state.imgH)),
    };
  }

  // --- drawing -------------------------------------------------------------

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!state.image) return;

    const { scale, offsetX, offsetY } = getTransform();
    ctx.drawImage(state.image, offsetX, offsetY, state.imgW * scale, state.imgH * scale);

    if (state.tool === "pan" && state.hoverIndex !== null) {
      // Verify mode: only kicks in while hovering a box — darken everything,
      // then spotlight just that box at full brightness so you can check its
      // placement against the real pixels without other boxes distracting.
      ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
      ctx.fillRect(offsetX, offsetY, state.imgW * scale, state.imgH * scale);
      const hovered = state.boxes[state.hoverIndex];
      const rect = boxPixelRect(hovered);
      const p1 = imageToScreen(rect.left, rect.top);
      const p2 = imageToScreen(rect.left + rect.width, rect.top + rect.height);
      // Crop-and-draw just the box's source region onto its destination
      // rect — no clip() involved, so there's no clip state to leak
      // between frames.
      ctx.drawImage(
        state.image,
        rect.left, rect.top, rect.width, rect.height,
        p1.x, p1.y, p2.x - p1.x, p2.y - p1.y
      );
    }

    state.boxes.forEach((box, i) => {
      const rect = boxPixelRect(box);
      const p1 = imageToScreen(rect.left, rect.top);
      const p2 = imageToScreen(rect.left + rect.width, rect.top + rect.height);
      const color = classColor(box.class_id);
      const selected = i === state.selectedIndex;

      ctx.lineWidth = selected ? 1.5 : 1;
      ctx.strokeStyle = color;
      ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);

      if (selected) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.12;
        ctx.fillRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
        ctx.globalAlpha = 1;
      }

      const label = state.classes[box.class_id] || `class ${box.class_id}`;
      ctx.font = "12px sans-serif";
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(p1.x, p1.y - 18, textW + 10, 18);
      ctx.fillStyle = "#0e1013";
      ctx.fillText(label, p1.x + 5, p1.y - 5);

      if (selected) {
        handlePositions(p1, p2).forEach((h) => {
          ctx.fillStyle = "#ffffff";
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.fillRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
          ctx.strokeRect(h.x - HANDLE_SIZE / 2, h.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
        });
      }
    });
  }

  function handlePositions(p1, p2) {
    const midX = (p1.x + p2.x) / 2, midY = (p1.y + p2.y) / 2;
    return [
      { name: "nw", x: p1.x, y: p1.y }, { name: "n", x: midX, y: p1.y }, { name: "ne", x: p2.x, y: p1.y },
      { name: "w", x: p1.x, y: midY }, { name: "e", x: p2.x, y: midY },
      { name: "sw", x: p1.x, y: p2.y }, { name: "s", x: midX, y: p2.y }, { name: "se", x: p2.x, y: p2.y },
    ];
  }

  // --- hit testing -----------------------------------------------------------

  function hitHandle(mx, my) {
    if (state.selectedIndex === null) return null;
    const box = state.boxes[state.selectedIndex];
    if (!box) return null;
    const rect = boxPixelRect(box);
    const p1 = imageToScreen(rect.left, rect.top);
    const p2 = imageToScreen(rect.left + rect.width, rect.top + rect.height);
    for (const h of handlePositions(p1, p2)) {
      if (Math.abs(mx - h.x) <= HANDLE_HIT_RADIUS && Math.abs(my - h.y) <= HANDLE_HIT_RADIUS) return h.name;
    }
    return null;
  }

  function hitBox(mx, my) {
    const img = screenToImage(mx, my);
    for (let i = state.boxes.length - 1; i >= 0; i--) {
      const rect = boxPixelRect(state.boxes[i]);
      if (img.x >= rect.left && img.x <= rect.left + rect.width && img.y >= rect.top && img.y <= rect.top + rect.height) {
        return i;
      }
    }
    return null;
  }

  // --- tool switching --------------------------------------------------------

  const TOOL_LABELS = { select: "Select", draw: "Draw", pan: "Pan" };

  function setTool(tool) {
    state.tool = tool;
    state.hoverIndex = null;
    updateCursor();
    el.toolBadge.textContent = `${TOOL_LABELS[tool]} `;
    const kbd = document.createElement("kbd");
    kbd.textContent = tool === "select" ? "Esc" : tool === "draw" ? "B" : "D";
    el.toolBadge.appendChild(kbd);
    draw();
  }

  function updateCursor() {
    if (state.spaceHeld || state.tool === "pan") canvas.style.cursor = "grab";
    else if (state.tool === "draw") canvas.style.cursor = "crosshair";
    else canvas.style.cursor = "default";
  }

  // --- mouse interaction -------------------------------------------------

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (!state.image) return;
    hideContextMenu();
    const mx = e.offsetX, my = e.offsetY;

    if (state.spaceHeld) {
      state.drag = { mode: "pan", startX: mx, startY: my, panX0: state.panX, panY0: state.panY };
      canvas.style.cursor = "grabbing";
      return;
    }

    if (state.tool === "draw") {
      state.selectedIndex = null;
      const startImg = clampPointToImage(screenToImage(mx, my));
      state.drag = { mode: "draw", startImg };
      draw();
      return;
    }

    // "select" and "pan" tools both act on a box/handle under the cursor first —
    // dragging only pans the view when you click empty canvas.
    const handle = hitHandle(mx, my);
    if (handle) {
      state.drag = { mode: "resize", handle, boxIndex: state.selectedIndex, startImg: screenToImage(mx, my), origBox: { ...state.boxes[state.selectedIndex] } };
      return;
    }

    const hitIdx = hitBox(mx, my);
    if (hitIdx !== null) {
      state.selectedIndex = hitIdx;
      const startImg = screenToImage(mx, my);
      state.drag = { mode: "move", boxIndex: hitIdx, startImg, origBox: { ...state.boxes[hitIdx] } };
      draw();
      return;
    }

    if (state.tool === "pan") {
      state.selectedIndex = null;
      state.drag = { mode: "pan", startX: mx, startY: my, panX0: state.panX, panY0: state.panY };
      canvas.style.cursor = "grabbing";
      draw();
      return;
    }

    state.selectedIndex = null;
    const startImg = clampPointToImage(screenToImage(mx, my));
    state.drag = { mode: "draw", startImg };
    draw();
  });

  window.addEventListener("mousemove", (e) => {
    if (!state.drag || !state.image) return;
    const rectEl = canvas.getBoundingClientRect();
    const mx = e.clientX - rectEl.left, my = e.clientY - rectEl.top;

    if (state.drag.mode === "pan") {
      state.panX = state.drag.panX0 + (mx - state.drag.startX);
      state.panY = state.drag.panY0 + (my - state.drag.startY);
      draw();
      return;
    }

    const cur = screenToImage(mx, my);

    if (state.drag.mode === "draw") {
      const c = clampPointToImage(cur);
      const x0 = state.drag.startImg.x, y0 = state.drag.startImg.y;
      const left = Math.min(x0, c.x), top = Math.min(y0, c.y);
      const w = Math.abs(c.x - x0), h = Math.abs(c.y - y0);
      state.drag.previewBox = {
        class_id: state.activeClassIndex,
        x: (left + w / 2) / state.imgW,
        y: (top + h / 2) / state.imgH,
        w: w / state.imgW,
        h: h / state.imgH,
      };
      renderWithPreview();
      return;
    }

    if (state.drag.mode === "move") {
      const dxPx = cur.x - state.drag.startImg.x;
      const dyPx = cur.y - state.drag.startImg.y;
      const wPx = state.drag.origBox.w * state.imgW;
      const hPx = state.drag.origBox.h * state.imgH;
      let left = (state.drag.origBox.x * state.imgW - wPx / 2) + dxPx;
      let top = (state.drag.origBox.y * state.imgH - hPx / 2) + dyPx;
      left = Math.max(0, Math.min(left, state.imgW - wPx));
      top = Math.max(0, Math.min(top, state.imgH - hPx));
      const box = state.boxes[state.drag.boxIndex];
      box.x = (left + wPx / 2) / state.imgW;
      box.y = (top + hPx / 2) / state.imgH;
      draw();
      return;
    }

    if (state.drag.mode === "resize") {
      resizeBox(state.drag, clampPointToImage(cur));
      draw();
    }
  });

  function renderWithPreview() {
    draw();
    if (state.drag && state.drag.previewBox) {
      const rect = boxPixelRect(state.drag.previewBox);
      const p1 = imageToScreen(rect.left, rect.top);
      const p2 = imageToScreen(rect.left + rect.width, rect.top + rect.height);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = classColor(state.activeClassIndex);
      ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
      ctx.setLineDash([]);
    }
  }

  function resizeBox(drag, cur) {
    const orig = drag.origBox;
    let left = (orig.x - orig.w / 2) * state.imgW;
    let top = (orig.y - orig.h / 2) * state.imgH;
    let right = left + orig.w * state.imgW;
    let bottom = top + orig.h * state.imgH;

    if (drag.handle.includes("n")) top = cur.y;
    if (drag.handle.includes("s")) bottom = cur.y;
    if (drag.handle.includes("w")) left = cur.x;
    if (drag.handle.includes("e")) right = cur.x;

    if (right < left) [left, right] = [right, left];
    if (bottom < top) [top, bottom] = [bottom, top];

    const box = state.boxes[drag.boxIndex];
    box.x = ((left + right) / 2) / state.imgW;
    box.y = ((top + bottom) / 2) / state.imgH;
    box.w = (right - left) / state.imgW;
    box.h = (bottom - top) / state.imgH;
  }

  window.addEventListener("mouseup", () => {
    if (!state.drag) return;
    if (state.drag.mode === "draw" && state.drag.previewBox) {
      const { scale } = getTransform();
      const wPx = state.drag.previewBox.w * state.imgW * scale;
      const hPx = state.drag.previewBox.h * state.imgH * scale;
      if (wPx >= MIN_BOX_PX && hPx >= MIN_BOX_PX) {
        state.boxes.push(state.drag.previewBox);
        state.selectedIndex = state.boxes.length - 1;
        autosave();
        showClassPicker(state.selectedIndex);
      }
    }
    state.drag = null;
    updateCursor();
    draw();
    renderClassList();
  });

  canvas.addEventListener("wheel", (e) => {
    if (!state.image) return;
    e.preventDefault();
    const rectEl = canvas.getBoundingClientRect();
    const mx = e.clientX - rectEl.left, my = e.clientY - rectEl.top;
    const before = screenToImage(mx, my);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    state.zoom = Math.min(Math.max(state.zoom * factor, 0.2), 10);
    const after = screenToImage(mx, my);
    const { scale } = getTransform();
    state.panX += (after.x - before.x) * scale;
    state.panY += (after.y - before.y) * scale;
    draw();
  }, { passive: false });

  // In Pan/verify mode, track which box the cursor is over so draw() can
  // spotlight just that one. Only relevant when not actively dragging.
  canvas.addEventListener("mousemove", (e) => {
    if (state.tool !== "pan" || state.drag || !state.image) return;
    const idx = hitBox(e.offsetX, e.offsetY);
    if (idx !== state.hoverIndex) {
      state.hoverIndex = idx;
      draw();
    }
  });

  canvas.addEventListener("mouseleave", () => {
    if (state.hoverIndex !== null) {
      state.hoverIndex = null;
      draw();
    }
  });

  // --- right-click context menu ---------------------------------------------

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (!state.image) return;
    const hitIdx = hitBox(e.offsetX, e.offsetY);
    if (hitIdx === null) {
      hideContextMenu();
      return;
    }
    state.selectedIndex = hitIdx;
    draw();
    showContextMenu(e.clientX, e.clientY, hitIdx);
  });

  function showContextMenu(clientX, clientY, boxIndex) {
    el.contextMenu.style.left = `${clientX}px`;
    el.contextMenu.style.top = `${clientY}px`;
    el.contextMenu.dataset.boxIndex = boxIndex;
    el.contextMenu.hidden = false;
  }

  function hideContextMenu() {
    el.contextMenu.hidden = true;
  }

  function duplicateBox(index) {
    const orig = state.boxes[index];
    if (!orig) return;
    const wPx = orig.w * state.imgW, hPx = orig.h * state.imgH;
    const offsetPx = Math.max(6, Math.min(wPx, hPx) * 0.08);
    let left = (orig.x * state.imgW - wPx / 2) + offsetPx;
    let top = (orig.y * state.imgH - hPx / 2) + offsetPx;
    left = Math.max(0, Math.min(left, state.imgW - wPx));
    top = Math.max(0, Math.min(top, state.imgH - hPx));
    state.boxes.push({
      class_id: orig.class_id,
      x: (left + wPx / 2) / state.imgW,
      y: (top + hPx / 2) / state.imgH,
      w: orig.w,
      h: orig.h,
    });
    state.selectedIndex = state.boxes.length - 1;
    draw();
    renderClassList();
    autosave();
  }

  el.ctxDuplicate.addEventListener("click", () => {
    const idx = Number(el.contextMenu.dataset.boxIndex);
    hideContextMenu();
    duplicateBox(idx);
  });

  el.ctxDelete.addEventListener("click", () => {
    const idx = Number(el.contextMenu.dataset.boxIndex);
    hideContextMenu();
    state.boxes.splice(idx, 1);
    state.selectedIndex = null;
    draw();
    renderClassList();
    autosave();
  });

  window.addEventListener("mousedown", (e) => {
    if (!el.contextMenu.hidden && !el.contextMenu.contains(e.target)) hideContextMenu();
    if (!el.classPicker.hidden && !el.classPicker.contains(e.target)) hideClassPicker();
  });

  // --- inline class picker ----------------------------------------------------
  // Shown right after drawing a new box, positioned at the box itself — pick a
  // class there instead of reaching for the sidebar. Whatever you pick (or the
  // box's current class, if you just click away) becomes the "active" class
  // for the next box you draw, Roboflow-style.

  function showClassPicker(boxIndex) {
    const box = state.boxes[boxIndex];
    if (!box) return;
    const rect = boxPixelRect(box);
    const p1 = imageToScreen(rect.left, rect.top);
    const canvasRect = canvas.getBoundingClientRect();

    el.classPicker.innerHTML = "";
    state.classes.forEach((name, i) => {
      const row = document.createElement("button");
      row.className = "class-picker-row";
      row.innerHTML = `
        <span class="swatch" style="background:${classColor(i)}"></span>
        <span>${name}</span>
        <span class="class-key">${i < 9 ? i + 1 : ""}</span>
      `;
      row.addEventListener("click", () => assignClass(boxIndex, i));
      el.classPicker.appendChild(row);
    });
    el.classPicker.dataset.boxIndex = boxIndex;
    el.classPicker.hidden = false;

    // position after it's visible so offsetWidth/Height are accurate, and
    // clamp so it never renders off-screen
    const menuW = el.classPicker.offsetWidth, menuH = el.classPicker.offsetHeight;
    let left = canvasRect.left + p1.x;
    let top = canvasRect.top + p1.y - menuH - 6;
    if (top < 4) top = canvasRect.top + p1.y + 6;
    left = Math.min(left, window.innerWidth - menuW - 8);
    el.classPicker.style.left = `${Math.max(8, left)}px`;
    el.classPicker.style.top = `${top}px`;
  }

  function hideClassPicker() {
    el.classPicker.hidden = true;
  }

  function assignClass(boxIndex, classIdx) {
    const box = state.boxes[boxIndex];
    if (!box) return;
    box.class_id = classIdx;
    state.activeClassIndex = classIdx;
    hideClassPicker();
    renderClassList();
    draw();
    autosave();
  }

  // --- keyboard ------------------------------------------------------------

  window.addEventListener("keydown", (e) => {
    if (document.activeElement && ["SELECT", "INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (!el.classmapModal.hidden || !el.confirmDeleteModal.hidden) return;

    if (e.key === "Escape") {
      e.preventDefault();
      if (!el.contextMenu.hidden) { hideContextMenu(); return; }
      if (!el.classPicker.hidden) { hideClassPicker(); return; }
      setTool("select");
      return;
    }
    if (!el.contextMenu.hidden) return;

    if (e.code === "Space") { state.spaceHeld = true; updateCursor(); e.preventDefault(); return; }

    if (e.key.toLowerCase() === "b" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setTool("draw"); return; }
    if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setTool("pan"); return; }

    if (e.key >= "1" && e.key <= "9") {
      const idx = Number(e.key) - 1;
      if (idx < state.classes.length) {
        if (state.selectedIndex !== null) {
          assignClass(state.selectedIndex, idx);
        } else {
          state.activeClassIndex = idx;
          renderClassList();
        }
      }
      return;
    }

    if ((e.key === "Delete" || e.key === "Backspace") && e.shiftKey) {
      e.preventDefault();
      openConfirmDelete();
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (state.selectedIndex !== null) {
        hideClassPicker();
        state.boxes.splice(state.selectedIndex, 1);
        state.selectedIndex = null;
        draw();
        renderClassList();
        autosave();
      }
      return;
    }

    if (e.key === "ArrowRight") { e.preventDefault(); nextImage(); return; }
    if (e.key === "ArrowLeft") { e.preventDefault(); prevImage(); return; }
    if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); nextImage(); return; }
  });

  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") { state.spaceHeld = false; updateCursor(); }
  });

  // --- class list sidebar --------------------------------------------------

  function renderClassList() {
    el.classList.innerHTML = "";
    state.classes.forEach((name, i) => {
      const count = state.boxes.filter((b) => b.class_id === i).length;
      const li = document.createElement("li");
      li.className = i === state.activeClassIndex ? "active" : "";
      li.innerHTML = `
        <span class="swatch" style="background:${classColor(i)}"></span>
        <span>${name}</span>
        <span class="class-count">${count}</span>
        <span class="class-key">${i < 9 ? i + 1 : ""}</span>
      `;
      li.addEventListener("click", () => {
        if (state.selectedIndex !== null) {
          assignClass(state.selectedIndex, i);
        } else {
          state.activeClassIndex = i;
          renderClassList();
        }
      });
      el.classList.appendChild(li);
    });
  }

  // --- image loading ---------------------------------------------------------

  function metaUrl(filename) {
    return state.activeTab === "annotated"
      ? `/api/annotated/${encodeURIComponent(filename)}`
      : `/api/image/${encodeURIComponent(filename)}`;
  }

  function fileUrl(filename) {
    return `${metaUrl(filename)}/file`;
  }

  async function loadCurrent() {
    if (state.queue.length === 0) {
      if (state.activeTab === "pending") {
        el.emptyStateTitle.textContent = "All done 🎉";
        el.emptyStateText.textContent = "No pending images left in the dataset folder.";
      } else {
        el.emptyStateTitle.textContent = "Nothing here yet";
        el.emptyStateText.textContent = "Images you finish annotating will show up in this tab.";
      }
      el.emptyState.hidden = false;
      el.loadingState.hidden = true;
      state.currentFilename = null;
      state.image = null;
      draw();
      updateCounts();
      updateNavButtons();
      return;
    }
    el.emptyState.hidden = true;
    const filename = state.queue[state.queueIndex];
    await loadMeta(filename);
  }

  async function loadMeta(filename) {
    el.loadingState.hidden = false;
    hideClassPicker();
    try {
      const data = await api(metaUrl(filename));
      state.currentFilename = filename;
      state.boxes = data.boxes;
      state.selectedIndex = null;
      state.zoom = 1; state.panX = 0; state.panY = 0;
      await loadImageBitmap(filename);
      renderClassList();
      updateCounts();
      updateNavButtons();
    } catch (err) {
      showToast(err.message, true);
    } finally {
      el.loadingState.hidden = true;
    }
  }

  function loadImageBitmap(filename) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        state.image = img;
        state.imgW = img.naturalWidth;
        state.imgH = img.naturalHeight;
        draw();
        resolve();
      };
      img.onerror = reject;
      img.src = `${fileUrl(filename)}?t=${Date.now()}`;
    });
  }

  function updateNavButtons() {
    const canBrowse = state.queue.length > 1;
    el.prevBtn.hidden = !canBrowse;
    el.nextBtn.hidden = !canBrowse;
  }

  function updateCounts() {
    el.pendingTabCount.textContent = state.pendingCount;
    el.annotatedTabCount.textContent = state.annotatedCount;
  }

  // --- navigation actions ------------------------------------------------

  function cleanBoxes() {
    return state.boxes.filter((b) => b && b.w > 0.001 && b.h > 0.001);
  }

  // Fire-and-forget: protects in-progress edits on disk. On the Pending tab
  // this writes a draft without finalizing (image stays in the queue); on
  // the Annotated tab it updates the label of an already-finished image in
  // place. Called on every box add/delete.
  async function autosave() {
    if (!state.currentFilename) return;
    const action = state.activeTab === "annotated" ? "save" : "autosave";
    try {
      await api(`${metaUrl(state.currentFilename)}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boxes: cleanBoxes() }),
      });
    } catch (err) {
      // non-critical — the full state still gets written when the image is finalized/left
    }
  }

  // Finalizes the current pending image (writes its label, moves it into
  // annotated_dir) then moves the queue by `direction` (0 = next, -1 = prev).
  async function finalizeAndMove(direction) {
    if (!state.currentFilename) return;
    try {
      const res = await api(`/api/image/${encodeURIComponent(state.currentFilename)}/save`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boxes: cleanBoxes() }),
      });
      state.pendingCount = res.pending_count;
      state.annotatedCount = res.annotated_count;
      state.queue.splice(state.queueIndex, 1);
      if (state.queue.length === 0) {
        state.queueIndex = 0;
      } else {
        state.queueIndex = ((state.queueIndex + direction) % state.queue.length + state.queue.length) % state.queue.length;
      }
      await loadCurrent();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // Ensures the image being left has its current box state persisted, even
  // if the last edit was a move/resize (which autosave doesn't cover) rather
  // than an add/delete. Only the Annotated tab needs this explicitly — the
  // Pending tab's finalizeAndMove already re-sends the full box list.
  async function persistCurrentBeforeLeaving() {
    if (state.activeTab !== "annotated" || !state.currentFilename) return;
    try {
      await api(`/api/annotated/${encodeURIComponent(state.currentFilename)}/save`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boxes: cleanBoxes() }),
      });
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function browseAnnotated(direction) {
    if (state.queue.length <= 1) return;
    await persistCurrentBeforeLeaving();
    state.queueIndex = ((state.queueIndex + direction) % state.queue.length + state.queue.length) % state.queue.length;
    await loadCurrent();
  }

  function nextImage() {
    if (state.activeTab === "pending") finalizeAndMove(0);
    else browseAnnotated(1);
  }

  function prevImage() {
    if (state.activeTab === "pending") finalizeAndMove(-1);
    else browseAnnotated(-1);
  }

  function openConfirmDelete() {
    if (!state.currentFilename || state.activeTab !== "pending") return;
    el.confirmDeleteModal.hidden = false;
  }

  // --- tabs ------------------------------------------------------------------

  async function loadQueueForTab() {
    if (state.activeTab === "pending") {
      const q = await api("/api/queue");
      state.queue = q.pending;
      state.pendingCount = q.pending_count;
      state.annotatedCount = q.annotated_count;
      const resumeIndex = q.last_filename ? state.queue.indexOf(q.last_filename) : -1;
      state.queueIndex = resumeIndex >= 0 ? resumeIndex : 0;
    } else {
      const q = await api("/api/annotated");
      state.queue = q.annotated;
      state.annotatedCount = q.annotated_count;
      state.queueIndex = 0;
    }
    updateCounts();
    await loadCurrent();
  }

  async function switchTab(tab) {
    if (state.activeTab === tab) return;
    hideContextMenu();
    await persistCurrentBeforeLeaving();
    state.activeTab = tab;
    el.pendingTab.classList.toggle("active", tab === "pending");
    el.annotatedTab.classList.toggle("active", tab === "annotated");
    el.deleteImageBtn.hidden = tab !== "pending";
    await loadQueueForTab();
  }

  el.pendingTab.addEventListener("click", () => switchTab("pending"));
  el.annotatedTab.addEventListener("click", () => switchTab("annotated"));

  el.deleteImageBtn.addEventListener("click", openConfirmDelete);
  el.cancelDeleteBtn.addEventListener("click", () => { el.confirmDeleteModal.hidden = true; });
  el.confirmDeleteBtn.addEventListener("click", async () => {
    el.confirmDeleteModal.hidden = true;
    try {
      const res = await api(`/api/image/${encodeURIComponent(state.currentFilename)}`, { method: "DELETE" });
      state.pendingCount = res.pending_count;
      state.annotatedCount = res.annotated_count;
      state.queue.splice(state.queueIndex, 1);
      if (state.queueIndex >= state.queue.length) state.queueIndex = 0;
      await loadCurrent();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  el.nextActionBtn.addEventListener("click", nextImage);
  el.prevBtn.addEventListener("click", prevImage);
  el.nextBtn.addEventListener("click", nextImage);

  // --- classmap modal --------------------------------------------------------

  async function openClassmap() {
    try {
      const data = await api("/api/classmap");
      el.classmapRows.innerHTML = "";
      if (data.model_names.length === 0) {
        el.classmapRows.innerHTML = `<p class="hint">No model loaded — nothing to map.</p>`;
      } else {
        data.model_names.forEach((name) => {
          const row = document.createElement("div");
          row.className = "classmap-row";
          const current = data.mapping[name];
          const options = [`<option value="">Ignore (drop)</option>`]
            .concat(data.target_classes.map((c) => `<option value="${c}" ${c === current ? "selected" : ""}>${c}</option>`));
          row.innerHTML = `<span class="model-name">${name}</span><select data-model-name="${name}">${options.join("")}</select>`;
          el.classmapRows.appendChild(row);
        });
      }
      el.classmapModal.hidden = false;
    } catch (err) {
      showToast(err.message, true);
    }
  }

  el.classmapBtn.addEventListener("click", openClassmap);
  el.classmapCancelBtn.addEventListener("click", () => { el.classmapModal.hidden = true; });
  el.classmapSaveBtn.addEventListener("click", async () => {
    const mapping = {};
    el.classmapRows.querySelectorAll("select").forEach((sel) => {
      mapping[sel.dataset.modelName] = sel.value || null;
    });
    try {
      await api("/api/classmap", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping }),
      });
      el.classmapModal.hidden = true;
      showToast("Class mapping saved.");
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // --- boot ------------------------------------------------------------------

  async function boot() {
    setTool("select");
    resizeCanvas();
    try {
      const s = await api("/api/state");
      state.classes = s.classes;
      state.pendingCount = s.pending_count;
      state.annotatedCount = s.annotated_count;

      el.modelBadge.textContent = s.model_loaded ? "Model loaded" : "Manual mode";
      el.modelBadge.className = "badge " + (s.model_loaded ? "on" : "off");

      renderClassList();
      await loadQueueForTab();

      if (s.needs_classmap_review) openClassmap();
    } catch (err) {
      el.loadingState.textContent = "Failed to load: " + err.message;
      showToast(err.message, true);
    }
  }

  boot();
})();
