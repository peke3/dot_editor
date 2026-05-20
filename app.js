'use strict';

// ── App version ───────────────────────────────────────
const VERSION    = '1.1.9';

// ── App info（タイトルや URL を変えるときはここだけ編集） ──
const APP_TITLE  = 'ドット絵エディタ';
const APP_URL    = 'https://peke3.github.io/dot_editor/';

// ── Pyodide CDN version ───────────────────────────────
const PYODIDE_VER = '0.26.4';

// ── Supported image extensions ────────────────────────
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']);

// ── App state ─────────────────────────────────────────
let py       = null;
let cw = 32, ch = 32;        // canvas logical size
let zoom     = 1.0;
let panX = 0, panY = 0;
let activeTool = 'pen';       // pen | eraser | eyedropper
let drawColor  = { r: 0, g: 0, b: 0, a: 255 };
let showGrid   = true;
let drawing    = false;
let panning    = false;
let panStart   = { x: 0, y: 0 };
let lastDot    = null;
let dirty          = false;   // current stroke changed canvas?
let pendingFile    = null;    // file waiting for size dialog
let touchDist      = null;    // 2本指のピンチ開始距離
let wasMultiTouch  = false;   // 2本指操作直後フラグ（誤タップ防止）
let gestureStartTime = null;  // ジェスチャー開始時刻（1本指touchstart時）
let peakTouches    = 0;       // このジェスチャー中の最大タッチ数
let panDistAccum   = 0;       // マルチタッチ中の累積移動距離（タップ判定用）
let checkerContrast = 20;     // チェッカー明暗差 (0=単色 〜 100=最大)
let brushSize  = 1;           // ブラシサイズ (1〜16)
let brushShape = 'square';    // 'square' | 'circle'

// ── DOM helpers ───────────────────────────────────────
const $  = id => document.getElementById(id);
const mainCanvas = $('main-canvas');
const ctx        = mainCanvas.getContext('2d');

// Offscreen canvas: holds the raw logical pixels (e.g. 32×32)
const offscreen = document.createElement('canvas');
const offCtx    = offscreen.getContext('2d');

// Cached checker pattern
let checkerPat = null;

// ── Geometry helpers ──────────────────────────────────
function pixelSize() {
  const area = $('canvas-area');
  const base = Math.min(area.clientWidth / cw, area.clientHeight / ch);
  return Math.max(1, Math.floor(base * zoom));
}

function canvasOffset() {
  const ps = pixelSize();
  return {
    ox: Math.floor((mainCanvas.width  - ps * cw) / 2) + panX,
    oy: Math.floor((mainCanvas.height - ps * ch) / 2) + panY,
    ps,
  };
}

function toLogical(wx, wy) {
  const { ox, oy, ps } = canvasOffset();
  return { x: Math.floor((wx - ox) / ps), y: Math.floor((wy - oy) / ps) };
}

function inBounds(x, y) { return x >= 0 && x < cw && y >= 0 && y < ch; }

// ── Checker pattern ───────────────────────────────────
// contrast: 0(単色グレー) 〜 100(最大コントラスト)
// midpoint 185 を基準に明暗を分ける
function makeChecker(cell) {
  const mid   = 185;
  const delta = Math.round(checkerContrast * 0.35); // 0→0, 100→35
  const light = `rgb(${mid + delta},${mid + delta},${mid + delta})`;
  const dark  = `rgb(${mid - delta},${mid - delta},${mid - delta})`;
  const sz  = cell * 2;
  const pat = document.createElement('canvas');
  pat.width = pat.height = sz;
  const pc  = pat.getContext('2d');
  pc.fillStyle = light; pc.fillRect(0, 0, sz, sz);
  pc.fillStyle = dark;
  pc.fillRect(0, 0, cell, cell);
  pc.fillRect(cell, cell, cell, cell);
  return ctx.createPattern(pat, 'repeat');
}

