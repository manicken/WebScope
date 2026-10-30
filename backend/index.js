import { createServer } from 'node:http';
import {
    readFile,
    writeFile,
    unlink,
    realpath,
    readdir,
    stat
} from 'node:fs/promises';

import {
    join,
    resolve,
    relative,
    dirname,
    basename,
    extname,
    sep,
    isAbsolute
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { DemoDevice } from './DemoDevice.js'
import { scanSigrok } from './SigrokDevice.js';
import { scanLogicAnalyzers } from './LogicAnalyzerDevice.js';
import { scanSigrokPicos } from './PicoCoderSigrokPicoDevice.js';
import { startTriggered } from './trigger.js';
import { resolveChannels } from './channels.js';
import { loadSettings, isHostAllowed, isOriginAllowed, hostname } from './settings.js';

import { WebSocketServer, WebSocket } from 'ws';

import open from 'open';

import readline from 'node:readline';

// settings.json next to this file (or --settings <file>), then the command line, see settings.js
const settings = loadSettings(process.argv.slice(2), fileURLToPath(new URL('./settings.json', import.meta.url)));
const PORT = settings.port;

// the drivers read these from the environment; an environment variable that is set wins over settings.json
if (settings.sigrokCli && !process.env.SIGROK_CLI) process.env.SIGROK_CLI = settings.sigrokCli;
if (settings.logicAnalyzerHosts.length && !process.env.LOGICANALYZER_HOSTS)
    process.env.LOGICANALYZER_HOSTS = settings.logicAnalyzerHosts.join(',');

const refusedHosts = new Set();     // log each refused name once, a page load makes many requests

function checkHost(req) {
    if (isHostAllowed(req, settings)) return true;
    if (!refusedHosts.has(req.headers.host)) {
        refusedHosts.add(req.headers.host);
        console.warn(`Request for host ${req.headers.host} refused (start with --allow-host ${hostname(req.headers.host) ?? req.headers.host} to allow it)`);
    }
    return false;
}


const PUBLIC_DIR = fileURLToPath(new URL('../frontend', import.meta.url));
const DATA_DIR = fileURLToPath(new URL('../user_data_fs', import.meta.url));
// the Python decoder extension (frontend/js/extensions/python): read only, served at /python/<name>/
const PYTHON_DIRS = {
    runtime: fileURLToPath(new URL('../python_runtime', import.meta.url)),     // Pyodide
    decoders: fileURLToPath(new URL('../python_decoders', import.meta.url)),   // sigrok decoders: sigrok/ and user/
};

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.py': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.zip': 'application/zip'
};

/** The file `virtualPath` names in folder `root` (default: the user's files); 403 when it is outside. */
async function resolveVirtualPath(virtualPath, root = DATA_DIR) {
    const filePath = resolve(root, virtualPath);
    const relPath = relative(root, filePath);
    console.log({filePath, relPath});
    // Prevent directory traversal.
    if (
        relPath === '..' ||
        relPath.startsWith('..' + sep) ||
        isAbsolute(relPath)
    ) {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
    }

    // Root directory is allowed.
    const checkPath = relPath
        ? dirname(filePath)
        : filePath;

    const parentPath = await realpath(checkPath);
    const parentRel = relative(root, parentPath);
    console.log({parentPath, parentRel});
    if (
        parentRel === '..' ||
        parentRel.startsWith('..' + sep) ||
        isAbsolute(parentRel)
    ) {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
    }

    // If the target exists, verify its real location.
    if (relPath) {
        try {
            const targetPath = await realpath(filePath);
            const targetRel = relative(root, targetPath);

            if (
                targetRel === '..' ||
                targetRel.startsWith('..' + sep) ||
                isAbsolute(targetRel)
            ) {
                throw Object.assign(new Error('Forbidden'), { status: 403 });
            }
        } catch (err) {
            if (err.code !== 'ENOENT') throw err;
        }
    }

    return filePath;
}

/** GET / HEAD of a file, or of a folder: its listing as JSON [{ name, isDir?, size? }]. */
async function sendFileOrListing(req, res, filePath) {
    const info = await stat(filePath);

    if (info.isDirectory()) {
        const files = await readdir(filePath, { withFileTypes: true });

        const result = await Promise.all(files.map(async file => {
            const fullPath = join(filePath, file.name);
            const info = await stat(fullPath);

            return {
                name: file.name,
                isDir: file.isDirectory() || undefined, // short for file.isDirectory()?true:undefined
                size: (file.isDirectory()==false)?info.size:undefined
            };
        }));

        res.writeHead(200, {
            'Content-Type': 'application/json'
        });

        return res.end(JSON.stringify(result));
    }

    const content = await readFile(filePath);

    res.writeHead(200, {
        'Content-Type':
            MIME_TYPES[extname(filePath).toLowerCase()]
            ?? 'application/octet-stream',
        'Content-Length': content.length
    });

    return res.end(req.method === 'HEAD' ? undefined : content);
}

