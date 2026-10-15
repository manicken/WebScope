

function downloadFile(filename, content, mimeType = 'application/octet-stream') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    setTimeout(() => {
        URL.revokeObjectURL(url);
    }, 1000);
}

async function uploadFile(url, file) {
    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            'Content-Type': file.type || 'application/octet-stream'
        },
        body: file
    });

    if (!response.ok) {
        throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
    }

    return response;
}

async function loadSamplesFromSigrokFile({filedata, decode=false}) {
    const cap = await loadSr(filedata);
    const { samplerate, channels, names, unitsize, length, data } = cap;
    
    const samples = unpackSamples(cap);
    //console.log({ samplerate, channels, names, unitsize, length, data, samples });
    const WS = window.WS;
    WS.capture.setBuffer(new CaptureBuffer(samples, samplerate, channels));
    const store = WS.store;
    if (store.get().channels.length !== channels) store.set({ channels: store.makeChannels(channels) });
    store.set((s) => ({ status: { ...s.status, state: 'done', sampleCount:samples.length, samplerate, channels, trigger: null } }));
    if (decode) {
        for (const d of store.get().decoders) WS.decoders.decode(d.id);
    }
    if (store.get().follow) WS.waveform.fit();
}

function loadDecoderStates(decoderStateData) {
    const WS = window.WS;
    const findByType = (t) => WS.decoders.registry.find(d => d.class.TYPE === t);
    let decoders = [];
    // First pass: instantiate all decoders.
    for (const d of decoderStateData) {
        const entry = findByType(d.type);

        if (!entry)
            throw new Error(`Unknown decoder type: ${d.type}`);

        decoders.push(new entry.class({
            id: d.id,
            color: d.color
        }));
    }
    
    const findById = (id) => decoders.find(d => d.id === id);
    for (let d of decoderStateData) {
        findById(d.id).setState(d, decoders);
    }
    const store = WS.store
    store.set({ decoders });
    //console.log(decoders);
    for (const d of store.get().decoders) WS.decoders.decode(d.id);
}

async function saveToLocation({name, data, location}) {
    if (location == FileDialog.FDSources.Local) {
        downloadFile(name, data);
    } else if (location == FileDialog.FDSources.Backend) {
    
        try {
            await uploadFile('/api/fs/' + name, data);
            console.log('Upload complete');
        } catch (err) {
            console.error(err);
        }
    }
}