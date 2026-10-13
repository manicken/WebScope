class AddNewDecoderContextMenu extends ContextMenu {

    constructor({itemClickedCb = (item) => {console.warn("itemClickedCb not set");}}={}) {
        super({width:256, height:400});
        this.itemClickedCb = itemClickedCb;
    }

    setItems({items=[], decoder=null}={}) {
        this.items = items.filter(item => {
            if (decoder == null) return true;
            //console.log(decoder.GetConsumers);
            const consumerTypes = decoder.GetConsumers?.() ?? item.class.GetConsumers();
            if (consumerTypes.length === 0) return true;
            return consumerTypes.some(type => decoder.constructor.TYPE === type);
        });

        this.searchInput_el = createNewElement("input", {
            type: "search",
            placeholder: "Search...",
            oninput:() => { this.renderItems(); },
            onclick:(e) => { e.stopPropagation(); },
            styles: {
                width: '100%',
                marginLeft: '4px',
                marginRight: '4px',
                boxSizing: 'border-box'
            }
        });

        this.list_el = createNewElement("div", {
            styles: {
                flex: '1 1 auto',
                width: '100%',
                height: '100%',
                minWidth: 0,
                minHeight: 0,
                maxHeight: '100%',
                overflowX: 'hidden',
                overflowY: 'auto',
                boxSizing: 'border-box'
            }
        });

        this.renderItems();

        super.setItems(this.searchInput_el, this.list_el);
    }

    renderItems() {
        const search = this.searchInput_el.value.toLowerCase();

        this.list_el.replaceChildren();

        for (const item of this.items) {
            if (!item.name.toLowerCase().includes(search)) continue;

            const el = createNewElement("div", {
                className: "context-menu-item",
                textContent: item.name,
                onclick: () => this.itemClickedCb(item)
            });

            this.list_el.appendChild(el);
        }
    }
}