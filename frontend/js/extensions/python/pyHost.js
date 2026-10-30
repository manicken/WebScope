/**
 * pyHost.js — the main-thread side of the Python extension: the decoder catalog and the one worker
 * (pyWorker.js) that all PythonDecoder instances share. Nothing is loaded until a PythonDecoder asks.
 *
 *   WS.python.catalog()           Promise<{ decoders: Map(name -> { name, folder, meta|null }), roots }>:
 *                                 the decoders of python_decoders/<folder>/, from each folder's
 *                                 index.json and listing (decoders not in an index have meta null)
 *   WS.python.metadata(name)      Promise<meta>: from the index, else the worker imports the decoder
 *   WS.python.decode(job, buf)    Promise<result>: runs a job (buf: the capture, null when stacked);
 *                                 starts the worker (Pyodide) the first time
 *   WS.python.forget(inst)        a PythonDecoder was removed
 *   WS.python.status              ReactiveValue: 'idle' | 'loading' | 'ready' | 'failed'
 *
 * Where the files are (page parameters, like fsapi): ?pyruntime=<Pyodide folder URL>
 * (default python/runtime/pyodide/) and ?pydecoders=<decoder folders URL> (default python/decoders/).
 */
(function (WS) {
    'use strict';

    const FOLDERS = ['user', 'sigrok'];   // a user decoder replaces a sigrok one of the same name
    const MAX_BUFFERS = 2;                // as many captures as the worker keeps

    const here = document.currentScript.src;
    const params = new URLSearchParams(location.search);
    const folderUrl = (param, def) => {
        const url = new URL(params.get(param) ?? def, location.href).href;
        return url.endsWith('/') ? url : url + '/';
    };
    const RUNTIME_URL = folderUrl('pyruntime', 'python/runtime/pyodide/');
    const DECODERS_URL = folderUrl('pydecoders', 'python/decoders/');

    const status = new ReactiveValue('idle');

    async function fetchJson(url) {
        try {
            const r = await fetch(url);
            return r.ok ? await r.json() : null;
        } catch {
            return null;
        }
    }

    let catalogPromise = null;
    function catalog() {
        catalogPromise ??= (async () => {
            const decoders = new Map();
            const roots = [];
            for (const folder of FOLDERS) {
                const url = DECODERS_URL + folder + '/';
                const [index, listing] = await Promise.all([fetchJson(url + 'index.json'), fetchJson(url)]);
                // the listing tells the worker which packages are in which folder (no requests for the others)
                const names = Array.isArray(listing) ? listing.filter((e) => e.isDir).map((e) => e.name) : null;
                roots.push({ url, names });
                for (const meta of index?.decoders ?? []) {
                    if (!decoders.has(meta.name) && (!names || names.includes(meta.name))) decoders.set(meta.name, { name: meta.name, folder, meta });
                }
                for (const name of names ?? []) {
                    if (name !== 'common' && !/^[._]/.test(name) && !decoders.has(name)) decoders.set(name, { name, folder, meta: null });
                }
            }
            return { decoders, roots };
        })();
        return catalogPromise;
    }

    /* ---------- the worker ---------- */
    let worker = null;
    let ready = null;
    let nextId = 1;
    const pending = new Map();   // request id -> { resolve, reject }

    function request(msg, transfer = []) {
        return new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            worker.postMessage({ ...msg, id }, transfer);
        });
    }

    function failAll(error) {
        for (const p of pending.values()) p.reject(error);
        pending.clear();
    }

    /** Starts the worker and Pyodide once; a failure stays (reload the page to try again). */
    function start() {
        ready ??= (async () => {
            status.set('loading');
            const { roots } = await catalog();
            worker = new Worker(new URL('pyWorker.js', here), { type: 'module' });
            worker.onmessage = (e) => {
                const p = pending.get(e.data.id);
                if (!p) return;
                pending.delete(e.data.id);
                if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error));
            };
            worker.onerror = (e) => {
                e.preventDefault?.();
                status.set('failed');
                failAll(new Error(`The Python worker failed: ${e.message ?? 'cannot be started'}`));
            };
            const t0 = performance.now();
            const info = await request({ op: 'init', runtimeUrl: RUNTIME_URL, roots });
            console.info(`Python decoders: Pyodide ${info.version} loaded in ${Math.round(performance.now() - t0)} ms`);
            status.set('ready');
            return info;
        })();
        ready.catch((e) => {
            status.set('failed');
            WS.toast('Python decoders: the Python runtime could not be loaded', `${e.message}\n\nRuntime: ${RUNTIME_URL}`);
        });
        return ready;
    }

    /* ---------- captures: each is copied to the worker once ---------- */
    const bufferIds = new WeakMap();   // capture -> id
    let nextBuffer = 1;
    let sent = [];                     // [{ buf, done: Promise }], what the worker holds, oldest first

    function sendBuffer(buf) {
        const known = sent.find((s) => s.buf === buf);
        if (known) return known.done;
        let id = bufferIds.get(buf);
        if (id == null) bufferIds.set(buf, id = nextBuffer++);
        // the worker gets its own copy (the page keeps drawing from buf.samples); a ring buffer
        // (start != 0) or a plain array (a CustomDecoder's output) is copied sample by sample
        const samples = ArrayBuffer.isView(buf.samples) && !buf.start
            ? buf.samples.slice(0, buf.length)
            : Uint32Array.from({ length: buf.length }, (_, i) => (buf.get ? buf.get(i) : buf.samples[i]));
        const done = request({ op: 'buffer', buffer: id, samples, length: buf.length, samplerate: buf.samplerate }, [samples.buffer]).then(() => id);
        sent = [...sent, { buf, done }].slice(-MAX_BUFFERS);
        return done;
    }

    /** Key of a capture for the decoders' result caches. */
    function bufferKey(buf) {
        let id = bufferIds.get(buf);
        if (id == null) bufferIds.set(buf, id = nextBuffer++);
        return id;
    }

    async function decode(job, buf) {
        await start();
        if (buf) job = { ...job, buffer: await sendBuffer(buf) };
        return request({ op: 'run', job });
    }

    async function metadata(name) {
        const entry = (await catalog()).decoders.get(name);
        if (entry?.meta) return entry.meta;
        await start();
        const meta = await request({ op: 'metadata', name });
        if (entry) entry.meta = meta;
        return meta;
    }

    function forget(inst) {
        if (status.value === 'ready') request({ op: 'forget', inst }).catch(() => {});
    }

    WS.python = { catalog, metadata, decode, forget, bufferKey, status, RUNTIME_URL, DECODERS_URL };
})(window.WS = window.WS ?? {});