// ── Render ────────────────────────────────────────────
function render() {
  if (!py) return;

  // Get flat RGBA bytes from Python
  const raw   = py.runPython('get_flat()');
  const bytes  = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw.toJs());

  // Paint into offscreen canvas
  offscreen.width  = cw;
  offscreen.height = ch;
  const imgData = offCtx.createImageData(cw, ch);
  imgData.data.set(bytes);
  offCtx.putImageData(imgData, 0, 0);

  // Clear main canvas
  ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);

  const { ox, oy, ps } = canvasOffset();
  const dw = ps * cw, dh = ps * ch;

  // Checker background
  if (!checkerPat) checkerPat = makeChecker(8);
  ctx.fillStyle = checkerPat;
  ctx.fillRect(ox, oy, dw, dh);

  // Scale pixel data (nearest-neighbor)
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreen, ox, oy, dw, dh);

  // Grid
  if (showGrid && ps >= 4) {
    ctx.strokeStyle = 'rgba(140,140,140,0.5)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    for (let x = 0; x <= cw; x++) {
      const px = ox + x * ps + 0.5;
      ctx.moveTo(px, oy); ctx.lineTo(px, oy + dh);
    }
    for (let y = 0; y <= ch; y++) {
      const py2 = oy + y * ps + 0.5;
      ctx.moveTo(ox, py2); ctx.lineTo(ox + dw, py2);
    }
    ctx.stroke();
  }
}

function resizeMainCanvas() {
  const area       = $('canvas-area');
  mainCanvas.width  = area.clientWidth;
  mainCanvas.height = area.clientHeight;
}

// ── Tool operations ───────────────────────────────────
function applyDraw(x, y) {
  if (!py || !inBounds(x, y)) return false;
  const { r, g, b, a } = drawColor;
  const s = brushSize, sh = `'${brushShape}'`;
  if (activeTool === 'pen') {
    py.runPython(`draw_dot(${x},${y},${s},${sh},${r},${g},${b},${a})`);
    return true;
  }
  if (activeTool === 'eraser') {
    py.runPython(`erase_dot(${x},${y},${s},${sh},${a})`);
    return true;
  }
  return false;
}

// lastDot から (x,y) まで線を引く（ドラッグ中に呼ぶ）
function applyLineTo(x, y) {
  if (!py || !lastDot || !inBounds(x, y)) return false;
  if (lastDot.x === x && lastDot.y === y) return false;
  const { r, g, b, a } = drawColor;
  const s = brushSize, sh = `'${brushShape}'`;
  if (activeTool === 'pen') {
    py.runPython(`draw_brush_line(${lastDot.x},${lastDot.y},${x},${y},${s},${sh},${r},${g},${b},${a})`);
    return true;
  }
  if (activeTool === 'eraser') {
    py.runPython(`erase_brush_line(${lastDot.x},${lastDot.y},${x},${y},${s},${sh},${a})`);
    return true;
  }
  return false;
}

function pickColor(x, y) {
  if (!py || !inBounds(x, y)) return;
  const rgba = py.runPython(`get_pixel(${x},${y})`).toJs();
  drawColor = { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] };
  updateColorUI();
  setStatus(`色を取得: rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3]})`);
}

// ── Undo / Redo ───────────────────────────────────────
function doUndo() {
  if (py && py.runPython('undo()')) { render(); setStatus('元に戻しました'); }
}
function doRedo() {
  if (py && py.runPython('redo()')) { render(); setStatus('やり直しました'); }
}

// ── New canvas ────────────────────────────────────────
function newCanvas(size) {
  cw = ch = size; zoom = 1.0; panX = panY = 0; checkerPat = null;
  py.runPython(`init(${size},${size})`);
  resizeMainCanvas();
  render();
  setStatus(`新規キャンバス ${size}×${size}`);
}

