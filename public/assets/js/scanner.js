/**
 * Camera + QR scanning module.
 * Wraps native BarcodeDetector (Chrome) and jsQR (fallback).
 * Usage:
 *   const scanner = new Scanner(videoEl, onDetected);
 *   await scanner.start();
 *   scanner.stop();
 */

const SCAN_MS  = 350;
const MAX_DIM  = 640;
const USE_NATIVE = typeof BarcodeDetector !== 'undefined';

let _detector = null;
async function getDetector() {
  if (!_detector && USE_NATIVE) {
    _detector = new BarcodeDetector({ formats: ['qr_code'] });
  }
  return _detector;
}

export class Scanner {
  constructor(videoEl, onDetected) {
    this._video       = videoEl;
    this._onDetected  = onDetected;
    this._stream      = null;
    this._raf         = null;
    this._canvas      = document.createElement('canvas');
    this._ctx         = this._canvas.getContext('2d', { willReadFrequently: true });
    this._scanning    = false;
    this._lastScan    = 0;
    this._active      = false;
  }

  async start() {
    if (this._active) return;
    this._active = true;

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } },
        audio: false,
      });
      this._video.srcObject = this._stream;
      await this._video.play();
      this._loop();
    } catch (err) {
      this._active = false;
      throw err;
    }
  }

  stop() {
    this._active = false;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
    this._video.srcObject = null;
  }

  _loop() {
    if (!this._active) return;
    this._raf = requestAnimationFrame(() => this._loop());

    const now = performance.now();
    if (now - this._lastScan < SCAN_MS) return;
    this._lastScan = now;

    if (this._video.readyState < 2) return;
    this._decode();
  }

  async _decode() {
    if (USE_NATIVE) {
      const det = await getDetector();
      try {
        const codes = await det.detect(this._video);
        if (codes.length) this._emit(codes[0].rawValue);
      } catch {/* ignore */}
      return;
    }

    // jsQR fallback
    const { videoWidth: vw, videoHeight: vh } = this._video;
    if (!vw || !vh) return;

    const scale  = Math.min(1, MAX_DIM / Math.max(vw, vh));
    const w      = Math.round(vw * scale);
    const h      = Math.round(vh * scale);

    this._canvas.width  = w;
    this._canvas.height = h;
    this._ctx.drawImage(this._video, 0, 0, w, h);

    const imgData = this._ctx.getImageData(0, 0, w, h);
    const result  = window.jsQR?.(imgData.data, w, h, { inversionAttempts: 'dontInvert' });
    if (result?.data) this._emit(result.data);
  }

  _emit(value) {
    if (!value || !this._active) return;
    this.stop();
    this._onDetected(value);
  }
}
