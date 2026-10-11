function appendInputFieldWithLabel(container, inputOptions) {
    //let container = document.getElementById(container_id);
    let labelEl = document.createElement('label');
    if (inputOptions.id !== undefined)
        labelEl.htmlFor = inputOptions.id;
    labelEl.textContent = inputOptions.labelText;
    container.appendChild(labelEl);
    let inputEl = document.createElement('input');
    if (inputOptions.id !== undefined)
        inputEl.id = inputOptions.id;
    inputEl.type = inputOptions.type;
    inputEl.value = inputOptions.value;
    inputEl.min = inputOptions.min;
    inputEl.max = inputOptions.max;
    inputEl.step = inputOptions.step;

    if (typeof inputOptions.styles === "object") {
        for (const [name, value] of Object.entries(inputOptions.styles)) {
            inputEl.style[name] = value;
        }
    }
    
    container.appendChild(inputEl);
    return inputEl;
}

function appendButton(container, label, id) {
    let btn = document.createElement("button");
    btn.textContent = label;
    btn.id = id;
    container.appendChild(btn);
    return btn;
}

function appendWriteValueToAddressControl(container, id_base, initial_addr, initial_value, setHandler) {
    if (typeof container == "string") { 
        container = document.getElementById(container);
    }
    let control = document.createElement("div");
    control.className = "row";
    let addrInputId = `write-to-${id_base}-addr`;
    let valueInputId = `write-to-${id_base}-value`;
    if (initial_addr == undefined) {
        initial_addr = "0x0000";
    }
    if (initial_value == undefined) {
        initial_value = "0x00";
    }
    container.appendChild(document.createElement('hr'));
    appendInputFieldWithLabel(control, {type:"text", id:addrInputId, labelText:"Address:", value:initial_addr, styles:{width:'48px'}});
    appendInputFieldWithLabel(control, {type:"text", id:valueInputId, labelText:"Value:", value:initial_value, styles:{width:'48px'}});
    let btnSet = document.createElement("button");
    btnSet.textContent = "Set";
    btnSet.onclick = function () {
        let addrValue = parseNumber(document.getElementById(addrInputId).value);
        let valueValue = parseNumber(document.getElementById(valueInputId).value);
        setHandler(addrValue, valueValue);
    };
    control.appendChild(btnSet);
    container.appendChild(control);
}

function appendDiv(container, className, id) {
    let div_el = document.createElement("div");
    div_el.className = className;
    if (id != undefined)
        div_el.id = id;
    container.appendChild(div_el);
    return div_el;
}

function appendBr(container) {
    container.appendChild(document.createElement("br"));
}
function appendH2(container, text) {
    let header_el = document.createElement("h2");
    header_el.textContent = text;
    container.appendChild(header_el);
}
function appendH2_from_data_title(container) {
    let header_el = document.createElement("h2");
    header_el.textContent = container.dataset.title;
    container.appendChild(header_el);
}
function getNewTable_Th(text) {
    let el = document.createElement("th");
    el.textContent = text;
    return el;
}
function appendNewTable_Th(container, text) {
    let el = document.createElement("th");
    el.textContent = text;
    container.appendChild(el);
    return el;
}

function setStyles(el, styles) {
    if (typeof styles === "object") {
        for (const [name, value] of Object.entries(styles)) {
            el.style[name] = value;
        }
    }
}

function createNewElement(tag, options = {}) {
    const el = document.createElement(tag);

    for (const [name, value] of Object.entries(options)) {
        el[name] = value;
    }
    setStyles(el, options.styles);
    
    return el;
}

function appendNewElement(container, tag, options) {
    const el = createNewElement(tag, options);
    container.appendChild(el);
    return el;
}

function getCheckBoxWithLabel(label, tooltip) {
    const label_el = createNewElement("label", {title:tooltip});
    const input_el = createNewElement("input", {type:"checkbox"});
    label_el.textContent = label;
    label_el.appendChild(input_el);
    return {label_el, input_el};
}

function appendCheckBoxWithLabel(container, options={label, tooltip, state, style}, onchange) {
    const label_el = createNewElement("label", {title:options.tooltip});
    const input_el = createNewElement("input", {type:"checkbox"});
    label_el.textContent = options.label;
    label_el.appendChild(input_el);

    input_el.checked = options.state;
    input_el.onchange = () => {
        onchange(input_el.checked);
    };
    for (const [name, value] of Object.entries(options.style)) {
        label_el.style[name] = value;
    }
    container.appendChild( label_el );
}


function renderKeyValueTable(container, regs) {
  let html = "";

  for (let i = 0; i < regs.length; i++) {
    html += `<tr>
      <td class="reg">${regs[i][0]}</td>
      <td class="val">${regs[i][1]}</td>
    </tr>`;
  }
  container.innerHTML = html;
}

