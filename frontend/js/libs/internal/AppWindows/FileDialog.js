class FileDialog extends AppWindow {

    static apiUrlDefault = '/api/fs'
    static apiUrl = FileDialog.apiUrlDefault;

    static FDModes = {
        Open:0,
        Save:1,
        Editor:2
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
    #moving = null;       // names being dragged onto a folder
    #hidden = 0;          // files in this folder that the extensions filter hides
    #canDelete = true;    // from the listing's Allow header: false when the backend runs with --no-delete

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
            title: title ?? (mode === FileDialog.FDModes.Open ? 'Open File' : (mode === FileDialog.FDModes.Save ? 'Save File' : 'File Manager')),
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

        // file management: new folder, rename (F2), delete (Del); drag rows onto a folder (or ..) to move them
        this.newDir_btn = FileDialog.#toolButton('📁 New folder', 'Make a folder here', () => this.#newFolder());
        this.rename_btn = FileDialog.#toolButton('✎ Rename', 'Rename the selected file or folder (F2)', () => this.#rename());
        this.delete_btn = FileDialog.#toolButton('🗑 Delete', '', () => this.#delete());
        const tools_el = createNewElement('div', { styles: { display: 'flex', gap: '6px' } });
        tools_el.append(this.newDir_btn, this.rename_btn, this.delete_btn);

        this.list_el = createNewElement('div', {
            tabIndex: 0,
            styles: { flex: '1', minHeight: '0', overflowY: 'auto', border: '1px solid #888', userSelect: 'none', outline: 'none' }
        });
        this.list_el.addEventListener('keydown', e => {
            const action = { F2: () => this.#rename(), Delete: () => this.#delete() }[e.key];
            if (!action) return;
            e.preventDefault();
            e.stopPropagation();    // Delete also removes the selected marker / selection (window listeners)
            action();
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

        this.error_el = createNewElement('div', { styles: { display: 'none', color: '#b40000', whiteSpace: 'pre-line' } });

        body_el.appendChild(this.path_el);
        body_el.appendChild(tools_el);
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
        if (mode !== FileDialog.FDModes.Editor) {
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
        } else {
            this.setFooter(createButtonBar([
                {
                    text: 'Cancel',
                    onClick: () => this.destroy()
                }
            ]));
        }

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

        // Check which rows intersect the selection
        for (const row of this.list_el.querySelectorAll('[data-name]')) {
            const r = row.getBoundingClientRect();

            if (
                r.right >= left &&
                r.left <= right &&
                r.bottom >= top &&
                r.top <= bottom
            ) {
                this.#selected.add(row.dataset.name);
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
        for (const row of this.list_el.querySelectorAll('[data-name]')) {
            row.style.background = this.#selected.has(row.dataset.name)
                ? 'rgba(80,140,255,0.35)'
                : '';
        }
        const n = this.#selected.size;
        this.rename_btn.disabled = n !== 1;
        this.delete_btn.disabled = !n || !this.#canDelete;
        this.delete_btn.title = this.#canDelete
            ? 'Delete the selected files and empty folders (Del)'
            : 'Deleting is turned off in the backend (--no-delete)';
    }

    // ---------- helpers ----------

    static #normalize(p) {
        return String(p ?? '').split('/').filter(s => s && s !== '.').join('/');
    }

    static #url(path) {
        const encoded = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
        return FileDialog.apiUrl  + '/' + encoded;
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

            // a file server that does not say what it allows is assumed to allow DELETE
            const allow = res.headers.get('Allow');
            this.#canDelete = !allow || /\bDELETE\b/i.test(allow);
            this.#cwd = path;
            this.#hidden = entries.filter(e => !e.isDir && !this.#matches(e.name)).length;
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
            const parent = this.#cwd.split('/').slice(0, -1).join('/');
            const row = this.#makeRow('📁', '..', {
                onDblClick: () => this.#load(parent)
            });
            this.#makeDropTarget(row, parent);
            this.list_el.appendChild(row);
        }

        for (const entry of this.#entries) {
            if (entry.isDir) {
                const row = this.#makeRow('📁', entry.name, {
                    onClick: (event) => this.#select(entry.name, row, event),
                    onDblClick: () => this.#load(this.#join(entry.name))
                });
                row.dataset.name = entry.name;
                this.#makeDraggable(row, entry.name);
                this.#makeDropTarget(row, this.#join(entry.name));
                this.list_el.appendChild(row);
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
                row.dataset.name = entry.name;
                this.#makeDraggable(row, entry.name);
                this.list_el.appendChild(row);
            }
        }

        if (!this.#entries.length && !this.#cwd && !this.#hidden) {
            this.list_el.appendChild(createNewElement('div', { innerHTML: 'No files', styles: { padding: '8px', opacity: '0.6' } }));
        }
        // a folder can look empty and still not be deletable: say that the filter hides files
        if (this.#hidden) {
            const files = this.#hidden === 1 ? '1 other file' : `${this.#hidden} other files`;
            this.list_el.appendChild(createNewElement('div', {
                textContent: `${files} not shown (showing only ${this.extensions.join(', ')})`,
                styles: { padding: '8px', opacity: '0.6', fontStyle: 'italic' }
            }));
        }
        this.#updateSelection();
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

        if (this.fdmode === FileDialog.FDModes.Save && !this.#isDir(name)) {
            this.name_el.value = name;
        }
    }

    #isDir(name) {
        return Boolean(this.#entries.find(e => e.name === name)?.isDir);
    }

    // ---------- file management ----------

    static #toolButton(text, title, onClick) {
        const button = createNewElement('button', { type: 'button', textContent: text, title });
        button.addEventListener('click', onClick);
        return button;
    }

    static #escape(text) {
        return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    static #validName(name) {
        name = name.trim();
        if (!name) return 'Enter a name.';
        if (/[\\/]/.test(name) || name === '.' || name === '..') return 'Invalid name.';
        return true;
    }

    /** One file operation; throws an Error that says what went wrong. MOVE: `destination` is a virtual path. */
    async #request(method, path, what, destination = null) {
        const headers = destination === null ? {} : { Destination: new URL(FileDialog.#url(destination), location.href).href };
        const res = await fetch(FileDialog.#url(path), { method, headers });
        if (res.ok) return;
        const reason = {
            403: 'not allowed',
            404: 'not found',
            405: method === 'DELETE' ? 'deleting is turned off in the backend' : 'not supported by this file server',
            409: method === 'DELETE' ? 'the folder is not empty' : 'it already exists',
            412: 'that name is already taken',
        }[res.status] ?? `${res.status} ${res.statusText}`.trim();
        throw new Error(`${what}: ${reason}`);
    }

    /** `op` on each name in turn, then the folder again with `select` selected; the errors under the list. */
    async #run(names, op, select = []) {
        const errors = [];
        for (const name of names) {
            try {
                await op(name);
            } catch (err) {
                errors.push(err.message);
            }
        }
        await this.#load(this.#cwd);
        this.#selected = new Set(select.filter(n => this.#entries.some(e => e.name === n)));
        this.#updateSelection();
        if (errors.length) this.#showError(errors.join('\n'));
    }

    #newFolder() {
        InputDialog.Show({
            title: 'New folder', message: 'Folder name:', confirmText: 'Create',
            onValidate: FileDialog.#validName,
            onConfirm: (name) => {
                name = name.trim();
                this.#run([name], n => this.#request('MKCOL', this.#join(n), `Could not make "${n}"`), [name]);
            }
        });
    }

    #rename() {
        if (this.#selected.size !== 1) return;
        const [old] = this.#selected;
        InputDialog.Show({
            title: 'Rename', message: `New name for "${FileDialog.#escape(old)}":`, value: old, confirmText: 'Rename',
            onValidate: FileDialog.#validName,
            onConfirm: (name) => {
                name = name.trim();
                if (name === old) return;
                this.#run([old], n => this.#request('MOVE', this.#join(n), `Could not rename "${n}"`, this.#join(name)), [name]);
            }
        });
    }

    #pluralisOfItem(count, nonEmptyEnding = '', empty='') {
        return count === 0 ? empty : (count === 1 ? '1 item' : count + ' items') + nonEmptyEnding;
    }

    async #delete() {
        if (!this.#selected.size || !this.#canDelete) return;
        const names = [...this.#selected];

        // only empty folders can be deleted: say so before asking (the backend still refuses the others itself)
        const full = [];
        for (const name of names.filter(n => this.#isDir(n))) {
            try {
                const res = await fetch(FileDialog.#url(this.#join(name)));
                const entries = await res.json();
                const hidden = entries.filter(e => !e.isDir && !this.#matches(e.name)).length;
                const count = res.ok ? (entries).length : 0;
                if (count) full.push(`"${name}" (${this.#pluralisOfItem(count)} ${(hidden ? 'of ':'') + this.#pluralisOfItem(hidden, ' not shown')})`);
            } catch {}     // unknown: let the backend decide
        }
        if (full.length) {
            
            return this.#showError(`Only empty folders can be deleted, not:\n ${full.join('\n')}.`);
        }

        const dirs = names.filter(n => this.#isDir(n)).length;
        const files = names.length - dirs;
        const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
        const what = [files && plural(files, 'file'), dirs && plural(dirs, 'folder')].filter(Boolean).join(' and ');
        const list = names.slice(0, 5).map(FileDialog.#escape).join(', ') + (names.length > 5 ? ', …' : '');
        ConfirmDialog.Show({
            title: 'Delete', confirmText: 'Delete',
            message: `Delete ${what}?<br><br>${list}<br><br>This cannot be undone.`,
            onConfirm: () => this.#run(names, n => this.#request('DELETE', this.#join(n), `Could not delete "${n}"`))
        });
    }

    #makeDraggable(row, name) {
        row.draggable = true;
        row.addEventListener('dragstart', e => {
            if (!this.#selected.has(name)) {
                this.#selected = new Set([name]);
                this.#updateSelection();
            }
            this.#moving = [...this.#selected];
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', this.#moving.join('\n'));
        });
        row.addEventListener('dragend', () => { this.#moving = null; });
    }

    /** Drop the dragged rows on a folder row to move them into `dir` (a virtual path). */
    #makeDropTarget(row, dir) {
        const over = e => {
            // not a folder onto itself
            if (!this.#moving || this.#moving.some(n => this.#join(n) === dir)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            row.style.outline = '1px dashed rgba(80,140,255,0.9)';
        };
        row.addEventListener('dragenter', over);
        row.addEventListener('dragover', over);
        row.addEventListener('dragleave', () => { row.style.outline = ''; });
        row.addEventListener('drop', e => {
            e.preventDefault();
            row.style.outline = '';
            const names = this.#moving;
            this.#moving = null;
            if (!names) return;
            const into = (n) => dir ? dir + '/' + n : n;
            this.#run(names, n => this.#request('MOVE', this.#join(n), `Could not move "${n}"`, into(n)));
        });
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
        if (this.fdmode === FileDialog.FDModes.Editor) return;   // nothing to open or save

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
            const names = [...this.#selected].filter(n => !this.#isDir(n));    // folders open with a double click
            if (!names.length)
                return this.#showError('Select a file first.');

            try {
                const files = await Promise.all(
                    names.map(async name => {
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
{
const params = new URLSearchParams(location.search);
FileDialog.apiUrl = params.get('fsapi') ?? FileDialog.apiUrlDefault;
}