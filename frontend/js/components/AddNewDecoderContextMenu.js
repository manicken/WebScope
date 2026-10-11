
class AddNewDecoderContextMenu extends ContextMenu {

    constructor({itemClickedCb = (item) => {console.warn("itemClickedCb not set");}}={}) {
        super({width:128, height:400});
        this.itemClickedCb = itemClickedCb;
    }

    setItems(items) {
        console.log(items);
        this.searchInput_el = createNewElement("input", {
            className: "",
            type: "search",
            placeholder: "Search..."
        });
        this.list_el = createNewElement("div", {
            className: "",
            styles: {
                flex: '1 1 auto',
                minHeight: 0,
                overflow: 'auto',
                position: 'relative',
            }
        });

        for (const item of items) {
            
            let new_el = createNewElement("div", {
                className:"context-menu-item",
                textContent:item.name,
                onclick: () => {this.itemClickedCb(item)}
            });
            this.list_el.appendChild(new_el);
        }
        super.setItems(this.searchItem_el, this.list_el);
    }
}