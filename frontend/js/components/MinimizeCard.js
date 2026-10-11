
function MinimizeCard({ title = null, headItems = [], bodyItems = [], open = true, className = ''} = {}) {
    const card = createNewElement('div', {className:`card ${className}`.trim()});
    const head = createNewElement('div', {className:'card-head'});
    const button = createNewElement('button', {className:'icon-btn'});
    const body = createNewElement('div', {className:'card-body'});

    head.append(button);
    
    /** used for quick and dirty cards */
    if (title) {
        head.append(createNewElement('span', {className:'card-title', textContent:title}));
    }

    head.append(...headItems);

    body.append(...bodyItems);

    card.append(head, body);

    const update = () => {
        button.textContent = open ? '▾' : '▸';
        button.setAttribute('aria-expanded', String(open));
        body.classList.toggle('hidden', !open);
    };

    button.addEventListener('click', () => {
        open = !open;
        update();
    });

    update();

    return {
        card,
        head,
        body,

        getRoot() {
            return card;
        },

        get open() {
            return open;
        },

        setOpen(value) {
            open = Boolean(value);
            update();
        },

        toggle() {
            open = !open;
            update();
        },
        headAppendChild(el) {
            head.appendChild(el);
        },
        bodyAppendChild(el) {
            body.appendChild(el);
        }
    };
}
