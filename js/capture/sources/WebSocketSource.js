class WebSocketSource {
    static #ws = null;
    static #onData = null;
    static #onDone = null;
    static #onError = null;
    static #cfg = null;
    static #offset = 0;

    static #wsUrlInput_el = document.getElementById('wsUrlInput');

    static wsConnectBtn_el =
        document.getElementById('wsConnectBtn').onclick = () => {
            WebSocketSource.connect();
        };

    static connect() {
        const current = WebSocketSource.#ws;

        if (current?.readyState === WebSocket.OPEN) {
            return;
        }

        if (current?.readyState === WebSocket.CONNECTING) {
            return;
        }

        const ws = new WebSocket(WebSocketSource.#wsUrlInput_el.value);
        WebSocketSource.#ws = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            console.log('WebSocket connected');
        };

        ws.onclose = () => {
            console.log('WebSocket disconnected');
            WebSocketSource.ws = null;
        };

        ws.onerror = () => {
            console.error('WebSocket error');
        };

        ws.onmessage = (ev) => {
            if (typeof ev.data === 'string') {
                const msg = JSON.parse(ev.data);

                if (msg.type === 'info') {
                    info = msg;
                } else if (msg.type === 'devices') {
                    for (let device of msg.devices) {
                        console.log(device);
                        device.sourceKind = WebSocketSource;
                        window.WS.sources.addDevice(device);
                    }
                    
                    
                } else if (msg.type === 'done') {
                    // fix for now, TODO make WebScope handle different kind of channels
                    console.log(msg);
                    if (Array.isArray(msg.channels)) {
                        console.log("was array");
                        msg.channels = msg.channels.length;
                    }
                    console.log(WebSocketSource.#cfg);
                    WebSocketSource.#onDone({
                        samples: msg.samples,
                        samplerate: WebSocketSource.#cfg.samplerate,
                        channels: Array.isArray(WebSocketSource.#cfg.channels)?WebSocketSource.#cfg.channels.length:WebSocketSource.#cfg.channels
                    });
                } else if (msg.type === 'error') {
                    WebSocketSource.#onError(msg.message);
                } else {
                    console.log("unknown type for: " + ev.data);
                }
            } else {
                let data = new Uint8Array(ev.data);
                //console.log(data.length);
                WebSocketSource.#onData(data, WebSocketSource.#offset);
                WebSocketSource.#offset += data.length;
            }
        };

        
    }

    static #sendStart() {
        const cfg = WebSocketSource.#cfg;
        WebSocketSource.#ws.send(JSON.stringify({
            type: 'start',
            deviceId: window.WS.sources.getSelectedId(),
            samplerate: cfg.samplerate,
            //channels: 8,
            samplecount: cfg.samplecount,
        }));
    }

    static start(cfg, onData, onDone, onError) {
        console.trace(cfg);
        WebSocketSource.#offset = 0;
        WebSocketSource.#cfg = cfg;
        WebSocketSource.#onData = onData;
        WebSocketSource.#onDone = onDone;
        WebSocketSource.#onError = onError;
        WebSocketSource.connect();

        const ws = WebSocketSource.#ws;

        if (ws.readyState === WebSocket.OPEN) {
            WebSocketSource.#sendStart();
        } else {
            ws.addEventListener('open', () => {
                WebSocketSource.#sendStart();
            }, { once: true });
        }
    }

    static refreshdevices() {
        const ws = WebSocketSource.#ws;
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({type:"refreshdevices"}));
            
        } else {
            console.error("websocket is not connected");
        }
    }

    static stop() {
        const ws = WebSocketSource.#ws;
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'stop', deviceId: window.WS.sources.getSelectedId()}));
        } else {
            console.error("websocket is not connected");
        }
    }
}