// ── Image load ────────────────────────────────────────
function loadImageFile(file, size) {
  const reader = new FileReader();
  reader.onload = async e => {
    const bytes = new Uint8Array(e.target.result);
    py.globals.set('_imgbuf', bytes);
    const ok = await py.runPythonAsync(`load_image(_imgbuf.to_py(), ${size})`);
    if (ok) {
      cw = ch = size; zoom = 1.0; panX = panY = 0; checkerPat = null;
      resizeMainCanvas(); render();
      setStatus(`${file.name} を ${size}×${size} で読み込みました`);
    }
  };
  reader.readAsArrayBuffer(file);
}

// ── PNG Export ────────────────────────────────────────
function exportPng() {
  if (!py) return;
  const raw   = py.runPython('export_png()');
  const bytes  = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw.toJs());
  const blob   = new Blob([bytes], { type: 'image/png' });
  const url    = URL.createObjectURL(blob);
  const a      = Object.assign(document.createElement('a'), { href: url, download: 'dot_art.png' });
  a.click();
  URL.revokeObjectURL(url);
  setStatus('PNG を書き出しました');
}

// ── Size dialog ───────────────────────────────────────
function openSizeDialog(file = null) {
  pendingFile = file;
  $('size-dialog').style.display = 'flex';
  $('dialog-title').textContent  = file ? '縮小サイズを選択' : 'キャンバスサイズを選択';
}

function closeSizeDialog() {
  $('size-dialog').style.display = 'none';
  pendingFile = null;
}

// ── UI helpers ────────────────────────────────────────
function setStatus(msg) { $('status').textContent = msg; }

function updateColorUI() {
  const { r, g, b, a } = drawColor;
  $('color-btn').style.backgroundColor = `rgba(${r},${g},${b},${a / 255})`;
  // sync color-input (hex only, ignore alpha)
  $('color-input').value = '#'
    + r.toString(16).padStart(2, '0')
    + g.toString(16).padStart(2, '0')
    + b.toString(16).padStart(2, '0');
  $('opacity-slider').value = a;
  $('opacity-value').textContent = a;
}

function selectTool(name) {
  activeTool = name;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  $(`tool-${name}`).classList.add('active');
  updateCursor();
  setStatus(`ツール: ${name}`);
}

function updateCursor() {
  const map = { pen: 'crosshair', eraser: 'cell', eyedropper: 'pointer' };
  mainCanvas.style.cursor = map[activeTool] || 'default';
}

