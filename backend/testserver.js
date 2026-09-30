import { DemoDevice } from './DemoDevice.js'

import { WebSocketServer, WebSocket } from 'ws';

const WEBSOCKET_PORT = 8080;

const server = new WebSocketServer({ port: WEBSOCKET_PORT });

server.on('listening', () => {
    console.log("Websocket started on port: " + WEBSOCKET_PORT);
});

const devices = new Map();

function sendDevices() {
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

server.on('connection', (ws) => {
    console.log('Client connected');

    devices.clear();
    let ddInfo = DemoDevice.info();
    devices.set(ddInfo.id, ddInfo);

    // real hw scan here
    // it will populate the devices map
    // which will when finished send the whole package
    // actually it's possible to send devices in parts
    // so first we can at least send the demo device(s)
    sendDevices();

    ws.on('message', (data) => {
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
                    console.log("Error: " + msg);
                }
            );
        }

        if (msg.type === 'stop') {
            console.log(msg);
            let device = devices.get(msg.deviceId);
            device?.deviceKind.stop(); 
        }
    });
});