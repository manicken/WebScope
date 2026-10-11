
class ContextMenu {

    constructor({x=0, y=0, width=0, height=0}={}) {
        this.contextMenu_el = createNewElement("div", {
            className: "context-menu"
        });
        
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;

        document.addEventListener("click", () => {
            this.hideContextMenu();
        });
        this.#updateBoundingBox();
        document.body.appendChild(this.contextMenu_el);
        this.hideContextMenu();
    }

    clearItems() {
        this.contextMenu_el.replaceChildren();
    }

    setItems(...items) {
        this.clearItems()
        this.contextMenu_el.append(...items);
    }

    appendItems(...items) {
        this.contextMenu_el.append(...items);
    }

    toggleContextMenu(event, {x=null, y=null, width=null, height=null}={}) {
        if (this.visible) {
            this.hideContextMenu(); // sets this.visible = false
        } else {
            this.showContextMenu(event, {x,y,width,height}); // sets this.visible = true
        }
    }

    showContextMenu(event, {x=null, y=null, width=null, height=null}={}) {
        this.visible = true;
        //event.preventDefault();
        event.stopPropagation();
        //console.log(x,y,height,width, this);
        this.contextMenu_el.style.display = "block";

        this.x = x ?? this.x;
        this.y = y ?? this.y;
        this.width = width ?? this.width;
        this.height = height ?? this.height;

        this.#updateBoundingBox();
    }

    #updateBoundingBox() {
        const menu = this.contextMenu_el;
        this.width = Math.max(10, this.width);
        this.height = Math.max(10, this.height);
        
        // prevent the menu from going outside the window
        if (this.x + this.width > window.innerWidth)
            this.x = window.innerWidth - this.width - 4;

        if (this.y + this.height > window.innerHeight)
            this.y = window.innerHeight - this.height - 4;

        
        menu.style.left = `${this.x}px`;
        menu.style.top = `${this.y}px`;
        menu.style.width = `${this.width}px`;
        menu.style.height = `${this.height}px`;
    }

    hideContextMenu() {
        this.visible = false;
        this.contextMenu_el.style.display = "none";
    }

}