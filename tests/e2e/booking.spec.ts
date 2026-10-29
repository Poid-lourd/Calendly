import { expect, test } from "@playwright/test";
import { loginAdmin, openFirstAvailableDay } from "./helpers.js";

// Parcours complet sur une instance dédiée, fournisseur simulé.
const BASE = "http://localhost:3103";

test.describe.configure({ mode: "serial" });

test("réservation, reprogrammation puis annulation", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await page.getByRole("link", { name: "Camille Martin" }).click();
  await page.getByRole("link", { name: /Échange de 30 minutes/ }).click();
  await expect(page.getByRole("heading", { name: "Choisissez un jour et un horaire" })).toBeVisible();

  // Étapes 1 et 2 : jour puis horaire.
  await openFirstAvailableDay(page);
  const slot = page.locator(".slots .slot").first();
  const time = (await slot.textContent())!.trim();
  await slot.click();

  // Étape 3 : coordonnées.
  await expect(page.getByRole("heading", { name: "Vos coordonnées" })).toBeVisible();
  await expect(page.locator(".chosen")).toContainText(time);
  await page.getByLabel("Nom").fill("Jeanne Dupont");
  await page.getByLabel("Email").fill("jeanne@exemple.fr");
  await page.getByLabel("Note").fill("Premier contact.");
  await page.getByRole("button", { name: "Confirmer la réservation" }).click();

  // Étape 4 : confirmation avec récapitulatif et liens.
  await expect(page.getByRole("heading", { name: "Réservation confirmée" })).toBeVisible();
  await expect(page.getByText("Une invitation Google Agenda a été envoyée à jeanne@exemple.fr.")).toBeVisible();
  await expect(page.locator(".recap")).toContainText(time);
  await expect(page.locator(".recap a[href^='https://meet.google.com/']")).toBeVisible();
  const manage = page.url().split("?")[0]!;
  expect(manage).toMatch(/\/b\/[A-Za-z0-9_-]{43}$/);

  // Reprogrammation par le lien, sans compte.
  await page.getByRole("link", { name: "Reprogrammer" }).click();
  await expect(page.getByRole("heading", { name: "Choisissez un nouvel horaire" })).toBeVisible();
  await openFirstAvailableDay(page);
  const newSlot = page.locator(".slots .slot").last();
  const newTime = (await newSlot.textContent())!.trim();
  await newSlot.click();
  await expect(page.getByRole("heading", { name: "Confirmer le nouvel horaire" })).toBeVisible();
  await page.getByRole("button", { name: "Confirmer" }).click();
  await expect(page.getByRole("heading", { name: "Rendez-vous déplacé" })).toBeVisible();
  await expect(page.locator(".recap")).toContainText(newTime);
  expect(page.url().split("?")[0]).toBe(manage);

  // Annulation avec motif.
  await page.getByRole("link", { name: "Annuler le rendez-vous" }).click();
  await page.getByLabel("Motif").fill("Empêchement.");
  await page.getByRole("button", { name: "Confirmer l'annulation" }).click();
  await expect(page.getByRole("heading", { name: "Rendez-vous annulé" })).toBeVisible();
  await expect(page.getByText("Motif : Empêchement.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Reprogrammer" })).toHaveCount(0);

  // Le lien d'annulation ne sert plus.
  await page.goto(`${manage}/annuler`);
  await expect(page.getByRole("heading", { name: "Rendez-vous annulé" })).toBeVisible();

  // Côté administration.
  await loginAdmin(page, BASE);
  await page.getByRole("link", { name: "Passées" }).click();
  await page.getByRole("link", { name: "À venir" }).click();
  const row = page.locator("tr", { hasText: "Jeanne Dupont" });
  await expect(row).toContainText("Annulée");
});

test("annulation par l'organisateur depuis l'administration", async ({ page }) => {
  await page.goto(`${BASE}/camille-martin/point-projet`);
  await openFirstAvailableDay(page);
  await page.locator(".slots .slot").first().click();
  await page.getByLabel("Nom").fill("Paul Martin");
  await page.getByLabel("Email").fill("paul@exemple.fr");
  await page.getByRole("button", { name: "Confirmer la réservation" }).click();
  const manage = page.url().split("?")[0]!;

  await loginAdmin(page, BASE);
  await page.locator("tr", { hasText: "Paul Martin" }).getByRole("link").click();
  await page.getByLabel("Motif").fill("Indisponible ce jour-là.");
  await page.getByRole("button", { name: "Annuler la réservation" }).click();
  await expect(page.getByText("Réservation annulée. Google a prévenu l'invité.")).toBeVisible();

  await page.goto(manage);
  await expect(page.getByText("L'organisateur a annulé ce rendez-vous.")).toBeVisible();
});

test("deux visiteurs sur le même horaire : le second est refusé", async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await a.goto(`${BASE}/camille-martin/echange-30-min`);
  await openFirstAvailableDay(a);
  const href = await a.locator(".slots .slot").first().getAttribute("href");
  await a.goto(`${BASE}${href}`);
  await b.goto(`${BASE}${href}`);
  for (const [p, name] of [
    [a, "Alice"],
    [b, "Bruno"],
  ] as const) {
    await p.getByLabel("Nom").fill(name);
    await p.getByLabel("Email").fill(`${name.toLowerCase()}@exemple.fr`);
  }
  await Promise.all([
    a.getByRole("button", { name: "Confirmer la réservation" }).click(),
    b.getByRole("button", { name: "Confirmer la réservation" }).click(),
  ]);
  const confirmed = [await a.getByRole("heading", { name: "Réservation confirmée" }).count(), await b.getByRole("heading", { name: "Réservation confirmée" }).count()];
  const refused = [await a.getByText("Horaire indisponible").count(), await b.getByText("Horaire indisponible").count()];
  expect(confirmed.reduce((x, y) => x + y)).toBe(1);
  expect(refused.reduce((x, y) => x + y)).toBe(1);
});

