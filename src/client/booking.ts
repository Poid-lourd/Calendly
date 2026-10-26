// Amélioration progressive du sélecteur de jour et d'horaire.
// Sans JavaScript, chaque lien recharge la page ; ici, seul le bloc du sélecteur est remplacé.

type Focus = "slots" | "prev" | "next" | "tz" | "first-day" | "last-day" | "none";

const root = document.querySelector<HTMLElement>("[data-picker]");

function setTzCookie(tz: string): void {
  const secure = location.protocol === "https:" ? "; secure" : "";
  document.cookie = `tz=${encodeURIComponent(tz)}; path=/; max-age=31536000; samesite=lax${secure}`;
}

function days(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".cal .day[data-date]"));
}

// Un seul jour dans l'ordre de tabulation, les flèches déplacent le focus.
function roving(container: HTMLElement): void {
  const cells = days(container);
  if (cells.length === 0) return;
  const active =
    cells.find((c) => c.closest("td")?.getAttribute("aria-selected") === "true") ??
    cells.find((c) => c.tagName === "A") ??
    cells.find((c) => c.classList.contains("day--today")) ??
    cells[0]!;
  for (const c of cells) c.tabIndex = c === active ? 0 : -1;
}

function hideNoJs(container: HTMLElement): void {
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-no-js]"))) el.hidden = true;
}

function moveTo(container: HTMLElement, cell: HTMLElement): void {
  for (const c of days(container)) c.tabIndex = -1;
  cell.tabIndex = 0;
  cell.focus();
}

