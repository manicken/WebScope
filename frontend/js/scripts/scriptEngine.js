/**
 * scripts/scriptEngine.js — the project's scripts: JavaScript the user writes to export (or otherwise use)
 * the capture and the decoders' results. A script is saved with the project (scripts/<name>.js in the
 * project file) and only runs when the user runs it (WS.scripts.run), never by itself, e.g. when a
 * project is loaded: it has the same access to the page as WebScope itself.
 *
 * A script is an object with a run(ws) function (it may be async):
 *   ({
 *       run(ws) {
 *           const uart = ws.decoders.find((d) => d.type === 'UART');
 *           ws.save('uart.bin', Uint8Array.from(uart.output, (f) => f.value));
 *       }
 *   })
 * `ws` is the script API below (makeApi): a small, stable view of WebScope, so scripts do not depend
 * on its internals.
 */
(function (WS) {
    'use strict';
    const { appState } = WS;

    /** [{ name, code, running?, output? }]: the project's scripts, in the order they are listed. Only name and
     *  code are saved; running and output (the lines of the last run, [{ text, error }]) are not. */
    const list = new ReactiveValue([]);
    const changed = () => list.set([...list.value]);

    const NEW_SCRIPT = `({
    /** Runs when you press Run. ws: the capture, the decoders and save(), see README "Scripts". */
    run(ws) {
        // e.g. every decoder's annotations as CSV
        const rows = [['decoder', 'row', 'start (s)', 'end (s)', 'text']];
        for (const d of ws.decoders) {
            for (const [row, anns] of Object.entries(d.annotations)) {
                for (const a of anns) rows.push([d.name, row, a.startTime, a.endTime, a.text]);
            }
        }
        ws.log(\`\${rows.length - 1} annotations\`);
        ws.save('annotations.csv', ws.csv(rows));
    },
})
`;

    const find = (name) => list.value.find((s) => s.name === name);

    /** A name that is not used yet: base, base_1, base_2, ... (without and then with ".js"). */
    function freeName(base = 'script') {
        base = base.replace(/\.js$/i, '');
        let name = base + '.js';
        for (let i = 1; find(name); i++) name = `${base}_${i}.js`;
        return name;
    }

    /** Checks a script name: true, or why it cannot be used. */
    function validateName(name, current = null) {
        if (!/^[\w\- .]+\.js$/i.test(name)) return 'Use letters, digits, "-", "_", "." and " ", ending with .js';
        if (name !== current && find(name)) return `There is already a script called ${name}`;
        return true;
    }

    function add(name = freeName(), code = NEW_SCRIPT) {
        const script = { name, code };
        list.set([...list.value, script]);
        return script;
    }

    function update(name, code) {
        const s = find(name);
        if (s && s.code !== code) { s.code = code; changed(); }
    }

    function rename(name, newName) {
        const s = find(name);
        if (s && name !== newName) { s.name = newName; changed(); }
    }

    function remove(name) {
        list.set(list.value.filter((s) => s.name !== name));
    }

    /* ============================== the script API ============================== */

    /** Bytes of what a script saves: text, bytes (any typed array / ArrayBuffer), or anything else as JSON. */
    function toBytes(data) {
        if (data instanceof Uint8Array) return data;
        if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        return new TextEncoder().encode(text);
    }

    /** CSV text: values with a comma, quote or line break are quoted. */
    function csv(rows, sep = ',') {
        const cell = (v) => {
            const t = v == null ? '' : String(v);
            return /[",\r\n]/.test(t) || t.includes(sep) ? `"${t.replace(/"/g, '""')}"` : t;
        };
        return rows.map((r) => r.map(cell).join(sep)).join('\r\n') + '\r\n';
    }

    const hex = (bytes, sep = ' ') => Array.from(bytes, (b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(sep);

    /** The `ws` object a script gets. log(text) shows a line in the script editor's output. */
    /** track(promise): an operation the script started (save); run() waits for these before "done". */
    function makeApi(log, track = (p) => p) {
        const buf = WS.capture.getBuffer();
        const time = (i) => (buf ? (i - buf.timeOrigin) / buf.samplerate : null);   // seconds, 0 = trigger / first sample

        const capture = buf && {
            samplerate: buf.samplerate,
            length: buf.length,
            trigger: buf.trigger,
            /** The channels: { index, name, captured } (captured: the capture holds its data). */
            channels: appState.channels.value.map((ch) => ({ index: ch.index, name: ch.name.value, captured: buf.has(ch.index) })),
            /** Sample i: bit n = channel n. */
            sample: (i) => buf.get(i),
            /** Level (0 / 1) of channel ch at sample i. */
            bit: (i, ch) => (buf.get(i) >>> ch) & 1,
            /** The edges of channel ch in [from, to]: { pos: [sample...], rising: [1 | 0...] }. */
            edges: (ch, from = 0, to = buf.length - 1) => WS.capture.edges(ch, from, to),
            /** Samples [from, from + count) as a Uint32Array (bit n = channel n). */
            samples: (from = 0, count = buf.length - from) => buf.rawSlice(from, count).data,
            time,
        };

        const decoders = WS.decoders.list.value.map((d) => {
            const result = WS.decoders.decodedResult(d.id) ?? {};
            const annotations = {};
            for (const [row, anns] of Object.entries(result)) {
                if (!Array.isArray(anns)) continue;
                annotations[row] = anns.map((a) => ({ start: a.start, end: a.end, startTime: time(a.start), endTime: time(a.end), text: a.text ?? '' }));
            }
            return {
                id: d.id,
                name: d.name,
                type: d.constructor.Info?.name ?? d.name,
                settings: d.cfg,
                /** { rowId: [{ start, end, startTime, endTime, text }] }, start / end in samples. */
                annotations,
                /** What the decoder hands to the decoders stacked on it (UART: its frames, ...), or null. */
                output: typeof d.getOutput === 'function' ? d.getOutput() : null,
                parent: d.parent?.id ?? null,
            };
        });

        // the selected time range, else the whole capture
        const { selections } = appState;
        const sel = selections.list.value.find((s) => s.id === selections.selected.value);
        const range = sel ? { start: sel.start, end: sel.end, selected: true }
            : { start: 0, end: Math.max(0, (buf?.length ?? 1) - 1), selected: false };

        /** Asks where to save (local download / the backend's files) and saves; resolves when saved, or
         *  with false when the user cancels. The script does not have to await it: run() waits for it. */
        function save(name, data) {
            const ext = name.match(/\.[^.]+$/)?.[0];
            return track(new Promise((resolve, reject) => {
                const dialog = new FileDialog({
                    mode: FileDialog.FDModes.Save, fileName: name, extensions: ext ? [ext] : null,
                    onConfirm: async ({ name: chosen, source }) => {
                        try { await saveToLocation({ name: chosen, data: toBytes(data), location: source }); log(`saved ${chosen}`); resolve(true); }
                        catch (err) { reject(err); }
                    },
                });
                // closed without saving (a confirm destroys the dialog instead of closing it)
                dialog.onClose = () => { log(`${name} not saved`); resolve(false); };
                dialog.setStates({ height: 700, width: 480 }).open();
            }));
        }

        return Object.freeze({
            capture, decoders, range, save, csv, hex,
            log: (...args) => log(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')),
            show: (p) => AceEditor.show(p),
        });
    }

    /**
     * Runs a script (only on the user's request): its output and errors go to the Messages panel (errors
     * are also shown) and to script.output (the script editor shows it). Resolves with true when it ran
     * without an error; a script that is running is not started again.
     */
    async function run(script) {
        if (script.running) return false;
        script.running = true;
        script.output = [];
        const log = (text, error = false) => {
            script.output.push({ text, error });
            (error ? WS.toast : WS.logMessage)(`${script.name}: ${text}`);
            changed();
        };
        // what the script started through ws (saves) and did not await: waited for before "done",
        // their errors are the script's errors (and never unhandled rejections)
        const pending = [];
        const track = (p) => { pending.push(p); p.catch(() => {}); return p; };
        try {
            const obj = new Function(`"use strict"; return (${script.code}\n)`)();
            if (typeof obj?.run !== 'function') throw new TypeError('A script must be an object with a run(ws) function');
            //log('running');
            await obj.run(makeApi((t) => log(t), track));
            while (pending.length) await Promise.all(pending.splice(0));   // also ones started by a finished one
            //log('done');
            return true;
        } catch (err) {
            log(String(err?.message ?? err), true);
            console.error(err);
            return false;
        } finally {
            script.running = false;
            changed();
        }
    }

    WS.scripts = { list, add, update, rename, remove, run, freeName, validateName, find };
})(window.WS = window.WS || {});
