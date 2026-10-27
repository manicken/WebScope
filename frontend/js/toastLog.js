/**
 * toastLog.js — "Messages" right-panel tab: every toast that was shown (appState.toasts), newest
 * first, with the time it was shown. A message with an extended message (`details`, e.g. sigrok-cli's
 * whole output) has a Details button that shows it. Clear empties the log.
 */
(function (WS) {
  'use strict';
  const { appState } = WS;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const fmtClock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const open = new WeakSet();   // log entries whose details are shown

  function row(entry) {
    const r = el('div', 'toast-log-row');
    const head = el('div', 'toast-log-head');
    head.append(el('span', 'toast-log-time', fmtClock(entry.time)), el('span', 'toast-log-msg', entry.message));
    head.title = entry.time.toLocaleString();
    r.appendChild(head);
    if (entry.details) {
      const shown = open.has(entry);
      const btn = el('button', 'icon-btn toast-log-more', shown ? 'Hide details' : 'Details');
      btn.addEventListener('click', () => {
        if (open.has(entry)) open.delete(entry); else open.add(entry);
        r.replaceWith(row(entry));
      });
      head.appendChild(btn);
      if (shown) r.appendChild(el('pre', 'toast-log-details', entry.details));
    }
    return r;
  }

  function render({ container }) {
    const log = appState.toasts.value;
    const clear = el('button', 'icon-btn', 'Clear');
    clear.title = 'Clear the message log';
    clear.disabled = log.length === 0;
    clear.addEventListener('click', () => appState.toasts.set([]));

    const s = WS.rightpanel.section(`Messages (${log.length})`, clear, true);
    const list = el('div', 'toast-log');
    if (log.length === 0) list.appendChild(el('div', 'hint', 'No messages yet. Messages shown at the bottom of the window are kept here.'));
    for (let i = log.length - 1; i >= 0; i--) list.appendChild(row(log[i]));
    s.appendChild(list);
    container.replaceChildren(s);
  }

  WS.toastLog = {
    render,
    watch: (changed) => appState.toasts.subscribe(changed),
  };
})(window.WS = window.WS || {});
