// Adresses de page : /personne, puis /personne/type-d-evenement.

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Premiers segments d'URL utilisés par le site : interdits comme adresse de page d'une personne.
export const RESERVED_USER_SLUGS = new Set([
  "admin",
  "auth",
  "b",
  "assets",
  "media",
  "healthz",
  "theme.css",
  "favicon.ico",
  "robots.txt",
  "api",
  "creneaux",
  "signature.png",
  "confidentialite",
]);

// Segments utilisés sous l'adresse d'une personne : interdits comme adresse d'un type d'événement.
export const RESERVED_EVENT_SLUGS = new Set(["creneaux", "signature.png"]);

// Minuscules sans accents, mots séparés par des tirets.
export function slugify(text: string, max = 60): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

// Adresse proposée à la première connexion : partie locale de l'email, prenom.nom devient prenom-nom.
export function slugFromEmail(email: string): string {
  return slugify(email.split("@")[0] ?? "", 40) || "page";
}
