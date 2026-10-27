import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, type Page, test } from "@playwright/test";
import { encrypt } from "../../src/lib/crypto.js";
import { DEMO, EMPTY, loginAdmin, openFirstAvailableDay } from "./helpers.js";

// Captures de chaque écran, à 390 px et 1440 px de large, dans docs/screenshots.
const OUT = path.resolve("docs/screenshots");
mkdirSync(OUT, { recursive: true });

async function shoot(page: Page, name: string): Promise<void> {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

test.describe.configure({ mode: "serial" });

test("écrans publics", async ({ page }) => {
  await page.goto(`${DEMO}/`);
  await shoot(page, "01-accueil");

  await page.goto(`${DEMO}/echange-30-min`);
  await expect(page.locator(".cal")).toBeVisible();
  await shoot(page, "02-reservation-calendrier");

  // Chargement : réponse retardée pour figer l'état intermédiaire.
  let release: () => void = () => undefined;
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/echange-30-min?*", async (route) => {
    if (route.request().headers()["x-partial"] === "1") await hold;
    await route.continue();
  });
  const firstDay = page.locator(".cal a.day").first();
  if ((await firstDay.count()) > 0) {
    await firstDay.click();
    await expect(page.locator("[data-picker]")).toHaveAttribute("aria-busy", "true");
    await shoot(page, "03-reservation-chargement");
    release();
    await expect(page.locator("[data-picker]")).not.toHaveAttribute("aria-busy", "true");
  }
  await page.unroute("**/echange-30-min?*");

  // Échec du chargement.
  await page.route("**/echange-30-min?*", (route) =>
    route.request().headers()["x-partial"] === "1" ? route.abort() : route.continue(),
  );
  await page.getByRole("link", { name: "Mois suivant" }).click();
  await expect(page.locator("[data-status]")).toContainText("Le chargement a échoué");
  await shoot(page, "04-reservation-erreur-chargement");
  await page.unroute("**/echange-30-min?*");

  await page.goto(`${DEMO}/echange-30-min`);
  await openFirstAvailableDay(page);
  await shoot(page, "05-reservation-horaires");

  await page.locator(".slots .slot").first().click();
  await expect(page.getByRole("heading", { name: "Vos coordonnées" })).toBeVisible();
  await shoot(page, "06-reservation-formulaire");

  await page.getByRole("button", { name: "Confirmer la réservation" }).click();
  await expect(page.getByText("Indiquez votre nom.")).toBeVisible();
  await shoot(page, "07-reservation-formulaire-erreurs");

  await page.getByLabel("Nom").fill("Jeanne Dupont");
  await page.getByLabel("Email").fill("jeanne.dupont@exemple.fr");
  await page.getByLabel("Note").fill("Refonte du site, premiers éléments de cadrage.");
  await page.getByRole("button", { name: "Confirmer la réservation" }).click();
  await expect(page.getByRole("heading", { name: "Réservation confirmée" })).toBeVisible();
  await shoot(page, "08-reservation-confirmee");
  const manage = page.url().split("?")[0]!;

  await page.getByRole("link", { name: "Reprogrammer" }).click();
  await openFirstAvailableDay(page);
  await shoot(page, "09-reprogrammation-calendrier");
  await page.locator(".slots .slot").last().click();
  await expect(page.getByRole("heading", { name: "Confirmer le nouvel horaire" })).toBeVisible();
  await shoot(page, "10-reprogrammation-confirmation");
  await page.getByRole("button", { name: "Confirmer" }).click();
  await expect(page.getByRole("heading", { name: "Rendez-vous déplacé" })).toBeVisible();
  await shoot(page, "11-rendez-vous-deplace");

  await page.goto(`${manage}/annuler`);
  await shoot(page, "12-annulation");

  // Deuxième réservation, annulée, pour l'état « annulé ».
  await page.goto(`${DEMO}/point-projet`);
  await openFirstAvailableDay(page);
  await page.locator(".slots .slot").first().click();
  await page.getByLabel("Nom").fill("Marc Lefèvre");
  await page.getByLabel("Email").fill("marc.lefevre@exemple.fr");
  await page.getByRole("button", { name: "Confirmer la réservation" }).click();
  await page.getByRole("link", { name: "Annuler le rendez-vous" }).click();
  await page.getByLabel("Motif").fill("Réunion déplacée en interne.");
  await page.getByRole("button", { name: "Confirmer l'annulation" }).click();
  await expect(page.getByRole("heading", { name: "Rendez-vous annulé" })).toBeVisible();
  await shoot(page, "13-rendez-vous-annule");

  await page.goto(`${DEMO}/confidentialite`);
  await shoot(page, "17-confidentialite");

  await page.goto(`${DEMO}/page-inconnue`);
  await shoot(page, "14-erreur-404");
});

