class CustomDecoderEditor extends AceEditor {
    #buttonBar = [
        {
            text: "Save",
            onClick: () => {this.save();}
        },
        {
            text: "Run",
            onClick: () => { this.run(); }
        },
    ];

    constructor() {
        super({title:"Custom Decoder Editor", singleton:true, aceTheme:"textmate", aceMode:"javascript"});
        this.setStates({height: 700, width: 700});

        this.aceEditor.commands.addCommand({
            name: "save",
            bindKey: { win: "Ctrl-S", mac: "Command-S" },
            exec: () => this.save()
        });

        this.aceEditor.commands.addCommand({
            name: "run",
            bindKey: { win: "Ctrl-R", mac: "Command-R" },
            exec: () => this.run()
        });

        this.header_el.style.paddingBottom = '0px';

        let toolbar_el = appendNewElement(this.header_el, 'div', {styles:{width: '100%', display: 'flex', flexDirection: 'row', boxSizing: 'border-box', padding:'0px', marginBottom:'4px'}});
        
        let buttons_el = createButtonBar(this.#buttonBar);
        buttons_el.style.marginLeft = 'auto';
        toolbar_el.appendChild(buttons_el);

    }

    save() {
        this.onSave(this.aceEditor.getValue());
    }

    run() {
        this.onRunDecoder(this.aceEditor.getValue());
    }

    open({onRunDecoder=(code)=>{}, onSave=(code)=>{}, code=null}={}) {
        super.open();
        this.onRunDecoder = onRunDecoder;
        this.onSave = onSave;
        if (code!=null) {
            this.aceEditor.setValue(code);
        }
    }

    showError(err) {

    }

}