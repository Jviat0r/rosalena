// Keeps the window's look across relaunches (src/ui-state.mjs has the why).
//
// A classic script in <head>, not a module: it runs before app.js and the plugin host
// read localStorage, so the theme, UI style, layout, a plugin's theme and plugins' saved
// data are already back when the page draws for the first time.
//
//   1. the server put the saved copy in <script id="rosalena-ui-state">: write it back
//   2. from then on, every change to a "rosalena-" or "rosalena." key is sent to
//      /api/ui-state (batched, and flushed when the page goes away)
//
// The very first launch after this shipped has nothing saved yet; whatever this origin
// already holds (a browser on a fixed port does keep localStorage) is sent up once, so
// nothing a person set before is lost.
(function () {
  "use strict";
  var KEY = /^rosalena[-.]/;
  var token = (document.querySelector('meta[name="rosalena-token"]') || {}).content || "";
  var store;
  try {
    store = window.localStorage;
  } catch (e) {
    return; // storage blocked: nothing to keep in step
  }
  var proto = Object.getPrototypeOf(store);
  var setItem = proto.setItem;
  var removeItem = proto.removeItem;

  var saved = { items: {} };
  try {
    var block = document.getElementById("rosalena-ui-state");
    if (block) saved = JSON.parse(block.textContent || "{}") || saved;
  } catch (e) {
    saved = { items: {} };
  }
  var items = saved.items || {};
  var known = Object.keys(items);

  if (known.length) {
    // The server's copy is the person's latest: it replaces whatever this origin has.
    for (var i = 0; i < store.length; i += 1) {
      var k = store.key(i);
      if (k && KEY.test(k) && !(k in items)) {
        removeItem.call(store, k);
        i -= 1;
      }
    }
    known.forEach(function (key) {
      try {
        setItem.call(store, key, items[key]);
      } catch (e) {
        /* full: that one key is lost for this page, the rest still apply */
      }
    });
  }

  var pending = { set: {}, remove: {} };
  var timer = 0;

  function flush(keepalive) {
    clearTimeout(timer);
    timer = 0;
    var set = pending.set;
    var remove = Object.keys(pending.remove);
    if (!Object.keys(set).length && !remove.length) return Promise.resolve();
    pending = { set: {}, remove: {} };
    if (!token) return Promise.resolve(); // a view-only page (the phone link without control) saves nothing
    try {
      return fetch("/api/ui-state", {
        method: "POST",
        headers: { "content-type": "application/json", "x-rosalena-token": token },
        body: JSON.stringify({ set: set, remove: remove }),
        keepalive: Boolean(keepalive),
      }).catch(function () {});
    } catch (e) {
      /* the next change tries again */
      return Promise.resolve();
    }
  }

  // For a change the page reloads on (the Language setting, i18n.mjs): the server's copy
  // replaces this origin's storage on load, so the change has to be saved before the reload.
  window.rosalenaPersist = { flush: function () { return flush(false); } };

  function queue() {
    if (!timer) timer = setTimeout(function () { flush(false); }, 400);
  }

  proto.setItem = function (key, value) {
    var result = setItem.call(this, key, value);
    if (this === store && KEY.test(String(key))) {
      pending.set[key] = String(value);
      delete pending.remove[key];
      queue();
    }
    return result;
  };
  proto.removeItem = function (key) {
    var result = removeItem.call(this, key);
    if (this === store && KEY.test(String(key))) {
      pending.remove[key] = true;
      delete pending.set[key];
      queue();
    }
    return result;
  };

  // Nothing saved on the server yet: send what this origin already has, once.
  if (!known.length) {
    for (var j = 0; j < store.length; j += 1) {
      var key = store.key(j);
      if (key && KEY.test(key)) pending.set[key] = store.getItem(key);
    }
    queue();
  }

  window.addEventListener("pagehide", function () { flush(true); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush(true);
  });
})();
