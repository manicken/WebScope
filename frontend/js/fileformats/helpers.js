

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

/** Shows loaded samples: new channels (with the file's names) and a new capture buffer. The
 *  decoders re-run and the view fits by themselves when the buffer changes. */
function setSamples({samples, samplerate, channelCount, names}) {
    const WS = window.WS;
    // file readers give one Uint32 per sample; with few channels a smaller type is enough
    const type = CaptureBuffer.sampleType(channelCount);
    if (samples.BYTES_PER_ELEMENT > type.BYTES_PER_ELEMENT) samples = new type(samples);
    WS.appState.channels.set(WS.makeChannels({count:channelCount, names}));
    WS.capture.setBuffer(new CaptureBuffer(samples, samplerate, channelCount));
}

async function loadSamplesFromSigrokFile({filedata}) {
    const cap = await loadSr(filedata);
    const { samplerate, channelCount, names, unitsize, length, data } = cap;
    
    const samples = unpackSamples(cap);
    //console.log({ samplerate, channelCount, names, unitsize, length, data, samples });
    setSamples({samples, samplerate, channelCount, names});
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
    WS.decoders.setDecoders(decoders);
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
    const names = window.WS.appState.channels.value.map(item=>item.name.value);
    return await saveSr({samplerate:buf.samplerate, channels:buf.channelCount, data:buf.samples, names});
}