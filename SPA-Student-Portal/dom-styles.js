/* Saint Patrick's Academy, Inc. — runtime style hooks.
 *
 * A page may set an element's style from JavaScript. What it may NOT do is let
 * the server dictate a style value: `element.style.x = dataFromServer` is a
 * script-computed style, and a Content-Security-Policy that blocks inline style
 * (style-src 'self') refuses it.
 *
 * The admin dashboard needs a few of these: the status select's coloured left
 * border, the "saved" flash on a row, and the Enable/Disable button trim.
 * Rather than weaken the policy with 'unsafe-inline', those rules live in
 * admin.css and this file only toggles CLASS NAMES.
 *
 * Loaded before admin.js (plain, in <head>) so the helpers exist by the time
 * the dashboard builds its table.
 */
(function (global) {
  "use strict";

  /**
   * Replace an element's optional-variant classes.
   *
   * `variants` maps a key to the class to add for it; any other key in that
   * map is removed first, so an element can never hold two variants at once.
   */
  function setVariant(element, variants, key) {
    if (!element) return;
    Object.keys(variants).forEach(function (name) {
      element.classList.remove(variants[name]);
    });
    if (key && variants[key]) element.classList.add(variants[key]);
  }

  /**
   * Add a class for a moment (a "saved" flash, say), then take it away again.
   * Returns a cancel function, so a second save can restart the timer rather
   * than let the first one remove the class early.
   */
  function flash(element, className, milliseconds) {
    if (!element) return function () {};
    element.classList.add(className);
    var timer = setTimeout(function () {
      element.classList.remove(className);
    }, milliseconds || 700);
    return function () {
      clearTimeout(timer);
      element.classList.remove(className);
    };
  }

  global.SpaStyles = { setVariant: setVariant, flash: flash };
})(window);
