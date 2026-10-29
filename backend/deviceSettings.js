// deviceSettings.js - device settings: a device describes its settings, the browser draws the form from that.
//
// A device that has settings puts them in its device info:
//   settings: {
//       title: 'WiFi settings',                 the window's title
//       note: 'Saved on the board.',            optional text above the fields
//       fields: [
//           { type: 'heading', label: 'Network' },
//           { key: 'ssid', label: 'Network name', type: 'text', maxLength: 32 },
//           { key: 'password', label: 'Password', type: 'password', maxLength: 63 },
//           { key: 'port', label: 'Port', type: 'number', min: 1, max: 65535, integer: true },
//           { key: 'rate', label: 'Rate', type: 'select', options: [{ value: 9600, label: '9600 baud' }, ...] },
//           { key: 'enabled', label: 'Enabled', type: 'checkbox' },
//       ],                                      every field may also have help: 'text under the field'
//       values: { ssid: '', ... },              the current values
//   }
// and its device kind has applySettings(values) -> Promise<{ message, info }> (info: the device info with the
// new settings), which throws Error(message) when the values cannot be used.
//
// Browser -> backend: { type: 'deviceSettings', reqId, deviceId, values }
// Backend -> browser: { type: 'deviceSettings', reqId, ok, message }, then to every browser
//                     { type: 'deviceUpdated', device: info }
//
// The browser checks the same rules (frontend/js/libs/internal/AppWindows/DeviceSettingsDialog.js), but the
// backend has to check them again: anything can send it a message.

/**
 * The values checked against the settings' fields: every field's value, from `values` or else the current one.
 * Throws Error(message) naming the field.
 */
export function validateSettings(settings, values) {
    const out = {};
    for (const f of settings.fields) {
        if (!f.key) continue;                                   // a heading
        const v = values?.[f.key] ?? settings.values?.[f.key];
        const bad = (why) => new Error(`${f.label}: ${why}`);
        switch (f.type) {
            case 'number':
                if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('must be a number');
                if (f.integer && !Number.isInteger(v)) throw bad('must be a whole number');
                if (f.min !== undefined && v < f.min) throw bad(`must be at least ${f.min}`);
                if (f.max !== undefined && v > f.max) throw bad(`must be at most ${f.max}`);
                break;
            case 'text':
            case 'password':
                if (typeof v !== 'string') throw bad('must be text');
                if (f.maxLength !== undefined && v.length > f.maxLength) throw bad(`at most ${f.maxLength} characters`);
                break;
            case 'select':
                if (!f.options.some((o) => o.value === v)) throw bad(`"${v}" is not one of the choices`);
                break;
            case 'checkbox':
                if (typeof v !== 'boolean') throw bad('must be on or off');
                break;
            default:
                throw bad(`unknown field type "${f.type}"`);
        }
        out[f.key] = v;
    }
    return out;
}
