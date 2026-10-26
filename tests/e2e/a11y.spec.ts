import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { loginAdmin, openFirstAvailableDay } from "./helpers.js";

// Contrôle automatique WCAG 2.1 A et AA (axe-core) sur chaque écran, en 390 et 1440 px.
const BASE = "http://localhost:3103";

async function audit(page: Page, label: string): Promise<void> {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    const summary = result.violations.map((v) => `${v.id} : ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    expect(summary, `${label} à ${width}px`).toEqual([]);
  }
}

test("pages publiques", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await audit(page, "accueil");
  await page.goto(`${BASE}/echange-30-min`);
  await audit(page, "calendrier");
  await openFirstAvailableDay(page);
  await audit(page, "horaires");
  await page.locator(".slots .slot").first().click();
  await audit(page, "formulaire");
  await page.getByRole("button", { name: "Confirmer la réservation" }).click();
  await audit(page, "formulaire en erreur");
  await page.getByLabel("Nom").fill("Axe Test");
  await page.getByLabel("Email").fill("axe@exemple.fr");
  await page.getByRole("button", { name: "Confirmer la réservation" }).click();
  await audit(page, "confirmation");
  await page.getByRole("link", { name: "Annuler le rendez-vous" }).click();
  await audit(page, "annulation");
  await page.goBack();
  await page.getByRole("link", { name: "Reprogrammer" }).click();
  await audit(page, "reprogrammation");
  await page.goto(`${BASE}/inexistant`);
  await audit(page, "404");
  await page.goto(`${BASE}/creneaux`);
  await audit(page, "créneaux de la signature");
});

test("administration", async ({ page }) => {
  await page.goto(`${BASE}/admin/connexion`);
  await audit(page, "connexion");
  await loginAdmin(page, BASE);
  for (const [path, label] of [
    ["/admin/reservations", "réservations"],
    ["/admin/reservations?vue=passees", "réservations passées"],
    ["/admin/types", "types"],
    ["/admin/types/1", "type"],
    ["/admin/types/nouveau", "nouveau type"],
    ["/admin/disponibilites", "disponibilités"],
    ["/admin/disponibilites/1", "planning"],
    ["/admin/agendas", "agendas"],
    ["/admin/reglages", "réglages"],
    ["/admin/signature", "signature"],
  ]) {
    await page.goto(`${BASE}${path}`);
    await audit(page, label!);
  }
  await page.goto(`${BASE}/admin/reservations`);
  await page.locator(".table tbody a").first().click();
  await audit(page, "détail réservation");
});
