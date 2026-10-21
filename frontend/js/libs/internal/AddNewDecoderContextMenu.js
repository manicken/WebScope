
class AddNewDecoderContextMenu extends ContextMenu {
    #subs = [];
    #hoverTimer = null;

    constructor({ itemClickedCb = () => { console.warn("itemClickedCb not set"); } } = {}) {
        super({ width: 256, height: 400 });
        this.itemClickedCb = itemClickedCb;

        document.addEventListener('pointerdown', (e) => {
            if (!this.#subs.length) return;
            const inside = this.#subs.some((s) => s.contains(e.target)) || this.list_el?.contains(e.target);
            if (!inside) this.#closeSubs(0);
        }, true);
    }

    setItems({ items = [], parentDecoder = null } = {}) {
        this.#closeSubs(0);
        this.parentDecoder = parentDecoder;
        this.registry = items;
        const {canConsume, instanceAccepts} = window.WS.decoders;
        const parentDef = parentDecoder ? { class: parentDecoder.constructor } : null;
        this.direct = items.filter((def) => canConsume(def, parentDef) && instanceAccepts(parentDecoder, def));

        this.searchInput_el = createNewElement("input", {
            type: "search",
            placeholder: "Search...",
            oninput: () => { this.renderItems(); },
            onclick: (e) => { e.stopPropagation(); },
            styles: { width: '100%', marginLeft: '4px', marginRight: '4px', boxSizing: 'border-box' }
        });

        this.list_el = createNewElement("div", {
            styles: {
                flex: '1 1 auto', width: '100%', height: '100%', minWidth: 0, minHeight: 0, maxHeight: '100%',
                overflowX: 'hidden', overflowY: 'auto', boxSizing: 'border-box'
            }
        });

        this.renderItems();
        super.setItems(this.searchInput_el, this.list_el);
    }

    #searchEntries(query) {
        const {allPaths, instanceAccepts, pathLabel} = window.WS.decoders;
        const parentDef = this.parentDecoder ? { class: this.parentDecoder.constructor } : null;
        const words = query.split(/\s+/).filter(Boolean);
        return allPaths(this.registry, parentDef)
            .filter((p) => instanceAccepts(this.parentDecoder, p[0]))
            .map((path) => ({ path, label: pathLabel(path) }))
            .filter((e) => words.every((w) => e.label.toLowerCase().includes(w)))
            .sort((a, b) => a.path.length - b.path.length || a.label.localeCompare(b.label));
    }

    #childrenOf(path) {
        const {hasOutput, isWildcard, canConsume} = window.WS.decoders;
        const def = path.at(-1);
        if (!hasOutput(def.class) || isWildcard(def)) return [];
        return this.registry.filter((c) => !path.includes(c) && canConsume(c, def));
    }

    #closeSubs(fromDepth) {
        while (this.#subs.length > fromDepth) this.#subs.pop().remove();
    }

    #pick(path) {
        this.#closeSubs(0);
        this.itemClickedCb({ path, parentDecoder: this.parentDecoder });
    }

    #entry(path, label, depth, withChildren) {
        const kids = withChildren ? this.#childrenOf(path) : [];
        const row = createNewElement("div", {
            className: "context-menu-item",
            textContent: label,
            onclick: () => this.#pick(path),
            styles: kids.length ? { display: 'flex', alignItems: 'center' } : {}
        });
        if (kids.length) {
            row.appendChild(createNewElement("span", { textContent: '▸', styles: { marginLeft: 'auto', opacity: '0.6' } }));
        }
        if (withChildren) {
            row.addEventListener('mouseenter', () => {
                clearTimeout(this.#hoverTimer);
                this.#hoverTimer = setTimeout(() => {
                    this.#closeSubs(depth);
                    if (kids.length) this.#openSub(row, path, kids, depth);
                }, 120);
            });
        }
        return row;
    }

    #openSub(anchor, path, kids, depth) {
        const sub = createNewElement("div", {
            styles: {
                position: 'fixed', zIndex: '100000', minWidth: '200px', maxHeight: '400px', overflowY: 'auto',
                padding: '4px', boxSizing: 'border-box', background: 'var(--panel-2)',
                border: '1px solid var(--border)', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
            }
        });
        for (const def of kids) sub.appendChild(this.#entry([...path, def], def.name, depth + 1, true));

        sub.addEventListener('mouseenter', () => clearTimeout(this.#hoverTimer));

        document.body.appendChild(sub);
        this.#subs[depth] = sub;

        const r = anchor.getBoundingClientRect(), w = sub.offsetWidth, h = sub.offsetHeight;
        const left = r.right + w + 4 <= innerWidth ? r.right + 2 : Math.max(0, r.left - w - 2);
        const top = Math.max(0, Math.min(r.top - 4, innerHeight - h - 4));
        sub.style.left = left + 'px';
        sub.style.top = top + 'px';
    }

    renderItems() {
        const q = this.searchInput_el.value.trim().toLowerCase();
        this.#closeSubs(0);
        this.list_el.replaceChildren();

        if (q) {
            const entries = this.#searchEntries(q);
            if (!entries.length) {
                this.list_el.appendChild(createNewElement("div", { className: "hint", textContent: "No matches", styles: { padding: '6px 8px' } }));
                return;
            }
            for (const { path, label } of entries) this.list_el.appendChild(this.#entry(path, label, 0, false));
            return;
        }
        for (const def of this.direct) this.list_el.appendChild(this.#entry([def], def.name, 0, true));
    }
}