import { expect, type Page } from "@playwright/test";

export const DEMO = "http://localhost:3101";
export const EMPTY = "http://localhost:3102";

// Connexion admin via l'écran de consentement simulé.
export async function loginAdmin(page: Page, base: string, email = "admin@exemple.test"): Promise<void> {
  await page.goto(`${base}/admin/connexion`);
  await page.getByRole("link", { name: "Se connecter avec Google" }).click();
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  await page.getByLabel("Adresse du compte").fill(email);
  await page.getByRole("button", { name: "Autoriser" }).click();
}

// Premier jour disponible du calendrier, en passant au mois suivant si besoin.
export async function openFirstAvailableDay(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const day = page.locator(".cal a.day").first();
    if ((await day.count()) > 0) {
      await day.click();
      await expect(page.locator(".slots .slot").first()).toBeVisible();
      return;
    }
    await page.getByRole("link", { name: "Mois suivant" }).click();
    await expect(page.locator("[data-picker]")).not.toHaveAttribute("aria-busy", "true");
  }
  throw new Error("Aucun jour disponible");
}
