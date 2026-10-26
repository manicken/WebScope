let CustomDecoderExampleCode = `
({
    /** in all functions self is the Decoder Instance */
    /** runs directly after the compile is done */
    init(self) {

    },
    /** called from custom decoder rows function*/
    rows(self) {
        return [
            {id:'data', label: 'DATA' },
            {id:'address', label: 'ADDRESS' }
        ];
    },
    /** called from custom decoder run function */
    run(self) {
        const input = self.getSource();
        return {};
    }
})
`;

class CustomDecoder extends Decoder {
    static Info = {
        name: "Custom",
        longname: 'Custom Decoder',
        desc: 'Custom Decoder that can be changed at runtime',
        class: CustomDecoder
    };

    static GuiConfigData = {
        code: {label:'code', type:'js_code_edit', default: CustomDecoderExampleCode},
        //subDecoders:{ label: 'Sub-Analyzers', type: 'subDecoders', default: []},
    }
    
    getCfgGui() {
        return {...CustomDecoder.GuiConfigData, ...this.#decoder?.getCfgGui?.(this)};
    }

    /** static method, no filter */
    static GetSourceTypes() {
        return ['*'];
    }

    /**
     * Instance override: restricts which decoder TYPEs may be stacked on this CD.
     * Defaults to ['*'] (accept all) so sub-decoders can be added before the user code has run.
     */
    GetSourceTypes() {
        return this.#decoder?.GetSourceTypes?.() ?? CustomDecoder.GetSourceTypes();
    }

    #decoder = null;

    constructor(p) {
        super(p);
    }

    summary(channels) {
        return '';
    }

    compile() {
        try {
            const factory = new Function(`return (${this.cfg.code})`);
            const decoder = factory();

            if (typeof decoder !== 'object' || decoder === null) {
                throw new TypeError('Custom decoder must return an object');
            }
            if (typeof decoder.run !== 'function') {
                throw new TypeError('Custom decoder must implement a run(self) function');
            }
             if (typeof decoder.rows !== 'function') {
                throw new TypeError('Custom decoder must implement a rows(self) function');
            }
            decoder?.init(this);
            this.#decoder = decoder;

            return true;
        } catch (ex) {
            console.error("Compile error in CustomDecoder:", ex);
            return ex;
        }
    }

    getOutput() {
        if (!this.#decoder) { console.warn("@ getOutput - CustomDecoder not initialized yet!"); }
        return this.#decoder?.getOutput?.() ?? null;
    }

    rows() {
        //if (!this.#decoder) { console.warn("@ rows - CustomDecoder not initialized yet!"); }
        return this.#decoder?.rows?.(this) ?? {};
    }

    run() {
        if (!this.#decoder) { console.warn("@ run - CustomDecoder not initialized yet!"); }
        return this.#decoder?.run?.(this);
    }

/* custom decoder example:

*/
}

window.WS.decoders.registry.push(CustomDecoder.Info);