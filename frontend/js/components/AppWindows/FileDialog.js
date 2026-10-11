class FileDialog extends AppWindow {

    static FDModes = {
        Open:0,
        Save:1
    };

    #cwd = '';            // virtual path relative to user_data_fs, e.g. "captures/2026"
    #entries = [];
    #selected = null;     // selected file name
    #loadToken = 0;
    #overwriteArmed = false;

    constructor({
        title = null,
        mode = FileDialog.FDModes.Open,
        path = '',                // start directory
        fileName = '',            // default name in save mode
        extensions = null,        // e.g. ['.sr', '.json'] - filters files, dirs always shown
        confirmText = null,
        confirmClass = '',
        onConfirm = (path) => {}  // receives the virtual path, e.g. "captures/test.sr"
    } = {}) {
        super({
            title: title ?? (mode === FileDialog.FDModes.Open ? 'Open File' : 'Save File'),
            backdrop: true,
            closeOnBackdropClick: false,
        });

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
                text: confirmText ?? (mode === FileDialog.FDModes.Save ? 'Save Anywhere' : 'Open Any File'),
                className: confirmClass,
                onClick: () => this.#openSaveAny()
            },
            {
                text: confirmText ?? (mode === FileDialog.FDModes.Save ? 'Save' : 'Open'),
                className: confirmClass,
                onClick: () => this.#confirm()
            },
            {
                text: 'Cancel',
                onClick: () => this.destroy()
            }
        ]));

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
            this.#selected = null;
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
                    onClick: () => this.#select(entry.name, row),
                    onDblClick: () => { this.#select(entry.name, row); this.#confirm(); }
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

    

    #select(name, row) {
        for (const r of this.list_el.children) r.style.background = '';
        row.style.background = 'rgba(80,140,255,0.35)';
        this.#selected = name;
        this.#overwriteArmed = false;
        this.#hideError();
        if (this.fdmode === FileDialog.FDModes.Save) this.name_el.value = name;
    }

    #openSaveAny() {
        if (this.fdmode === FileDialog.FDModes.Open) {
            SelectFile({filters:['.ws.zip','.sr','.vcd','.bin'], onRead: async({data, name, ext})=>{
                console.log({data, name, ext});
                this.onConfirm({data, name, ext});
                this.destroy();
            }});
        } else {
            let name = this.name_el.value.trim();
            if (!name) return this.#showError('Enter a file name.');
            if (/[\\/]/.test(name) || name === '.' || name === '..') {
                return this.#showError('Invalid file name.');
            }

            this.onConfirm({name});
            this.destroy();
        }
    }

    // ---------- confirm ----------

    async #confirm() {
        let name;

        if (this.fdmode === FileDialog.FDModes.Open) {
            name = this.#selected;
            if (!name) return this.#showError('Select a file first.');
        } else {
            name = this.name_el.value.trim();
            if (!name) return this.#showError('Enter a file name.');
            if (/[\\/]/.test(name) || name === '.' || name === '..') {
                return this.#showError('Invalid file name.');
            }
            // Add default extension if the user didn't type one.
            if (this.extensions?.length && !this.#matches(name) && !name.includes('.')) {
                name += this.extensions[0];
                this.name_el.value = name;
            }
            const exists = this.#entries.some(e => !e.isDir && e.name === name);
            if (exists && !this.#overwriteArmed) {
                this.#overwriteArmed = true;
                return this.#showError(`"${name}" already exists. Press ${this.fdmode === FileDialog.FDModes.Save ? 'Save' : 'OK'} again to overwrite.`);
            }
        }

        if (this.fdmode === FileDialog.FDModes.Open) {
            const filePath = this.#join(name);
            const response = await fetch('/api/fs/' + filePath);

            if (!response.ok)
                throw new Error(`Failed to read file: ${response.status}`);

            const file = await response.arrayBuffer();

            this.onConfirm({data:file, name:filePath, ext:name.substring(name.lastIndexOf('.')+1)});
        } else {

            this.onConfirm({name:filePath, ext:name.substring(name.lastIndexOf('.')+1)});
        }
        this.destroy();
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