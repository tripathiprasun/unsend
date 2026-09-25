/**
 * qr.js -- QR code scanning via jsQR, run entirely client-side.
 *
 * jsQR works on raw RGBA pixel data, so we read it from a canvas. To catch
 * QR codes that are small relative to the full screenshot, we scan the
 * full-resolution image directly rather than a downscaled preview.
 */

const QR = (() => {

  function classifyPayload(text) {
    if (/^wifi:/i.test(text)) return 'Wi-Fi credentials';
    if (/^https?:\/\//i.test(text)) return 'URL';
    if (/^mailto:/i.test(text)) return 'Email';
    if (/^tel:/i.test(text)) return 'Phone number';
    if (/^begin:vcard/i.test(text)) return 'Contact card';
    if (/^upi:\/\//i.test(text) || /^(bitcoin|ethereum):/i.test(text)) return 'Payment / crypto address';
    if (/^otpauth:\/\//i.test(text)) return 'Authentication (2FA) link';
    return 'Text';
  }

  /**
   * Scans a canvas for one or more QR codes. jsQR only returns the first
   * match per call, so we blank out found regions and re-scan to catch
   * multiple codes in one image (bounded to avoid infinite loops).
   */
  function scanCanvas(canvas, maxCodes = 5) {
    if (typeof jsQR === 'undefined') return [];
    const ctx = canvas.getContext('2d');
    const working = document.createElement('canvas');
    working.width = canvas.width;
    working.height = canvas.height;
    const wctx = working.getContext('2d');
    wctx.drawImage(canvas, 0, 0);

    const results = [];
    for (let i = 0; i < maxCodes; i++) {
      const imageData = wctx.getImageData(0, 0, working.width, working.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth',
      });
      if (!code) break;

      const xs = code.location ? [
        code.location.topLeftCorner.x, code.location.topRightCorner.x,
        code.location.bottomLeftCorner.x, code.location.bottomRightCorner.x,
      ] : [];
      const ys = code.location ? [
        code.location.topLeftCorner.y, code.location.topRightCorner.y,
        code.location.bottomLeftCorner.y, code.location.bottomRightCorner.y,
      ] : [];
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);

      results.push({
        type: 'QR CODE',
        payloadType: classifyPayload(code.data),
        contents: code.data,
        region: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      });

      // Blank this region out so the next scan finds a different code.
      wctx.fillStyle = '#808080';
      wctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    }
    return results;
  }

  return { scanCanvas, classifyPayload };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QR;