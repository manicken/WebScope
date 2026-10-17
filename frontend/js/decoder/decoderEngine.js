/**
 * decoderEngine.js — runs decoders over the capture and keeps their results.
 * 
 * annotations/annotationEngine.js.
 */
(function (WS) {
    'use strict';
    const { store } = WS;

    const decodedCache = new Map(); // decoder id -> { anns: Annotation[] }
    const registry = [];

    function addNewDecoder({item, parentDecoder=null}) {
        const decoders = store.get().decoders;
        const id = decoders.reduce((m, d) => Math.max(m, d.id), 0) + 1; // find the last used id and add 1
        const color = WS.theme.DECODER_COLORS[decoders.length % WS.theme.DECODER_COLORS.length];
        const newDec = new item.class({ id, color, parentDecoder });
        if (parentDecoder != null) {
            parentDecoder.addSubDecoder(newDec);
        }
        store.set({ decoders: [...decoders, newDec], table: { decoder: id, row: 0, focus: null } });
        console.log(newDec);
        decode(id);
        return newDec;
    }
/*
    function removeDecoder(id) {
        console.log("removed decoder:" + id);
        const d = store.get().decoders.find((x) => x.id === id);
        if (d) {
            d.destroy();
        }
        const remaining = store.get().decoders.filter((d) => d.id !== id);
        console.log(remaining);
        const table = store.get().table;
        store.set({ decoders: remaining, table: table.decoder === id ? { decoder: remaining[0]?.id ?? null, row: 0, focus: null } : table });
    }*/

    function removeDecoder(id) {
        const all = store.get().decoders;
        const root = all.find((x) => x.id === id);
        if (!root) return;

        // collect the whole branch BEFORE destroy(), which empties subDecoders
        const ids = new Set();
        const collect = (d) => { ids.add(d.id); d.subDecoders.forEach(collect); };
        collect(root);

        root.destroy();   // unlinks from its parent and destroys all descendants

        const remaining = all.filter((x) => !ids.has(x.id));
        const table = store.get().table;
        store.set({
            decoders: remaining,
            table: ids.has(table.decoder) ? { decoder: remaining[0]?.id ?? null, row: 0, focus: null } : table,
        });
    }
    function toggleDecoderVisible(id) {
        const d = store.get().decoders.find((x) => x.id === id);
        if (!d) return;
        d.visible = !d.visible;
        store.set({ decoders: store.get().decoders });
    }
    function updateDecoder(id, patch) {
        const d = store.get().decoders.find((x) => x.id === id);
        if (!d) return;
        d.cfg = { ...d.cfg, ...patch };
        store.set({ decoders: store.get().decoders });
        decode(id);
    }
/*
    function decode(id) {
        //console.log("decode ID:" + id);
        if (!WS.capture.hasData()) return;
        const inst = WS.store.get().decoders.find((d) => d.id === id);
        if (!inst) return;

        let decRes = inst.run(WS.capture.getBuffer());
        //console.log(decRes);
        decodedCache.set(id, decRes);
        
        WS.store.set((s) => ({ status: { ...s.status, decodeGen: s.status.decodeGen + 1 } }));
    }
*/
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

function decode(id) {
    if (!WS.capture.hasData()) return;
    const inst = WS.store.get().decoders.find((d) => d.id === id);
    if (!inst) return;

    decodeBranch(inst, WS.capture.getBuffer());

    // one redraw for the whole branch, not one per decoder
    WS.store.set((s) => ({ status: { ...s.status, decodeGen: s.status.decodeGen + 1 } }));
}
/** new funcitons to be used in the future */
    class DecoderChainError extends Error {}

    const typeOf    = (def) => def.class.TYPE;
    const outTypeOf = (def) => def.class.OUTPUT_TYPE ?? def.class.TYPE;   // what the decoder produces
    const sourcesOf = (def) => def.class.GetSourceTypes?.() ?? ['logic'];
    const isWildcard = (def) => sourcesOf(def).includes('*');
    const pathLabel = (p) => p.map(d => d.name).join(' › ');
    /** does this decoder class implement getOutput (i.e. can other decoders stack on it)? */
    const hasOutput = (cls) => cls.prototype.getOutput !== Decoder.prototype.getOutput;

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
        decode,
        addNewDecoder,
        removeDecoder,
        toggleDecoderVisible, 
        updateDecoder,
        /** Result stored by the decode(id), or undefined. Annotations are in `.anns`. */
        decodedResult(id) { return decodedCache.get(id); }
    });
})(window.WS = window.WS ?? {});
