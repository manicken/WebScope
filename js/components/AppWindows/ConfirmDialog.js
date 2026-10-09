
class ConfirmDialog extends AppWindow {

    constructor({ title = "Confirm", message = "", confirmText = "OK", confirmClass = "", onConfirm = () => {} } = {}) {
        super({ title, backdrop: true, closeOnBackdropClick: false });
        this.setBody(createNewElement("div", { innerHTML: message, styles: { padding: "8px" } }));
        this.setFooter(createButtonBar([
            {
                text: confirmText,
                className: confirmClass,
                onClick: () => {
                    this.destroy();
                    onConfirm();
                }
            },
            {
                text: "Cancel",
                onClick: () => {
                    this.destroy();
                }
            }
        ]));
    }

    static Show(p={}) {
        new ConfirmDialog(p).setStates({height: 200, width: 350}).open();
    }
}