// ── Event setup ───────────────────────────────────────
function setupCanvas() {
  // ── Mouse ──
  mainCanvas.addEventListener('mousedown', e => {
    const rect = mainCanvas.getBoundingClientRect();
    const wx = e.clientX - rect.left, wy = e.clientY - rect.top;

    // Middle button → pan
    if (e.button === 1) {
      panning = true; panStart = { x: e.clientX, y: e.clientY };
      mainCanvas.style.cursor = 'move'; e.preventDefault(); return;
    }

    if (e.button !== 0) return;
    const { x, y } = toLogical(wx, wy);

    // Ctrl+click or eyedropper tool → pick color
    if (e.ctrlKey || activeTool === 'eyedropper') {
      pickColor(x, y);
      if (activeTool === 'eyedropper') selectTool('pen'); // auto-switch back
      return;
    }

    drawing = true; dirty = false; lastDot = null;
    if (applyDraw(x, y)) { dirty = true; lastDot = { x, y }; render(); }
  });

  mainCanvas.addEventListener('mousemove', e => {
    const rect = mainCanvas.getBoundingClientRect();
    const wx = e.clientX - rect.left, wy = e.clientY - rect.top;

    // Pan
    if (panning) {
      panX += e.clientX - panStart.x; panY += e.clientY - panStart.y;
      panStart = { x: e.clientX, y: e.clientY };
      render(); return;
    }

    // Cursor hint for Ctrl hover
    if (e.ctrlKey && !drawing) mainCanvas.style.cursor = 'pointer';
    else if (!drawing) updateCursor();

    if (!drawing) return;
    const { x, y } = toLogical(wx, wy);
    if (applyLineTo(x, y)) { dirty = true; lastDot = { x, y }; render(); }
  });

  mainCanvas.addEventListener('mouseup', e => {
    if (e.button === 1 && panning) { panning = false; updateCursor(); return; }
    if (e.button === 0 && drawing) {
      drawing = false;
      if (dirty) { py.runPython('push_history()'); dirty = false; }
    }
  });

  // ホイール → zoom（最大32倍）Ctrl不要
  mainCanvas.addEventListener('wheel', e => {
    zoom = Math.max(0.25, Math.min(32.0, zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    render(); e.preventDefault();
  }, { passive: false });

  mainCanvas.addEventListener('contextmenu', e => e.preventDefault());

  // ── Touch ──────────────────────────────────────────
  // キャンバス座標に変換
  function touchPos(t) {
    const r = mainCanvas.getBoundingClientRect();
    return { wx: t.clientX - r.left, wy: t.clientY - r.top };
  }
  // 2本指の中点（クライアント座標）
  function touchMid(t0, t1) {
    return { cx: (t0.clientX + t1.clientX) / 2,
             cy: (t0.clientY + t1.clientY) / 2 };
  }
  // 2本指の距離
  function touchDist2(t0, t1) {
    const dx = t0.clientX - t1.clientX, dy = t0.clientY - t1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  mainCanvas.addEventListener('touchstart', e => {
    e.preventDefault();

    if (e.touches.length === 1) {
      // 新しいジェスチャー開始
      gestureStartTime = Date.now();
      peakTouches      = 1;
      panDistAccum     = 0;

      // 2本指操作の直後は誤タップを無視
      if (wasMultiTouch) return;

      // 1本指 → 描画 / スポイト
      const { wx, wy } = touchPos(e.touches[0]);
      const { x, y }   = toLogical(wx, wy);

      if (activeTool === 'eyedropper') {
        pickColor(x, y); selectTool('pen'); return;
      }
      drawing = true; dirty = false; lastDot = null;
      if (applyDraw(x, y)) { dirty = true; lastDot = { x, y }; render(); }

    } else if (e.touches.length === 2) {
      peakTouches   = Math.max(peakTouches, 2);
      wasMultiTouch = true;
      panDistAccum  = 0;   // パン距離をリセット（2本指タップ判定用）

      // 1本指で描いていた誤描画をキャンセルしてヒストリに積まない
      if (drawing) {
        drawing = false;
        if (dirty) {
          py.runPython('cancel_stroke()');
          dirty = false;
          render();
        }
      }

      panning   = true;
      const mid = touchMid(e.touches[0], e.touches[1]);
      panStart  = { x: mid.cx, y: mid.cy };
      touchDist = touchDist2(e.touches[0], e.touches[1]);

    } else if (e.touches.length >= 3) {
      // 3本指以上 → パン/ズームを止めてタップ待ち
      peakTouches = Math.max(peakTouches, e.touches.length);
      panning     = false;
    }
  }, { passive: false });

  mainCanvas.addEventListener('touchmove', e => {
    e.preventDefault();

    if (e.touches.length === 1 && drawing) {
      // 1本指ドラッグ → 線を引きながら描画
      const { wx, wy } = touchPos(e.touches[0]);
      const { x, y }   = toLogical(wx, wy);
      if (applyLineTo(x, y)) { dirty = true; lastDot = { x, y }; render(); }

    } else if (e.touches.length === 2 && panning) {
      // 2本指 → パン＋ピンチズーム
      const mid    = touchMid(e.touches[0], e.touches[1]);
      const stepDx = mid.cx - panStart.x;
      const stepDy = mid.cy - panStart.y;
      // 累積移動距離を記録（タップ判定に使う）
      panDistAccum += Math.sqrt(stepDx * stepDx + stepDy * stepDy);
      panX += stepDx; panY += stepDy;
      panStart = { x: mid.cx, y: mid.cy };

      const d = touchDist2(e.touches[0], e.touches[1]);
      if (touchDist) {
        panDistAccum += Math.abs(d - touchDist) * 0.5; // ピンチ量も加算
        zoom = Math.max(0.25, Math.min(32.0, zoom * (d / touchDist)));
        touchDist = d;
      }
      render();
    }
  }, { passive: false });

  mainCanvas.addEventListener('touchend', e => {
    e.preventDefault();

    if (e.touches.length === 0) {
      // 全指が離れた → マルチタップ判定
      const elapsed = gestureStartTime ? Date.now() - gestureStartTime : 9999;
      if (peakTouches >= 2 && elapsed < 500 && panDistAccum < 30) {
        // 2本指タップ → 元に戻す、3本指以上 → やり直し
        if (peakTouches === 2) doUndo();
        else                   doRedo();
        drawing = false; dirty = false; panning = false;
        touchDist = null; wasMultiTouch = false;
        peakTouches = 0; gestureStartTime = null;
        return;
      }

      // 通常のジェスチャー終了
      wasMultiTouch = false;
      if (drawing) {
        drawing = false;
        if (dirty) { py.runPython('push_history()'); dirty = false; }
      }
      panning = false; touchDist = null;
      peakTouches = 0; gestureStartTime = null;

    } else if (e.touches.length < 2) {
      // 1本だけ残った → パン終了（描画は次のtouchstartから）
      panning = false; touchDist = null;
    }
  }, { passive: false });
}

function setupKeyboard() {
  document.addEventListener('keydown', e => {
    if (!e.ctrlKey) return;
    if (e.key === 'z' || e.key === 'Z') { e.shiftKey ? doRedo() : doUndo(); e.preventDefault(); }
    if (e.key === 'y' || e.key === 'Y') { doRedo(); e.preventDefault(); }
    if (e.key === 's' || e.key === 'S') { exportPng(); e.preventDefault(); }
  });
  // Restore cursor when Ctrl released
  document.addEventListener('keyup', e => {
    if (e.key === 'Control' && !drawing) updateCursor();
  });
}

function setupUI() {
  // Tools
  $('tool-pen').onclick        = () => selectTool('pen');
  $('tool-eraser').onclick     = () => selectTool('eraser');
  $('tool-eyedropper').onclick = () => selectTool('eyedropper');

  // Color picker（inputがbtn上に重なっているのでクリック不要）
  $('color-input').addEventListener('input', e => {
    const hex = e.target.value;
    drawColor.r = parseInt(hex.slice(1, 3), 16);
    drawColor.g = parseInt(hex.slice(3, 5), 16);
    drawColor.b = parseInt(hex.slice(5, 7), 16);
    updateColorUI();
  });
  $('opacity-slider').addEventListener('input', e => {
    drawColor.a = parseInt(e.target.value);
    updateColorUI();
  });

  // Checker contrast slider
  $('checker-slider').value = checkerContrast;
  $('checker-value').textContent = checkerContrast;
  $('checker-slider').addEventListener('input', e => {
    checkerContrast = parseInt(e.target.value);
    $('checker-value').textContent = checkerContrast;
    checkerPat = null; // パターンキャッシュをリセット
    render();
  });

  // パネル折りたたみ
  const panel       = $('tool-panel');
  const toggleBtn   = $('btn-toggle-panel');
  const isTouch     = window.matchMedia('(pointer: coarse)').matches;

  // スマホはデフォルトで折りたたむ、PCは開く
  if (isTouch) {
    panel.classList.add('collapsed');
  } else {
    toggleBtn.classList.add('active');
  }

  toggleBtn.onclick = () => {
    panel.classList.toggle('collapsed');
    toggleBtn.classList.toggle('active', !panel.classList.contains('collapsed'));
    // パネル開閉後にキャンバスサイズを再計算
    setTimeout(() => { resizeMainCanvas(); render(); }, 250);
  };

  // Grid / Zoom reset
  $('btn-grid').onclick = function () {
    showGrid = !showGrid;
    this.classList.toggle('active', showGrid);
    this.textContent = showGrid ? 'グリッド ON' : 'グリッド OFF';
    render();
  };
  $('btn-zoom-reset').onclick = () => { zoom = 1.0; panX = panY = 0; render(); };

  // Fit button（画面にフィット）
  $('btn-fit').onclick = () => { zoom = 1.0; panX = panY = 0; render(); };

  // Brush size slider
  $('brush-size-slider').value = brushSize;
  $('brush-size-value').textContent = brushSize;
  $('brush-size-slider').addEventListener('input', e => {
    brushSize = parseInt(e.target.value);
    $('brush-size-value').textContent = brushSize;
  });

  // Brush shape buttons
  $('shape-square').onclick = () => {
    brushShape = 'square';
    $('shape-square').classList.add('active');
    $('shape-circle').classList.remove('active');
  };
  $('shape-circle').onclick = () => {
    brushShape = 'circle';
    $('shape-circle').classList.add('active');
    $('shape-square').classList.remove('active');
  };

  // Undo / Redo
  $('btn-undo').onclick = doUndo;
  $('btn-redo').onclick = doRedo;

  // New canvas
  $('btn-new').onclick = () => openSizeDialog(null);

  // Open file
  $('btn-open').onclick = () => $('file-input').click();
  $('file-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) openSizeDialog(f);
    e.target.value = '';
  });

  // Export
  $('btn-export').onclick = exportPng;

  // Share（Web Share API 対応端末のみ表示 → iOS Safari など）
  if (navigator.share) {
    $('btn-share').style.display = '';
    $('btn-share').onclick = async () => {
      if (!py) return;
      // キャンバスを PNG に書き出して File オブジェクト化
      const raw   = py.runPython('export_png()');
      const bytes = (raw instanceof Uint8Array) ? raw : new Uint8Array(raw.toJs());
      const file  = new File([bytes], 'dot_art.png', { type: 'image/png' });
      // ファイル共有対応なら画像を、非対応なら URL を共有
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: APP_TITLE,
          text:  `${APP_TITLE}\n${APP_URL}`,
        }).catch(() => {});
      } else {
        await navigator.share({ title: APP_TITLE, url: APP_URL }).catch(() => {});
      }
    };
  }

  // Size dialog buttons
  document.querySelectorAll('.size-option').forEach(btn => {
    btn.onclick = () => {
      const size = parseInt(btn.dataset.size);
      if (pendingFile) loadImageFile(pendingFile, size);
      else             newCanvas(size);
      closeSizeDialog();
    };
  });
  $('size-cancel').onclick = closeSizeDialog;
  $('size-dialog').addEventListener('click', e => {
    if (e.target === $('size-dialog')) closeSizeDialog();
  });

  // Window resize
  window.addEventListener('resize', () => { resizeMainCanvas(); render(); });
}

