// update-sigrok.mjs — replaces python_decoders/sigrok with the decoders of a libsigrokdecode commit
// and rebuilds its index.json. Needs git.
//
//   node python_decoders/update-sigrok.mjs <commit>    e.g. a commit of https://github.com/sigrokproject/libsigrokdecode
//
// The decoders are copied unchanged; sigrok/VERSION holds the commit.
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/sigrokproject/libsigrokdecode.git';
const TARGET = fileURLToPath(new URL('./sigrok/', import.meta.url));

const commit = process.argv[2];
if (!commit) {
    console.error('usage: node python_decoders/update-sigrok.mjs <commit>');
    process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'srd-'));
try {
    const git = (...args) => execFileSync('git', args, { cwd: tmp, stdio: 'inherit' });
    git('init', '-q');
    git('remote', 'add', 'origin', REPO);
    git('fetch', '-q', '--depth', '1', 'origin', commit);
    git('checkout', '-q', 'FETCH_HEAD');
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp }).toString().trim();

    rmSync(TARGET, { recursive: true, force: true });
    cpSync(join(tmp, 'decoders'), TARGET, { recursive: true, filter: (src) => !src.includes('__pycache__') });
    if (existsSync(join(tmp, 'COPYING'))) cpSync(join(tmp, 'COPYING'), join(TARGET, 'COPYING'));
    writeFileSync(join(TARGET, 'VERSION'), sha + '\n');
    console.log(`python_decoders/sigrok is now libsigrokdecode ${sha}`);
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

execFileSync(process.execPath, [fileURLToPath(new URL('./build-index.mjs', import.meta.url)), 'sigrok'], { stdio: 'inherit' });
