let mainMenuItems = [
    {
        label: "File",
        items: [
            {
                label: "New Project",
                action: () => { NotImplementedMessageDialog.Show(); }
            },
            {
                label: "Import",
                submenu:  [
                    {
                        label: 'From Logic2',
                        action:() => {
                            SelectFile({filter:'.sal', onRead: async(data, file)=>{
                                const zip = await JSZip.loadAsync(data);

                                for (const [name, entry] of Object.entries(zip.files)) {
                                    if (entry.dir) continue;

                                    const content = await entry.async('uint8array');

                                    console.log(name, content);

                                    // Här har du filens innehåll i en Uint8Array
                                }
                            }});
                            
                            
                        }
                    },
                    {
                        label: 'From Sigrok',
                        action:() => {NotImplementedMessageDialog.Show();}
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
