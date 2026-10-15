let CustomDecoderExampleCode = `
({
    /** in all functions context is the Decoder Instance */
    /** runs directly after the compile is done */
    init(context) {

    },
    /** called from custom decoder rows function*/
    rows(context) {
        return [
            {id:'data', label: 'DATA' },
            {id:'address', label: 'ADDRESS' }
        ];
    },
    /** called from custom decoder run function */
    run(input, context) {
        // Decode input
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
        subDecoders:{ label: 'Sub-Analyzers', type: 'subDecoders', default: []},
    }
    
    getCfgGui() {
        return {...CustomDecoder.GuiConfigData, ...this.#decoder?.getCfgGui()};
    }

    /** static method, no filter */
    static GetSourceTypes() {
        return [];
    }

    /** instance method, gets it's filter from custom code or defaults to filter that includes nothing */
    GetSourceTypes() {
        return this.#decoder?.GetSourceTypes?.() ?? [null];
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
                throw new TypeError('Custom decoder must implement a run(context) function');
            }
             if (typeof decoder.rows !== 'function') {
                throw new TypeError('Custom decoder must implement a rows(context) function');
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
        if (typeof this.#decoder?.getOutput !== 'function')
            throw new Error('Custom decoder does not implement getOutput()');

        return this.#decoder.getOutput();
    }

    rows() {
        //if (!this.#decoder) { console.warn("@ rows - CustomDecoder not initialized yet!"); }
        return this.#decoder?.rows?.(this) ?? {};
    }

    run(input) {
        if (!this.#decoder) { console.warn("@ run - CustomDecoder not initialized yet!"); }
        return this.#decoder?.run?.(input, this);
    }

/* custom decoder example:

*/
}

window.WS.decoders.registry.push(CustomDecoder.Info);