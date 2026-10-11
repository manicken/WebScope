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
                            store.set((s) => ({ status: { ...s.status, state: 'done', samples:samples.length, samplerate, channels, trigger: null } }));
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
