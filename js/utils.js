/**
 * utils.js -- small, dependency-free helpers shared across modules.
 */

const Utils = (() => {

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / Math.pow(1024, i);
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function uid(prefix = 'r') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function baseName(filename) {
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.slice(0, dot) : filename;
  }

  function extOf(filename) {
    const dot = filename.lastIndexOf('.');
    return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  }

  function safeFilename(filename) {
    const base = baseName(filename);
    const ext = extOf(filename) || 'png';
    return `${base}-safe.${ext}`;
  }

  function announce(msg) {
    const region = document.getElementById('sr-status');
    if (region) region.textContent = msg;
  }

  return { formatBytes, escapeHtml, debounce, uid, clamp, baseName, extOf, safeFilename, announce };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Utils;