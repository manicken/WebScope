
class InputDialog extends AppWindow {

    constructor({ title = "Input", message = "Enter Value: ", confirmText = "OK", value = "", enterConfirm=true, confirmClass = "", onValidate = (value) => { return true; }, onConfirm = (value) => {} } = {}) {
        super({ title, backdrop: true, closeOnBackdropClick: false});
        this.onValidate = onValidate;
        this.onConfirm = onConfirm;

        let body_el = createNewElement('div', {styles:{width: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding:'8px'}})
        let message_el = createNewElement("div", { innerHTML: message, styles: { padding: "8px" } });
        this.input_el = createNewElement('input', { type:"text" });
        this.error_el = createNewElement('div', {styles:{display:'none', color:'#b40000'}});
        
        if (enterConfirm == true) {
            this.input_el.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.#validateAndConfirm();
                }
            });
        }
        this.input_el.value = value;
        body_el.appendChild(message_el);
        body_el.appendChild(this.input_el);
        body_el.appendChild(this.error_el);

        this.setBody(body_el);
        this.setFooter(createButtonBar([
            {
                text: confirmText,
                className: confirmClass,
                onClick: () => {
                    this.#validateAndConfirm();
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

    #validateAndConfirm() {
        let validationRes = this.onValidate(this.input_el.value); 
        if (validationRes !== true) {
            this.error_el.textContent = validationRes;
            this.error_el.style.display = '';
            //infoAppWindow({message:validationRes, z:3000});
            this.input_el.focus();
            return;
        }
        this.error_el.style.display = 'none';
        this.onConfirm(this.input_el.value);
        this.destroy();
    }

    open() {
        super.open();
        this.input_el.focus();
    }

    static Show(p={}) {
        new InputDialog(p).setStates({height: 200, width: 350}).open();
    }
}