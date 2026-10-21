class InfoDialog extends AppWindow {
    static #slots = new Set();
    #slot = null;

    static #claim() { let n = 0; while (InfoDialog.#slots.has(n)) n++; InfoDialog.#slots.add(n); return n; }


    constructor({ title = "Info", message = "", backdrop = true, buttonText = "OK", z=3000, onConfirm = () => {} } = {})
    {
        super({ title, backdrop, closeOnBackdropClick: false, z, resizable:true });
        this.setBody(createNewElement("div", { innerHTML: message, styles: { padding: "8px" } }));
        this.setFooter(createButtonBar([
            {
                text: buttonText,
                onClick: () => {
                    this.destroy();
                    onConfirm();
                }
            }
        ]));
    }
    static Show(p={}) {
        const states = { height: 200, width: 350, ...p.states };
        const dlg = new InfoDialog(p);

        if (p.backdrop === false) {                       // only stack windows that don't block the app
            const STEP = 28;
            const maxX = Math.max(0, innerWidth - states.width);
            const maxY = Math.max(0, innerHeight - states.height);
            const cols = Math.max(1, Math.floor(Math.min(maxX, maxY) / 2 / STEP));
            dlg.#slot = InfoDialog.#claim();
            const k = (dlg.#slot % cols) - cols / 2;      // spread around the center
            states.x = maxX / 2 + k * STEP;
            states.y = maxY / 2 + k * STEP;
        }
        dlg.setStates(states).open();
    }

    destroy() {
        if (this.#slot !== null) { InfoDialog.#slots.delete(this.#slot); this.#slot = null; }
        super.destroy();
    }
}

class NotImplementedMessageDialog {
    static Show() {
        console.trace("This function is not yes implemented");
        InfoDialog.Show({message:"This function is not yes implemented"});
    }
}

class CallBackNotSetDialog {
    static Show(name) {
        console.trace("the callback is not set: " + name);
        InfoDialog.Show({message:"the callback is not set: " + name});
    }
}
