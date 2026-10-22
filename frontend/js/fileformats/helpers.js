

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

function setSamples({samples, samplerate, channelCount, decode, names}) {

    const WS = window.WS;
    WS.capture.setBuffer(new CaptureBuffer(samples, samplerate, channelCount));
    const store = WS.store;
    console.log(channelCount, store.makeChannels({count:channelCount, names}));
    store.set({ channels: store.makeChannels({count:channelCount, names}) });
    console.log(store.get());
    store.set((s) => ({ status: { ...s.status, state: 'done', sampleCount:samples.length, samplerate, trigger: null } }));
    if (decode) {
        for (const d of store.get().decoders) WS.decoders.decode(d.id);
    }
    if (store.get().follow) WS.waveform.fit();
    
    WS.uiRows.recompute();
    WS.gutter.ui.render();
    WS.waveform.ui.requestDraw();
}

async function loadSamplesFromSigrokFile({filedata, decode=false}) {
    const cap = await loadSr(filedata);
    const { samplerate, channelCount, names, unitsize, length, data } = cap;
    
    const samples = unpackSamples(cap);
    //console.log({ samplerate, channelCount, names, unitsize, length, data, samples });
    setSamples({samples, samplerate, channelCount, decode, names});
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

async function getSigrokData() {
    let buf = window.WS.capture.getBuffer();
    const channels = window.WS.store.get().channels;
    let names = Object.values(channels).map(item=>item.name);
    return await saveSr({samplerate:buf.samplerate, channels:buf.channelCount, data:buf.samples, names});
}