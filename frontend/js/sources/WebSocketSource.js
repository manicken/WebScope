class WebSocketSource {
    /** The backend triggers itself (backend/trigger.js): it sends only the finished capture. */
    static handlesTrigger = true;

    static #ws = null;
    static #onData = null;
    static #onDone = null;
    static #onError = null;
    static #onStatus = null;
    static #cfg = null;
    static #offset = 0;
    static #pending = new Map();    // reqId -> { resolve, reject } of a request waiting for its answer
    static #reqIds = 0;

    static wsUrl = new ReactiveValue();

    static wsUrlInput_el = null;
    static #wsConnectedStatus_el = document.getElementById('connectionStatusPill');

    static #SetDisconnected() {
        WebSocketSource.#wsConnectedStatus_el.textContent = 'disconnected';
        WebSocketSource.#wsConnectedStatus_el.className = 'status-pill error';
    }

    static #SetConnecting() {
        WebSocketSource.#wsConnectedStatus_el.textContent = 'connecting';
        WebSocketSource.#wsConnectedStatus_el.className = 'status-pill waiting';
    }

    static #SetConnected() {
        WebSocketSource.#wsConnectedStatus_el.textContent = 'connected';
        WebSocketSource.#wsConnectedStatus_el.className = 'status-pill running';
    }

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

        WebSocketSource.#SetConnecting();
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = WebSocketSource.wsUrl.value.trim().toLowerCase();

        if (!(wsUrl.startsWith('ws:') || wsUrl.startsWith('wss:'))) {
            wsUrl = `${protocol}//${wsUrl}`;
        }
        const ws = new WebSocket(wsUrl);
        WebSocketSource.#ws = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            WebSocketSource.#SetConnected();
            console.log('WebSocket connected');
        };

        ws.onclose = () => {
            //console.log('WebSocket disconnected');
            WebSocketSource.#ws = null;
            WebSocketSource.#SetDisconnected();
            for (const { reject } of WebSocketSource.#pending.values()) reject(new Error('the connection to the backend was lost'));
            WebSocketSource.#pending.clear();
            setTimeout(() => {
                WebSocketSource.#SetConnecting();
                WebSocketSource.connect();
            }, 2000);
        };

        ws.onerror = () => {
            /*if (ws.readyState === WebSocket.CONNECTING) {
                console.warn('Unable to connect to WebSocket server');
            } else {
                console.error('WebSocket error');
            }*/
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
                        channels: Array.isArray(WebSocketSource.#cfg.channels)?WebSocketSource.#cfg.channels.length:WebSocketSource.#cfg.channels,
                        trigger: msg.trigger,   // sample index of the trigger (triggered capture only)
                        warning: msg.warning,   // e.g. the device sent fewer samples than asked for
                        details: msg.details,   // the warning's extended message, for the message log
                    });
                } else if (msg.type === 'trigger') {
                    // triggered capture: {state:'armed'} then {state:'triggered', sample}
                    WebSocketSource.#onStatus?.(msg);
                } else if (msg.type === 'error') {
                    WebSocketSource.#onError(msg.message, msg.details);
                } else if (msg.type === 'deviceSettings') {
                    // the answer to applySettings()
                    const req = WebSocketSource.#pending.get(msg.reqId);
                    WebSocketSource.#pending.delete(msg.reqId);
                    if (msg.ok) req?.resolve({ message: msg.message });
                    else req?.reject(new Error(msg.message));
                } else if (msg.type === 'deviceUpdated') {
                    // a device's info changed, e.g. its settings were saved (also from another browser)
                    msg.device.sourceKind = WebSocketSource;
                    window.WS.sources.updateDevice(msg.device);
                } else {
                    console.log("unknown type for: " + ev.data);
                }
            } else {
                let data = new Uint8Array(ev.data);
                //console.log(data);
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
            // device channel indexes to capture; without it the backend captures all channels
            ...(cfg.activeChannels && { channels: cfg.activeChannels }),
            samplecount: cfg.samplecount,
            // triggered capture, see backend/trigger.js
            ...(cfg.triggerOn && {
                triggerOn: cfg.triggerOn,
                preTrigger: cfg.preTrigger,
                postTrigger: cfg.postTrigger,
            }),
        }));
    }

    static start(cfg, onData, onDone, onError, onStatus) {
        console.trace(cfg);
        WebSocketSource.#offset = 0;
        WebSocketSource.#cfg = cfg;
        WebSocketSource.#onData = onData;
        WebSocketSource.#onDone = onDone;
        WebSocketSource.#onError = onError;
        WebSocketSource.#onStatus = onStatus;
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

    /** Save a device's settings (see backend/deviceSettings.js) -> Promise<{ message }>, rejects with the backend's reason. */
    static applySettings(device, values) {
        const ws = WebSocketSource.#ws;
        if (ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected to the backend'));
        const reqId = ++WebSocketSource.#reqIds;
        return new Promise((resolve, reject) => {
            WebSocketSource.#pending.set(reqId, { resolve, reject });
            ws.send(JSON.stringify({ type: 'deviceSettings', reqId, deviceId: device.id, values }));
        });
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
WebSocketSource.wsUrlInput_el = document.getElementById('wsUrlInput');
// connect GUI input changes to the internal value
WebSocketSource.wsUrlInput_el.onchange = (e)=> {
    WebSocketSource.wsUrl.set(WebSocketSource.wsUrlInput_el.value, WebSocketSource.wsUrlInput_el);
};
// connect internal value changes back to the GUI input
WebSocketSource.wsUrl.subscribe((args) => {
    // prevent recursive loop
    if (args.source === WebSocketSource.wsUrlInput_el) return;
    WebSocketSource.wsUrlInput_el.value = args.value
});
// set the value
{
    const params = new URLSearchParams(location.search);
    WebSocketSource.wsUrl.set(params.get('ws') ?? 'localhost:8080');
}
