import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { RateLimiter } from "../../src/web/ratelimit.js";
import { createApp } from "../../src/web/app.js";
import { SignatureRenderer } from "../../src/web/signature.js";
import { createContext, firstSlots, fontFiles } from "../helpers.js";

const BASE = "http://localhost:3000";
let signature: SignatureRenderer | undefined;

async function setup(opts: { latencyMs?: number } = {}) {
  const ctx = await createContext({ latencyMs: opts.latencyMs ?? 0 });
  signature ??= new SignatureRenderer(fontFiles());
  const config = loadConfig({ CALENDAR_PROVIDER: "mock", ADMIN_EMAILS: "admin@exemple.test", BASE_URL: BASE });
  const app = createApp({
    config,
    repo: ctx.repo,
    provider: ctx.provider,
    mock: ctx.provider,
    accounts: ctx.accounts,
    availability: ctx.availability,
    bookings: ctx.bookings,
    limiter: new RateLimiter(() => ctx.clock.now),
    signature,
    assets: { css: "/assets/app.css", booking: "/assets/booking.js", admin: "/assets/admin.js", dir: null },
    now: () => ctx.clock.now,
  });
  return { ctx, app };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

// Récupère un cookie CSRF et le jeton à renvoyer dans les formulaires.
async function csrf(app: App): Promise<{ cookie: string; token: string }> {
  const res = await app.request(`${BASE}/`);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return { cookie, token: cookie.split("=")[1]! };
}

function form(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

async function post(app: App, path: string, fields: Record<string, string>, cookie: string, headers: Record<string, string> = {}) {
  return app.request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: BASE, ...headers },
    body: form(fields),
  });
}

async function bookingFields(ctx: Awaited<ReturnType<typeof setup>>["ctx"], token: string, i = 0) {
  const [start] = await firstSlots(ctx, "echange-30-min");
  return {
    _csrf: token,
    debut: new Date(start!).toISOString(),
    tz: "Europe/Paris",
    nom: `Invité ${i}`,
    email: `invite${i}@exemple.fr`,
    note: "",
    site_web: "",
  };
}

