let testRestoreState = [
    {
        "type": "UARTDecoder",
        "cfg": {
            "channel": 0,
            "baud": 115200,
            "dataBits": 8,
            "parity": "none",
            "stopBits": 1,
            "msbFirst": false,
            "invert": false,
            "format": "ascii"
        },
        "color": "#7c6cff",
        "id": 1,
        "parent": null,
        "subDecoders": [
            5
        ],
        "visible": true
    },
    {
        "type": "I2CDecoder",
        "cfg": {
            "scl": 1,
            "sda": 2,
            "format": "hex",
            "subDecoders": []
        },
        "color": "#22d3ee",
        "id": 2,
        "parent": null,
        "subDecoders": [],
        "visible": true
    },
    {
        "type": "SPIDecoder",
        "cfg": {
            "clk": 3,
            "mosi": 4,
            "miso": 5,
            "cs": 6,
            "csActiveLow": true,
            "cpol": 0,
            "cpha": 0,
            "displayMode": 1,
            "wordBits": 8,
            "msbFirst": true,
            "format": "hex",
            "subDecoders": []
        },
        "color": "#ff9f43",
        "id": 3,
        "parent": null,
        "subDecoders": [],
        "visible": true
    },
    {
        "type": "WS281xDecoder",
        "cfg": {
            "channel": 0,
            "wireorder": "GRB",
            "textorder": "RGB[W]"
        },
        "color": "#51cf66",
        "id": 4,
        "parent": null,
        "subDecoders": [],
        "visible": true
    },
    {
        "type": "CustomDecoder",
        "cfg": {
            "code": "\n({\n    /** in all functions context is the Decoder Instance */\n    /** runs directly after the compile is done */\n    init(context) {\n\n    },\n    /** called from custom decoder rows function*/\n    rows(context) {\n        return [\n            {id:'data', label: 'DATA' },\n            {id:'address', label: 'ADDRESS' }\n        ];\n    },\n    /** called from custom decoder run function */\n    run(input, context) {\n        // Decode input\n        return {};\n    }\n})\n",
            "subDecoders": []
        },
        "color": "#ff6b9a",
        "id": 5,
        "parent": 1,
        "subDecoders": [],
        "visible": true
    }
];

function downloadFile(filename, content, mimeType = 'application/octet-stream') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();

    URL.revokeObjectURL(url);
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

let mainMenuItems = [
    {
        label: "File",
        items: [
            {
                label: "Open",
                action: () => {
                    FileDialog.Show({extensions:['.ws.zip', '.sr', '.vcd', '.bin'], onConfirm: async (out)=>{ // {data, name, ext, source}
                        
                        console.log("Selected the file:", {data:out.data, name:out.name, ext:out.ext, size:out.data.byteLength, source:FileDialog.FDSourceToString(out.source)});
                        
                        if (out.ext == 'sr') {
                            const cap = await loadSr(out.data);
                            const { samplerate, channels, names, unitsize, length, data } = cap;
                            
                            const samples = unpackSamples(cap);
                            console.log({ samplerate, channels, names, unitsize, length, data, samples });
                            const WS = window.WS;
                            WS.capture.setBuffer(new CaptureBuffer(samples, samplerate, channels));
                            const store = WS.store;
                            if (store.get().channels.length !== channels) store.set({ channels: store.makeChannels(channels) });
                            store.set((s) => ({ status: { ...s.status, state: 'done', sampleCount:samples.length, samplerate, channels, trigger: null } }));
                            for (const d of store.get().decoders) WS.decoders.decode(d.id);
                            if (store.get().follow) WS.waveform.fit();
                            
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
                        console.log("file to save selected:", {name, source:FileDialog.FDSourceToString(source)});
                        
                    }});
                }
            },
            {
                label: "SaveTest",
                action: () => {
                    let decoders =  window.WS.store.get().decoders;
                    console.log(decoders);
                    let save = [];
                    for (let d of decoders) {
                        save.push(d.getState());
                    }
                    console.log(JSON.stringify(save, null, 4));

                }
            },
            {
                label: "LoadTest",
                action: () => {
                    const findByType = (t) => WS.decoders.registry.find(d => d.class.TYPE === t);
                    let decoders = [];
                    // First pass: instantiate all decoders.
                    for (const d of testRestoreState) {
                        const entry = findByType(d.type);

                        if (!entry)
                            throw new Error(`Unknown decoder type: ${d.type}`);

                        decoders.push(new entry.class({
                            id: d.id,
                            color: d.color
                        }));
                    }
                    
                    const findById = (id) => decoders.find(d => d.id === id);
                    for (let d of testRestoreState) {
                        findById(d.id).setState(d, decoders);
                    }
                    window.WS.store.set({ decoders });
                    console.log(decoders);

                }//testRestoreState
            },
            {
                label: "Save As Sigrok",
                action: () => {
                    FileDialog.Show({extensions:['.sr'], mode: FileDialog.FDModes.Save, onConfirm: async ({name, source})=>{
                        console.log("file to save selected:", {name, source:FileDialog.FDSourceToString(source)});
                        //console.log(window.WS.capture)
                        let buf = window.WS.capture.getBuffer();
                        //console.log(buf);

                        
                        let data = await saveSr({samplerate:buf.samplerate, channels:buf.channelCount, data:buf.samples});
                        if (source == FileDialog.FDSources.Local) {
                            downloadFile(name, data);
                        } else if (source == FileDialog.FDSources.Backend) {
                        
                            try {
                                await uploadFile('/api/fs/' + name, data);
                                console.log('Upload complete');
                            } catch (err) {
                                console.error(err);
                            }
                        }
                    }});
                }
            },
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
