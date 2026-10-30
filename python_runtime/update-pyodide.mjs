// update-pyodide.mjs — replaces python_runtime/pyodide with the files of a Pyodide release from npm.
// Needs npm and tar (both come with Node / Windows 10+).
//
//   node python_runtime/update-pyodide.mjs <version>     e.g. 314.0.7
//
// Only the runtime itself is kept (no extra packages: the sigrok decoders need only the standard
// library). After an update, run python_decoders/build-index.mjs to check the decoders still load.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'package.json', 'README.md'];
const TARGET = fileURLToPath(new URL('./pyodide/', import.meta.url));

const version = process.argv[2];
if (!version) {
    console.error('usage: node python_runtime/update-pyodide.mjs <version>');
    process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'pyodide-'));
try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const tgz = execFileSync(npm, ['pack', `pyodide@${version}`, '--silent'], { cwd: tmp, shell: process.platform === 'win32' })
        .toString().trim().split(/\r?\n/).at(-1);
    execFileSync('tar', ['-xzf', tgz], { cwd: tmp, stdio: 'inherit' });
    rmSync(TARGET, { recursive: true, force: true });
    mkdirSync(TARGET, { recursive: true });
    for (const f of FILES) cpSync(join(tmp, 'package', f), join(TARGET, f));
    console.log(`python_runtime/pyodide is now Pyodide ${version}`);
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
