// Finds PowerPoint's presenter view (class PodiumParent) and owns our panes to it.
// Loaded only on Windows. A failure here leaves the rest of Stage Credit running.
const koffi = require('koffi');

const GWLP_HWNDPARENT = -8;
const PRESENTER_CLASS = /^Podium(Parent)?$/i;

function create() {
  const user32 = koffi.load('user32.dll');
  const RECT = koffi.struct('RECT', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long'
  });
  const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
  const enumProto = koffi.proto('bool __stdcall EnumProc(void *hwnd, intptr_t lParam)');

  const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr_t lParam)');
  const EnumChildWindows = user32.func('bool __stdcall EnumChildWindows(void *hwnd, EnumProc *cb, intptr_t lParam)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
  const IsIconic = user32.func('bool __stdcall IsIconic(void *hwnd)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ RECT *rect)');
  const GetClientRect = user32.func('bool __stdcall GetClientRect(void *hwnd, _Out_ RECT *rect)');
  const ClientToScreen = user32.func('bool __stdcall ClientToScreen(void *hwnd, _Inout_ POINT *pt)');
  const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hwnd, _Out_ uint16_t *buf, int max)');
  const SetWindowLongPtrW = user32.func('void * __stdcall SetWindowLongPtrW(void *hwnd, int index, void *value)');

  function className(hwnd) {
    const buf = Buffer.alloc(512);
    const n = GetClassNameW(hwnd, buf, 256);
    if (!n) return '';
    return buf.toString('utf16le', 0, n * 2);
  }

  function windowRect(hwnd) {
    const r = {};
    if (!GetWindowRect(hwnd, r)) return null;
    return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
  }

  function clientInfo(hwnd) {
    const r = {};
    const origin = { x: 0, y: 0 };
    if (!GetClientRect(hwnd, r)) return null;
    if (!ClientToScreen(hwnd, origin)) return null;
    return {
      origin: { x: origin.x, y: origin.y },
      client: { width: r.right - r.left, height: r.bottom - r.top }
    };
  }

  const slot = { mode: '', hwnd: null, list: null };
  const enumCb = koffi.register((hwnd) => {
    try {
      if (slot.mode === 'top') {
        if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
        if (!PRESENTER_CLASS.test(className(hwnd))) return true;
        slot.hwnd = hwnd;
        return false;
      }
      if (!IsWindowVisible(hwnd)) return true;
      const screen = windowRect(hwnd);
      if (!screen || screen.width < 8 || screen.height < 8) return true;
      slot.list.push({
        className: className(hwnd),
        x: screen.x - slot.originX,
        y: screen.y - slot.originY,
        width: screen.width,
        height: screen.height
      });
    } catch (err) { /* keep enumerating */ }
    return true;
  }, koffi.pointer(enumProto));

  function findPresenter() {
    slot.mode = 'top';
    slot.hwnd = null;
    EnumWindows(enumCb, 0);
    const hwnd = slot.hwnd;
    if (!hwnd) return null;
    const info = clientInfo(hwnd);
    if (!info) return null;
    slot.mode = 'child';
    slot.list = [];
    slot.originX = info.origin.x;
    slot.originY = info.origin.y;
    EnumChildWindows(hwnd, enumCb, 0);
    return {
      hwnd,
      hwndKey: String(hwnd),
      origin: info.origin,
      client: info.client,
      children: slot.list
    };
  }

  // Owner, not parent: the pane stays above presenter view only, and hides with it.
  function own(win, ownerHwnd) {
    if (!win || win.isDestroyed() || !ownerHwnd) return;
    const child = koffi.decode(win.getNativeWindowHandle(), 'void *');
    SetWindowLongPtrW(child, GWLP_HWNDPARENT, ownerHwnd);
  }

  return { findPresenter, own };
}

module.exports = { create };
