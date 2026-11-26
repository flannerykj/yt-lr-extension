// Swallowing an error is often right — a hook installed on the page's own
// `fetch` must never break the page, and a best-effort cleanup has nowhere to
// report to. Swallowing it *silently* is what costs a debugging round, because
// a feature that quietly does nothing looks exactly like one that was never
// wired up.
//
// So: catch, carry on, but say so. Deduplicated by site and message, so a hook
// that runs hundreds of times a second still only speaks once.
(function () {
  const NS = (window.YLR = window.YLR || {});
  const seen = new Set();

  NS.warn = function (where, err, extra) {
    const message = (err && err.message) || String(err == null ? "" : err);
    const key = where + "|" + message;
    if (seen.has(key)) return;
    seen.add(key);
    const parts = ["[YLR] " + where];
    if (message) parts.push("— " + message);
    if (extra !== undefined) parts.push(extra);
    console.log(parts.join(" "));
  };
})();
