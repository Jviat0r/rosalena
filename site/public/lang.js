// The EN / ES switch, shared by every page. The switch itself is a plain link in the header
// (it works with JavaScript off, and crawlers follow it); this file only does two small things:
//
//   1. remembers the language someone picked, in localStorage under "rosalena-lang";
//   2. on an English page, shows a small, dismissible "Ver esta página en español" note when
//      the browser's language is Spanish or the visitor picked Spanish before.
//
// It never redirects. A shared link opens the page it names, in the language it names, and a
// crawler sees the same page a visitor does. Loaded with defer; the site CSP allows scripts from
// this origin only, which is why this is a file and not inline.
(function () {
  var KEY = "rosalena-lang";
  var root = document.documentElement;
  var lang = /^es\b/i.test(root.getAttribute("lang") || "") ? "es" : "en";

  function saved() {
    try {
      return localStorage.getItem(KEY);
    } catch (e) {
      return null;
    }
  }
  function remember(value) {
    try {
      localStorage.setItem(KEY, value);
    } catch (e) {
      /* private window: the switch still works, it just is not remembered */
    }
  }

  var links = document.querySelectorAll("[data-lang-switch]");
  for (var i = 0; i < links.length; i++) {
    links[i].addEventListener("click", function (event) {
      remember(event.currentTarget.getAttribute("data-lang-switch") === "es" ? "es" : "en");
    });
  }

  if (lang !== "en") return;
  var toSpanish = document.querySelector('[data-lang-switch="es"]');
  if (!toSpanish) return;
  var choice = saved();
  var browserSpanish = /^es\b/i.test((navigator && navigator.language) || "");
  if (choice === "en" || (choice !== "es" && !browserSpanish)) return;

  var hint = document.createElement("div");
  hint.className = "lang-hint";
  hint.setAttribute("lang", "es");
  hint.setAttribute("role", "note");
  var go = document.createElement("a");
  go.href = toSpanish.getAttribute("href");
  go.hreflang = "es";
  go.textContent = "Ver esta página en español";
  go.addEventListener("click", function () {
    remember("es");
  });
  var close = document.createElement("button");
  close.type = "button";
  close.className = "lang-hint-close";
  close.setAttribute("aria-label", "Seguir en inglés");
  close.title = "Seguir en inglés";
  close.textContent = "×";
  close.addEventListener("click", function () {
    remember("en");
    hint.remove();
  });
  hint.append(go, close);
  document.body.prepend(hint);
})();
