/**
 * scripts/scriptPanel.js — the "Scripts" right-panel tab: title, "+" (a new script) and the project's
 * scripts (scripts/scriptEngine.js), like the Markers list.
 *   ▶ run the script        ✎ edit it (ScriptEditor.openFor)        ✕ remove it (asks first)
 *   double-click the name   rename it (Enter / click outside keeps it, Esc cancels)
 * A script's output goes to the Messages panel (and its editor); the row only says "running…" or "error".
 */
(function (WS) {
  'use strict';
  const S = WS.scripts;

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

  let ui = null;

  function build(container) {
    container.innerHTML = '';
    const head = el('div', 'sel-panel-head');
    const title = el('span', 'sel-panel-title', 'Scripts');
    const add = el('button', 'sel-add', '+'); add.title = 'New script';
    add.addEventListener('click', () => S.add());
    head.append(title, add);
    const listEl = el('div', 'sel-list');
    container.append(head, listEl);
    ui = { container, listEl };
  }

  /** Double-click: the name becomes a text field. */
  function renameInPlace(script, nameEl) {
    const input = document.createElement('input');
    input.className = 'sc-rename';
    input.value = script.name;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      let name = input.value.trim();
      if (keep && name && !name.endsWith('.js')) name += '.js';
      const ok = keep && name && name !== script.name ? S.validateName(name, script.name) : true;
      if (ok !== true) WS.toast(ok);
      else if (keep && name && name !== script.name) { S.rename(script.name, name); return; }   // the list is redrawn
      nameEl.textContent = script.name;
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();   // keep typing away from global shortcuts
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  function removeAsked(script) {
    ConfirmDialog.Show({
      title: 'Remove script', message: `Remove the script ${script.name}? Its code is lost.`,
      confirmText: 'Remove', confirmClass: 'button-danger',
      onConfirm: () => S.remove(script.name),
    });
  }

  function rebuildList() {
    const scripts = S.list.value;
    ui.listEl.innerHTML = '';
    if (!scripts.length) {
      ui.listEl.appendChild(el('div', 'hint sel-empty', 'Press + to add a script: JavaScript that can export the capture or anything the decoders found. ▶ runs it, ✎ edits it. Scripts are saved with the project and only run when you press ▶.'));
      return;
    }
    for (const script of scripts) {
      const failed = script.output?.some((l) => l.error);

      const item = el('div', 'sel-item');
      item.style.height = '48px';
      const name = el('span', 'sel-name sc-name'); name.textContent = script.name; name.title = 'Double-click to rename';
      const state = el('span', 'sel-dt sc-state' + (failed ? ' sc-error' : ''));
      state.textContent = script.running ? 'running…' : failed ? 'error' : '';
      if (failed) state.title = 'See the Messages panel';
      const run = el('button', 'sc-btn', '▶'); run.title = 'Run'; run.disabled = !!script.running;
      const edit = el('button', 'sc-btn', '✎'); edit.title = 'Edit';
      const del = el('button', 'sel-del', '✕'); del.title = 'Remove';
      item.append(name, state, run, edit, del);

      name.addEventListener('dblclick', () => renameInPlace(script, name));
      run.addEventListener('click', () => S.run(script));
      edit.addEventListener('click', () => ScriptEditor.openFor(script));
      del.addEventListener('click', () => removeAsked(script));
      ui.listEl.appendChild(item);
    }
  }

  /** Called by the rightpanel when the panel is opened and when the scripts changed. */
  function render({ container }) {
    if (!ui || ui.container !== container) build(container);
    rebuildList();
  }

  S.panel = { render };
})(window.WS = window.WS || {});
