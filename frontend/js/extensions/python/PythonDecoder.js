/**
 * PythonDecoder.js — the one WebScope decoder type of the Python extension: an instance runs one sigrok
 * protocol decoder (Python) from python_decoders, chosen in its settings. To the rest of WebScope it is
 * a normal decoder: rows(), run(), getOutput(), settings and getState()/setState().
 *
 * Settings: 'decoder' (the decoder package, e.g. 'uart') and per decoder '<name>.ch.<id>' (channels)
 * and '<name>.opt.<id>' (options); only those of the chosen decoder are saved.
 *
 * Decoding happens in the shared worker (pyHost.js), so run() cannot wait for it. run() returns the
 * result of the last job if it was made from the same input (capture or parent result) and settings
 * (the job's key); else it starts a job, unless one with that key is running, and returns no rows.
 * When the job is done the decoder is decoded again (WS.decoders.decode), which now returns the
 * result and runs the decoders stacked on this one. A job's answer is dropped when a newer job was
 * started meanwhile, so an older job never replaces a newer result.
 *
 * Stacking: a PythonDecoder on a PythonDecoder gets its parent's Python output (as in sigrok, e.g.
 * i2c -> eeprom24xx). A CustomDecoder can stack on a PythonDecoder (getOutput(): [{ start, end, data,
 * type? }]), and a PythonDecoder on a CustomDecoder whose output is logic data ({ samples, length,
 * samplerate }, like a capture).
 */
class PythonDecoder extends Decoder {

    static Info = {
        name: 'Python (sigrok)',
        longname: 'Python decoder',
        desc: 'Runs a sigrok protocol decoder (Python) from python_decoders',
        class: PythonDecoder
    };

    static GuiConfigData = {
        decoder: { label: 'Decoder', type: 'select', options: [['', 'Loading…']], default: '' },
    };

    static GetSourceTypes() {
        return ['logic', PythonDecoder.TYPE, CustomDecoder.TYPE];
    }

    /** generation of the jobs, increasing over all instances (the worker skips a superseded job) */
    static #gen = 0;

    /** sigrok annotation class id -> WebScope class (the color), by the words sigrok decoders use */
    static annClass(id) {
        const ANN = window.WS.theme.ANN;
        const s = id.toLowerCase();
        if (/err|invalid|fail|bad|break/.test(s)) return ANN.ERROR;
        if (/warn/.test(s)) return ANN.WARN;
        if (/nack/.test(s)) return ANN.NACK;
        if (/(^|[-_])ack/.test(s)) return ANN.ACK;
        if (/addr|cmd|command|reg/.test(s)) return ANN.ADDRESS;
        if (/start|stop|bit|sync|idle|reset|frame|packet|ctrl|control/.test(s)) return ANN.CONTROL;
        return ANN.DATA;
    }

    #catalog = null;
    #meta = null;         // metadata of a decoder, once loaded: only used while it is the chosen one
    #loadingMeta = null;  // the decoder whose metadata is loading or failed to load
    #fields = null;       // { name, gui }: the settings fields of #meta
    #decoderField = PythonDecoder.GuiConfigData.decoder;
    #result = null;       // { key, gen, rows, python, output, recorded, error, stats }
    #pending = null;      // { key, gen } of the job that is running
    #key = null;          // the key run() computed last: what a current result was made from
    #status = '';         // shown in the summary: 'loading…', 'decoding…'
    #error = null;        // { message, details }: shown as an error row and in the summary
    #toasted = null;      // the last error message shown as a toast

    constructor(p) {
        super(p);
        /** bumped when getCfgGui(), rows() or summary() change: decoderGui updates the card */
        this.guiChanged = new ReactiveValue(0);
        this.setting('decoder').subscribe(() => this.#changed());
        window.WS.python.catalog().then((catalog) => {
            this.#catalog = catalog;
            this.#decoderField = null;
            this.#changed();
        });
    }

    #changed() {
        this.guiChanged.set(this.guiChanged.value + 1);
    }

