
class Decoder {

    static FORMAT_FIELD = { label: 'Display', type: 'select', options: [['hex', 'Hex'], ['dec', 'Decimal'], ['bin', 'Binary'], ['ascii', 'ASCII']] };

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