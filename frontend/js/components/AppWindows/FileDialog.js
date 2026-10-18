class FileDialog extends AppWindow {

    static FDModes = {
        Open:0,
        Save:1
    };

    static FDSources = {
        Local:0,
        Backend:1
    }
    static FDSourceToString(src) {
        if (src == FileDialog.FDSources.Local) return 'Local';
        else if (src == FileDialog.FDSources.Backend) return 'Backend';
        else return 'unknown';
    }

    #cwd = '';            // virtual path relative to user_data_fs, e.g. "captures/2026"
    #entries = [];
    //#selected = null;     // selected file name
    #selected = new Set();
    #loadToken = 0;
    #overwriteArmed = false;
    #drag = null;

    constructor({
        title = null,
        mode = FileDialog.FDModes.Open,
        multiple = false,         // multiple file selection
        path = '',                // start directory
        fileName = '',            // default name in save mode
        extensions = null,        // e.g. ['.sr', '.json'] - filters files, dirs always shown
        onConfirm = (path) => {}  // receives the virtual path, e.g. "captures/test.sr"
    } = {}) {
        super({
            title: title ?? (mode === FileDialog.FDModes.Open ? 'Open File' : 'Save File'),
            backdrop: true,
            closeOnBackdropClick: false,
        });
        this.multiple = multiple;
        this.fdmode = mode;
        this.extensions = extensions?.map(e => e.toLowerCase()) ?? null;
        this.onConfirm = onConfirm;
        this.#cwd = FileDialog.#normalize(path);

        const body_el = createNewElement('div', {
            styles: {
                width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
                boxSizing: 'border-box', padding: '8px', gap: '6px'
            }
        });

        this.path_el = createNewElement('div', {
            styles: { padding: '4px 8px', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
        });

        this.list_el = createNewElement('div', {
            styles: { flex: '1', minHeight: '0', overflowY: 'auto', border: '1px solid #888', userSelect: 'none' }
        });
        if (this.multiple) {
            this.list_el.addEventListener('mousedown', e => {
                if (e.button !== 0 || e.target !== this.list_el) return;

                this.#drag = {
                    x: e.clientX,
                    y: e.clientY,
                    ctrl: e.ctrlKey || e.metaKey,
                    base: new Set(this.#selected),
                    moved: false,
                    box: null
                };

                e.preventDefault();
            });

            window.addEventListener('mousemove', e => this.#dragMove(e));
            window.addEventListener('mouseup', e => this.#dragEnd(e));

        }

        this.error_el = createNewElement('div', { styles: { display: 'none', color: '#b40000' } });

        body_el.appendChild(this.path_el);
        body_el.appendChild(this.list_el);

        if (mode === FileDialog.FDModes.Save) {
            this.name_el = createNewElement('input', { type: 'text' });
            this.name_el.value = fileName;
            this.name_el.addEventListener('input', () => { this.#overwriteArmed = false; this.#hideError(); });
            this.name_el.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.#confirm();
                }
            });
            body_el.appendChild(this.name_el);
        }

        body_el.appendChild(this.error_el);

        this.setBody(body_el);
        this.setFooter(createButtonBar([
            {
                text: (mode === FileDialog.FDModes.Save ? 'Save Anywhere' : 'Open Any File'),
                className: '',
                onClick: () => this.#openSaveAny()
            },
            {
                text: (mode === FileDialog.FDModes.Save ? 'Save' : 'Open'),
                className: '',
                onClick: () => this.#confirm()
            },
            {
                text: 'Cancel',
                onClick: () => this.destroy()
            }
        ]));

    }

    #dragMove(e) {
        const drag = this.#drag;
        if (!drag) return;

        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;

        // Ignore small mouse movements
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;

        if (!drag.moved) {
            drag.moved = true;

            // Create selection rectangle
            drag.box = createNewElement('div', {
                styles: {
                    position: 'absolute',
                    border: '1px solid rgba(80,140,255,0.9)',
                    background: 'rgba(80,140,255,0.2)',
                    pointerEvents: 'none',
                    zIndex: '10'
                }
            });

            this.list_el.style.position = 'relative';
            this.list_el.appendChild(drag.box);
        }

        const rect = this.list_el.getBoundingClientRect();

        const left = Math.min(drag.x, e.clientX);
        const right = Math.max(drag.x, e.clientX);
        const top = Math.min(drag.y, e.clientY);
        const bottom = Math.max(drag.y, e.clientY);

        // Position selection rectangle relative to list
        Object.assign(drag.box.style, {
            left: `${left - rect.left - this.list_el.clientLeft + this.list_el.scrollLeft}px`,
            top: `${top - rect.top - this.list_el.clientTop + this.list_el.scrollTop}px`,
            width: `${right - left}px`,
            height: `${bottom - top}px`
        });

        // Start with previously selected files (Ctrl selection)
        this.#selected = new Set(drag.ctrl ? drag.base : []);

        // Check which file rows intersect the selection
        for (const row of this.list_el.querySelectorAll('[data-file]')) {
            const r = row.getBoundingClientRect();

            if (
                r.right >= left &&
                r.left <= right &&
                r.bottom >= top &&
                r.top <= bottom
            ) {
                this.#selected.add(row.dataset.file);
            }
        }

        this.#updateSelection();
    }

    #dragEnd(e) {
        const drag = this.#drag;
        if (!drag) return;

        if (drag.box) drag.box.remove();

        // Clicking empty space clears selection
        if (!drag.moved && !drag.ctrl) {
            this.#selected.clear();
            this.#updateSelection();
        }

        this.#drag = null;
    }

    #updateSelection() {
        for (const row of this.list_el.querySelectorAll('[data-file]')) {
            row.style.background = this.#selected.has(row.dataset.file)
                ? 'rgba(80,140,255,0.35)'
                : '';
        }
    }

    // ---------- helpers ----------

    static #normalize(p) {
        return String(p ?? '').split('/').filter(s => s && s !== '.').join('/');
    }

    static #url(path) {
        const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
        return '/api/fs/' + encoded;
    }

    #join(name) {
        return this.#cwd ? this.#cwd + '/' + name : name;
    }

    #matches(name) {
        if (!this.extensions) return true;
        const lower = name.toLowerCase();
        return this.extensions.some(ext => lower.endsWith(ext));
    }

    #showError(msg) {
        this.error_el.textContent = msg;
        this.error_el.style.display = '';
    }

    #hideError() {
        this.error_el.style.display = 'none';
    }

    // ---------- navigation ----------

    async #load(path) {
        const token = ++this.#loadToken;
        try {
            const res = await fetch(FileDialog.#url(path));
            if (!res.ok) throw new Error(`${res.status} ${res.statusText || ''}`.trim());
            const entries = await res.json();
            if (token !== this.#loadToken) return; // a newer navigation won

            this.#cwd = path;
            this.#entries = entries
                .filter(e => e.isDir || this.#matches(e.name))
                .sort((a, b) => (Boolean(b.isDir) - Boolean(a.isDir)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
            this.#selected = new Set();
            this.#overwriteArmed = false;
            this.#hideError();
            this.#render();
        } catch (err) {
            if (token !== this.#loadToken) return;
            this.#showError('Could not read directory: ' + err.message);
        }
    }

    #render() {
        this.path_el.textContent = '/' + this.#cwd;
        this.list_el.replaceChildren();

        if (this.#cwd) {
            this.list_el.appendChild(this.#makeRow('📁', '..', {
                onDblClick: () => this.#load(this.#cwd.split('/').slice(0, -1).join('/'))
            }));
        }

        for (const entry of this.#entries) {
            if (entry.isDir) {
                this.list_el.appendChild(this.#makeRow('📁', entry.name, {
                    onDblClick: () => this.#load(this.#join(entry.name))
                }));
            } else {
                const row = this.#makeRow('📄', entry.name, { size:entry.size,
                    //onClick: () => this.#select(entry.name, row),
                    //onDblClick: () => { this.#select(entry.name, row); this.#confirm(); }
                    onClick: (event) => this.#select(entry.name, row, event),
                    onDblClick: () => {
                        this.#selected.clear();
                        this.#selected.add(entry.name);
                        this.#confirm();
                    }
                });
                row.dataset.file = entry.name;
                this.list_el.appendChild(row);
            }
        }

        if (!this.#entries.length && !this.#cwd) {
            this.list_el.appendChild(createNewElement('div', { innerHTML: 'No files', styles: { padding: '8px', opacity: '0.6' } }));
        }
    }

    #formatFileSize(size) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;

        while (size >= 1024 && i < units.length - 1) {
            size /= 1024;
            i++;
        }

        return `${size.toFixed(i!=0?2:0)} ${units[i]}`;
    }

    #makeRow(icon, name, {size, onClick, onDblClick } = {}) {
        const row = createNewElement('div', {
            styles: { padding: '3px 8px', cursor: 'pointer', display: 'flex', gap: '6px' }
        });
        row.appendChild(createNewElement('span', { innerHTML: icon }));
        row.appendChild(createNewElement('span', { textContent: name }));
        if (size != undefined) {
            row.appendChild(createNewElement('span', { textContent: `(${this.#formatFileSize(size)})` }));
        }
        if (onClick) row.addEventListener('click', onClick);
        if (onDblClick) row.addEventListener('dblclick', onDblClick);
        return row;
    }

    /*#select(name, row) {
        for (const r of this.list_el.children) r.style.background = '';
        row.style.background = 'rgba(80,140,255,0.35)';
        this.#selected = name;
        this.#overwriteArmed = false;
        this.#hideError();
        if (this.fdmode === FileDialog.FDModes.Save) this.name_el.value = name;
    }*/

    /*#select(name, row, event = {}) {
        if (!this.multiple || (!event.ctrlKey && !event.metaKey)) {
            this.#selected.clear();
        }

        if (this.#selected.has(name)) {
            this.#selected.delete(name);
        } else {
            this.#selected.add(name);
        }

        for (const r of this.list_el.children) {
            r.style.background = this.#selected.has(r.dataset.file)
                ? 'rgba(80,140,255,0.35)'
                : '';
        }

        this.#overwriteArmed = false;
        this.#hideError();

        if (this.fdmode === FileDialog.FDModes.Save) {
            this.name_el.value = name;
        }
    }*/

    #select(name, row, event = {}) {
        if (!this.multiple || (!event.ctrlKey && !event.metaKey)) {
            this.#selected.clear();
            this.#selected.add(name);
        } else {
            if (this.#selected.has(name))
                this.#selected.delete(name);
            else
                this.#selected.add(name);
        }

        this.#updateSelection();

        this.#overwriteArmed = false;
        this.#hideError();

        if (this.fdmode === FileDialog.FDModes.Save) {
            this.name_el.value = name;
        }
    }

    #getSaveName() {
        let name = this.name_el.value.trim();
        if (!name) { this.#showError('Enter a file name.'); return null; }
        if (/[\\/]/.test(name) || name === '.' || name === '..') {
            this.#showError('Invalid file name.'); return null;
        }
        if (this.extensions?.length && !this.#matches(name) && !name.includes('.')) {
            name += this.extensions[0];
            this.name_el.value = name;
        }
        return name;
    }

    #openSaveAny() {
        if (this.fdmode === FileDialog.FDModes.Open) {
            SelectFile({filters:this.extensions, multiple:this.multiple, onRead: async(files)=>{
                if (this.multiple) {
                    this.onConfirm({files, source: FileDialog.FDSources.Local});
                } else {
                    this.onConfirm({file:files, source: FileDialog.FDSources.Local});
                }
                
                this.destroy();
            }});
        } else {
            const name = this.#getSaveName();
            if (!name) return;

            this.onConfirm({name, source: FileDialog.FDSources.Local});
            this.destroy();
        }
    }

    // ---------- confirm ----------

    static #extOf(name, extensions) {
        console.log({name, extensions});
        const lower = name.toLowerCase();
        const hit = extensions?.find(e => lower.endsWith(e));
        if (hit) return hit.slice(1);
        const i = lower.lastIndexOf('.');
        return i >= 0 ? lower.slice(i + 1) : '';
    }

    async #confirm() {
        let name;

        if (this.fdmode === FileDialog.FDModes.Open) {
            //name = this.#selected;
            //if (!name) return this.#showError('Select a file first.');
        } else {
            name = this.#getSaveName();
            if (!name) return;

            const exists = this.#entries.some(e => !e.isDir && e.name === name);
            if (exists && !this.#overwriteArmed) {
                this.#overwriteArmed = true;
                return this.#showError(`"${name}" already exists. Press ${this.fdmode === FileDialog.FDModes.Save ? 'Save' : 'OK'} again to overwrite.`);
            }
        }
        const filePath = this.#join(name);
        if (this.fdmode === FileDialog.FDModes.Open) {
            /*try {
                const response = await fetch(FileDialog.#url(filePath));
                if (!response.ok) throw new Error(`${response.status}`);
                const data = await response.arrayBuffer();
                this.onConfirm({ data, name: filePath, ext: FileDialog.#extOf(name, this.extensions), source: FileDialog.FDSources.Backend });
                this.destroy();
            } catch (err) {
                this.#showError('Failed to read file: ' + err.message);
            }*/
            if (!this.#selected.size)
                return this.#showError('Select a file first.');

            try {
                const files = await Promise.all(
                    [...this.#selected].map(async name => {
                        const filePath = this.#join(name);
                        const response = await fetch(FileDialog.#url(filePath));

                        if (!response.ok)
                            throw new Error(`${response.status}`);

                        return {
                            data: await response.arrayBuffer(),
                            name: filePath,
                            ext: FileDialog.#extOf(name, this.extensions)
                        };
                    })
                );
                if (this.multiple) {
                    this.onConfirm({
                        files,
                        source: FileDialog.FDSources.Backend
                    });
                } else {
                    this.onConfirm({
                        file: files[0],
                        source: FileDialog.FDSources.Backend
                    });
                }

                this.destroy();

            } catch (err) {
                this.#showError('Failed to read file: ' + err.message);
            }
        } else {
            this.onConfirm({name:filePath, source: FileDialog.FDSources.Backend});
            this.destroy();
        }

    }

    open() {
        super.open();
        this.#load(this.#cwd);
        (this.name_el ?? this.list_el).focus?.();
    }

    static Show(p = {}) {
        new FileDialog(p).setStates({ height: 700, width: 480 }).open();
    }
}