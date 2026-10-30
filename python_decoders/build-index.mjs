// build-index.mjs — writes index.json (the metadata of every decoder) into a decoder folder, so
// WebScope can list the decoders and show their channels and options without downloading them all.
//
//   node python_decoders/build-index.mjs            both folders (sigrok and user)
//   node python_decoders/build-index.mjs user       one folder
//
// It imports every decoder with the same code WebScope uses (frontend/js/extensions/python and the
// Pyodide in python_runtime), so no local Python is needed. A decoder that cannot be imported is
// listed in index.json's "errors". Decoders that are not in index.json are still found by WebScope
// (from the folder listing), they are only imported when chosen.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const EXT = fileURLToPath(new URL('../frontend/js/extensions/python/', import.meta.url));
const RUNTIME = fileURLToPath(new URL('../python_runtime/pyodide/', import.meta.url));
const FOLDERS = ['user', 'sigrok'];   // import order: a user decoder replaces a sigrok one of the same name

/** The decoder packages of a folder: sub folders with an __init__.py, except the helper package `common`. */
export function decoderNames(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'common' && !e.name.startsWith('.') && !e.name.startsWith('_')
            && existsSync(`${dir}/${e.name}/__init__.py`))
        .map((e) => e.name)
        .sort();
}

async function main(which) {
    vm.runInThisContext(readFileSync(`${EXT}pyWorker.js`, 'utf8'), { filename: 'pyWorker.js' });
    const { loadPyodide } = await import(pathToFileURL(`${RUNTIME}pyodide.mjs`).href);

    for (const folder of which) {
        // a fresh runtime per folder: the folder's own decoders first, then the sigrok helpers (common.*)
        const roots = [folder, ...(folder === 'sigrok' ? [] : ['sigrok'])].map((f) => ({ url: `local://${f}/`, dir: `${HERE}${f}/` }));
        const fetchText = (url) => {
            const root = roots.find((r) => url.startsWith(r.url));
            const path = root && root.dir + url.slice(root.url.length);
            return path && existsSync(path) ? readFileSync(path, 'utf8') : null;
        };
        const core = new globalThis.WSPy.SrdCore({
            loadPyodide, runtimeUrl: RUNTIME, fetchText,
            sources: {
                'sigrokdecode.py': readFileSync(`${EXT}sigrokdecode.py`, 'utf8'),
                'ws_srd_runner.py': readFileSync(`${EXT}ws_srd_runner.py`, 'utf8'),
            },
        });
        await core.init(roots.map((r) => ({ url: r.url, names: null })));

        const dir = `${HERE}${folder}`;
        const names = decoderNames(dir);
        const { decoders, errors } = core.scan(names);
        const version = existsSync(`${dir}/VERSION`) ? readFileSync(`${dir}/VERSION`, 'utf8').trim() : null;
        writeFileSync(`${dir}/index.json`, JSON.stringify({ version, decoders, errors }, null, 1) + '\n');
        console.log(`${folder}: ${decoders.length} decoders indexed, ${Object.keys(errors).length} failed`);
        for (const [name, text] of Object.entries(errors)) console.log(`  ${name}: ${text.trim().split('\n').at(-1)}`);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const arg = process.argv[2];
    await main(arg ? [arg] : FOLDERS.filter((f) => existsSync(`${HERE}${f}`)));
}
