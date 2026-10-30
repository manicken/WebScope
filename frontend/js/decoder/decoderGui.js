/**
 * decoderGui.js — the "Analyzers" section of the right panel: add buttons and one config card
 * per decoder instance. (The "Decoded data" table is dataTable/DataTable.js.)
 *
 * A card is created once per decoder and kept until the decoder is removed. Every form field is
 * bound to one of decoder.settings (a ReactiveValue); the decoder engine re-runs the decoder when
 * its settings change, so nothing else is needed here.
 */
(function (WS) {
    'use strict';
    const { appState } = WS;
    const { toggleDecoderVisible, removeDecoder } = WS.decoders;

    function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

    let addDecoderMenu = null;

    function init() {
        addDecoderMenu = new AddNewDecoderContextMenu({
            itemClickedCb: ({ path, parentDecoder }) => {
                try { window.WS.decoders.addChain(path.map(window.WS.decoders.typeOf), { parentDecoder }); }
                catch (e) { console.log(e); InfoDialog.Show({ title: 'Cannot add decoder', message: e }); }
            }
        });
        WS.decoders.ui.addDecoderMenu = addDecoderMenu;
    }

    /* ---------- caches (persist across re-renders so MinimizeCard state is kept) ---------- */
    const decoderCards = new Map();   // decoder id -> { el, update() }
    const sections = new Map();       // parent id ('root' for top level) -> { sec, root, hint, cards, parent }

    function pruneCaches() {
        const alive = new Set(WS.decoders.list.value.map((d) => d.id));
        for (const id of [...decoderCards.keys()]) if (!alive.has(id)) decoderCards.delete(id);
        for (const key of [...sections.keys()]) if (key !== 'root' && !alive.has(key)) sections.delete(key);
    }

    function getDecoderCard(d) {
        let card = decoderCards.get(d.id);
        if (!card) {
            card = analyzerCard(d);
            decoderCards.set(d.id, card);
        }
        card.update();
        return card;
    }

    /* ============================== Analyzers ============================== */

    function getSection({title, parent, panelRoot}) {
        const key = parent ? parent.id : 'root';
        let s = sections.get(key);
        if (s) return s;

        s = { parent, sec: null, root: null, hint: null, cards: null };

        const btn = el('button', '', '➕');
        btn.addEventListener('click', (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            addDecoderMenu.setItems({ items: WS.decoders.registry, parentDecoder: s.parent });
            addDecoderMenu.toggleContextMenu(e, { x: rect.left, y: rect.top + rect.height + 2 });
        });

        s.hint = el('div', 'hint', 'Add a protocol analyzer to decode the captured data');
        s.cards = el('div', 'cards');

        if (panelRoot) {
            // plain section for the panel root, no minimize card
            s.root = el('section', 'section');
            const head = el('div', 'rp-header');
            head.append(el('span', 'rp-header-title', title), btn);
            s.root.append(head, s.hint, s.cards);
        } else {
            const spacer = createNewElement('div', { className: 'spacer' });
            s.sec = MinimizeCard({ title, headItems: [spacer, btn] });
            s.sec.bodyAppendChild(s.hint);
            s.sec.bodyAppendChild(s.cards);
            s.root = s.sec.getRoot();
        }

        sections.set(key, s);
        return s;
    }

    /** Renders the cards of the decoders whose parent is `parent` (null = the root decoders). */
    function renderAnalyzers({ container, title = 'Analyzers', parent = null, panelRoot = false } = {}) {
        const decoders = WS.decoders.list.value;
        if (!parent) pruneCaches();

        const s = getSection({title, parent, panelRoot});
        s.parent = parent;

        // attach the (persistent) section only if it is not already there
        if (s.root.parentNode !== container) {
            container.innerHTML = '';
            container.appendChild(s.root);
        }

        const visible = decoders.filter(d => d.parent == parent); // sub-decoders only render under their own parent
        s.hint.style.display = decoders.length === 0 ? '' : 'none';

        // reconcile cards in order, without recreating them
        const wanted = visible.map(d => getDecoderCard(d).el);
        wanted.forEach((node, i) => {
            if (s.cards.children[i] !== node) s.cards.insertBefore(node, s.cards.children[i] || null);
        });
        while (s.cards.children.length > wanted.length) s.cards.lastElementChild.remove();
    }

    /* ============================== form fields ============================== */
    // Each is bound to one setting (a ReactiveValue): it writes with setting.set(v, input) and
    // subscribes to it to show changes made elsewhere. Returns { input, dispose } (+ fillOptions for
    // channels); dispose() ends the subscription when the field is replaced.

    /** The channels decoder d reads that give it no data: not active (hidden, so not in the next capture)
     *  or not in the capture on screen. One text per channel, empty when all is fine. */
    function channelProblems(d) {
        const buf = WS.capture.buffer.value;
        return WS.uiRowsLayout.decoderChannels(d).flatMap((i) => {
            const ch = appState.channels.value.find((c) => c.index === i);
            if (!ch) return [];
            if (!ch.visible.value) return [`${ch.name.value} is not active`];
            if (buf && !buf.has(i)) return [`${ch.name.value} is not captured`];
            return [];
        });
    }

    /** Channel select: the active channels (and the chosen one when it is not active, marked so);
     *  the card calls fillOptions() when the channels, their names or which are active change. */
    function channelField(setting, f) {
        const input = document.createElement('select');
        const show = () => { input.value = setting.value == null ? '' : String(setting.value); };
        function fillOptions() {
            input.innerHTML = '';
            if (f.type === 'channel?') input.appendChild(new Option('None', ''));
            for (const ch of appState.channels.value) {
                if (ch.visible.value) input.appendChild(new Option(ch.name.value, String(ch.index)));
                else if (ch.index === setting.value) input.appendChild(new Option(`${ch.name.value} (not active)`, String(ch.index)));
            }
            show();
        }
        input.addEventListener('change', () => setting.set(input.value === '' ? null : Number(input.value), input));
        // refill: an inactive channel that is no longer chosen leaves the list
        const dispose = setting.subscribe(({ source }) => { if (source !== input) fillOptions(); else show(); });
        fillOptions();
        return { input, fillOptions, dispose };
    }

    function selectField(setting, f) {
        const input = document.createElement('select');
        for (const [k, label] of f.options) input.appendChild(new Option(label, String(k)));
        input.addEventListener('change', () => {
            const opt = f.options.find(([k]) => String(k) === input.value);
            if (opt) setting.set(opt[0], input);
        });
        const show = () => { input.value = String(setting.value); };
        const dispose = setting.subscribe(({ source }) => { if (source !== input) show(); });
        show();
        return { input, dispose };
    }

    function boolField(setting) {
        const input = createNewElement('input', {
            type: 'checkbox',
            onchange: (e) => { setting.set(e.currentTarget.checked, input); }
        });
        const show = () => { input.checked = Boolean(setting.value); };
        const dispose = setting.subscribe(({ source }) => { if (source !== input) show(); });
        show();
        return { input, dispose };
    }

    function textField(setting) {
        const input = document.createElement('input');
        input.className = 'mono';
        const show = () => { input.value = String(setting.value ?? ''); };
        input.addEventListener('change', () => setting.set(input.value, input));
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
        const dispose = setting.subscribe(({ source }) => { if (source !== input) show(); });
        show();
        return { input, dispose };
    }

    /** Code editor for CustomDecoder. `onCompiled` is called after a successful compile (the form may change). */
    function codeField(d, setting, onCompiled) {
        const input = createNewElement('div', { styles: { width: '100%' } });
        const compileAndRun = (code) => {
            setting.set(code);
            const res = d.compile();
            if (res !== true) { InfoDialog.Show({ title: 'Custom Code Error', message: res }); return; }
            onCompiled();
            WS.decoders.decode(d.id);
        };

        const codeText = createNewElement('textarea', {
            styles: { width: '100%', minHeight: '200px', background: '#AAA' },
            onchange: (e) => setting.set(e.currentTarget.value, codeText)
        });
        const codeEditOpenBtn = createNewElement('button', {
            textContent: 'Open Code Editor',
            styles: { width: '100%', background: '#494949' },
            onclick: () => {
                WS.customDecoderEditor.open({
                    code: codeText.value,
                    onSave: (code) => setting.set(code),
                    onRunDecoder: compileAndRun
                });
            }
        });
        const codeRunBtn = createNewElement('button', {
            textContent: 'run',
            styles: { width: '100%', background: '#494949' },
            onclick: () => compileAndRun(codeText.value)
        });
        const buttons = createNewElement('div', { className: 'form-row' });
        buttons.append(codeEditOpenBtn, codeRunBtn);
        input.append(codeText, buttons);

        const show = () => { codeText.value = String(setting.value ?? ''); };
        const dispose = setting.subscribe(({ source }) => { if (source !== codeText) show(); });
        show();
        return { input, dispose };
    }

    /** A number above 0, or at least f.min when the field has one (min: -Infinity: any number). */
    function numberField(setting, f) {
        const input = document.createElement('input');
        input.title = "Unknown settings type: " + f.type;
        input.className = 'mono';
        const show = () => { input.value = String(setting.value); };
        const commit = () => {
            const n = Number(input.value);
            if (input.value.trim() !== '' && isFinite(n) && (f.min === undefined ? n > 0 : n >= f.min)) setting.set(n, input);
            show(); // normalises the text, or reverts an invalid value
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
        const dispose = setting.subscribe(({ source }) => { if (source !== input) show(); });
        show();
        return { input, dispose };
    }

    /* ============================== One decoder card ============================== */
    function analyzerCard(d) {
        const dot = createNewElement('span', { className: 'dot' });
        const titleEl = createNewElement('span', { className: 'card-title' });
        const subEl = createNewElement('span', { className: 'card-sub' });
        const eyeBtn = createNewElement('button', { className: 'icon-btn', onclick: () => { toggleDecoderVisible(d.id); } });
        const delBtn = createNewElement('button', {
            className: 'icon-btn danger', textContent: '✕', title: 'Remove',
            onclick: () => { removeDecoder(d.id); }
        });

        const card = MinimizeCard({ headItems: [dot, titleEl, subEl, eyeBtn, delBtn] });

        const form = el('div', 'card-body');
        card.bodyAppendChild(form);
        const warnEl = el('div', 'card-warn');     // the channels that give this decoder no data, see channelProblems()
        warnEl.hidden = true;
        form.appendChild(warnEl);

        // One row per setting, created the first time the setting is in getCfgGui() and then kept, in
        // getCfgGui()'s order. A decoder's fields can change (a CustomDecoder's after a compile, a
        // decoder with d.guiChanged whenever it bumps it): rows that are gone are only hidden, a row
        // whose field definition is another object is made again.
        const formRows = new Map();   // key -> { row, f, field }
        const channelFields = [];     // { fillOptions } of the channel selects
        let subSection = null;        // row with the sub-decoder cards, if this decoder has an output

        function fieldFor(key, f, row) {
            const setting = d.setting(key, f.default);
            if (f.type === 'channel' || f.type === 'channel?') {
                const field = channelField(setting, f);
                channelFields.push(field);
                return field;
            }
            if (f.type === 'select') return selectField(setting, f);
            if (f.type === 'bool') return boolField(setting);
            if (f.type === 'text') return textField(setting);
            if (f.type === 'js_code_edit') { row.className = 'form-col'; return codeField(d, setting, updateForm); }
            return numberField(setting, f);
        }

        function formRow(key, f) {
            const row = el('label', 'form-row' + (f.type === 'bool' ? ' bool' : ''));
            if (f.desc) row.title = f.desc;
            row.appendChild(el('span', null, f.label));
            const field = fieldFor(key, f, row);
            row.appendChild(field.input);
            return { row, f, field };
        }

        function updateForm() {
            const gui = d.getCfgGui();
            for (const [key, f] of Object.entries(gui)) {
                const old = formRows.get(key);
                if (old?.f === f) continue;
                if (old) {
                    old.field.dispose?.();
                    const i = channelFields.indexOf(old.field);
                    if (i >= 0) channelFields.splice(i, 1);
                    old.row.remove();
                }
                formRows.set(key, formRow(key, f));
            }
            for (const [key, { row }] of formRows) row.hidden = !(key in gui);
            for (const key of Object.keys(gui)) form.appendChild(formRows.get(key).row);

            if (!subSection && typeof d.getOutput === 'function' && d.getOutput() != null) {
                subSection = el('label', 'form-col');
                subSection.appendChild(createNewElement('div', { styles: { width: '100%' } }));
            }
            if (subSection) form.appendChild(subSection); // (re)appended, so it stays below the fields
            renderSubDecoders();
        }

        function renderSubDecoders() {
            if (subSection) renderAnalyzers({ container: subSection.firstChild, parent: d, title: "Sub Decoders" });
        }

        function updateHead() {
            dot.style.background = d.color;
            titleEl.textContent = d.name;
            // the decoders' summary() takes plain channels: [{ index, name }]
            subEl.textContent = d.summary(appState.channels.value.map((ch) => ({ index: ch.index, name: ch.name.value })));
            eyeBtn.textContent = d.visible.value ? '👁' : '🚫';
            eyeBtn.title = d.visible.value ? 'Hide rows' : 'Show rows';
            const problems = channelProblems(d);
            warnEl.hidden = problems.length === 0;
            warnEl.textContent = problems.length ? `No data: ${problems.join(', ')}` : '';
        }

        d.settingsChanged.subscribe(updateHead);
        d.visible.subscribe(updateHead);
        // optional: a decoder whose fields, rows or summary change by themselves (e.g. PythonDecoder)
        d.guiChanged?.subscribe(() => {
            if (d.removed) return;
            updateForm();
            updateHead();
        });
        // the channels outlive the decoder: stop updating once it is removed
        ReactiveValue.subscribeItems(appState.channels, (ch) => [ch.name, ch.visible], () => {
            if (d.removed) return;
            channelFields.forEach((f) => f.fillOptions());
            updateHead();
        });
        WS.capture.buffer.subscribe(() => { if (!d.removed) updateHead(); });

        updateForm();
        updateHead();
        return { el: card.card, update: renderSubDecoders };
    }

    WS.decoders = WS.decoders ?? {};
    WS.decoders.ui = Object.assign(WS.decoders.ui ?? {}, {
        init,
        channelProblems,
        renderAnalyzers,
        addDecoderMenu,
    });

})(window.WS = window.WS ?? {});
