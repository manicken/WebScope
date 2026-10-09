/**
 * decoderGui.js — the "Analyzers" section of the right panel: add buttons and one config card
 * per decoder instance. (The "Decoded data" table is annotations/annotationGui.js.)
 */
(function (WS) {
  'use strict';
  const { store } = WS;
  const { addNewDecoder, updateDecoder, toggleDecoderVisible, removeDecoder } = WS.decoders;

  function el(tag, className, html) { const e = document.createElement(tag); if (className) e.className = className; if (html !== undefined) e.innerHTML = html; return e; }

  let addDecoderMenu = null;

  function init() {
    addDecoderMenu = new AddNewDecoderContextMenu({itemClickedCb: (item) => {addNewDecoder(item.class)}});
    console.log(WS.decoders.registry);
    addDecoderMenu.setItems(WS.decoders.registry);
  }
/* ============================== Analyzers ============================== */
  function renderAnalyzers(container) {
    //console.trace();
    container.innerHTML = '';

    const btn = el('button', '', '➕');
    btn.addEventListener('click', (e) => {
      const rect  = e.currentTarget.getBoundingClientRect();
      addDecoderMenu.toggleContextMenu(e, {x:rect.left, y:(rect.top+rect.height)});
    });
    const spacer = createNewElement('div', {className:'spacer'});
    const sec = MinimizeCard({ title:'Analyzers', headItems:[spacer, btn]})
    const decoders = store.get().decoders;
    if (decoders.length === 0) sec.bodyAppendChild(el('div', 'hint', 'Add a protocol analyzer to decode UART, I²C or SPI traffic.'));
    const cards = el('div', 'cards');
    for (const d of decoders) cards.appendChild(analyzerCard(d));
    sec.bodyAppendChild(cards);
    container.appendChild(sec.getRoot());
  }

  
function analyzerCard(d) {
    const channels = store.get().channels;

    const eyeText = d.visible ? '👁' : '🚫'; const eyeToolTip = d.visible ? 'Hide rows' : 'Show rows';
    const card = MinimizeCard({
        headItems: [ 
            createNewElement('span', {className:'dot', styles:{background:d.color}}),
            createNewElement('span', {className:'card-title', textContent:d.name}),
            createNewElement('span', {className:'card-sub', textContent:d.summary(channels)}),
            createNewElement('button', {className:'icon-btn', textContent:eyeText, title:eyeToolTip, onclick:()=>{toggleDecoderVisible(d.id)}}),
            createNewElement('button', {className:'icon-btn danger', textContent:'✕', title:'Remove', onclick:()=>{removeDecoder(d.id)}})
        ]
    });

    for (const [key, f] of Object.entries(d.getCfgGui())) {
        const row = el('label', 'form-row' + (f.type === 'bool' ? ' bool' : ''));
        row.appendChild(el('span', null, f.label));

        const v = d.cfg[key];
        const update = (val) => updateDecoder(d.id, { [key]: val });
        let input;

        if (f.type === 'channel' || f.type === 'channel?') {
            input = document.createElement('select');
            if (f.type === 'channel?') { input.appendChild(new Option('None', '')); }
            for (const ch of channels) { input.appendChild(new Option(ch.name, String(ch.index))); }
            input.value = v == null ? '' : String(v);
            input.addEventListener('change', () =>
                update(input.value === '' ? null : Number(input.value))
            );

        } else if (f.type === 'select') {
            input = document.createElement('select');
            for (const [k, label] of f.options) { input.appendChild(new Option(label, String(k))); }
            input.value = String(v);
            input.addEventListener('change', () => {
                const opt = f.options.find(([k]) => String(k) === input.value);
                if (opt) update(opt[0]);
            });

        } else if (f.type === 'bool') {
            input = createNewElement('input', {type:'checkbox', checked:Boolean(v), onchange:(e)=>{update(e.currentTarget.checked)}});
        } else if (f.type === 'js_code_edit') {
            row.className = 'form-col';
            input = createNewElement('div', { styles: { width: '100%' } });
            const codeText = createNewElement('textarea', {styles: { width: '100%', minHeight: '200px', background: '#AAA' }, value: v,
                onchange: (e) => update(e.currentTarget.value)
            });
            const codeEditOpenBtn = createNewElement('button', {
                textContent: 'edit',
                styles: { width: '100%', background: '#494949' },
                onclick: () => {
                    WS.customDecoderEditor.open({
                        code: codeText.value,
                        onSave: (code) => {
                            update(code);
                        },
                        onRunDecoder: (code) => {
                            update(code);
                            const res = d.compile();

                            if (res !== true) {
                                InfoDialog.Show({ title: 'Custom Code Error', message: res });
                            }
                        }
                    });
                }
            });

            const codeRunBtn = createNewElement('button', { textContent: 'run', styles: { width: '100%', background: '#494949' },
                onclick: () => {
                    update(codeText.value);
                    const res = d.compile();
                    if (res !== true) {
                        InfoDialog.Show({ title: 'Custom Code Error', message: res });
                    }
                }
            });
            const buttons = createNewElement('div', { className: 'form-row' });
            buttons.append(codeEditOpenBtn, codeRunBtn);
            input.append(codeText, buttons);

        } else {
            input = document.createElement('input'); input.className = 'mono'; input.value = String(v);
            const commit = () => { const n = Number(input.value); if (isFinite(n) && n > 0 && n !== v) update(n); else input.value = String(v); };
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
        }
        row.appendChild(input);
        card.bodyAppendChild(row);
    }

    return card.card;
}


  /*function analyzerCard(d) {
    //console.log(d);
    const channels = store.get().channels;
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    const toggleBtn = el('button', 'icon-btn', '▾');
    const body = el('div', 'card-body');
    let open = true;
    toggleBtn.addEventListener('click', () => {
      open = !open;
      toggleBtn.textContent = open ? '▾' : '▸';
      body.style.display = open ? 'grid' : 'none';
    });
    head.appendChild(toggleBtn);
    head.appendChild(el('span', 'dot', '')); head.lastChild.style.background = d.color;
    head.appendChild(el('span', 'card-title', d.name));
    head.appendChild(el('span', 'card-sub', d.summary(channels)));
    const eyeBtn = el('button', 'icon-btn', d.visible ? '👁' : '🚫');
    eyeBtn.title = d.visible ? 'Hide rows' : 'Show rows';
    eyeBtn.addEventListener('click', () => toggleDecoderVisible(d.id));
    head.appendChild(eyeBtn);
    const delBtn = el('button', 'icon-btn danger', '✕');
    delBtn.title = 'Remove';
    delBtn.addEventListener('click', () => removeDecoder(d.id));
    head.appendChild(delBtn);
    card.appendChild(head);

    for (const [key, f] of Object.entries(d.getCfgGui())) {
      const row = el('label', 'form-row' + (f.type === 'bool' ? ' bool' : ''));
      row.appendChild(el('span', null, f.label));
      const v = d.cfg[key];
      const update = (val) => updateDecoder(d.id, { [key]: val });
      let input;
      if (f.type === 'channel' || f.type === 'channel?') {
        input = document.createElement('select');
        if (f.type === 'channel?') input.appendChild(new Option('None', ''));
        for (const ch of channels) input.appendChild(new Option(ch.name, String(ch.index)));
        input.value = v === null || v === undefined ? '' : String(v);
        input.addEventListener('change', () => update(input.value === '' ? null : Number(input.value)));
      } else if (f.type === 'select') {
        input = document.createElement('select');
        for (const [k, label] of f.options) input.appendChild(new Option(label, String(k)));
        input.value = String(v);
        input.addEventListener('change', () => { const opt = f.options.find(([k]) => String(k) === input.value); update(opt[0]); });
      } else if (f.type === 'bool') {
        input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(v);
        input.addEventListener('change', () => update(input.checked));
      } else if (f.type === 'js_code_edit') {
        row.className = 'form-col';
        input = createNewElement('div', {styles:{width:'100%'}});
        let codeText = createNewElement('textarea', {styles:{width:'100%', minHeight:'200px', background:'#AAA'}, value:v, onchange:(e)=>{update(e.currentTarget.value)}});
        let codeEditOpenBtn = createNewElement('button', {textContent:'edit', styles:{width:'100%', background:'#494949'},
          onclick:()=>{ 
            WS.customDecoderEditor.open({code:codeText.value,
              onSave:(code) => { 
                update(code);
                //codeText.value = v; // not really necessary
              },
              onRunDecoder:(code) => {
                update(code);
                let res = d.compile();
                if (res != true) {
                    InfoDialog.Show({title:"Custom Code Error", message:res});
                }
                update(code);
                //codeText.value = v; // not really necessary
                
              }
            });
            
          }
        });
        let codeRunBtn = createNewElement('button', {textContent:'run', styles:{width:'100%', background:'#494949'},
          onclick:()=>{
            update(codeText.value);
            let res = d.compile();
            if (res != true) {
                InfoDialog.Show({title:"Custom Code Error", message:res});
            }
            update(codeText.value);
          }
        });
        let buttons = createNewElement('div', {className:'form-row'});
        buttons.append(codeEditOpenBtn, codeRunBtn)
        input.append(codeText, buttons);

      } else {
        input = document.createElement('input'); input.className = 'mono'; input.value = String(v);
        const commit = () => { const n = Number(input.value); if (isFinite(n) && n > 0 && n !== v) update(n); else input.value = String(v); };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      }
      row.appendChild(input);
      body.appendChild(row);
    }
    card.appendChild(body);
    return card;
  }*/

  WS.decoders = WS.decoders ?? {};
  WS.decoders.ui = Object.assign(WS.decoders.ui ?? {}, {
    init,
    renderAnalyzers
  });

})(window.WS = window.WS ?? {});
