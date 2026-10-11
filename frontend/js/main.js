let mainMenuItems = [
    {
        label: "File",
        items: [
            {
                label: "Open",
                action: () => {
                    FileDialog.Show({extensions:['.ws.zip', '.sr', '.vcd', '.bin'], onConfirm: async ({data, name, ext, source})=>{
                        console.log("Selected the file:", {data, name, ext, size:data.byteLength, source:FileDialog.FDSourceToString(source)});
                    }});

                }
            },
            {
                label: "Save",
                action: () => {
                    FileDialog.Show({extensions:['.ws.zip'], mode: FileDialog.FDModes.Save, onConfirm: async ({name, source})=>{
                        console.log("file to save selected:", {name, source:FileDialog.FDSourceToString(source)});
                        // special note here data to save is not provided to the FD
                        // and even if it where there is no point returning it here
                        // this would then instead be the 
                    }});
                }
            },
            {
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
            },
            {
                label: "Export",
                submenu:  [
                    {
                        label: 'Sigrok',
                        action:() => {
                            
                        }
                    }
                ]
                
            },
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
