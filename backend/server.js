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

import { WebSocketServer, WebSocket } from 'ws';

const PORT = 8080;

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

httpServer.listen(PORT, () => {
    console.log(`WebScope: http://localhost:${PORT}`);
    console.log(`WebSocket: ws://localhost:${PORT}`);
});

server.on('listening', () => {
    console.log("Websocket started on port: " + PORT);
});

const devices = new Map();

async function sendDevices(ws) {
    let _devices = await scanSigrok();
    for (const info of _devices) devices.set(info.id, info);
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

    refreshDevices(ws);

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);

            if (msg.type === 'start') {
                console.log(msg);
                let device = devices.get(msg.deviceId);
                
                device?.deviceKind.start(msg, 
                    /* onData */
                    (chunk, offset) => {
                        //console.log("sending: ", chunk);
                        console.log("sending @ offset: "+ offset);
                        ws.send(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
                    },
                    /* onDone */
                    (info) => {
                        sendTo(ws, {type:"done", ...info});
                    },
                    (msg) => { 
                        sendTo(ws, {type:"error", message:msg});
                        console.log("Error: " + msg);
                    }
                );
            }

            if (msg.type === 'stop') {
                console.log(msg);
                let device = devices.get(msg.deviceId);
                device?.deviceKind.stop(); 
            }

            if (msg.type === "refreshdevices") {
                refreshDevices(ws);
            }
        } catch (ex) {
            console.error(ex);
        }
    });
});