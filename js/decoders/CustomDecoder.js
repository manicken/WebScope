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
        class: CustomDecoder
    };

    static GuiConfigData = {
        code: {label:'code', type:'js_code_edit', default: CustomDecoderExampleCode},
        custom:{ label: 'custom', type: 'custom', default: []},
    }
    
    getCfgGui() {
        return {...CustomDecoder.GuiConfigData, ...this.#decoder?.getCfgGui()};
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
            decoder?.init(this);
            this.#decoder = decoder;

            return true;
        } catch (ex) {
            console.error(ex);
            return ex;
        }
    }

    rows() {
        return this.#decoder?.rows?.(this) ?? [];
    }

    run(input) {
        return this.#decoder?.run?.(input, this);
    }

/* custom decoder example:

*/
}

window.WS.decoders.registry.push(CustomDecoder.Info);