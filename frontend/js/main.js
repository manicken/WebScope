

let mainMenuItems = [
    {
        label: "File",
        items: [
            {
                label: "Open",
                action: () => {
                    FileDialog.Show({extensions:['.ws.zip', '.sr', '.vcd', '.bin'], mode: FileDialog.FDModes.Open, onConfirm: async (out)=>{ // {data, name, ext, source}
                        
                        //console.log("Selected the file:", {data:out.data, name:out.name, ext:out.ext, size:out.data.byteLength, source:FileDialog.FDSourceToString(out.source)});
                        console.log(out);
                        const file = out.file;
                        
                        if (file.ext == 'sr') {
                            await loadSamplesFromSigrokFile({filedata:file.data, decode:true});
                        } else if (file.ext == 'ws.zip') {
                            await loadWebScopeProjectFile(file.data);
                        } else {
                            console.log("Currently not supported file extension: " + file.ext);
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
            {
                label: "Import Saleae Binary",
                action: () => {
                    FileDialog.Show({extensions:['.bin'], multiple:true, mode: FileDialog.FDModes.Open, onConfirm: async (out)=>{ // {data, name, ext, source}
                        console.log(out);
                    }});
                }
            }
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
      sourceKind: 'sourceKind', wsUrl: 'wsUrl', samplerate: 'samplerateSelect', duration: 'durationIn',
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
