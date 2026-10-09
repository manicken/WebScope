import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DemoDevice } from './DemoDevice.js'
import { scanSigrok } from './SigrokDevice.js';

import { WebSocketServer, WebSocket } from 'ws';

const PORT = 8080;

const PUBLIC_DIR = fileURLToPath(new URL('../', import.meta.url));

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

const httpServer = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        return res.end('Method Not Allowed');
    }

    try {
        const url = new URL(req.url, 'http://localhost');
        const pathname = decodeURIComponent(url.pathname);
        const requestedPath = pathname === '/'
            ? 'index.html'
            : pathname.slice(1);

        const filePath = resolve(PUBLIC_DIR, requestedPath);
        const relPath = relative(PUBLIC_DIR, filePath);

        // Prevent requests outside the public directory.
        if (relPath === '..' ||
            relPath.startsWith('..' + sep) ||
            resolve(filePath) === resolve(PUBLIC_DIR)) {
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
        const status = err.code === 'ENOENT' ? 404 : 500;
        res.writeHead(status, {
            'Content-Type': 'text/plain; charset=utf-8'
        });
        res.end(status === 404 ? 'Not Found' : 'Internal Server Error');
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

async function sendDevices() {
    let _devices = await scanSigrok();
    for (const info of _devices) devices.set(info.id, info);
    const arr = [...devices.values()];
    sendToAll({
        type: 'devices',
        devices: arr
    });
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

function refreshDevices() {
    devices.clear();
    let ddInfo = DemoDevice.info();
    devices.set(ddInfo.id, ddInfo);

    // real hw scan here
    // it will populate the devices map
    // which will when finished send the whole package
    // actually it's possible to send devices in parts
    // so first we can at least send the demo device(s)
    sendDevices();
}

server.on('connection', (ws) => {
    console.log('Client connected');

    refreshDevices();

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
                        sendToAll({type:"done", ...info});
                    },
                    (msg) => { 
                        sendToAll({type:"error", message:msg});
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
                refreshDevices();
            }
        } catch (ex) {
            console.error(ex);
        }
    });
});