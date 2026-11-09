// Light or dark site theme (dark is the default), shared by every page through one storage key;
// /try/ and /check/ keep their own switch buttons but read and write the same key. Loaded in
// <head> without defer, so a saved
// light choice is applied before the page draws and it never flashes dark first. The site's
// CSP allows only scripts from this origin, which is why this is a file and not inline.
(function () {
  var KEY = "rosalena-theme";
  var root = document.documentElement;
  function saved() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }
  function apply(theme) {
    root.setAttribute("data-theme", theme === "light" ? "light" : "dark");
  }
  // `?theme=light` (or dark) in the address picks it for this visit, so a link can show either.
  var asked = /[?&]theme=(light|dark)\b/.exec(location.search);
  apply(asked ? asked[1] : saved());

  // The labels follow the page language (<html lang>): the Spanish pages under /es/ are built
  // from the English ones by site/tools/build-i18n.mjs and load this same file.
  var LABELS = /^es\b/i.test(root.getAttribute("lang") || "")
    ? { toDark: "Cambiar al tema oscuro", toLight: "Cambiar al tema claro", dark: "Tema oscuro", light: "Tema claro" }
    : { toDark: "Switch to the dark theme", toLight: "Switch to the light theme", dark: "Dark theme", light: "Light theme" };

  function paint(button) {
    var light = root.getAttribute("data-theme") === "light";
    button.setAttribute("aria-pressed", light ? "true" : "false");
    button.setAttribute("aria-label", light ? LABELS.toDark : LABELS.toLight);
    button.title = light ? LABELS.dark : LABELS.light;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      (function (button) {
        paint(button);
        button.addEventListener("click", function () {
          var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
          apply(next);
          try {
            localStorage.setItem(KEY, next);
          } catch (e) {
            /* private window: the choice lasts for this page only */
          }
          for (var j = 0; j < buttons.length; j++) paint(buttons[j]);
        });
      })(buttons[i]);
    }
  });
})();
