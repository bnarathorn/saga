/**
 * Applies the stored theme before first paint, so a reload never flashes the wrong one.
 *
 * This is a file rather than an inline `<script>` in index.html because the reference
 * deployment serves Guild Hall under `default-src 'self'` with no `script-src` (see
 * `deploy/nginx/saga-headers.conf`). That policy blocks inline script, which left the class
 * unset on every load: the toggle worked, and a refresh silently reverted to light. Served
 * from the same origin, this runs under the same policy without a hash or a nonce to keep in
 * step with the file's contents.
 *
 * Loaded synchronously in `<head>`, ahead of the module bundle, so `documentElement` carries
 * the class before the stylesheet paints anything.
 */
(function () {
  try {
    var stored = localStorage.getItem('saga.theme');
    var dark =
      stored === 'dark' ||
      (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (error) {
    /* localStorage unavailable: fall back to the media query default in CSS */
  }
})();