function setupDragDrop() {
  document.body.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.body.addEventListener('drop', e => {
    e.preventDefault();
    for (const file of e.dataTransfer.files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (IMG_EXTS.has(ext)) { openSizeDialog(file); break; }
    }
  });
}

// ── Initialization ────────────────────────────────────
async function initApp() {
  const loadStatus = $('loading-status');

  loadStatus.textContent = 'Pyodide を読み込み中...';
  py = await loadPyodide({ indexURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VER}/full/` });

  loadStatus.textContent = 'Pillow を読み込み中...';
  await py.loadPackage(['pillow']);

  loadStatus.textContent = 'コアロジックを読み込み中...';
  const coreCode = await fetch('./py/core.py').then(r => r.text());
  py.runPython(coreCode);

  // Show app
  $('loading').style.display = 'none';
  $('app').style.display     = 'flex';

  // バージョン表示
  $('version-label').textContent = `v${VERSION}`;

  resizeMainCanvas();
  setupCanvas();
  setupKeyboard();
  setupUI();
  setupDragDrop();
  updateColorUI();
  newCanvas(32);
  setStatus('準備完了  |  ホイール:ズーム  |  中クリックドラッグ:パン  |  Ctrl+クリック:スポイト');
}

initApp().catch(err => {
  console.error(err);
  $('loading-status').textContent = '初期化エラー: ' + err.message;
});
