function createButtonBar(buttons = []) {

    const wrapper = document.createElement("div");
    wrapper.className = "button-bar";

    for (const config of buttons) {

        const button = document.createElement("button");

        button.type = "button";
        button.textContent = config.text ?? "";

        if (config.className) {
            button.className = config.className;
        }

        if (config.disabled) {
            button.disabled = true;
        }

        if (config.title) {
            button.title = config.title;
        }

        if (config.onClick) {
            button.addEventListener("click", config.onClick);
        }

        wrapper.appendChild(button);
    }

    return wrapper;
}