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

import { WebSocketServer, WebSocket } from 'ws';

import open from 'open';

import readline from 'node:readline';

const args = process.argv.slice(2);

const autoOpen = args.includes('--open');

const portIndex = args.indexOf('--port');

const PORT = portIndex !== -1
    ? Number(args[portIndex + 1])
    : 8080;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535)
    throw new Error('Invalid port number');


const PUBLIC_DIR = fileURLToPath(new URL('../frontend', import.meta.url));
const DATA_DIR = fileURLToPath(new URL('../user_data_fs', import.meta.url));

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm'
};

async function resolveVirtualPath(virtualPath) {
    const filePath = resolve(DATA_DIR, virtualPath);
    const relPath = relative(DATA_DIR, filePath);
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
    const parentRel = relative(DATA_DIR, parentPath);
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
            const targetRel = relative(DATA_DIR, targetPath);

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

const httpServer = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        const pathname = decodeURIComponent(url.pathname);

        // -------------------------------
        // Virtual filesystem API
        // -------------------------------
        
        if (pathname.startsWith('/api/fs')) {
            console.log("FS Request: ", {url});
            if (!['GET', 'HEAD', 'PUT', 'DELETE'].includes(req.method)) {
                res.writeHead(405);
                return res.end('Method Not Allowed');
            }

            const requestedPath = pathname.slice('/api/fs/'.length);

            const filePath = await resolveVirtualPath(requestedPath);

            console.log('FS Request:', req.method, requestedPath);

            switch (req.method) {
                case 'GET':
                case 'HEAD': {
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
const server = new WebSocketServer({ server: httpServer });
//console.log(process.argv);

httpServer.listen(PORT, async () => {
    console.log(`WebScope: http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
    if (autoOpen) {
        await open(`http://localhost:${PORT}`);
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