/**
 * ScriptEditor — edits one of the project's scripts (WS.scripts, scripts/scriptEngine.js), opened with
 * the ✎ button in the Scripts panel: ScriptEditor.openFor(script). One window per script, several can be
 * open; ✎ on a script that already has one brings it to the front.
 * Save keeps the code in the project (saved with it), Run saves and runs it, Remove deletes the script;
 * the output of its last run is shown below the code. Closing the window keeps the changes (saves them).
 *   Ctrl+S save, Ctrl+Enter (or Ctrl+R) run.
 */
class ScriptEditor extends AceEditor {
    #buttonBar = [
        { text: "Save", onClick: () => { this.save(); } },
        { text: "Run", onClick: () => { this.run(); } },
        { text: "Remove", onClick: () => { this.remove(); } },
    ];

    static #Title = "Script";
    static #open = new Map();   // script -> its editor

    /** Opens the editor of `script`: the one that is open, else a new one. */
    static openFor(script) {
        let editor = ScriptEditor.#open.get(script);
        if (!editor) {
            editor = new ScriptEditor(script);
            ScriptEditor.#open.set(script, editor);
        }
        editor.open();
        editor.aceEditor.focus();
        return editor;
    }

    /** The script being edited. */
    script;
    #unsubscribe;

    constructor(script) {
        super({ title: ScriptEditor.#Title, singleton: false, aceTheme: "textmate", aceMode: "javascript" });
        this.setStates({ height: 700, width: 760 });
        this.script = script;

        this.aceEditor.commands.addCommand({ name: "save", bindKey: { win: "Ctrl-S", mac: "Command-S" }, exec: () => this.save() });
        for (const [name, key] of [["run", "Enter"], ["run2", "R"]]) {
            this.aceEditor.commands.addCommand({ name, bindKey: { win: "Ctrl-" + key, mac: "Command-" + key }, exec: () => this.run() });
        }

        this.header_el.style.paddingBottom = '0px';
        const toolbar_el = appendNewElement(this.header_el, 'div', { styles: { width: '100%', display: 'flex', flexDirection: 'row', boxSizing: 'border-box', padding: '0px', marginBottom: '4px' } });
        appendNewElement(toolbar_el, 'span', { textContent: 'A script runs only when you press Run, and can use everything the page can.', styles: { alignSelf: 'center', fontSize: '11px', color: '#888' } });
        const buttons_el = createButtonBar(this.#buttonBar);
        buttons_el.style.marginLeft = 'auto';
        toolbar_el.appendChild(buttons_el);

        // the editor takes the free space, the output a strip below it
        setStyles(this.aceEditor_el, { flex: '1', minHeight: '0', height: 'auto' });
        this.output_el = appendNewElement(this.body_el, 'div', { className: 'script-output' });

        this.aceEditor.setSession(new ace.EditSession(script.code, 'ace/mode/javascript'));
        this.#showScript();

        // the output follows the script's runs (also the ones started from the panel), a removed script closes the editor
        this.#unsubscribe = WS.scripts.list.subscribe(() => {
            if (!WS.scripts.list.value.includes(this.script)) this.close();
            else this.#showScript();
        });

        // closed: keep the changes, then the window is gone (a new one is made the next time)
        this.onClose = () => {
            this.save();
            this.#unsubscribe();
            ScriptEditor.#open.delete(this.script);
            this.destroy();
        };
    }

    /** Keeps the code in the project (nothing when the script was removed). */
    save() {
        WS.scripts.update(this.script.name, this.aceEditor.getValue());
    }

    run() {
        this.save();
        WS.scripts.run(this.script);
    }

    remove() {
        const script = this.script;
        ConfirmDialog.Show({
            title: "Remove script", message: `Remove the script ${script.name}? Its code is lost.`,
            confirmText: "Remove", confirmClass: "button-danger",
            onConfirm: () => WS.scripts.remove(script.name),
        });
    }

    #showScript() {
        this.setTitle(`${ScriptEditor.#Title} - ${this.script.name}`);
        this.output_el.replaceChildren(...(this.script.output ?? []).map(({ text, error }) =>
            createNewElement('div', { textContent: text, className: error ? 'error' : '' })));
        this.output_el.scrollTop = this.output_el.scrollHeight;
    }
}