const httpServer = createServer(async (req, res) => {
    try {
        if (!checkHost(req)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Forbidden: unknown host name, see the backend\'s --allow-host');
        }

        const url = new URL(req.url, 'http://localhost');
        const pathname = decodeURIComponent(url.pathname);

        // -------------------------------
        // Virtual filesystem API
        // -------------------------------
        
        if (pathname.startsWith('/api/fs')) {
            console.log("FS Request: ", {url});
            if (req.headers.origin) {
                if (!isOriginAllowed(req, settings)) {
                    res.writeHead(403);
                    return res.end('Forbidden');
                }
                res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
                res.setHeader('Vary', 'Origin');
            }
            if (req.method === 'OPTIONS') {
                // CORS preflight for PUT / DELETE from an allowed page on another origin
                res.writeHead(204, {
                    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE',
                    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '',
                    'Access-Control-Allow-Private-Network': 'true',
                    'Access-Control-Max-Age': '600',
                });
                return res.end();
            }
            if (!['GET', 'HEAD', 'PUT', 'DELETE'].includes(req.method)) {
                res.writeHead(405);
                return res.end('Method Not Allowed');
            }

            const requestedPath = pathname.slice('/api/fs/'.length);

            const filePath = await resolveVirtualPath(requestedPath);

            console.log('FS Request:', req.method, requestedPath);

            switch (req.method) {
                case 'GET':
                case 'HEAD':
                    return await sendFileOrListing(req, res, filePath);   // await: errors go to the catch below

                case 'PUT': {
                    await writeFile(filePath, req);

                    res.writeHead(204);
                    return res.end();
                }

                case 'DELETE': {
                    await unlink(filePath);

                    res.writeHead(204);
                    return res.end();
                }
            }
        }

        // -------------------------------
        // Python decoder extension: /python/runtime/..., /python/decoders/... (read only)
        // -------------------------------

        const python = /^\/python\/([^/]+)\/(.*)$/.exec(pathname);
        if (python && PYTHON_DIRS[python[1]]) {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405);
                return res.end('Method Not Allowed');
            }
            const filePath = await resolveVirtualPath(python[2], PYTHON_DIRS[python[1]]);
            return await sendFileOrListing(req, res, filePath);
        }

        // -------------------------------
        // Static file server
        // -------------------------------

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405);
            return res.end('Method Not Allowed');
        }

        const requestedPath = pathname === '/'
            ? 'index.html'
            : pathname.slice(1);

        const filePath = resolve(PUBLIC_DIR, requestedPath);
        const relPath = relative(PUBLIC_DIR, filePath);

        if (
            relPath === '..' ||
            relPath.startsWith('..' + sep) ||
            isAbsolute(relPath) ||
            !relPath
        ) {
            res.writeHead(403);
            return res.end('Forbidden');
        }

        const content = await readFile(filePath);

        res.writeHead(200, {
            'Content-Type':
                MIME_TYPES[extname(filePath).toLowerCase()]
                ?? 'application/octet-stream',
            'Content-Length': content.length
        });

        res.end(req.method === 'HEAD' ? undefined : content);

    } catch (err) {
        console.error('HTTP error:', err);

        const status =
            err.status ??
            (err.code === 'ENOENT' ? 404 :
             err.code === 'EISDIR' ? 400 : 500);

        res.writeHead(status, {
            'Content-Type': 'text/plain; charset=utf-8'
        });

        res.end(
            status === 403 ? 'Forbidden' :
            status === 404 ? 'Not Found' :
            status === 400 ? 'Invalid file operation' :
            'Internal Server Error'
        );
    }
});

// HTTP and WebSocket share the same server and port.
// WebSockets have no CORS: the browser sends the page's Origin and the server decides.
const server = new WebSocketServer({
    server: httpServer,
    verifyClient: ({ req }) => {
        if (!checkHost(req)) return false;
        if (isOriginAllowed(req, settings)) return true;
        console.warn(`WebSocket from ${req.headers.origin} refused (start with --allow-origin ${req.headers.origin} to allow it)`);
        return false;
    },
});
//console.log(process.argv);

httpServer.listen(PORT, async () => {
    console.log(`WebScope: http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    if (settings.file) console.log(`Settings: ${settings.file}`);
    if (settings.allowOrigins.length) console.log(`Allowed origins: ${settings.allowOrigins.join(', ')}`);
    if (settings.allowHosts.length) console.log(`Allowed host names: ${settings.allowHosts.join(', ')}`);
    if (!settings.hostCheck) console.warn('Host check off (--no-host-check): open to DNS rebinding from any web page');
    if (settings.open) {
        await open(`http://localhost:${PORT}?ws=localhost:${PORT}`);
    }
});

