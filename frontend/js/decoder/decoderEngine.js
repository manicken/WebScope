/**
 * decoderEngine.js — the list of decoder instances, running them over the capture and keeping their results.
 *
 *   WS.decoders.list      ReactiveValue<Decoder[]>, replaced when a decoder is added or removed
 *   WS.decoders.revision  bumped after decoders ran, so the waveform, the layout and the data table update
 *
 * A decoder is re-run when one of its settings changes (decoder.settingsChanged), and all decoders
 * are re-run when there is new complete capture data (WS.capture.buffer).
 * Annotation queries are in annotations/annotationEngine.js.
 */
(function (WS) {
    'use strict';
    const { appState } = WS;

    const decodedCache = new Map(); // decoder id -> { anns: Annotation[] }
    const registry = [];

    const list = new ReactiveValue([]);
    const revision = new ReactiveValue(0);
    const find = (id) => list.value.find((d) => d.id === id);

    /** Re-run the decoder whenever the user changes one of its settings. */
    function watchSettings(decoder) {
        decoder.settingsChanged.subscribe(() => decode(decoder.id));
    }

    function showInTable(id) {
        appState.table.rowId.set(null);
        appState.table.focus.set(null);
        appState.table.decoder.set(id);
    }

    function addNewDecoder({item, parentDecoder=null}) {
        const decoders = list.value;
        const id = decoders.reduce((m, d) => Math.max(m, d.id), 0) + 1; // find the last used id and add 1
        const color = WS.theme.DECODER_COLORS[decoders.length % WS.theme.DECODER_COLORS.length];
        const newDec = new item.class({ id, color, parentDecoder });
        if (parentDecoder != null) {
            parentDecoder.addSubDecoder(newDec);
        }
        watchSettings(newDec);
        list.set([...decoders, newDec]);
        showInTable(id);
        decode(id);
        return newDec;
    }

    /** Replaces all decoders (project load). The decoders' parent/subDecoders must already be linked. */
    function setDecoders(decoders) {
        list.value.forEach((d) => { d.removed = true; });
        decodedCache.clear();
        decoders.forEach(watchSettings);
        list.set(decoders);
        showInTable(decoders[0]?.id ?? null);
        decodeAll();
    }

    function removeDecoder(id) {
        const all = list.value;
        const root = all.find((x) => x.id === id);
        if (!root) return;

        // collect the whole branch BEFORE destroy(), which empties subDecoders
        const ids = new Set();
        const collect = (d) => { ids.add(d.id); d.subDecoders.forEach(collect); };
        collect(root);

        root.destroy();   // unlinks from its parent and destroys all descendants
        ids.forEach((x) => decodedCache.delete(x));

        const remaining = all.filter((x) => !ids.has(x.id));
        list.set(remaining);
        if (ids.has(appState.table.decoder.value)) showInTable(remaining[0]?.id ?? null);
    }

    function toggleDecoderVisible(id) {
        const d = find(id);
        if (d) d.visible.set(!d.visible.value);
    }

    function bumpRevision() {
        revision.set(revision.value + 1);
    }

    function decodeOne(inst, buf) {
        try {
            decodedCache.set(inst.id, inst.run(buf));
        } catch (e) {
            // e.g. getSource() throwing because the parent produced nothing: drop stale output, keep going
            console.warn(`decode failed: ${inst.name} (${inst.id})`, e);
            decodedCache.delete(inst.id);
        }
    }

    function decodeBranch(inst, buf) {
        decodeOne(inst, buf);                                   // parent first, so children read fresh getOutput()
        for (const sub of inst.subDecoders) decodeBranch(sub, buf);
    }

    /** The buffer to decode: only complete data, not a capture that is still streaming in. */
    function decodableBuffer() {
        const buf = WS.capture.getBuffer();
        return buf?.complete ? buf : null;
    }

    /** Runs a decoder and its sub-decoders. Without (complete) data only the revision is bumped (rows may have changed). */
    function decode(id) {
        const inst = find(id);
        if (!inst) return;
        const buf = decodableBuffer();
        if (buf) decodeBranch(inst, buf);
        bumpRevision(); // one redraw for the whole branch, not one per decoder
    }

    /** Runs every decoder, e.g. after a new capture. While a capture streams in, the old results are dropped. */
    function decodeAll() {
        const buf = decodableBuffer();
        if (buf) {
            for (const d of list.value) if (!d.parent) decodeBranch(d, buf);
        } else {
            decodedCache.clear();
        }
        bumpRevision();
    }

    WS.capture.buffer.subscribe(decodeAll);

/** new funcitons to be used in the future */
    class DecoderChainError extends Error {}

    const typeOf    = (def) => def.class.TYPE;
    const outTypeOf = (def) => def.class.OUTPUT_TYPE ?? def.class.TYPE;   // what the decoder produces
    const sourcesOf = (def) => def.class.GetSourceTypes?.() ?? ['logic'];
    const isWildcard = (def) => sourcesOf(def).includes('*');
    const pathLabel = (p) => p.map(d => d.name).join(' › ');
    /** does this decoder class implement getOutput (i.e. can other decoders stack on it)? */
    const hasOutput = (cls) => typeof cls.prototype.getOutput === 'function';

    /** CustomDecoder instances can restrict which TYPEs may be stacked on them (default ['*']) */
    function instanceAccepts(parentDecoder, def) {
        const accepted = parentDecoder?.GetSourceTypes?.();
        return !accepted || accepted.includes('*') || accepted.includes(typeOf(def));
    }

    function canConsume(child, parent) {              // parent: registry entry, or null for the raw capture
        if (!parent) return sourcesOf(child).includes('logic') || isWildcard(child);
        if (!hasOutput(parent.class)) return false;
        if (isWildcard(child) && isWildcard(parent)) return false;          // no CD on CD
        return isWildcard(child) || sourcesOf(child).includes(outTypeOf(parent));
    }

    function allPaths(registry, startDef = null) {
        const out = [];
        const walk = (path, parentDef) => {
            for (const def of registry) {
                if (path.includes(def) || !canConsume(def, parentDef)) continue;   // no cycles
                const p = [...path, def];
                out.push(p);
                if (hasOutput(def.class) && !isWildcard(def)) walk(p, def);        // CD is always a leaf
            }
        };
        walk([], startDef);
        return out;
    }
    function addChain(path, { parentDecoder = null, registry = WS.decoders.registry } = {}) {
    const defs = path.map((type) => {
        const def = registry.find((d) => typeOf(d) === type);
        if (!def) throw new DecoderChainError(`Unknown decoder type "${type}"`);
        return def;
    });

    const startDef = parentDecoder ? { class: parentDecoder.constructor } : null;
    defs.forEach((def, i) => {
        const parent = i ? defs[i - 1] : startDef;
        if (!canConsume(def, parent)) {
            throw new DecoderChainError(`"${typeOf(def)}" cannot be stacked on ${parent ? `"${typeOf(parent)}"` : 'the capture'} (step ${i + 1})`);
        }
        if (i === 0 && !instanceAccepts(parentDecoder, def)) {
            throw new DecoderChainError(`The parent does not accept "${typeOf(def)}"`);
        }
    });

    const created = [];
    try {
        let parent = parentDecoder;
        for (const def of defs) {
            parent = addNewDecoder({ item: def, parentDecoder:parent });
            if (!parent) throw new DecoderChainError(`Creating "${typeOf(def)}" failed`);
            created.push(parent);
        }
    } catch (e) {
        if (created.length) removeDecoder(created[0].id);   // the existing parent is never touched
        throw e;
    }
    return created.at(-1);
}

    WS.decoders = Object.assign(WS.decoders ?? {}, {
        registry,
        addChain,
        canConsume,
        typeOf,
        pathLabel,
        hasOutput,
        isWildcard,
        allPaths,
        instanceAccepts,
        list,
        revision,
        find,
        decode,
        decodeAll,
        addNewDecoder,
        setDecoders,
        removeDecoder,
        toggleDecoderVisible,
        /** Result stored by the decode(id), or undefined. Annotations are in `.anns`. */
        decodedResult(id) { return decodedCache.get(id); }
    });
})(window.WS = window.WS ?? {});