describe("pages et en-têtes", () => {
  it("sert les pages publiques avec les en-têtes de sécurité", async () => {
    const { app } = await setup();
    const res = await app.request(`${BASE}/echange-30-min`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("Choisissez un jour et un horaire");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/);
  });

  it("aucune ressource tierce dans les pages", async () => {
    const { app } = await setup();
    for (const path of ["/", "/echange-30-min", "/admin/connexion"]) {
      const html = await (await app.request(`${BASE}${path}`)).text();
      expect(html).not.toMatch(/(src|href)="https?:\/\//);
    }
  });

  it("répond à /healthz", async () => {
    const { app } = await setup();
    const res = await app.request(`${BASE}/healthz`);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("renvoie une page 404 soignée", async () => {
    const { app } = await setup();
    const res = await app.request(`${BASE}/inconnu`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Page introuvable");
  });

  it("un type non listé reste accessible par son lien mais absent de l'accueil", async () => {
    const { app } = await setup();
    expect(await (await app.request(`${BASE}/`)).text()).not.toContain("Appel téléphonique");
    expect((await app.request(`${BASE}/appel`)).status).toBe(200);
  });

  it("le rendu partiel ne renvoie que le sélecteur", async () => {
    const { app } = await setup();
    const res = await app.request(`${BASE}/echange-30-min?tz=Asia/Tokyo`, { headers: { "x-partial": "1" } });
    const html = await res.text();
    expect(html).not.toContain("<html");
    expect(html).toContain("Asia/Tokyo");
    expect(res.headers.get("vary")).toContain("X-Partial");
  });
});

describe("réservation par formulaire", () => {
  it("crée la réservation et redirige vers la confirmation", async () => {
    const { app, ctx } = await setup();
    const { cookie, token } = await csrf(app);
    const res = await post(app, "/echange-30-min/reserver", await bookingFields(ctx, token), cookie);
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(location).toMatch(/^\/b\/[A-Za-z0-9_-]{43}\?nouveau=1$/);
    const page = await (await app.request(`${BASE}${location}`)).text();
    expect(page).toContain("Réservation confirmée");
    expect(page).toContain("invite0@exemple.fr");
  });

  it("refuse une requête sans jeton CSRF ou d'une autre origine", async () => {
    const { app, ctx } = await setup();
    const { cookie, token } = await csrf(app);
    const fields = await bookingFields(ctx, token);
    expect((await post(app, "/echange-30-min/reserver", { ...fields, _csrf: "x".repeat(43) }, cookie)).status).toBe(403);
    expect((await post(app, "/echange-30-min/reserver", fields, cookie, { origin: "https://pirate.example" })).status).toBe(403);
    expect((await post(app, "/echange-30-min/reserver", fields, "")).status).toBe(403);
    expect(ctx.provider.listEvents()).toEqual([]);
  });

  it("le pot de miel rejette les robots", async () => {
    const { app, ctx } = await setup();
    const { cookie, token } = await csrf(app);
    const res = await post(app, "/echange-30-min/reserver", { ...(await bookingFields(ctx, token)), site_web: "https://spam" }, cookie);
    expect(res.status).toBe(400);
    expect(ctx.provider.listEvents()).toEqual([]);
  });

  it("valide les champs", async () => {
    const { app, ctx } = await setup();
    const { cookie, token } = await csrf(app);
    const res = await post(app, "/echange-30-min/reserver", { ...(await bookingFields(ctx, token)), nom: "", email: "pas-une-adresse" }, cookie);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("Indiquez votre nom.");
    expect(html).toContain("Adresse email invalide.");
  });

  it("limite le débit des réservations", async () => {
    const { app, ctx } = await setup();
    const { cookie, token } = await csrf(app);
    const fields = { ...(await bookingFields(ctx, token)), nom: "" };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post(app, "/echange-30-min/reserver", fields, cookie)).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("requêtes HTTP simultanées sur le même créneau : une seule réservation", async () => {
    const { app, ctx } = await setup({ latencyMs: 15 });
    const { cookie, token } = await csrf(app);
    const base = await bookingFields(ctx, token);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(app, "/echange-30-min/reserver", { ...base, nom: `Invité ${i}`, email: `invite${i}@exemple.fr` }, cookie, {
          "x-forwarded-for": `10.0.0.${i}`,
        }),
      ),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 303).length).toBe(1);
    expect(statuses.filter((s) => s === 409).length).toBe(7);
    expect(ctx.provider.listEvents().length).toBe(1);
  });
});

describe("gestion par lien", () => {
  it("annule et reprogramme sans compte", async () => {
    const { app, ctx } = await setup();
    const { cookie, token } = await csrf(app);
    const fields = await bookingFields(ctx, token);
    const link = (await post(app, "/echange-30-min/reserver", fields, cookie)).headers.get("location")!.split("?")[0]!;

    const slots = await firstSlots(ctx, "echange-30-min");
    const target = new Date(slots[slots.length - 1]!).toISOString();
    const confirm = await app.request(`${BASE}${link}/reprogrammer/confirmer?debut=${target}&tz=Europe/Paris`, { headers: { cookie } });
    expect(await confirm.text()).toContain("Confirmer le nouvel horaire");
    const moved = await post(app, `${link}/reprogrammer`, { _csrf: token, debut: target, tz: "Europe/Paris" }, cookie);
    expect(moved.status).toBe(303);
    expect(ctx.provider.listEvents()[0]!.start).toBe(Date.parse(target));

    const cancelled = await post(app, `${link}/annuler`, { _csrf: token, motif: "Imprévu" }, cookie);
    expect(cancelled.status).toBe(303);
    expect(await (await app.request(`${BASE}${link}`)).text()).toContain("Rendez-vous annulé");
  });

  it("un jeton inconnu ou mal formé renvoie 404", async () => {
    const { app } = await setup();
    expect((await app.request(`${BASE}/b/inconnu`)).status).toBe(404);
    expect((await app.request(`${BASE}/b/${"a".repeat(43)}`)).status).toBe(404);
  });
});

describe("administration", () => {
  it("redirige vers la connexion sans session", async () => {
    const { app } = await setup();
    for (const path of ["/admin", "/admin/reservations", "/admin/types/1", "/admin/agendas/connecter"]) {
      const res = await app.request(`${BASE}${path}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/admin/connexion");
    }
  });

  async function oauth(app: App, ctx: Awaited<ReturnType<typeof setup>>["ctx"], email: string, cookies: string[] = []) {
    const start = await app.request(`${BASE}/auth/google/connexion`, { headers: { cookie: cookies.join("; ") } });
    const authorize = new URL(start.headers.get("location")!, BASE);
    const state = authorize.searchParams.get("state")!;
    const oauthCookie = start.headers.getSetCookie().find((c) => c.startsWith("oauth="))!.split(";")[0]!;
    const code = ctx.provider.issueCode({ email, codeChallenge: authorize.searchParams.get("code_challenge")!, purpose: "login" });
    return { state, code, oauthCookie };
  }

  it("connexion réservée aux adresses de ADMIN_EMAILS, avec state et PKCE", async () => {
    const { app, ctx } = await setup();
    const denied = await oauth(app, ctx, "intrus@exemple.test");
    const res1 = await app.request(`${BASE}/auth/google/callback?state=${denied.state}&code=${denied.code}`, { headers: { cookie: denied.oauthCookie } });
    expect(res1.headers.get("location")).toBe("/admin/connexion?erreur=non-autorise");

    const ok = await oauth(app, ctx, "admin@exemple.test");
    // Sans le cookie de state : refusé.
    const noCookie = await app.request(`${BASE}/auth/google/callback?state=${ok.state}&code=${ok.code}`);
    expect(noCookie.headers.get("location")).toBe("/admin/connexion?erreur=expire");

    const ok2 = await oauth(app, ctx, "admin@exemple.test");
    const res2 = await app.request(`${BASE}/auth/google/callback?state=${ok2.state}&code=${ok2.code}`, { headers: { cookie: ok2.oauthCookie } });
    expect(res2.headers.get("location")).toBe("/admin");
    const sid = res2.headers.getSetCookie().find((c) => c.startsWith("sid="))!.split(";")[0]!;
    const page = await app.request(`${BASE}/admin/reservations`, { headers: { cookie: sid } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Réservations");

    // Un state ne sert qu'une fois.
    const replay = await app.request(`${BASE}/auth/google/callback?state=${ok2.state}&code=${ok2.code}`, { headers: { cookie: ok2.oauthCookie } });
    expect(replay.headers.get("location")).toBe("/admin/connexion?erreur=expire");
  });
});

describe("signature de mail", () => {
  it("image PNG dynamique, lisible depuis une autre origine et jamais en cache", async () => {
    const { app } = await setup();
    const res = await app.request(`${BASE}/signature.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("set-cookie")).toBeNull();
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("la page des créneaux propose la sélection, liée au formulaire de réservation", async () => {
    const { app } = await setup();
    const html = await (await app.request(`${BASE}/creneaux?tz=Europe/Paris`)).text();
    const links = html.match(/href="\/echange-30-min\/reserver\?[^"]+"/g) ?? [];
    expect(links.length).toBe(3);
    expect(html).toContain("Cette semaine");
    expect(html).toContain('href="/echange-30-min?tz=Europe%2FParis"');
  });

  it("sans type configuré, la page renvoie vers l'accueil", async () => {
    const { app, ctx } = await setup();
    ctx.repo.updateSignature({ eventTypeId: null, maxSlots: 3 });
    const res = await app.request(`${BASE}/creneaux`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect((await app.request(`${BASE}/signature.png`)).status).toBe(200);
  });

  it("administration réservée, aperçu isolé avec sa propre politique", async () => {
    const { app, ctx } = await setup();
    expect((await app.request(`${BASE}/admin/signature`)).headers.get("location")).toBe("/admin/connexion");
    const sid = "s".repeat(43);
    const { sha256 } = await import("../../src/lib/crypto.js");
    ctx.repo.createSession(sha256(sid), "admin@exemple.test", 60_000);
    const page = await app.request(`${BASE}/admin/signature`, { headers: { cookie: `sid=${sid}` } });
    const html = await page.text();
    expect(html).toContain("Signature de mail");
    expect(html).toContain("http://localhost:3000/signature.png");
    const preview = await app.request(`${BASE}/admin/signature/apercu`, { headers: { cookie: `sid=${sid}` } });
    expect(preview.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(preview.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await preview.text()).toContain("Réserver un échange");
  });
});
