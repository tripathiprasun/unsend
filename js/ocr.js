/**
 * ocr.js
 *
 * Thin wrapper around Tesseract.js. Runs entirely client-side (Tesseract.js
 * spins up its own Web Worker + WASM internally, so the main thread never
 * blocks on recognition).
 *
 * Produces:
 *   - fullText: the concatenated recognized text (for regex scanning)
 *   - words: [{ text, x, y, width, height }] bounding boxes in image pixels
 *
 * detectors.js works on plain text and returns character offsets into
 * fullText. mapMatchesToRegions() below reconciles those offsets against
 * the word boxes to produce redaction rectangles.
 *
 * NOTE: Tesseract.js v5 no longer returns a flat `data.words` array (that
 * was the v4 API shape). Word-level geometry now lives nested inside
 * `data.blocks[].paragraphs[].lines[].words[]`, so we flatten it ourselves
 * in flattenWords() below.
 */

const OCR = (() => {

  let worker = null;
  let workerPromise = null;

  async function getWorker(onProgress) {
    if (worker) return worker;
    if (workerPromise) return workerPromise;
    if (typeof Tesseract === 'undefined') {
      throw new Error('OCR engine failed to load. Check your connection and reload the page.');
    }
    workerPromise = Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (onProgress && m.status === 'recognizing text') onProgress(m.progress);
      },
    }).then((w) => {
      worker = w;
      return w;
    });
    return workerPromise;
  }

  /**
   * Flattens Tesseract v5's nested block > paragraph > line > word
   * structure into a flat array of { text, x, y, width, height, newLine }.
   * Skips whitespace-only words (line breaks etc. can show up as empty
   * or blank word entries depending on page segmentation).
   *
   * FIXED: previously trusted Tesseract's block/paragraph/line order
   * completely. Tesseract's default page segmentation groups text by
   * spatial layout ("columns"), which is a well-known failure mode for
   * chat screenshots: it can emit ALL of one side's message bubbles
   * before the other side's, out of top-to-bottom reading order. When
   * that happens, tokens that are visually stacked together (e.g. an
   * email and a phone number in the same bubble) can end up far apart
   * in fullText, or unrelated bubbles can end up adjacent -- either way,
   * regex detectors that rely on adjacency in fullText get the wrong
   * picture. We defend against this by re-sorting lines by their
   * vertical position before flattening, which approximates true
   * top-to-bottom reading order regardless of how Tesseract grouped
   * blocks/paragraphs/columns internally.
   *
   * Each word also carries `newLine: true` when it's the first word of a
   * (post-sort) line, so recognize() can join lines with '\n' instead of
   * collapsing everything to a single space. This doesn't change regex
   * matching behavior (both ' ' and '\n' are non-word / whitespace
   * characters as far as \b and \s are concerned) but makes fullText far
   * easier to inspect and debug -- log it and you'll see real line
   * structure instead of one giant run-on string.
   */
  function flattenWords(data) {
    const lines = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const words = (line.words || []).filter((w) => w.text && w.text.trim());
          if (words.length === 0) continue;
          const y = Math.min(...words.map((w) => w.bbox.y0));
          lines.push({ y, words });
        }
      }
    }

    // Re-sort lines top-to-bottom (see comment above). Ties (rare, but
    // possible for words on the same visual row split across blocks) keep
    // their relative order via a stable sort, which is guaranteed for
    // Array.prototype.sort in all modern JS engines.
    lines.sort((a, b) => a.y - b.y);

    const flatWords = [];
    for (const line of lines) {
      line.words.forEach((word, i) => {
        flatWords.push({
          text: word.text,
          x: word.bbox.x0,
          y: word.bbox.y0,
          width: word.bbox.x1 - word.bbox.x0,
          height: word.bbox.y1 - word.bbox.y0,
          newLine: i === 0,
        });
      });
    }
    return flatWords;
  }

  /**
   * Run OCR on a canvas (or image element). Returns { fullText, words }.
   */
  async function recognize(source, onProgress) {
    const w = await getWorker(onProgress);
    // Explicitly request blocks so word/line/paragraph geometry is present
    // even if a future Tesseract.js version changes its default output set.
    const { data } = await w.recognize(source, {}, { text: true, blocks: true });
    const words = flattenWords(data);
    // Rebuild fullText by joining words the same way we'll index them, so
    // character offsets from the regex detectors line up with word
    // boundaries reliably. Words within the same line join with a single
    // space; a new line joins with '\n' instead, purely for readability/
    // debuggability -- both are 1 character, so the offset math below is
    // unaffected either way.
    const fullText = words
      .map((w2, i) => (i > 0 && w2.newLine ? '\n' : i > 0 ? ' ' : '') + w2.text)
      .join('');
    return { fullText, words };
  }

  /**
   * Given detector matches (character offsets into fullText, where
   * fullText is words joined by single spaces/newlines per flattenWords)
   * and the word list, compute a bounding rectangle per match by finding
   * which words its character range overlaps.
   */
  function mapMatchesToRegions(matches, words) {
    // Build a lookup of each word's [start, end) offset in fullText.
    // Matches the same separator-length assumption used in recognize():
    // every word is preceded by exactly one joining character (' ' or
    // '\n'), except the very first word in fullText.
    const spans = [];
    let cursor = 0;
    words.forEach((w, i) => {
      if (i > 0) cursor += 1; // the joining space or newline
      const start = cursor;
      const end = start + w.text.length;
      spans.push({ start, end, word: w });
      cursor = end;
    });

    return matches.map((match) => {
      const matchEnd = match.index + match.length;
      const overlapping = spans.filter(
        (s) => s.start < matchEnd && s.end > match.index
      );
      if (overlapping.length === 0) return { ...match, region: null };

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of overlapping) {
        const w = s.word;
        minX = Math.min(minX, w.x);
        minY = Math.min(minY, w.y);
        maxX = Math.max(maxX, w.x + w.width);
        maxY = Math.max(maxY, w.y + w.height);
      }
      return {
        ...match,
        region: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      };
    }).filter((m) => m.region !== null);
  }

  async function terminate() {
    if (worker) {
      await worker.terminate();
      worker = null;
      workerPromise = null;
    }
  }

  return { recognize, mapMatchesToRegions, terminate };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = OCR;