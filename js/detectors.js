/**
 * detectors.js
 * Pure, dependency-free functions that scan text for privacy-sensitive
 * patterns. Each detector returns an array of { type, value, index, length,
 * confidence } matches. "confidence" is one of "detected" | "possible" |
 * "needs-review" -- never a fake percentage.
 *
 * These operate on plain strings. Mapping matches back onto image
 * coordinates (via OCR word boxes) happens in ocr.js.
 */

const Detectors = (() => {

  // ---- helpers -----------------------------------------------------------

  function luhnValid(digitsOnly) {
    let sum = 0;
    let alt = false;
    for (let i = digitsOnly.length - 1; i >= 0; i--) {
      let n = parseInt(digitsOnly[i], 10);
      if (Number.isNaN(n)) return false;
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  function addMatch(list, type, value, index, confidence) {
    list.push({ type, value, index, length: value.length, confidence });
  }

  // ---- individual detectors ----------------------------------------------

  function detectEmails(text) {
    // FIXED (round 2): the previous fix used a lookahead that blocked BOTH
    // letters and digits from following the TLD: (?![A-Za-z0-9]). That
    // over-corrected -- when OCR glues an email directly to a following
    // phone number with zero separator characters (e.g.
    // "name@gmail.com9763583144"), the engine locks the TLD onto "com",
    // then checks the lookahead against the very next character, "9". A
    // digit is NOT a letter, so it trips the (?![A-Za-z0-9]) guard and the
    // whole match is rejected -- exactly the case we needed to allow.
    //
    // A TLD can only ever contain letters, so a digit immediately after it
    // is not evidence of a truncated match -- it's just unrelated content
    // glued on afterward, and it's safe to stop right there. We only need
    // to guard against MORE LETTERS following (which would mean we grabbed
    // a truncated TLD, e.g. matching "co" of "com"), not digits.
    const re = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?![a-zA-Z])/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) addMatch(out, 'EMAIL', m[0], m.index, 'detected');
    return out;
  }

  function detectPhones(text) {
    // Conservative: requires at least 7 digits, allows common separators,
    // optional leading +country code. Avoids matching bare short numbers.
    //
    // FIXED: previously required a minimum of THREE digit groups (two
    // separators), which misses very common two-group formats like
    // "976-3583144" (a 3+7 split) or "555-1234". Now only requires ONE
    // separator (two groups) minimum, with up to two more optional groups.
    //
    // NOTE: this still requires at least one literal separator character
    // ([\s.-]) somewhere in the match. A fully unbroken run of digits with
    // NO separator at all (e.g. "9763583144" as a single contiguous token)
    // will NOT match this regex. That's intentional -- a bare long digit
    // run is ambiguous with order IDs, timestamps, etc, and loosening this
    // would trade false negatives for false positives. If your OCR is
    // reliably producing bare unbroken digit runs for real phone numbers,
    // that's a signal worth confirming (log fullText) before loosening
    // this pattern, rather than widening it defensively.
    const re = /(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{2,4}[\s.-]\d{2,7}(?:[\s.-]\d{2,4}){0,2}/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) {
        addMatch(out, 'PHONE NUMBER', m[0], m.index, 'detected');
      }
    }
    return out;
  }

  function detectUrls(text) {
    const re = /\b((?:https?:\/\/|www\.)[^\s"'<>]+)/gi;
    const out = [];
    let m;
    while ((m = re.exec(text))) addMatch(out, 'URL', m[0], m.index, 'detected');
    return out;
  }

  function detectIPv4(text) {
    const re = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const parts = m[0].split('.').map(Number);
      // Skip obviously-not-an-IP looking version numbers like 1.2.3.4 only
      // when every octet is tiny AND there's no other context -- still flag
      // it but as "possible" rather than "detected".
      const looksLikeVersion = parts.every((p) => p < 10) && !/(?:ip|address)/i.test(text.slice(Math.max(0, m.index - 12), m.index));
      addMatch(out, 'IP ADDRESS', m[0], m.index, looksLikeVersion ? 'possible' : 'detected');
    }
    return out;
  }

  function detectSecrets(text) {
    const out = [];
    // Long hex strings (32+ chars) -- md5/sha/api-key-shaped
    const hexRe = /\b[a-fA-F0-9]{32,}\b/g;
    let m;
    while ((m = hexRe.exec(text))) addMatch(out, 'POSSIBLE SECRET', m[0], m.index, 'possible');

    // JWT-like: three base64url segments separated by dots
    const jwtRe = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
    while ((m = jwtRe.exec(text))) addMatch(out, 'POSSIBLE SECRET', m[0], m.index, 'possible');

    // Common API key prefixes
    const prefixRe = /\b(sk|pk|AKIA|ghp|gho|ghu|ghs|xox[baprs]|AIza)[A-Za-z0-9_-]{10,}\b/g;
    while ((m = prefixRe.exec(text))) addMatch(out, 'POSSIBLE SECRET', m[0], m.index, 'possible');

    // key: value / key=value pairs where the key name suggests a secret
    const kvRe = /\b(api[_-]?key|secret|token|password|passwd|pwd|auth)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+]{6,})['"]?/gi;
    while ((m = kvRe.exec(text))) addMatch(out, 'POSSIBLE SECRET', m[2], m.index + m[0].indexOf(m[2]), 'possible');

    return out;
  }

  function detectCardNumbers(text) {
    // 13-19 digits, optionally grouped by spaces/dashes in 4s
    const re = /\b(?:\d[ -]?){13,19}\b/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) continue;
      const grouped = /^\d{4}([ -]?\d{4}){2,3}([ -]?\d{1,4})?$/.test(m[0].trim());
      const valid = luhnValid(digits);
      if (valid && grouped) {
        addMatch(out, 'POSSIBLE CARD NUMBER', m[0], m.index, 'detected');
      } else if (valid) {
        addMatch(out, 'POSSIBLE CARD NUMBER', m[0], m.index, 'possible');
      }
      // If Luhn fails, we deliberately do NOT flag it -- avoids false
      // positives on arbitrary long numbers (order IDs, timestamps, etc).
    }
    return out;
  }

  function detectHandles(text) {
    const re = /(?<![\w@])@[A-Za-z0-9_]{2,30}\b/g;
    const out = [];
    let m;
    while ((m = re.exec(text))) addMatch(out, 'USERNAME / HANDLE', m[0], m.index, 'needs-review');
    return out;
  }

  /**
   * Run every detector over a block of text and return a flat, sorted list.
   */
  function detectAll(text) {
    if (!text) return [];
    const results = [
      ...detectEmails(text),
      ...detectPhones(text),
      ...detectUrls(text),
      ...detectIPv4(text),
      ...detectSecrets(text),
      ...detectCardNumbers(text),
      ...detectHandles(text),
    ];
    // Remove near-duplicate overlaps (e.g. a URL swallowing part of an
    // email-looking string) by preferring the longer match at a given start.
    results.sort((a, b) => a.index - b.index || b.length - a.length);
    const filtered = [];
    let lastEnd = -1;
    for (const r of results) {
      if (r.index >= lastEnd) {
        filtered.push(r);
        lastEnd = r.index + r.length;
      }
    }
    return filtered;
  }

  function maskValue(type, value) {
    if (type === 'EMAIL') {
      const [user, domain] = value.split('@');
      if (!domain) return '•'.repeat(value.length);
      const shownUser = user.length > 2 ? user.slice(0, 2) : user[0] || '';
      return `${shownUser}${'•'.repeat(Math.max(3, user.length - shownUser.length))}@${domain}`;
    }
    if (type === 'PHONE NUMBER') {
      // FIXED: previously always prepended a synthesized "+" and treated
      // the first 3 digits of whatever matched as a "country code", even
      // when the original text had no "+" in it at all (e.g. a plain local
      // number like "9763583144" got displayed as "+976 xxxxx44", which
      // looks like a detected/parsed country code but is actually just
      // digits.slice(0,3) with a "+" glued on -- misleading either way).
      const hasPlus = value.trim().startsWith('+');
      const digits = value.replace(/\D/g, '');
      if (hasPlus) {
        return `+${digits.slice(0, 3)} ${'x'.repeat(Math.max(0, digits.length - 5))}${digits.slice(-2)}`;
      }
      return `${'x'.repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
    }
    if (type === 'POSSIBLE SECRET' || type === 'POSSIBLE CARD NUMBER') {
      return '•'.repeat(Math.min(16, value.length));
    }
    if (type === 'IP ADDRESS' || type === 'URL' || type === 'USERNAME / HANDLE') {
      return value.length > 24 ? value.slice(0, 21) + '...' : value;
    }
    return value;
  }

  return {
    luhnValid,
    detectEmails,
    detectPhones,
    detectUrls,
    detectIPv4,
    detectSecrets,
    detectCardNumbers,
    detectHandles,
    detectAll,
    maskValue,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Detectors;