test("écrans d'administration", async ({ page }) => {
  await page.goto(`${DEMO}/admin/connexion`);
  await shoot(page, "20-admin-connexion");
  await page.getByRole("link", { name: "Se connecter avec Google" }).click();
  await shoot(page, "21-connexion-simulee");
  await page.getByLabel("Adresse du compte").fill("intrus@exemple.test");
  await page.getByRole("button", { name: "Autoriser" }).click();
  await expect(page.getByText("n'est pas autorisée")).toBeVisible();
  await shoot(page, "22-admin-connexion-refusee");

  await loginAdmin(page, DEMO);
  await expect(page.getByRole("heading", { name: "Réservations" })).toBeVisible();
  await shoot(page, "23-admin-reservations");
  await page.getByRole("link", { name: "Passées" }).click();
  await shoot(page, "24-admin-reservations-passees");
  await page.getByRole("link", { name: "À venir" }).click();
  await page.locator(".table tbody a").first().click();
  await shoot(page, "25-admin-reservation");

  await page.getByRole("link", { name: "Types d'événements" }).click();
  await shoot(page, "26-admin-types");
  await page.getByRole("link", { name: "Échange de 30 minutes" }).click();
  await shoot(page, "27-admin-type");
  await page.getByLabel("Titre").fill("");
  await page.getByLabel("Adresse de la page").fill("Mauvaise Adresse");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText("Indiquez un titre.")).toBeVisible();
  await shoot(page, "28-admin-type-erreurs");
  await page.goto(`${DEMO}/admin/types/nouveau`);
  await shoot(page, "29-admin-type-nouveau");

  await page.getByRole("link", { name: "Disponibilités" }).click();
  await shoot(page, "30-admin-disponibilites");
  await page.getByRole("link", { name: "Horaires de bureau" }).click();
  const nextMonday = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel("Date").fill(nextMonday);
  await page.getByRole("button", { name: "Ajouter l'exception" }).click();
  await expect(page.getByText("Exception enregistrée.")).toBeVisible();
  await shoot(page, "31-admin-planning");

  await page.getByRole("link", { name: "Agendas" }).click();
  await shoot(page, "32-admin-agendas");

  await page.getByRole("link", { name: "Réglages" }).click();
  await shoot(page, "33-admin-reglages");
  await page.getByLabel("Couleur d'accent").fill("#ffd400");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText("Contraste insuffisant")).toBeVisible();
  await shoot(page, "34-admin-reglages-erreur");
});

test("signature de mail", async ({ page, request }) => {
  const png = await request.get(`${DEMO}/signature.png`);
  expect(png.headers()["content-type"]).toBe("image/png");
  writeFileSync(path.join(OUT, "50-signature-image.png"), await png.body());

  await page.goto(`${DEMO}/creneaux`);
  await expect(page.getByRole("heading", { name: "Réserver un échange" })).toBeVisible();
  await shoot(page, "51-signature-creneaux");

  await loginAdmin(page, DEMO);
  await page.getByRole("link", { name: "Signature" }).click();
  await expect(page.frameLocator(".signature-frame").getByText("Réserver un échange")).toBeVisible();
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>(".signature-frame");
    const img = frame?.contentDocument?.querySelector("img");
    return Boolean(img && img.complete && img.naturalWidth > 0);
  });
  await shoot(page, "52-admin-signature");
});

test("compte Google déconnecté", async ({ page }) => {
  // Remplace le jeton par celui d'un compte révoqué : le prochain appel reçoit invalid_grant.
  const db = new Database(".tmp/e2e-demo/app.db");
  const key = createHash("sha256").update("rendez-vous-mode-simule").digest();
  db.prepare("UPDATE google_accounts SET refresh_token_enc = ?").run(encrypt("mock-refresh:revoque@exemple.test", key));
  db.close();

  await page.goto(`${DEMO}/echange-30-min?mois=${new Date().toISOString().slice(0, 7)}&tz=Europe/Paris`);
  await expect(page.getByText("Disponibilités momentanément indisponibles")).toBeVisible();
  await shoot(page, "15-reservation-indisponible");

  await loginAdmin(page, DEMO);
  await expect(page.getByText("Compte Google déconnecté")).toBeVisible();
  await shoot(page, "35-admin-alerte-deconnexion");
  await page.getByRole("link", { name: "Agendas" }).click();
  await expect(page.getByText("Autorisation à renouveler")).toBeVisible();
  await shoot(page, "36-admin-agendas-deconnecte");
});

test("états vides", async ({ page }) => {
  await page.goto(`${EMPTY}/`);
  await shoot(page, "16-accueil-vide");
  await loginAdmin(page, EMPTY);
  await shoot(page, "40-admin-reservations-vide");
  await page.getByRole("link", { name: "Types d'événements" }).click();
  await shoot(page, "41-admin-types-vide");
  await page.getByRole("link", { name: "Disponibilités" }).click();
  await shoot(page, "42-admin-disponibilites-vide");
  await page.getByRole("link", { name: "Agendas" }).click();
  await shoot(page, "43-admin-agendas-vide");
  await page.goto(`${EMPTY}/admin/disponibilites/nouveau`);
  await shoot(page, "44-admin-planning-nouveau");
});