server.on('listening', () => {
    console.log("Websocket started on port: " + PORT);
});

const devices = new Map();
const sessions = new WeakMap();   // ws -> handle of a running triggered capture ({ stop() })

async function sendDevices(ws) {
    let _devices = await Promise.all([scanSigrok(), scanLogicAnalyzers(), scanSigrokPicos()]);
    for (const info of _devices.flat()) devices.set(info.id, info);
    const arr = [...devices.values()];
    sendTo(ws, {
        type: 'devices',
        devices: arr
    });
}

/** A device's settings form was saved (see deviceSettings.js): the answer to the sender, the new info to everyone. */
async function applyDeviceSettings(ws, msg) {
    const reply = (r) => sendTo(ws, { type: 'deviceSettings', reqId: msg.reqId, ...r });
    const device = devices.get(msg.deviceId);
    if (!device?.deviceKind?.applySettings) {
        reply({ ok: false, message: 'This device has no settings' });
        return;
    }
    try {
        const { message, info } = await device.deviceKind.applySettings(msg.values ?? {});
        devices.set(info.id, info);
        reply({ ok: true, message });
        sendToAll({ type: 'deviceUpdated', device: info });
    } catch (err) {
        reply({ ok: false, message: err.message });
    }
}

function sendTo(ws, data) {
    if (typeof data !== "string") {
        data = JSON.stringify(data);
    }
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
    }
}

function sendToAll(data) {
    if (typeof data !== "string") {
        data = JSON.stringify(data);
    }
    for (const ws of server.clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    }
}

function refreshDevices(ws) {
    devices.clear();
    let ddInfo = DemoDevice.info();
    devices.set(ddInfo.id, ddInfo);

    // real hw scan here
    // it will populate the devices map
    // which will when finished send the whole package
    // actually it's possible to send devices in parts
    // so first we can at least send the demo device(s)
    sendDevices(ws);
}

server.on('connection', (ws) => {
    console.log('Client connected');

    // a triggered capture can wait forever: never leave one running for a client that is gone
    ws.on('close', () => { sessions.get(ws)?.stop(); sessions.delete(ws); });

    refreshDevices(ws);

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'start') {
                console.log({msg});
                let device = devices.get(msg.deviceId);

                // a new start replaces whatever this client still had running
                sessions.get(ws)?.stop();
                sessions.delete(ws);

                const onData = (chunk, offset) => {
                    ws.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                };
                const onDone = (info) => { sendTo(ws, {type:"done", ...info, channels: msg.channels}); };
                // details: the device's extended message (e.g. sigrok-cli's whole stderr), shown in the frontend's message log
                const onError = (m, details) => {
                    sendTo(ws, {type:"error", message:m, ...(details && { details })});
                    console.log("Error: " + m);
                };

                if (!device) { onError('unknown device'); return; }
                // the devices always get the channel list: the one asked for, or all channels (see channels.js)
                try { msg.channels = resolveChannels(msg, device); }
                catch (err) { onError(err.message); return; }

                const onStatus = (s) => sendTo(ws, { type: 'trigger', ...s });   // {state:'armed'} / {state:'triggered', sample}

                if (msg.triggerOn && !device.deviceKind.hardwareTrigger) {
                    // triggered capture: the device runs continuously, trigger.js decides what is kept
                    const handle = startTriggered(device, msg, { onData, onDone, onError, onStatus });
                    if (handle) sessions.set(ws, handle); else sessions.delete(ws);
                } else {
                    // a device that triggers itself (LogicAnalyzerDevice) also gets the trigger settings,
                    // and gives back a handle like startTriggered() does
                    const handle = device.deviceKind.start(msg, onData, onDone, onError, onStatus);
                    if (handle?.stop) sessions.set(ws, handle);
                }
            }

            if (msg.type === 'stop') {
                console.log({msg});
                let device = devices.get(msg.deviceId);
                const session = sessions.get(ws);
                if (session) { session.stop(); sessions.delete(ws); }
                else device?.deviceKind.stop();
            }

            if (msg.type === "refreshdevices") {
                refreshDevices(ws);
            }

            if (msg.type === 'deviceSettings') {
                applyDeviceSettings(ws, msg);
            }
        } catch (ex) {
            console.error(ex);
        }
    });
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'WebScope> '
});

rl.prompt();

rl.on('line', (line) => {
    const command = line.trim().toLowerCase();

    switch (command) {
        case 'help':
            console.log('Commands: help, e/exit');
            break;

        case 'e':
        case 'exit':
            console.log('Stopping WebScope...');
            rl.close();
            server.close(() => {
                process.exit(0);
            });
            return;

        default:
            console.log(`Unknown command: ${command}`);
    }

    rl.prompt();
});

rl.on('close', () => {
    console.log('Console closed.');
});