/**
 * SaleaeImportDialog – importformulär för raw Saleae .bin (digital, en kanal/fil).
 *
 * SaleaeImportDialog.Show({
 *     items: [{ data, name }, ...],      // data: ArrayBuffer | typed array
 *     sampleRate: undefined,             // förifylld (Hz), tom = filens egen (v1)
 *     maxSamples: 1 << 28,
 *     onConfirm: ({ items, sampleRate, maxSamples }) => {}   // direkt till importSaleae()
 * });
 *
 * Antal valbara kanaler = antal filer (0..N-1). Unik kanal per fil krävs.
 */

function saleaeFileVersion(data) {
    const u8 = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (u8.length < 12) return null;
    if (String.fromCharCode(...u8.subarray(0, 8)) !== '<SALEAE>') return null;
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getInt32(8, true);
}

class SaleaeImportDialog extends AppWindow {

    constructor({ title = "Import Saleae .bin", items = [], sampleRate = undefined, maxSamples = 1 << 28, confirmText = "Import", confirmClass = "", onConfirm = (args) => {} } = {}) {
        super({ title, backdrop: true, closeOnBackdropClick: false });
        this.items = items;
        this.onConfirm = onConfirm;
        this.versions = items.map(it => saleaeFileVersion(it.data));
        this.needsRate = this.versions.some(v => v !== 1);

        const n = items.length;
        const rowStyles = { display: 'flex', alignItems: 'center', gap: '8px' };

        let body_el = createNewElement('div', { styles: { width: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: '8px', gap: '8px' } });

        // Sample rate
        let sr_row = createNewElement('div', { styles: rowStyles });
        sr_row.appendChild(createNewElement('div', { innerHTML: 'Sample rate (Hz):', styles: { minWidth: '120px' } }));
        this.sr_el = createNewElement('input', { type: 'number', styles: { flex: '1' } });
        this.sr_el.min = 1;
        this.sr_el.step = 'any';
        this.sr_el.value = sampleRate ?? '';
        this.sr_el.placeholder = this.needsRate ? 'required (v0 files)' : 'empty = from file';
        sr_row.appendChild(this.sr_el);
        body_el.appendChild(sr_row);

        // Max samples
        let max_row = createNewElement('div', { styles: rowStyles });
        max_row.appendChild(createNewElement('div', { innerHTML: 'Max samples:', styles: { minWidth: '120px' } }));
        this.max_el = createNewElement('input', { type: 'number', styles: { flex: '1' } });
        this.max_el.min = 1;
        this.max_el.step = 1;
        this.max_el.value = maxSamples;
        max_row.appendChild(this.max_el);
        body_el.appendChild(max_row);

        // File -> channel mapping
        body_el.appendChild(createNewElement('div', { innerHTML: 'File → channel:', styles: { marginTop: '8px' } }));
        let files_el = createNewElement('div', { styles: { display: 'flex', flexDirection: 'column', gap: '4px', overflowY: 'auto', maxHeight: '300px' } });
        this.ch_els = [];
        items.forEach((it, i) => {
            let row = createNewElement('div', { styles: rowStyles });
            let name_el = createNewElement('div', { styles: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } });
            name_el.textContent = it.name;
            name_el.title = it.name;
            let ver = this.versions[i];
            let ver_el = createNewElement('div', { styles: { opacity: '0.6', fontSize: '0.85em' } });
            ver_el.textContent = ver === null ? 'unknown' : 'v' + ver;

            let sel = createNewElement('select', {});
            for (let c = 0; c < n; c++) {
                let opt = document.createElement('option');
                opt.value = c;
                opt.textContent = c;
                sel.appendChild(opt);
            }
            sel.value = i;
            sel.addEventListener('change', () => this.#validate());
            this.ch_els.push(sel);

            row.appendChild(name_el);
            row.appendChild(ver_el);
            row.appendChild(sel);
            files_el.appendChild(row);
        });
        body_el.appendChild(files_el);

        this.error_el = createNewElement('div', { styles: { display: 'none', color: '#b40000' } });
        body_el.appendChild(this.error_el);

        this.sr_el.addEventListener('input', () => this.#validate());
        this.max_el.addEventListener('input', () => this.#validate());

        this.setBody(body_el);
        this.setFooter(createButtonBar([
            { text: confirmText, className: confirmClass, onClick: () => this.#validateAndConfirm() },
            { text: "Cancel", onClick: () => this.destroy() }
        ]));
    }

    /** Returnerar true eller felmeddelande. */
    #check() {
        const chs = this.ch_els.map(s => +s.value);
        if (new Set(chs).size !== chs.length) return 'Two files are mapped to the same channel.';
        if (this.needsRate && !(+this.sr_el.value > 0)) return 'Sample rate is required for v0/unknown files.';
        if (this.sr_el.value !== '' && !(+this.sr_el.value > 0)) return 'Invalid sample rate.';
        if (!(+this.max_el.value >= 1)) return 'Max samples must be >= 1.';
        return true;
    }

    #validate() {
        const res = this.#check();
        if (res === true) {
            this.error_el.style.display = 'none';
        } else {
            this.error_el.textContent = res;
            this.error_el.style.display = '';
        }
        return res;
    }

    #validateAndConfirm() {
        if (this.#validate() !== true) return;
        this.onConfirm({
            items: this.items.map((it, i) => ({ data: it.data, ch: +this.ch_els[i].value })),
            sampleRate: this.sr_el.value === '' ? undefined : +this.sr_el.value,
            maxSamples: Math.floor(+this.max_el.value)
        });
        this.destroy();
    }

    static Show(p = {}) {
        const rows = Math.min((p.items || []).length, 8);
        new SaleaeImportDialog(p).setStates({ height: 230 + rows * 34, width: 420 }).open();
    }
}

/* Exempel:
const items = await Promise.all([...input.files].map(async f => ({ data: await f.arrayBuffer(), name: f.name })));
SaleaeImportDialog.Show({
    items,
    onConfirm: (args) => {
        const res = importSaleae(args);
        console.log(res.numSamples, res.sampleRate, res.channels);
    }
});
*/
