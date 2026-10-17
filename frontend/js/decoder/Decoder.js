'use strict';

class Decoder {
    
    static get TYPE() {
        return this.name;
    }


    static Info = {
        name: '',
        longname: '',
        desc: '',
        class: Decoder // to be changed to the current class
    };

    /**
     * Types this decoder can consume as input:
     *  - 'logic' = raw captured channels (default, i.e. a root decoder)
     *  - a decoder TYPE (e.g. 'i2c') = stacks on decoders of that type
     *  - '*'     = accepts any source (CustomDecoder)
     */
    static GetSourceTypes() {
        return ['logic'];
    }

    static FORMAT_FIELD = { label: 'Display', type: 'select', options: [['hex', 'Hex'], ['dec', 'Decimal'], ['bin', 'Binary'], ['ascii', 'ASCII']] };
    static AsFormat({word, type, hexPadding=2, binPadding=8}) {
        if (type === 'dec') {
            return word.toString();
        } else if (type === 'bin') {
            return word.toString(2).padStart(binPadding, '0').toUpperCase();
        } else if (type === 'ascii') {
            return (word >= 32 && word < 127) ? String.fromCharCode(word) : '\\x' + word.toString(16).padStart(hexPadding, '0');
        } else { // hex and default
            return word.toString(16).padStart(hexPadding, '0').toUpperCase();
        }

    }

    constructor({id=null, color='#FFF', parentDecoder=null}={}) {
        if (id == null) {
            throw Error("decoder ID must be provided");
        }
        /** instance id */
        this.id = id;
        /** instance color */
        this.color = color;
        this.visible = true;
        this.cfg = {};
        /** points to the decoder:s parent, 
         *  if null then it's a root decoder, 
         *  this is used to keep track of it's parent 
         *  so that when a subdecoder is removed 
         *  it can also be removed from the parent
         */
        this.parent = parentDecoder;
        /** contains a list of subdecoders that consume this decoder:s output */
        this.subDecoders = [];

        this.loadDefaultConfig(this.constructor.GuiConfigData, this.cfg);
    }

    addSubDecoder(decoder) {
        this.subDecoders.push(decoder);
    }

    getSource() {
        if (!this.parent)
            return window.WS.capture.getBuffer();

        if (typeof this.parent.getOutput !== 'function')
            throw new Error('Parent decoder does not implement getOutput()');

        let src = this.parent.getOutput();
        if (src == null) {
            throw new Error('Decoder getOutput() returned null');
        }
        return src;
    }

    get name() {
        return this.constructor.Info.name;
    }

    loadDefaultConfig(src, dest) {
        for (const [name, value] of Object.entries(src)) {
            dest[name] = value.default;
        }
    }

    run(input) {
        throw new Error('Not implemented');
    }

    rows() {
        throw new Error('Not implemented');
    }

    summary() {
        return '';
    }

    getState() {
        return {
            type:this.constructor.TYPE, 
            cfg:this.cfg, 
            color:this.color, 
            id:this.id, 
            parent:this.parent?.id??null, 
            subDecoders:this.subDecoders.map((d)=>d.id), 
            visible:this.visible 
        };
    }

    /** very important this function need to be run after all decoders have been instantiated  */
    setState(v, decoders =  window.WS.store.get().decoders) {
        const dFind = (id) => decoders.find((d) => d.id === id);
        this.cfg = v.cfg;
        //this.color = v.color; set by the constructor
        //this.id = v.id; set by the constructor
        this.parent = v.parent != null ? dFind(v.parent) : null;
        this.subDecoders = (v.subDecoders ?? []).map(id => {
            const decoder = dFind(id);
            if (!decoder)
                throw new Error(`Decoder ${id} not found`);

            return decoder;
        });
        this.visible = v.visible;
        
    }

    destroy() {
        console.log(`Städar upp decoder instans: ${this.id} (${this.name})`);

        // 1. remove from the parent
        if (this.parent) {
            const index = this.parent.subDecoders.indexOf(this);
            if (index !== -1) {
                this.parent.subDecoders.splice(index, 1);
            }
            this.parent = null;
        }

        // 2. remove all subdecoders 
        while (this.subDecoders.length > 0) {
            const sub = this.subDecoders[0];
            sub.destroy();
        }

        // 3. clear references
        this.cfg = null;
    }

    
}