

function closeAllMenus(rootcontainer) {
    rootcontainer.querySelectorAll(".menu.open").forEach(el => {
        el.classList.remove("open");
    });
}

function createMenuItem(rootcontainer, item) {
    if (item === null) {
        const separator = document.createElement("div");
        separator.className = "menu-separator";
        return separator;
    }

    const el = document.createElement("div");
    el.className = "menu-item";

    const button = document.createElement("button");
    button.className = "dropdown-item";
    button.textContent = item.label;
    if (item.comment) {
        button.title = item.comment;
    }

    el.appendChild(button);

    if (item.submenu) {
        const arrow = document.createElement("span");
        arrow.className = "menu-arrow";
        arrow.textContent = "›";
        button.appendChild(arrow);

        const submenu = document.createElement("div");
        submenu.className = "submenu";

        for (const child of item.submenu) {
            submenu.appendChild(createMenuItem(rootcontainer, child));
        }

        el.appendChild(submenu);
        // Ingen click-lyssnare behövs – CSS :hover sköter visning
    }
    else if (item.action) {
        button.addEventListener("click", (e) => {
            closeAllMenus(rootcontainer);
            item.action(e);
        });
    }

    return el;
}

function createMenu(container, menu) {
    for (const item of menu) {
        const menuEl = document.createElement("div");
        menuEl.className = "menu";

        const button = document.createElement("button");
        button.className = "menu-button";
        button.textContent = item.label;
        button.addEventListener("click", (e) => {
            e.stopPropagation();

            const wasOpen = menuEl.classList.contains("open");

            closeAllMenus(container);

            if (!wasOpen) {
                menuEl.classList.add("open");
            }
        });

        const dropdown = document.createElement("div");
        dropdown.className = "dropdown";

        for (const child of item.items) {
            dropdown.appendChild(createMenuItem(container, child));
        }

        menuEl.appendChild(button);
        menuEl.appendChild(dropdown);

        container.appendChild(menuEl);
    }

    document.addEventListener("click", (e) => {
        if (!container.contains(e.target)) {
            closeAllMenus(container);
        }
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closeAllMenus(container);
        }
    });
}

