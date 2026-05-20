"""
ドット絵エディタ コアロジック (Pyodide 用)
Canvas / History / 画像 I/O
"""
import io


class Canvas:
    VALID_SIZES = [16, 32, 64, 256]

    def __init__(self, width, height):
        self.width = width
        self.height = height
        # flat RGBA bytearray: index = (y*width + x)*4
        self._data = bytearray(width * height * 4)

    def _i(self, x, y):
        return (y * self.width + x) * 4

    def in_bounds(self, x, y):
        return 0 <= x < self.width and 0 <= y < self.height

    def get_pixel(self, x, y):
        if not self.in_bounds(x, y):
            return (0, 0, 0, 0)
        i = self._i(x, y)
        return (self._data[i], self._data[i+1], self._data[i+2], self._data[i+3])

    def set_pixel(self, x, y, r, g, b, a):
        if not self.in_bounds(x, y):
            return
        i = self._i(x, y)
        self._data[i]   = int(r)
        self._data[i+1] = int(g)
        self._data[i+2] = int(b)
        self._data[i+3] = int(a)

    def get_flat(self):
        """全ピクセルデータを bytes で返す (JS の ImageData に直接渡せる)"""
        return bytes(self._data)

    def snapshot(self):
        return bytearray(self._data)

    def restore(self, snap):
        self._data = bytearray(snap)

    def clear(self):
        self._data = bytearray(self.width * self.height * 4)


class History:
    MAX_STEPS = 50

    def __init__(self, canvas):
        self._canvas = canvas
        self._undo = [canvas.snapshot()]
        self._redo = []

    def push(self):
        self._undo.append(self._canvas.snapshot())
        if len(self._undo) > self.MAX_STEPS + 1:
            self._undo.pop(0)
        self._redo.clear()

    def undo(self):
        if len(self._undo) <= 1:
            return False
        self._redo.append(self._undo.pop())
        self._canvas.restore(self._undo[-1])
        return True

    def redo(self):
        if not self._redo:
            return False
        snap = self._redo.pop()
        self._undo.append(snap)
        self._canvas.restore(snap)
        return True

    def can_undo(self):
        return len(self._undo) > 1

    def can_redo(self):
        return bool(self._redo)

    def reset(self, canvas):
        self._canvas = canvas
        self._undo = [canvas.snapshot()]
        self._redo.clear()


# ── グローバル状態 ──────────────────────────────────────
_canvas  = None
_history = None


def init(width, height):
    global _canvas, _history
    _canvas  = Canvas(int(width), int(height))
    _history = History(_canvas)


def get_flat():
    return _canvas.get_flat() if _canvas else b''


def set_pixel(x, y, r, g, b, a):
    if _canvas:
        _canvas.set_pixel(int(x), int(y), int(r), int(g), int(b), int(a))


def get_pixel(x, y):
    if _canvas:
        return list(_canvas.get_pixel(int(x), int(y)))
    return [0, 0, 0, 0]


def erase_pixel(x, y, amount):
    """現在のアルファ値から amount を引く（RGB は維持、0未満にはならない）"""
    if _canvas is None:
        return
    r, g, b, a = _canvas.get_pixel(int(x), int(y))
    _canvas.set_pixel(int(x), int(y), r, g, b, max(0, a - int(amount)))


def _brush_offsets(size, shape):
    """ブラシ形状のオフセット一覧を返す（キャッシュなし・小サイズ前提）"""
    half = size // 2
    r2   = (size / 2) ** 2
    offsets = []
    for dy in range(-half, half + 1):
        for dx in range(-half, half + 1):
            if shape == 'circle' and dx * dx + dy * dy > r2:
                continue
            offsets.append((dx, dy))
    return offsets


def draw_dot(cx, cy, size, shape, r, g, b, a):
    """ブラシ1スタンプ描画"""
    if _canvas is None:
        return
    cx, cy, r, g, b, a = int(cx), int(cy), int(r), int(g), int(b), int(a)
    for dx, dy in _brush_offsets(int(size), str(shape)):
        _canvas.set_pixel(cx + dx, cy + dy, r, g, b, a)


def erase_dot(cx, cy, size, shape, amount):
    """ブラシ1スタンプ消しゴム"""
    if _canvas is None:
        return
    cx, cy, amount = int(cx), int(cy), int(amount)
    for dx, dy in _brush_offsets(int(size), str(shape)):
        cr, cg, cb, ca = _canvas.get_pixel(cx + dx, cy + dy)
        _canvas.set_pixel(cx + dx, cy + dy, cr, cg, cb, max(0, ca - amount))