test.describe("fuseau du visiteur", () => {
  test.use({ timezoneId: "Asia/Tokyo" });

  test("détecté automatiquement puis modifiable", async ({ page }) => {
    await page.goto(`${BASE}/camille-martin/echange-30-min`);
    await expect(page.locator("#tz")).toHaveValue("Asia/Tokyo");
    await expect(page).toHaveURL(/tz=Asia%2FTokyo/);
    await openFirstAvailableDay(page);
    // 09:00 à Paris correspond à 16:00 ou 17:00 à Tokyo selon l'heure d'été.
    const tokyo = (await page.locator(".slots .slot").first().textContent())!.trim();
    expect(Number(tokyo.slice(0, 2))).toBeGreaterThanOrEqual(15);

    await page.locator("#tz").selectOption("Europe/Paris");
    await expect(page).toHaveURL(/tz=Europe%2FParis/);
    await expect(page.locator("#tz")).toHaveValue("Europe/Paris");
    await page.goto(`${BASE}/camille-martin/echange-30-min`);
    await expect(page.locator("#tz")).toHaveValue("Europe/Paris");
  });
});

test("calendrier navigable au clavier", async ({ page }) => {
  await page.goto(`${BASE}/camille-martin/echange-30-min`);
  const focusable = page.locator(".cal .day[tabindex='0']");
  await expect(focusable).toHaveCount(1);
  await focusable.focus();
  const start = await focusable.getAttribute("data-date");
  await page.keyboard.press("ArrowRight");
  const next = await page.evaluate(() => document.activeElement?.getAttribute("data-date"));
  expect(next).not.toBe(start);
  expect(new Date(next!).getTime() - new Date(start!).getTime()).toBe(86_400_000);
  await page.keyboard.press("ArrowLeft");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-date"))).toBe(start);
  await page.keyboard.press("PageDown");
  await expect(page).toHaveURL(/mois=/);
  await expect(page.locator(".cal .day").first()).toBeFocused();

  // Un jour disponible s'ouvre avec Entrée, le focus passe aux horaires.
  await page.goto(`${BASE}/camille-martin/echange-30-min`);
  const available = page.locator(".cal a.day").first();
  if ((await available.count()) === 0) await page.getByRole("link", { name: "Mois suivant" }).click();
  await page.locator(".cal a.day").first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#horaires-titre")).toBeFocused();
});

test.describe("sans JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("le parcours reste possible", async ({ page }) => {
    await page.goto(`${BASE}/camille-martin/appel`);
    await expect(page.getByRole("button", { name: "Appliquer" })).toBeVisible();
    let day = page.locator(".cal a.day").first();
    if ((await day.count()) === 0) {
      await page.getByRole("link", { name: "Mois suivant" }).click();
      day = page.locator(".cal a.day").first();
    }
    await day.click();
    await page.locator(".slots .slot").first().click();
    await page.getByLabel("Nom").fill("Sans Script");
    await page.getByLabel("Email").fill("sans.script@exemple.fr");
    await page.getByRole("button", { name: "Confirmer la réservation" }).click();
    await expect(page.getByRole("heading", { name: "Réservation confirmée" })).toBeVisible();
    await expect(page.getByText("Téléphone, +33 1 23 45 67 89")).toBeVisible();
  });
});

test("depuis un créneau de la signature de mail : réservation directe", async ({ page }) => {
  await page.goto(`${BASE}/camille-martin/creneaux`);
  const time = (await page.locator(".shortlist-slot").nth(1).locator("strong").textContent())!.trim();
  await page.goto(`${BASE}/camille-martin/signature/2`);
  await expect(page.locator(".chosen")).toContainText(time);
  await page.getByLabel("Nom").fill("Depuis Pastille");
  await page.getByLabel("Email").fill("pastille@exemple.fr");
  await page.getByRole("button", { name: "Confirmer la réservation" }).click();
  await expect(page.getByRole("heading", { name: "Réservation confirmée" })).toBeVisible();
});

test("depuis la signature de mail : créneau de la semaine puis réservation", async ({ page }) => {
  await page.goto(`${BASE}/camille-martin/creneaux`);
  await expect(page.getByRole("heading", { name: "Réserver un échange" })).toBeVisible();
  const slots = page.locator(".shortlist-slot");
  expect(await slots.count()).toBeGreaterThan(0);
  expect(await slots.count()).toBeLessThanOrEqual(3);
  const time = (await slots.first().locator("strong").textContent())!.trim();
  const href = await slots.first().getAttribute("href");
  await slots.first().click();
  await expect(page.locator(".chosen")).toContainText(time);
  await page.getByLabel("Nom").fill("Depuis Signature");
  await page.getByLabel("Email").fill("signature@exemple.fr");
  await page.getByRole("button", { name: "Confirmer la réservation" }).click();
  await expect(page.getByRole("heading", { name: "Réservation confirmée" })).toBeVisible();

  // Le créneau réservé n'est plus proposé.
  await page.goto(`${BASE}/camille-martin/creneaux`);
  const hrefs = await page.locator(".shortlist-slot").evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  expect(hrefs).not.toContain(href);
  await page.getByRole("link", { name: "Voir toutes les disponibilités" }).click();
  await expect(page.getByRole("heading", { name: "Choisissez un jour et un horaire" })).toBeVisible();
});
