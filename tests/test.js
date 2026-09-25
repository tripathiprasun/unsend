/**
 * tests.js -- a tiny dependency-free test runner for test.html.
 * Covers detectors, metadata parsing helpers, editor region math, and
 * filename/formatting utilities. Canvas-pixel redaction correctness (that
 * exported images actually contain redacted pixels, not the original
 * underneath) is covered by the "pixel-level redaction" section, which
 * renders to a real canvas and reads pixels back with getImageData.
 */

const TestRunner = (() => {
  const results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name, pass: true });
    } catch (e) {
      results.push({ name, pass: false, error: e.message || String(e) });
    }
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'Assertion failed');
  }
  function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }

  // ---------------------------------------------------------------- run --
  function run() {
    results.length = 0;

    // ---- email detection ----
    test('detects a plain email address', () => {
      const m = Detectors.detectEmails('contact me at john@example.com please');
      assertEqual(m.length, 1);
      assertEqual(m[0].value, 'john@example.com');
    });
    test('does not detect an email without a TLD', () => {
      const m = Detectors.detectEmails('not an email: foo@bar');
      assertEqual(m.length, 0);
    });

    // ---- phone detection ----
    test('detects a hyphenated phone number', () => {
      const m = Detectors.detectPhones('call 555-123-4567 now');
      assert(m.length >= 1, 'expected at least one match');
    });
    test('ignores short digit sequences', () => {
      const m = Detectors.detectPhones('room 42-1');
      assertEqual(m.length, 0);
    });

    // ---- URL detection ----
    test('detects https URL', () => {
      const m = Detectors.detectUrls('see https://example.com/reset/token123 for details');
      assertEqual(m.length, 1);
      assert(m[0].value.startsWith('https://example.com'));
    });
    test('detects www URL without scheme', () => {
      const m = Detectors.detectUrls('visit www.example.com today');
      assertEqual(m.length, 1);
    });

    // ---- IPv4 detection ----
    test('detects a private IPv4 address', () => {
      const m = Detectors.detectIPv4('server is at 192.168.1.24 on the LAN');
      assertEqual(m.length, 1);
      assertEqual(m[0].value, '192.168.1.24');
    });
    test('rejects octets over 255', () => {
      const m = Detectors.detectIPv4('version 999.999.999.999 nope');
      assertEqual(m.length, 0);
    });

    // ---- secret detection ----
    test('flags a long hex string as a possible secret', () => {
      const m = Detectors.detectSecrets('key=' + 'a1b2c3d4'.repeat(4));
      assert(m.some((x) => x.type === 'POSSIBLE SECRET'), 'expected a POSSIBLE SECRET match');
    });
    test('flags a JWT-shaped string', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYXNpZ25hdHVyZQ';
      const m = Detectors.detectSecrets(jwt);
      assert(m.length >= 1);
    });
    test('flags an AWS-style access key prefix', () => {
      const m = Detectors.detectSecrets('AKIAABCDEFGHIJKLMNOP in the config');
      assert(m.some((x) => x.value.startsWith('AKIA')));
    });

    // ---- card number / Luhn ----
    test('Luhn validates a known-good test number', () => {
      assert(Detectors.luhnValid('4111111111111111'), 'Visa test number should be Luhn-valid');
    });
    test('Luhn rejects an invalid number', () => {
      assert(!Detectors.luhnValid('1234567812345678'));
    });
    test('detects a formatted, Luhn-valid card number', () => {
      const m = Detectors.detectCardNumbers('card: 4111 1111 1111 1111 exp 12/29');
      assert(m.some((x) => x.confidence === 'detected'), 'expected a high-confidence card match');
    });
    test('does not flag an arbitrary 16-digit non-Luhn number', () => {
      const m = Detectors.detectCardNumbers('order id 1234567890123456');
      assertEqual(m.length, 0);
    });

    // ---- handles ----
    test('detects an @handle', () => {
      const m = Detectors.detectHandles('follow @jane_doe for updates');
      assertEqual(m.length, 1);
      assertEqual(m[0].value, '@jane_doe');
    });

    // ---- combined / overlap resolution ----
    test('detectAll resolves overlapping matches by preferring the longer one', () => {
      const text = 'reset your account at https://example.com/reset?email=john@example.com';
      const m = Detectors.detectAll(text);
      // The URL should win over a nested email-looking substring at the same start.
      const kinds = m.map((x) => x.type);
      assert(kinds.includes('URL'), 'expected URL to be detected');
    });

    // ---- masking ----
    test('maskValue partially hides an email', () => {
      const masked = Detectors.maskValue('EMAIL', 'johnsmith@example.com');
      assert(masked.includes('@example.com'));
      assert(!masked.includes('johnsmith'));
    });

    // ---- utils ----
    test('formatBytes renders human sizes', () => {
      assertEqual(Utils.formatBytes(0), '0 B');
      assert(Utils.formatBytes(2048).includes('KB'));
      assert(Utils.formatBytes(5 * 1024 * 1024).includes('MB'));
    });
    test('safeFilename appends -safe before the extension', () => {
      assertEqual(Utils.safeFilename('screenshot.png'), 'screenshot-safe.png');
      assertEqual(Utils.safeFilename('IMG_2024.JPG'.toLowerCase()), 'img_2024-safe.jpg');
    });
    test('clamp bounds a value', () => {
      assertEqual(Utils.clamp(5, 0, 3), 3);
      assertEqual(Utils.clamp(-5, 0, 3), 0);
      assertEqual(Utils.clamp(2, 0, 3), 2);
    });

    // ---- QR payload classification ----
    test('classifies a URL QR payload', () => {
      assertEqual(QR.classifyPayload('https://example.com'), 'URL');
    });
    test('classifies a WIFI QR payload', () => {
      assertEqual(QR.classifyPayload('WIFI:S:MyNet;T:WPA;P:hunter2;;'), 'Wi-Fi credentials');
    });
    test('classifies plain text as Text', () => {
      assertEqual(QR.classifyPayload('just some text'), 'Text');
    });

    // ---- OCR word-to-region mapping ----
    test('maps a detected email to the correct word bounding box', () => {
      const words = [
        { text: 'Contact:', x: 0, y: 0, width: 60, height: 20 },
        { text: 'john@example.com', x: 65, y: 0, width: 140, height: 20 },
        { text: 'thanks', x: 210, y: 0, width: 50, height: 20 },
      ];
      const fullText = words.map((w) => w.text).join(' ');
      const matches = Detectors.detectEmails(fullText);
      const mapped = OCR.mapMatchesToRegions(matches, words);
      assertEqual(mapped.length, 1);
      assertEqual(mapped[0].region.x, 65);
      assertEqual(mapped[0].region.width, 140);
    });

    // ---- editor region model (no DOM canvas rendering needed for this part) ----
    test('RedactionEditor tracks regions and supports undo/redo', () => {
      const canvas = document.createElement('canvas');
      canvas.width = 200; canvas.height = 200;
      const ed = new RedactionEditor(canvas);
      const img = new Image();
      // Fake a loaded image without waiting on network/file IO.
      Object.defineProperty(img, 'naturalWidth', { value: 200 });
      Object.defineProperty(img, 'naturalHeight', { value: 200 });
      ed.loadImage(img);

      const r = ed.addRegion({ x: 10, y: 10, width: 40, height: 20, mode: 'black' });
      assertEqual(ed.regions.length, 1);
      assertEqual(r.mode, 'black');

      ed.setMode(r.id, 'pixelate');
      assertEqual(ed.regions[0].mode, 'pixelate');

      ed.removeRegion(r.id);
      assertEqual(ed.regions.length, 0);

      ed.undo(); // undoes the remove
      assertEqual(ed.regions.length, 1);
      ed.undo(); // undoes the mode change
      assertEqual(ed.regions[0].mode, 'black');
      ed.redo();
      assertEqual(ed.regions[0].mode, 'pixelate');
    });

    // ---- pixel-level redaction: the most important test in this file ----
    test('exported black redaction actually overwrites the source pixels', () => {
      const size = 40;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;

      // Build a fake "image-like" source: a canvas filled with a distinct
      // red color, standing in for the loaded photo.
      const source = document.createElement('canvas');
      source.width = size; source.height = size;
      const sctx = source.getContext('2d');
      sctx.fillStyle = '#ff0000';
      sctx.fillRect(0, 0, size, size);

      const ed = new RedactionEditor(canvas);
      ed.image = source; // RedactionEditor.render()/renderFinal() just need drawImage-able source
      canvas.width = size; canvas.height = size;
      ed.addRegion({ x: 5, y: 5, width: 20, height: 20, mode: 'black', active: true, source: 'manual' });

      const finalCanvas = ed.renderFinal();
      const ctx = finalCanvas.getContext('2d');

      const inside = ctx.getImageData(15, 15, 1, 1).data; // center of the redaction
      const outside = ctx.getImageData(35, 35, 1, 1).data; // outside the redaction

      assert(inside[0] < 30 && inside[1] < 30 && inside[2] < 30, 'redacted pixel should be near-black, not the original red');
      assertEqual(outside[0], 255, 'pixel outside the redaction should be untouched red');
      assertEqual(outside[1], 0);
    });

    test('an inactive auto-detected region is NOT baked into the export', () => {
      const size = 20;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const source = document.createElement('canvas');
      source.width = size; source.height = size;
      source.getContext('2d').fillStyle = '#00ff00';
      source.getContext('2d').fillRect(0, 0, size, size);

      const ed = new RedactionEditor(canvas);
      ed.image = source;
      ed.addRegion({ x: 0, y: 0, width: size, height: size, mode: 'black', source: 'auto', active: false });

      const finalCanvas = ed.renderFinal();
      const px = finalCanvas.getContext('2d').getImageData(10, 10, 1, 1).data;
      assertEqual(px[1], 255, 'ignored detection should leave the original green pixel untouched');
    });

    return results;
  }

  return { run, test, assert, assertEqual };
})();
