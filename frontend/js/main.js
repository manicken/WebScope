

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

async function loadWebScopeProjectFile(filedata) {
    const zip = readZip(filedata);
    const projectData = JSON.parse(await zip.readText("project.json"));

    if (projectData.format !== "WebScope")
        throw new Error("Invalid project format");

    if (projectData.version > 1)
        throw new Error(`Unsupported project version: ${projectData.version}`);

    const srFileData = await zip.read("sigrok.sr");
    await loadSamplesFromSigrokFile({filedata:srFileData, decode:false});
    const decodersJsonData = await zip.readText('decoders.json');
    const decoderData = JSON.parse(decodersJsonData);
    loadDecoderStates(decoderData);
    //console.log(decoderData);
}

async function getSaveData() {
    let decoders =  window.WS.store.get().decoders;
    console.log(decoders);
    let save = [];
    for (let d of decoders) {
        save.push(d.getState());
    }
    let jsonString = JSON.stringify(save, null, 4);
    console.log(jsonString);
    let buf = window.WS.capture.getBuffer();

    let sigrokData = await saveSr({samplerate:buf.samplerate, channels:buf.channelCount, data:buf.samples});
    const enc = new TextEncoder();
    const entries = [
        { name: "sigrok.sr", data: sigrokData },
        { name: "decoders.json", data: enc.encode(jsonString) },
        { name: "project.json", data: enc.encode(JSON.stringify({format:"WebScope", version:1}, null, 4)) },
    ];
    let data = await writeZip(entries, { compress: true });
    return data;
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

let mainMenuItems = [
    {
        label: "File",
        items: [
            {
                label: "Open",
                action: () => {
                    FileDialog.Show({extensions:['.ws.zip', '.sr', '.vcd', '.bin'], onConfirm: async (out)=>{ // {data, name, ext, source}
                        
                        //console.log("Selected the file:", {data:out.data, name:out.name, ext:out.ext, size:out.data.byteLength, source:FileDialog.FDSourceToString(out.source)});
                        
                        if (out.ext == 'sr') {
                            await loadSamplesFromSigrokFile({filedata:out.data, decode:true});
                        } else if (out.ext == 'ws.zip') {
                            await loadWebScopeProjectFile(out.data);
                        } else {
                            console.log("Currently not supported file extension: " + out.ext);
                        }
                    }});

                }
            },
            {
                label: "Save",
                action: () => {
                    FileDialog.Show({extensions:['.ws.zip'], mode: FileDialog.FDModes.Save, onConfirm: async ({name, source})=>{
                        //console.log("file to save selected:", {name, source:FileDialog.FDSourceToString(source)});
                        const data = await getSaveData();
                        await saveToLocation({name, data, location:source});
                    }});
                }
            },
            {
                label: "Save As Sigrok",
                action: () => {
                    FileDialog.Show({extensions:['.sr'], mode: FileDialog.FDModes.Save, onConfirm: async ({name, source})=>{
                        //console.log("file to save selected:", {name, source:FileDialog.FDSourceToString(source)});
                        let buf = window.WS.capture.getBuffer();
                        let data = await saveSr({samplerate:buf.samplerate, channels:buf.channelCount, data:buf.samples});
                        await saveToLocation({name, data, location:source});
                    }});
                }
            },
            /*{
                label: "SaveTest",
                action: async () => {
                    const data = await getSaveData();
                    downloadFile("test.ws.zip", data);
                }
            },
            {
                label: "LoadTest",
                action: () => {
                    loadDecoderStates(testRestoreState);

                }//testRestoreState
            },*/
            /*{
                label: "List Files root",
                action: async () => {
                    const files = await fetch('/api/fs').then(r => r.json());
                    console.log(files);
                        //
                }
            },
            {
                label: "List Files testdir",
                action: async () => {
                    const files = await fetch('/api/fs/testdir').then(r => r.json());
                    console.log(files);
                        //
                }
            },*/
            /*{
                label: "Export",
                submenu:  [
                    {
                        label: 'Sigrok',
                        action:() => {
                            
                        }
                    }
                ]
                
            },*/
          ]
    }
];

(function (WS) {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {

    WS.sources.setRefreshCallback(() => {
      WebSocketSource.refreshdevices();
    });
    WS.sources.refresh(); // do not call the function above
    WebSocketSource.connect();

    const gutterBody = document.getElementById('gutterBody');
    const waveform = WS.waveform.ui.init({
      canvas: document.getElementById('canvas'),
      plotWrap: document.getElementById('plotWrap'),
      hoverTipEl: document.getElementById('hoverTip'),
      emptyStateEl: document.getElementById('emptyState')
    });
    WS.gutter.ui.init(gutterBody, (y) => waveform.setScroll(y));
    WS.rightpanel.init(document.getElementById('rightPanel'));
    WS.topbar.init({
      sourceKind: 'sourceKind', wsUrl: 'wsUrl', samplerate: 'samplerateIn', duration: 'durationIn',
      captureBtn: 'captureBtn', fitBtn: 'fitBtn', statusPill: 'statusPill'
    });
    WS.statusbar.init({ samples: 'stSamples', rate: 'stRate', view: 'stView', sampleResolution:'stSampleResolution' });
    WS.overview.init(document.getElementById('overviewCanvas'));
    WS.keymap.init(document.getElementById('keyHints'));
    WS.uiRows.recompute();
    WS.decoders.ui.init();

    WS.customDecoderEditor = new CustomDecoderEditor();
    //WS.customDecoderEditor.open(); // dev test

    let menu = createMenu(document.getElementById('mainMenu'), mainMenuItems);

  });
})(window.WS = window.WS || {});
