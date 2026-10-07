
class Decoder {

    static FORMAT_FIELD = { label: 'Display', type: 'select', options: [['hex', 'Hex'], ['dec', 'Decimal'], ['bin', 'Binary'], ['ascii', 'ASCII']] };

    constructor() {
        this.id = 0; // instance id
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
}