function applyFocus(container: HTMLElement, focus: Focus): void {
  if (focus === "none") return;
  if (focus === "slots") {
    const heading = container.querySelector<HTMLElement>("#horaires-titre");
    heading?.focus();
    heading?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (focus === "tz") {
    container.querySelector<HTMLElement>("#tz")?.focus();
    return;
  }
  if (focus === "prev" || focus === "next") {
    const label = focus === "prev" ? "Mois précédent" : "Mois suivant";
    const link = container.querySelector<HTMLElement>(`a[aria-label="${label}"]`);
    if (link) link.focus();
    else container.querySelector<HTMLElement>(".day[tabindex='0']")?.focus();
    return;
  }
  const cells = days(container);
  const target = focus === "first-day" ? cells[0] : cells[cells.length - 1];
  if (target) moveTo(container, target);
}

if (root) {
  const picker = root;
  let controller: AbortController | null = null;

  const status = () => picker.querySelector<HTMLElement>("[data-status]");

  const load = async (href: string, opts: { history: "push" | "replace" | "none"; focus: Focus }) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    picker.setAttribute("aria-busy", "true");
    const line = status();
    if (line) {
      line.textContent = "Chargement des disponibilités…";
      delete line.dataset.state;
    }
    try {
      const res = await fetch(href, { headers: { "X-Partial": "1" }, credentials: "same-origin", signal: current.signal });
      if (!res.ok) throw new Error(String(res.status));
      const html = await res.text();
      picker.innerHTML = html;
      const url = new URL(href, location.href);
      const tz = url.searchParams.get("tz");
      if (tz) picker.dataset.tz = tz;
      if (opts.history === "push") history.pushState(null, "", url);
      else if (opts.history === "replace") history.replaceState(null, "", url);
      hideNoJs(picker);
      roving(picker);
      applyFocus(picker, opts.focus);
    } catch (err) {
      if (current.signal.aborted) return;
      const el = status();
      if (el) {
        el.textContent = "Le chargement a échoué. Vérifiez votre connexion puis réessayez.";
        el.dataset.state = "error";
      }
      console.error(err);
    } finally {
      if (controller === current) picker.removeAttribute("aria-busy");
    }
  };

  hideNoJs(picker);
  roving(picker);

  picker.addEventListener("click", (e) => {
    const target = e.target as Element;
    const link = target.closest<HTMLAnchorElement>("a[data-nav]");
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const label = link.getAttribute("aria-label");
    const focus: Focus = link.dataset.date ? "slots" : label === "Mois précédent" ? "prev" : label === "Mois suivant" ? "next" : "first-day";
    void load(link.href, { history: "push", focus });
  });

  const tzUrl = (form: HTMLFormElement, tz: string) => {
    const url = new URL(form.action, location.href);
    for (const input of Array.from(form.querySelectorAll<HTMLInputElement>("input[type=hidden]"))) url.searchParams.set(input.name, input.value);
    url.searchParams.set("tz", tz);
    return url.toString();
  };

  picker.addEventListener("change", (e) => {
    const select = e.target as HTMLSelectElement;
    if (select.id !== "tz" || !select.form) return;
    setTzCookie(select.value);
    void load(tzUrl(select.form, select.value), { history: "replace", focus: "tz" });
  });

  picker.addEventListener("submit", (e) => {
    const form = e.target as HTMLFormElement;
    if (!form.matches("[data-tz-form]")) return;
    e.preventDefault();
    const select = form.querySelector<HTMLSelectElement>("#tz");
    if (select) void load(tzUrl(form, select.value), { history: "replace", focus: "tz" });
  });

  picker.addEventListener("keydown", (e) => {
    const cell = (e.target as Element).closest<HTMLElement>(".cal .day[data-date]");
    if (!cell) return;
    const cells = days(picker);
    const index = cells.indexOf(cell);
    const row = Array.from(cell.closest("tr")?.querySelectorAll<HTMLElement>(".day[data-date]") ?? []);
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = index + 1;
        break;
      case "ArrowLeft":
        next = index - 1;
        break;
      case "ArrowDown":
        next = index + 7;
        break;
      case "ArrowUp":
        next = index - 7;
        break;
      case "Home":
        next = row[0] ? cells.indexOf(row[0]) : index;
        break;
      case "End":
        next = row.length ? cells.indexOf(row[row.length - 1]!) : index;
        break;
      case "PageUp":
      case "PageDown": {
        const label = e.key === "PageUp" ? "Mois précédent" : "Mois suivant";
        const link = picker.querySelector<HTMLAnchorElement>(`a[aria-label="${label}"]`);
        e.preventDefault();
        if (link) void load(link.href, { history: "push", focus: "first-day" });
        return;
      }
      case " ":
        if (cell instanceof HTMLAnchorElement) {
          e.preventDefault();
          cell.click();
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    if (next >= 0 && next < cells.length) {
      moveTo(picker, cells[next]!);
      return;
    }
    const label = next < 0 ? "Mois précédent" : "Mois suivant";
    const link = picker.querySelector<HTMLAnchorElement>(`a[aria-label="${label}"]`);
    if (link) void load(link.href, { history: "push", focus: next < 0 ? "last-day" : "first-day" });
  });

  window.addEventListener("popstate", () => {
    void load(location.href, { history: "none", focus: "none" });
  });

  // Fuseau du visiteur : détecté automatiquement, puis mémorisé dans un cookie.
  if (picker.dataset.tzSource === "default") {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) {
      setTzCookie(detected);
      if (detected !== picker.dataset.tz) {
        const url = new URL(location.href);
        url.searchParams.set("tz", detected);
        void load(url.toString(), { history: "replace", focus: "none" });
      }
    }
  }
}

// Liste courte ouverte depuis la signature : fuseau détecté puis page rechargée dans ce fuseau.
const shortlist = document.querySelector<HTMLElement>("[data-tz-auto]");
if (shortlist) {
  for (const el of Array.from(shortlist.querySelectorAll<HTMLElement>("[data-no-js]"))) el.hidden = true;
  const select = shortlist.querySelector<HTMLSelectElement>("select[data-autosubmit]");
  select?.addEventListener("change", () => {
    setTzCookie(select.value);
    select.form?.submit();
  });
  if (shortlist.dataset.tzSource === "default") {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) {
      setTzCookie(detected);
      if (detected !== shortlist.dataset.tz) {
        const url = new URL(location.href);
        url.searchParams.set("tz", detected);
        location.replace(url.toString());
      }
    }
  }
}
