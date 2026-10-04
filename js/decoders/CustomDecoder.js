class CustomDecoder extends Decoder {
    static Info = {
        name: "I2C",
        class: I2CDecoder
    };

    static GuiConfigData = {
        code: {label:'code', type:'js_code_edit', default: ""},
        custom:{ label: 'custom', type: 'custom', default: []},
    }

    #decodeFunc;

    constructor(code) {
        super();
        this.compile(code);
    }

    compile(code) {
        try {
            this.#decodeFunc = eval(code);
            return true;
        } catch (ex) {
            console.log(ex);
            // TODO custom emit here
            return false;
        }
    }

    decode(input) {
        return this.#decodeFunc(input, this);
    }

    /* custom decoder example:

        (input, context) => {
            
        }

    */
}

window.WS.decoderregistry.push(CustomDecoder.Info);