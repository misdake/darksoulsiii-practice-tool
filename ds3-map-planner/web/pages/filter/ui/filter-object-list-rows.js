export function createHitFilterRow({
  document,
  text,
  buttonTitle,
  buttonHtml,
  onToggle,
}) {
  const row = document.createElement("div");
  row.className = "hf-row";

  const label = document.createElement("span");
  label.textContent = text;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "hf-btn";
  button.title = buttonTitle;
  button.innerHTML = buttonHtml;
  button.addEventListener("click", onToggle);

  row.appendChild(label);
  row.appendChild(button);
  return row;
}

export function createObjectRow({
  document,
  key,
  checked,
  text,
  onToggle,
  onSelect,
  targetObj,
  registerRow,
}) {
  const row = document.createElement("label");
  row.className = "obj-item";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = checked;
  checkbox.addEventListener("change", () => onToggle(checkbox.checked));

  const label = document.createElement("span");
  label.textContent = text;

  targetObj.userData.rowKey = key;
  registerRow(key, row);
  row.addEventListener("click", (event) => {
    if (event.target?.tagName?.toLowerCase() === "input") {
      return;
    }
    onSelect();
  });

  row.appendChild(checkbox);
  row.appendChild(label);
  return row;
}
