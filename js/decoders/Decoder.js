
class Decoder {

    static FORMAT_FIELD = { label: 'Display', type: 'select', options: [['hex', 'Hex'], ['dec', 'Decimal'], ['bin', 'Binary'], ['ascii', 'ASCII']] };

    decode(input) {
        throw new Error('Not implemented');
    }
}