class WebSocketSource {
    constructor(url) { this.url = url; this.ws = null; }
    start(cfg, onData, onDone, onError) {
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let info = null;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'start', sampleRate: cfg.samplerate, channels: 8, samples: Math.round(cfg.samplerate * cfg.duration) }));
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'info') info = msg;
          else if (msg.type === 'done') onDone({ samples: msg.samples, samplerate: info?.sampleRate ?? cfg.samplerate, channels: info?.channels ?? 8 });
          else if (msg.type === 'error') onError(msg.message);
        } else {
          onData(new Uint32Array(ev.data));
        }
      };
      ws.onerror = () => onError('WebSocket error');
    }
    stop() { this.ws?.send(JSON.stringify({ type: 'stop' })); }
  }