    /** the metadata of the chosen decoder, null while it is not loaded */
    #current() {
        return this.#meta && this.#meta.name === this.cfg.decoder ? this.#meta : null;
    }

    get name() {
        const meta = this.#current();
        return meta ? `${meta.shortname} (sigrok)` : PythonDecoder.Info.name;
    }

    /** setting key of channel / option `id` of the chosen decoder */
    #chKey(id) { return `${this.cfg.decoder}.ch.${id}`; }
    #optKey(id) { return `${this.cfg.decoder}.opt.${id}`; }

    #channels() {
        const meta = this.#current();
        return meta && meta.inputs.includes('logic') ? [...meta.channels, ...meta.optional_channels] : [];
    }

    /** the setting keys that hold channels (rowslayout and the card read them) */
    get signals() {
        return this.#channels().map((c) => this.#chKey(c.id));
    }

    /* ---------- settings ---------- */

    getCfgGui() {
        if (!this.#decoderField) {
            const parentOutputs = this.#parentOutputs();
            const entries = [...(this.#catalog?.decoders.values() ?? [])]
                .filter((e) => e.name === this.cfg.decoder || !e.meta
                    || e.meta.inputs.some((i) => (parentOutputs ? parentOutputs.includes(i) : i === 'logic')))
                .map((e) => [e.name, e.meta ? `${e.meta.shortname} — ${e.meta.longname}` : `${e.name} (not indexed)`])
                .sort((a, b) => a[1].localeCompare(b[1]));
            const none = entries.length ? '— choose a decoder —' : 'no decoders found';
            this.#decoderField = { label: 'Decoder', type: 'select', options: [['', none], ...entries], default: '' };
        }
        return { decoder: this.#decoderField, ...this.#fieldsFor(this.#current()) };
    }

    /** what a decoder stacked on this one may take: the parent's sigrok outputs, null at the capture */
    #parentOutputs() {
        if (!this.parent) return null;
        if (this.parent instanceof PythonDecoder) return this.parent.#current()?.outputs ?? [];
        return ['logic'];
    }

    #fieldsFor(meta) {
        if (!meta) return {};
        if (this.#fields?.name === meta.name) return this.#fields.gui;
        const gui = {};
        const first = meta.channels.length === 0;   // no required channel: the first optional one gets channel 0
        this.#channels().forEach((c, i) => {
            const required = i < meta.channels.length;
            gui[this.#chKey(c.id)] = {
                label: c.name, desc: c.desc,
                type: required ? 'channel' : 'channel?',
                default: required ? i : (first && i === 0 ? 0 : null),
            };
        });
        for (const o of meta.options) {
            const f = { label: o.desc || o.id, desc: o.id, default: o.default };
            if (o.values?.length) Object.assign(f, { type: 'select', options: o.values.map((v) => [v, String(v)]) });
            else if (typeof o.default === 'number') Object.assign(f, { type: 'number', min: -Infinity });
            else Object.assign(f, { type: 'text' });
            gui[this.#optKey(o.id)] = f;
        }
        // the settings exist with their defaults before a card shows them: run() reads them
        for (const [key, f] of Object.entries(gui)) this.setting(key, f.default);
        this.#fields = { name: meta.name, gui };
        return gui;
    }

    summary(channels) {
        if (!this.cfg.decoder) return 'choose a decoder';
        const name = (i) => (typeof i === 'number' ? (channels[i]?.name ?? `D${i}`) : null);
        const used = this.signals.map((k) => name(this.cfg[k])).filter(Boolean).join(' / ');
        const ms = this.#result?.key === this.#key ? this.#result.stats?.ms : null;
        const time = ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
        const state = this.#error ? `⚠ ${this.#error.message}` : this.#status || time;
        return [used, state].filter(Boolean).join(' · ');
    }

    /* ---------- rows and output ---------- */

    #rowDefs() {
        const meta = this.#current();
        if (!meta) return [];
        const rows = meta.annotation_rows.length
            ? meta.annotation_rows.map(([id, desc, classes]) => ({ id, label: desc, classes }))
            : [{ id: 'ann', label: meta.shortname, classes: meta.annotations.map((_, i) => i) }];
        const inRow = new Set(rows.flatMap((r) => r.classes));
        const rest = meta.annotations.map((_, i) => i).filter((i) => !inRow.has(i));
        if (rest.length) rows.push({ id: '_other', label: 'Other', classes: rest });
        return rows;
    }

    /** The rows that have annotations (all of a decoder's rows would be many: UART has 10), the first
     *  row while there is no result, and the error row when there is an error. */
    rows() {
        const anchor = this.parent ? { anchor: { decoder: this.parent.id }, placement: 'after' } : {};
        const result = this.#result?.key === this.#key ? this.#result : null;
        const out = {};
        this.#rowDefs().forEach((r, i) => {
            if (result ? result.rows[r.id]?.length : i === 0) out[r.id] = { label: r.label, ...anchor };
        });
        if (this.#error) out._error = { label: 'Error', ...anchor };
        return out;
    }

    getOutput() {
        if (!this.#current()?.outputs.length) return null;
        const result = this.#result;
        if (!result || result.key !== this.#key) return [];
        result.output ??= result.python.map(([start, end, data]) =>
            (Array.isArray(data) && typeof data[0] === 'string' ? { type: data[0], data, start, end } : { data, start, end }));
        return result.output;
    }

    /** For a PythonDecoder stacked on this one: the job whose output it gets, null while there is none. */
    pythonInput() {
        const r = this.#result;
        if (!r || r.key !== this.#key) return null;
        return { inst: this.id, gen: r.gen, recorded: r.recorded };
    }

    /* ---------- decoding ---------- */

    /** Sets the error (an error row, the summary), with a toast unless it was the last one shown. */
    #fail(message, details = message) {
        this.#error = { message, details };
        if (this.#toasted !== message) {
            this.#toasted = message;
            window.WS.toast(`${this.name} (${this.id}): ${message}`, details);
        }
        return this.#errorRows();
    }

    #errorRows() {
        const buf = window.WS.capture.getBuffer();
        const end = Math.max(0, (buf?.length ?? 1) - 1);
        const text = this.#error.message;
        return { _error: [{ start: 0, end, class: window.WS.theme.ANN.ERROR, text: [`${this.name}: ${text}`, text, 'Error'] }] };
    }

    /** The input of the job: { key, buf } at the capture / a CustomDecoder, { key, parent } on a PythonDecoder,
     *  { wait: true } while the parent has no result, or { error }. */
    #input(meta) {
        if (this.parent instanceof PythonDecoder) {
            const outputs = this.parent.#current()?.outputs;
            if (!outputs) return { wait: true };
            if (!meta.inputs.some((i) => outputs.includes(i))) {
                return { error: `${meta.shortname} takes ${meta.inputs.join(' / ')}, ${this.parent.name} gives ${outputs.join(' / ') || 'nothing'}` };
            }
            const p = this.parent.pythonInput();
            if (!p) return { wait: true };
            if (!p.recorded) return { error: `${this.parent.name} (${this.parent.id}) failed` };
            return { key: `p${p.inst}@${p.gen}`, parent: { inst: p.inst, gen: p.gen } };
        }
        if (!meta.inputs.includes('logic')) {
            return { error: `${meta.shortname} stacks on a decoder that gives ${meta.inputs.join(' / ')}` };
        }
        const buf = this.getSource();
        if (!buf?.samples || !(buf.length >= 0) || !buf.samplerate) {
            return { error: 'The parent decoder gives no logic data ({ samples, length, samplerate })' };
        }
        return { key: `b${window.WS.python.bufferKey(buf)}`, buf };
    }

    run() {
        const name = this.cfg.decoder;
        this.#key = null;
        if (!name) {
            this.#error = null;
            return {};
        }
        const meta = this.#current();
        if (!meta) {
            this.#loadMetadata(name);
            return this.#error ? this.#errorRows() : {};   // #error: the metadata could not be loaded
        }
        this.#error = null;
        const input = this.#input(meta);
        if (input.error) return this.#fail(input.error);
        if (input.wait) return {};

        const cfg = this.cfg;
        const job = {
            name,
            options: Object.fromEntries(meta.options.map((o) => [o.id, cfg[this.#optKey(o.id)] ?? o.default])),
            bits: this.#channels().map((c) => cfg[this.#chKey(c.id)] ?? -1),
            samplerate: (input.buf ?? window.WS.capture.getBuffer())?.samplerate ?? 0,
            parent: input.parent ?? null,
        };
        const key = `${input.key}|${JSON.stringify(job)}`;
        this.#key = key;
        const result = this.#result;
        if (result?.key === key) {
            if (!result.error) return result.rows;
            return { ...result.rows, ...this.#fail(result.error.message, result.error.details) };
        }
        if (this.#pending?.key !== key) this.#start(key, job, input.buf ?? null);
        return {};
    }

    #start(key, job, buf) {
        const gen = ++PythonDecoder.#gen;
        this.#pending = { key, gen };
        this.#status = window.WS.python.status.value === 'ready' ? 'decoding…' : 'loading Python…';
        this.#changed();
        window.WS.python.decode({ ...job, inst: this.id, gen }, buf).then(
            (res) => this.#done(key, gen, res),
            (e) => this.#done(key, gen, { failed: String(e?.message ?? e) }));
    }

    #done(key, gen, res) {
        if (this.removed || this.#pending?.gen !== gen) return;   // superseded by a newer job
        this.#pending = null;
        this.#status = '';
        if (res.stale) {          // the parent's output changed meanwhile: the parent decodes this one again
            this.#changed();
            return;
        }
        // failed: the job did not run (e.g. no channel chosen); error: decode() raised, the result is partial
        const details = res.failed ?? res.error;
        const error = details ? { message: details.trim().split('\n').at(-1) || 'failed', details } : null;
        this.#result = {
            key, gen, error, stats: res.stats,
            rows: res.anns ? this.#toRows(res.anns) : {},
            python: res.python ?? [], output: null, recorded: !res.failed,
        };
        if (!error) this.#toasted = null;
        if (res.invalid) console.warn(`${this.name} (${this.id}): ${res.invalid} invalid annotations ignored`);
        if (res.stats) console.info(`${this.name} (${this.id}): decoded in ${Math.round(res.stats.ms)} ms, ${res.stats.waits} wait() calls`);
        window.WS.decoders.decode(this.id);   // run() now returns the result (and sets the error)
        this.#changed();
    }

    /** [[start, end, class, texts]] -> { rowId: [annotation] }, each row sorted by start */
    #toRows(anns) {
        const meta = this.#current();
        const rowOf = new Map();
        for (const r of this.#rowDefs()) for (const c of r.classes) if (!rowOf.has(c)) rowOf.set(c, r.id);
        const classes = meta.annotations.map(([id]) => PythonDecoder.annClass(id));
        const rows = {};
        for (const [start, end, c, text] of anns) {
            (rows[rowOf.get(c)] ??= []).push({ start, end, class: classes[c], text });
        }
        for (const list of Object.values(rows)) list.sort((a, b) => a.start - b.start);
        return rows;
    }

    /** Loads the metadata of decoder `name` once; a failure stays until another decoder is chosen. */
    #loadMetadata(name) {
        if (this.#loadingMeta === name) return;
        this.#loadingMeta = name;
        this.#status = 'loading…';
        this.#error = null;
        window.WS.python.metadata(name).then((meta) => {
            if (this.removed || this.cfg.decoder !== name) return;
            this.#meta = meta;
            this.#result = null;
            this.#status = '';
            this.#decoderField = null;   // the choices of the decoders stacked on this one depend on its outputs
            for (const sub of this.subDecoders) if (sub instanceof PythonDecoder) { sub.#decoderField = null; sub.#changed(); }
            this.#fieldsFor(meta);
            window.WS.decoders.decode(this.id);
            this.#changed();
        }, (e) => {
            if (this.removed || this.cfg.decoder !== name) return;
            this.#status = '';
            this.#fail(`cannot load ${name}`, String(e?.message ?? e));
            window.WS.decoders.decode(this.id);
            this.#changed();
        });
    }

    /* ---------- persistence and removal ---------- */

    /** Saves only the settings of the chosen decoder. */
    getState() {
        const state = super.getState();
        const prefix = `${state.cfg.decoder}.`;
        state.cfg = Object.fromEntries(Object.entries(state.cfg).filter(([k]) => k === 'decoder' || k.startsWith(prefix)));
        return state;
    }

    destroy() {
        super.destroy();
        window.WS.python.forget(this.id);
    }
}

window.WS.decoders.registry.push(PythonDecoder.Info);
