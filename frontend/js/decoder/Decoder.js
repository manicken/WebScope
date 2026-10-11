
class Decoder {

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

    constructor({id=null, color='#FFF'}={}) {
        if (id == null) {
            throw Error("decoder ID must be provided");
        }
        this.id = id; // instance id
        this.color = color; // instance color
        this.visible = true;
        this.cfg = {};
        this.subDecoders = [];
        this.loadDefaultConfig(this.constructor.GuiConfigData, this.cfg);
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
}