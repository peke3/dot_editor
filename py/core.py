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
