/**
 * DeviceSettingsDialog.js — the window for the selected device: what it is (name, channels, samplerates,
 * description, and the driver's own `details`), then its settings when it has any, drawn from the description
 * in its device info (`device.settings`, the format is in backend/deviceSettings.js).
 *
 * Save hands the values to the device's source: device.sourceKind.applySettings(device, values) ->
 * Promise<{ message }>, which updates the device (WS.sources.updateDevice) when it worked and rejects with the
 * reason when it did not. Settings with `disabled: 'reason'` are shown grayed out with the reason, without Save.
 *
 *   DeviceSettingsDialog.Show({ device });
 */
class DeviceSettingsDialog extends AppWindow {

    #device;
    #inputs = new Map();    // key -> { field, input }
    #status_el;
    #footer_el;

    constructor({ device }) {
        const s = device.settings;
        super({ title: s?.title ?? device.name, backdrop: true, closeOnBackdropClick: false, resizable: true });
        this.#device = device;
        const editable = s && !s.disabled;

        const body_el = createNewElement('div', { className: 'ds-form' });
        DeviceSettingsDialog.#infoSection(body_el, device);

        if (s) {
            appendNewElement(body_el, 'div', { className: 'ds-heading', textContent: 'Settings' });
            if (s.disabled) appendNewElement(body_el, 'div', { className: 'ds-disabled', textContent: s.disabled });
            if (s.note) appendNewElement(body_el, 'div', { className: 'ds-note', textContent: s.note });

            for (const field of s.fields) {
                if (field.type === 'heading') {
                    appendNewElement(body_el, 'div', { className: 'ds-heading', textContent: field.label });
                    continue;
                }
                const input = DeviceSettingsDialog.#makeInput(field, s.values?.[field.key]);
                input.id = `ds-${field.key}`;
                input.disabled = !editable;
                const label_el = appendNewElement(body_el, 'label', { className: 'ds-label', textContent: field.label, htmlFor: input.id });
                const cell_el = appendNewElement(body_el, 'div', { className: 'ds-cell' });
                cell_el.appendChild(input);
                if (field.help) appendNewElement(cell_el, 'div', { className: 'ds-help', textContent: field.help });
                if (field.type === 'checkbox') label_el.classList.add('ds-label-check');
                if (!editable) label_el.classList.add('ds-label-disabled');
                this.#inputs.set(field.key, { field, input });
            }
        }
        this.#status_el = appendNewElement(body_el, 'div', { className: 'ds-status' });

        body_el.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') return;                     // closes the window
            e.stopPropagation();                                // keep typing away from global shortcuts
            if (editable && e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); this.#save(); }
        });

        this.setBody(body_el);
        this.#footer_el = createButtonBar(editable
            ? [{ text: 'Save', className: 'primary', onClick: () => this.#save() }, { text: 'Cancel', onClick: () => this.destroy() }]
            : [{ text: 'Close', onClick: () => this.destroy() }]);
        this.setFooter(this.#footer_el);
    }

    /** Name, channels, samplerates, description, and the driver's details. */
    static #infoSection(body_el, device) {
        const { fmtRate } = WS.format;
        const rates = device.samplerates ?? [];
        const rows = [
            ['Name', device.name],
            ['Channels', String(device.channels?.length ?? 0)],
            ...(rates.length ? [['Samplerates', rates.length === 1 ? fmtRate(rates[0]) : `${fmtRate(Math.min(...rates))} – ${fmtRate(Math.max(...rates))}`]] : []),
            ...(device.details ?? []).map((d) => [d.label, d.value]),
            ...(device.note ? [['Description', device.note]] : []),
        ];
        appendNewElement(body_el, 'div', { className: 'ds-heading', textContent: 'Device' });
        for (const [label, value] of rows) {
            appendNewElement(body_el, 'div', { className: 'ds-label ds-info-label', textContent: label });
            appendNewElement(body_el, 'div', { className: 'ds-info', textContent: String(value) });
        }
    }

    static #makeInput(field, value) {
        switch (field.type) {
            case 'checkbox':
                return createNewElement('input', { type: 'checkbox', checked: !!value });
            case 'select': {
                const sel = createNewElement('select');
                field.options.forEach((o, i) => appendNewElement(sel, 'option', { value: String(i), textContent: o.label ?? String(o.value) }));
                sel.value = String(Math.max(0, field.options.findIndex((o) => o.value === value)));
                return sel;
            }
            case 'number': {
                const inp = createNewElement('input', { type: 'number', value: value ?? '' });
                if (field.min !== undefined) inp.min = field.min;
                if (field.max !== undefined) inp.max = field.max;
                inp.step = field.step ?? (field.integer ? 1 : 'any');
                return inp;
            }
            default: {                                          // text, password
                const inp = createNewElement('input', { type: field.type === 'password' ? 'password' : 'text', value: value ?? '' });
                if (field.maxLength !== undefined) inp.maxLength = field.maxLength;
                return inp;
            }
        }
    }

    /** The form's values, typed as the fields say (a select gives its option's own value, e.g. a number). */
    #read() {
        const values = {};
        for (const [key, { field, input }] of this.#inputs) {
            if (field.type === 'checkbox') values[key] = input.checked;
            else if (field.type === 'select') values[key] = field.options[Number(input.value)]?.value;
            else if (field.type === 'number') values[key] = input.value.trim() === '' ? NaN : Number(input.value);
            else values[key] = input.value;
        }
        return values;
    }

    /** The first problem with the values, as text, or null. The same rules as validateSettings() in backend/deviceSettings.js. */
    static validate(fields, values) {
        for (const f of fields) {
            if (!f.key) continue;
            const v = values[f.key];
            if (f.type === 'number') {
                if (!Number.isFinite(v)) return `${f.label}: must be a number`;
                if (f.integer && !Number.isInteger(v)) return `${f.label}: must be a whole number`;
                if (f.min !== undefined && v < f.min) return `${f.label}: must be at least ${f.min}`;
                if (f.max !== undefined && v > f.max) return `${f.label}: must be at most ${f.max}`;
            } else if (f.type === 'text' || f.type === 'password') {
                if (f.minLength !== undefined && v.length < f.minLength) return `${f.label}: ${f.minLength === 1 ? 'is needed' : `at least ${f.minLength} characters`}`;
                if (f.maxLength !== undefined && v.length > f.maxLength) return `${f.label}: at most ${f.maxLength} characters`;
                if (f.pattern !== undefined && !new RegExp(`^(?:${f.pattern})$`).test(v)) return `${f.label}: ${f.patternHint ?? 'wrong format'}`;
            }
        }
        return null;
    }

    #setStatus(text, error = false) {
        this.#status_el.textContent = text;
        this.#status_el.classList.toggle('ds-error', error);
    }

    async #save() {
        const values = this.#read();
        const problem = DeviceSettingsDialog.validate(this.#device.settings.fields, values);
        if (problem) { this.#setStatus(problem, true); return; }

        const buttons = [...this.#footer_el.querySelectorAll('button')];
        buttons.forEach((b) => (b.disabled = true));
        this.#setStatus('Saving…');
        try {
            const res = await this.#device.sourceKind.applySettings(this.#device, values);
            this.destroy();
            if (res?.message) WS.toast(res.message);
        } catch (e) {
            this.#setStatus(e.message ?? String(e), true);
            buttons.forEach((b) => (b.disabled = false));
        }
    }

    open() {
        super.open();
        const first = this.#inputs.values().next().value?.input;
        if (first && !first.disabled) first.focus();
        return this;
    }

    static Show({ device }) {
        if (!device) return;
        const rows = 4 + (device.details?.length ?? 0) + (device.settings ? 2 + device.settings.fields.length : 0);
        const height = Math.min(innerHeight - 40, 140 + 32 * rows);
        new DeviceSettingsDialog({ device }).setStates({ width: 440, height }).open();
    }
}