def draw_brush_line(x0, y0, x1, y1, size, shape, r, g, b, a):
    """ブレゼンハム線分 × ブラシスタンプ（ペン）"""
    if _canvas is None:
        return
    offsets = _brush_offsets(int(size), str(shape))
    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
    r, g, b, a = int(r), int(g), int(b), int(a)
    dx, dy = abs(x1 - x0), abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    while True:
        for ox, oy in offsets:
            _canvas.set_pixel(x0 + ox, y0 + oy, r, g, b, a)
        if x0 == x1 and y0 == y1:
            break
        e2 = err * 2
        if e2 > -dy:
            err -= dy; x0 += sx
        if e2 < dx:
            err += dx; y0 += sy


def erase_brush_line(x0, y0, x1, y1, size, shape, amount):
    """ブレゼンハム線分 × ブラシスタンプ（消しゴム）"""
    if _canvas is None:
        return
    offsets = _brush_offsets(int(size), str(shape))
    x0, y0, x1, y1, amount = int(x0), int(y0), int(x1), int(y1), int(amount)
    dx, dy = abs(x1 - x0), abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    while True:
        for ox, oy in offsets:
            cr, cg, cb, ca = _canvas.get_pixel(x0 + ox, y0 + oy)
            _canvas.set_pixel(x0 + ox, y0 + oy, cr, cg, cb, max(0, ca - amount))
        if x0 == x1 and y0 == y1:
            break
        e2 = err * 2
        if e2 > -dy:
            err -= dy; x0 += sx
        if e2 < dx:
            err += dx; y0 += sy


def draw_line(x0, y0, x1, y1, r, g, b, a):
    """ブレゼンハムの線分アルゴリズムでペン描画"""
    if _canvas is None:
        return
    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
    r, g, b, a = int(r), int(g), int(b), int(a)
    dx, dy = abs(x1 - x0), abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    while True:
        _canvas.set_pixel(x0, y0, r, g, b, a)
        if x0 == x1 and y0 == y1:
            break
        e2 = err * 2
        if e2 > -dy:
            err -= dy; x0 += sx
        if e2 < dx:
            err += dx; y0 += sy


def erase_line(x0, y0, x1, y1, amount):
    """ブレゼンハムの線分アルゴリズムで消しゴム描画"""
    if _canvas is None:
        return
    x0, y0, x1, y1, amount = int(x0), int(y0), int(x1), int(y1), int(amount)
    dx, dy = abs(x1 - x0), abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy
    while True:
        cr, cg, cb, ca = _canvas.get_pixel(x0, y0)
        _canvas.set_pixel(x0, y0, cr, cg, cb, max(0, ca - amount))
        if x0 == x1 and y0 == y1:
            break
        e2 = err * 2
        if e2 > -dy:
            err -= dy; x0 += sx
        if e2 < dx:
            err += dx; y0 += sy


def push_history():
    if _history:
        _history.push()


def undo():
    return _history.undo() if _history else False


def redo():
    return _history.redo() if _history else False


def can_undo():
    return _history.can_undo() if _history else False


def can_redo():
    return _history.can_redo() if _history else False


def canvas_size():
    return [_canvas.width, _canvas.height] if _canvas else [0, 0]


def load_image(data, target_size):
    """
    バイト列から画像を読み込み target_size x target_size にリサイズ。
    tobytes() で一括転送するためピクセルループなし。
    """
    global _canvas, _history
    from PIL import Image
    img = Image.open(io.BytesIO(bytes(data))).convert('RGBA')
    img = img.resize((int(target_size), int(target_size)), Image.NEAREST)
    c = Canvas(int(target_size), int(target_size))
    c._data = bytearray(img.tobytes())  # 一括転送
    _canvas  = c
    _history = History(c)
    return True


def export_png():
    """キャンバスを PNG bytes で返す（frombytes で一括転送）"""
    from PIL import Image
    if _canvas is None:
        return b''
    img = Image.frombytes('RGBA', (_canvas.width, _canvas.height), bytes(_canvas._data))
    buf = io.BytesIO()
    img.save(buf, 'PNG')
    return buf.getvalue()
