// Extension-wide preferences, in chrome.storage.local so they are shared across
// sites and survive a reload (IndexedDB and localStorage are per-origin, which
// would give YouTube and Prime Video separate copies).
(function () {
  const NS = (window.YLR = window.YLR || {});
  const KEY = "ylr-settings";
  const DEFAULTS = { wordHighlight: false };

  let cache = Object.assign({}, DEFAULTS);
  const listeners = [];

  const ready = new Promise((resolve) => {
    try {
      chrome.storage.local.get(KEY, (stored) => {
        if (!chrome.runtime.lastError && stored && stored[KEY])
          cache = Object.assign({}, DEFAULTS, stored[KEY]);
        resolve(cache);
      });
    } catch (e) {
      resolve(cache);
    }
  });

  // Fires in every tab, including the one that made the change, so a sidebar
  // open on another video keeps up.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[KEY]) return;
      cache = Object.assign({}, DEFAULTS, changes[KEY].newValue || {});
      for (const fn of listeners) fn(cache);
    });
  } catch (e) {}

  NS.settings = {
    ready,
    get() {
      return cache;
    },
    onChange(fn) {
      listeners.push(fn);
    },
    async set(patch) {
      await ready;
      cache = Object.assign({}, cache, patch);
      const value = Object.assign({}, cache);
      return new Promise((resolve, reject) => {
        chrome.storage.local.set({ [KEY]: value }, () => {
          const err = chrome.runtime.lastError;
          err ? reject(new Error(err.message)) : resolve(value);
        });
      });
    }
  };
})();
