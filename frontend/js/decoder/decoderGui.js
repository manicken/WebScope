/**
 * decoderGui.js — the "Analyzers" section of the right panel: add buttons and one config card
 * per decoder instance. (The "Decoded data" table is annotations/annotationGui.js.)
 */
(function (WS) {
    'use strict';
    const { store } = WS;
    const { addNewDecoder, updateDecoder, toggleDecoderVisible, removeDecoder } = WS.decoders;

    function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

    let addDecoderMenu = null;

    function init() {
        //addDecoderMenu = new AddNewDecoderContextMenu({ itemClickedCb: (p) => { addNewDecoder(p); } });

        addDecoderMenu = new AddNewDecoderContextMenu({
            itemClickedCb: ({ path, parentDecoder }) => {
                try { window.WS.decoders.addChain(path.map(window.WS.decoders.typeOf), { parentDecoder }); }
                catch (e) { console.log(e); InfoDialog.Show({ title: 'Cannot add decoder', message: e }); }
            }
        });
        WS.decoders.ui.addDecoderMenu = addDecoderMenu;
    }

    /* ---------- caches (persist across re-renders so MinimizeCard state is kept) ---------- */
    const decoderCards = new Map();   // decoder id -> { el, update(d) }
    const sections = new Map();       // parent id ('root' for top level) -> { sec, root, hint, cards, parent }

    function collectIds(decoders, out = new Set()) {
        for (const d of decoders) {
            out.add(d.id);
            if (d.subDecoders?.length) collectIds(d.subDecoders, out);
        }
        return out;
    }

    function pruneCaches() {
        const alive = collectIds(store.get().decoders);
        for (const id of [...decoderCards.keys()]) if (!alive.has(id)) decoderCards.delete(id);
        for (const key of [...sections.keys()]) if (key !== 'root' && !alive.has(key)) sections.delete(key);
    }

    function getDecoderCard(d) {
        let card = decoderCards.get(d.id);
        if (!card) {
            card = analyzerCard(d);
            decoderCards.set(d.id, card);
        }
        card.update(d);
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

    function renderAnalyzers({ container, title = 'Analyzers', decoders = store.get().decoders, parent = null, panelRoot = false } = {}) {
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

        // Form lives in its own div: it can be rebuilt without touching the MinimizeCard shell/state.
        const form = el('div', 'card-body');
        card.bodyAppendChild(form);

        let formSig = null;
        let updaters = new Map(); // cfg key -> (decoder) => void

        function guiSignature(dec, channels) {
            const gui = dec.getCfgGui();
            return JSON.stringify([
                Object.entries(gui).map(([k, f]) => [k, f.type, f.label, f.options ?? null]),
                channels.map(c => [c.index, c.name]),
            ]);
        }

        function update(dec) {
            d = dec; // always point at the latest decoder object
            const channels = store.get().channels;

            // head
            dot.style.background = d.color;
            titleEl.textContent = d.name;
            subEl.textContent = d.summary(channels);
            eyeBtn.textContent = d.visible ? '👁' : '🚫';
            eyeBtn.title = d.visible ? 'Hide rows' : 'Show rows';

            // body
            const sig = guiSignature(d, channels);
            if (sig !== formSig) {
                formSig = sig;
                buildForm();
            }
            for (const fn of updaters.values()) fn(d);
        }

        function buildForm() {
            form.innerHTML = '';
            updaters = new Map();
            const channels = store.get().channels;

            for (const [key, f] of Object.entries(d.getCfgGui())) {
                const row = el('label', 'form-row' + (f.type === 'bool' ? ' bool' : ''));
                if (f.type !== 'subDecoders') row.appendChild(el('span', null, f.label));

                const upd = (val) => updateDecoder(d.id, { [key]: val });
                const isActive = (node) => document.activeElement === node;
                let input;

                if (f.type === 'channel' || f.type === 'channel?') {
                    input = document.createElement('select');
                    if (f.type === 'channel?') input.appendChild(new Option('None', ''));
                    for (const ch of channels) input.appendChild(new Option(ch.name, String(ch.index)));
                    input.addEventListener('change', () => upd(input.value === '' ? null : Number(input.value)));
                    updaters.set(key, (dec) => {
                        const v = dec.cfg[key];
                        input.value = v == null ? '' : String(v);
                    });

                } else if (f.type === 'select') {
                    input = document.createElement('select');
                    for (const [k, label] of f.options) input.appendChild(new Option(label, String(k)));
                    input.addEventListener('change', () => {
                        const opt = f.options.find(([k]) => String(k) === input.value);
                        if (opt) upd(opt[0]);
                    });
                    updaters.set(key, (dec) => { input.value = String(dec.cfg[key]); });

                } else if (f.type === 'bool') {
                    input = createNewElement('input', {
                        type: 'checkbox',
                        onchange: (e) => { upd(e.currentTarget.checked); }
                    });
                    updaters.set(key, (dec) => { input.checked = Boolean(dec.cfg[key]); });

                } else if (f.type === 'js_code_edit') {
                    row.className = 'form-col';
                    input = createNewElement('div', { styles: { width: '100%' } });

                    const codeText = createNewElement('textarea', {
                        styles: { width: '100%', minHeight: '200px', background: '#AAA' },
                        onchange: (e) => upd(e.currentTarget.value)
                    });
                    const compileAndReport = () => {
                        const res = d.compile();
                        if (res !== true) InfoDialog.Show({ title: 'Custom Code Error', message: res });
                    };
                    const codeEditOpenBtn = createNewElement('button', {
                        textContent: 'Open Code Editor',
                        styles: { width: '100%', background: '#494949' },
                        onclick: () => {
                            WS.customDecoderEditor.open({
                                code: codeText.value,
                                onSave: (code) => { upd(code); },
                                onRunDecoder: (code) => { upd(code); compileAndReport(); }
                            });
                        }
                    });
                    const codeRunBtn = createNewElement('button', {
                        textContent: 'run',
                        styles: { width: '100%', background: '#494949' },
                        onclick: () => { upd(codeText.value); compileAndReport(); }
                    });
                    const buttons = createNewElement('div', { className: 'form-row' });
                    buttons.append(codeEditOpenBtn, codeRunBtn);
                    input.append(codeText, buttons);

                    updaters.set(key, (dec) => {
                        const v = String(dec.cfg[key] ?? '');
                        if (!isActive(codeText) && codeText.value !== v) codeText.value = v;
                    });

                }/* else if (f.type === 'subDecoders') {
                    row.className = 'form-col';
                    input = createNewElement('div', { styles: { width: '100%' } });
                    updaters.set(key, (dec) => {
                        renderAnalyzers({ container: input, decoders: store.get().decoders, parent: dec, title: f.label });
                    });

                } */else {
                    input = document.createElement('input');
                    input.title = "Unknown settings type: " + f.type;
                    input.className = 'mono';
                    const commit = () => {
                        const cur = d.cfg[key];
                        const n = Number(input.value);
                        if (isFinite(n) && n > 0 && n !== cur) upd(n); else input.value = String(cur);
                    };
                    input.addEventListener('blur', commit);
                    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
                    updaters.set(key, (dec) => {
                        if (!isActive(input)) input.value = String(dec.cfg[key]);
                    });
                }

                row.appendChild(input);
                form.appendChild(row);
            }
            if (typeof d.getOutput === 'function' && d.getOutput() != null) {
                const row = el('label', 'form-col');
                let input = createNewElement('div', { styles: { width: '100%' } }); 
                updaters.set('__subDecoders', (dec) => {
                    renderAnalyzers({ container: input, decoders: store.get().decoders, parent: d, title: "Sub Decoders" });
                });
                row.appendChild(input);
                form.appendChild(row);
            }
        }

        update(d);
        return { el: card.card, update };
    }

    WS.decoders = WS.decoders ?? {};
    WS.decoders.ui = Object.assign(WS.decoders.ui ?? {}, {
        init,
        renderAnalyzers,
        addDecoderMenu,
    });

})(window.WS = window.WS ?? {});