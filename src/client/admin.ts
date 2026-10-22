// Comportements de l'administration : plages horaires, confirmations, couleur, adresse.

function rangeRow(prefix: string, label: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "range";
  row.dataset.range = "";
  const input = (suffix: string, aria: string) => {
    const el = document.createElement("input");
    el.className = "input";
    el.type = "text";
    el.inputMode = "numeric";
    el.maxLength = 5;
    el.placeholder = suffix === "debut" ? "09:00" : "18:00";
    el.pattern = "[0-2][0-9]:[0-5][0-9]";
    el.name = `${prefix}_${suffix}`;
    el.setAttribute("aria-label", `${label}, ${aria}`);
    return el;
  };
  const sep = document.createElement("span");
  sep.className = "range-sep";
  sep.setAttribute("aria-hidden", "true");
  sep.textContent = "à";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-btn";
  remove.dataset.removeRange = "";
  remove.setAttribute("aria-label", `Retirer cette plage, ${label}`);
  remove.textContent = "Retirer";
  row.append(input("debut", "début"), sep, input("fin", "fin"), remove);
  return row;
}

document.addEventListener("click", (e) => {
  const target = e.target as Element;
  const add = target.closest<HTMLElement>("[data-add-range]");
  if (add) {
    const box = add.closest<HTMLElement>("[data-ranges]");
    if (!box) return;
    box.querySelector("[data-empty]")?.remove();
    const row = rangeRow(box.dataset.prefix ?? "", box.dataset.label ?? "");
    add.parentElement!.before(row);
    row.querySelector("input")?.focus();
    return;
  }
  const remove = target.closest<HTMLElement>("[data-remove-range]");
  if (remove) {
    const box = remove.closest<HTMLElement>("[data-ranges]");
    const row = remove.closest("[data-range]");
    row?.remove();
    if (box && !box.querySelector("[data-range]")) {
      const empty = document.createElement("p");
      empty.className = "range-off";
      empty.dataset.empty = "";
      empty.textContent = box.dataset.emptyText ?? "Indisponible";
      box.prepend(empty);
    }
    box?.querySelector<HTMLElement>("[data-add-range]")?.focus();
  }
});

document.addEventListener("submit", (e) => {
  const form = e.target as HTMLFormElement;
  const message = form.dataset.confirm;
  if (message && !window.confirm(message)) e.preventDefault();
});

// Couleur d'accent : sélecteur natif et saisie hexadécimale synchronisés.
const picker = document.querySelector<HTMLInputElement>("[data-color-picker]");
const text = document.querySelector<HTMLInputElement>("[data-color-text]");
if (picker && text) {
  picker.addEventListener("input", () => {
    text.value = picker.value;
  });
  text.addEventListener("input", () => {
    if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value.toLowerCase();
  });
}

// Adresse de la page déduite du titre tant qu'elle n'a pas été modifiée.
const title = document.querySelector<HTMLInputElement>("#title");
const slug = document.querySelector<HTMLInputElement>("#slug");
if (title && slug && slug.value === "") {
  let touched = false;
  slug.addEventListener("input", () => {
    touched = true;
  });
  title.addEventListener("input", () => {
    if (touched) return;
    slug.value = title.value
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  });
}

// Précision du lieu masquée pour Google Meet.
const locationField = document.querySelector<HTMLInputElement>("#locationValue")?.closest<HTMLElement>(".field");
const locationRadios = Array.from(document.querySelectorAll<HTMLInputElement>("[data-location-type]"));
if (locationField && locationRadios.length) {
  const sync = () => {
    locationField.hidden = locationRadios.find((r) => r.checked)?.value === "meet";
  };
  for (const r of locationRadios) r.addEventListener("change", sync);
  sync();
}

// Exception : plages visibles uniquement pour des horaires spécifiques.
const modeRadios = Array.from(document.querySelectorAll<HTMLInputElement>("input[name=mode]"));
const excRanges = document.querySelector<HTMLElement>("[data-ranges][data-prefix=exc]");
if (modeRadios.length && excRanges) {
  const sync = () => {
    excRanges.hidden = modeRadios.find((r) => r.checked)?.value !== "hours";
  };
  for (const r of modeRadios) r.addEventListener("change", sync);
  sync();
}

// Nom du fichier choisi pour la photo.
const fileInput = document.querySelector<HTMLInputElement>("[data-file-input]");
const fileName = document.querySelector<HTMLElement>("[data-file-name]");
if (fileInput && fileName) {
  fileInput.addEventListener("change", () => {
    fileName.textContent = fileInput.files?.[0]?.name ?? "Aucun fichier choisi";
  });
}
