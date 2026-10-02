class CustomDecoder extends Decoder {
    #decode;

    constructor(code) {
        super();
        this.compile(code);
    }

    compile(code) {
        try {
            this.#decode = eval(code);
            return true;
        } catch (ex) {
            console.log(ex);
            // TODO custom emit here
            return false;
        }
    }

    decode(input) {
        return this.#decode(input, this);
    }

    /* custom decoder example:

        (input, context) => {
            
        }

    */
}