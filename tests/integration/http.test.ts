import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { sha256 } from "../../src/lib/crypto.js";
import { AccountTakenError } from "../../src/providers/accounts.js";
import { RateLimiter } from "../../src/web/ratelimit.js";
import { createApp } from "../../src/web/app.js";
import { SignatureRenderer } from "../../src/web/signature.js";
import { createContext, demoUser, eventType, firstSlots, fontFiles } from "../helpers.js";

const BASE = "http://localhost:3000";
let signature: SignatureRenderer | undefined;

async function setup(opts: { latencyMs?: number } = {}) {
  const ctx = await createContext({ latencyMs: opts.latencyMs ?? 0 });
  signature ??= new SignatureRenderer(fontFiles());
  const config = loadConfig({ CALENDAR_PROVIDER: "mock", ADMIN_EMAILS: "admin@exemple.test", ADMIN_DOMAINS: "42lausanne.ch", BASE_URL: BASE });
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
    const res = await app.request(`${BASE}/camille-martin/echange-30-min`);
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
    expect(await (await app.request(`${BASE}/camille-martin`)).text()).not.toContain("Appel téléphonique");
    expect((await app.request(`${BASE}/camille-martin/appel`)).status).toBe(200);
  });

  it("le rendu partiel ne renvoie que le sélecteur", async () => {
    const { app } = await setup();
    const res = await app.request(`${BASE}/camille-martin/echange-30-min?tz=Asia/Tokyo`, { headers: { "x-partial": "1" } });
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
    const res = await post(app, "/camille-martin/echange-30-min/reserver", await bookingFields(ctx, token), cookie);
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
    expect((await post(app, "/camille-martin/echange-30-min/reserver", { ...fields, _csrf: "x".repeat(43) }, cookie)).status).toBe(403);
    expect((await post(app, "/camille-martin/echange-30-min/reserver", fields, cookie, { origin: "https://pirate.example" })).status).toBe(403);
    expect((await post(app, "/camille-martin/echange-30-min/reserver", fields, "")).status).toBe(403);
    expect(ctx.provider.listEvents()).toEqual([]);
  });

  it("le pot de miel rejette les robots", async () => {
    const { app, ctx } = await setup();
    const { cookie, token } = await csrf(app);
    const res = await post(app, "/camille-martin/echange-30-min/reserver", { ...(await bookingFields(ctx, token)), site_web: "https://spam" }, cookie);
    expect(res.status).toBe(400);
    expect(ctx.provider.listEvents()).toEqual([]);
  });

  it("valide les champs", async () => {
    const { app, ctx } = await setup();
    const { cookie, token } = await csrf(app);
    const res = await post(app, "/camille-martin/echange-30-min/reserver", { ...(await bookingFields(ctx, token)), nom: "", email: "pas-une-adresse" }, cookie);
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
    for (let i = 0; i < 12; i++) statuses.push((await post(app, "/camille-martin/echange-30-min/reserver", fields, cookie)).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("requêtes HTTP simultanées sur le même créneau : une seule réservation", async () => {
    const { app, ctx } = await setup({ latencyMs: 15 });
    const { cookie, token } = await csrf(app);
    const base = await bookingFields(ctx, token);
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(app, "/camille-martin/echange-30-min/reserver", { ...base, nom: `Invité ${i}`, email: `invite${i}@exemple.fr` }, cookie, {
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
    const link = (await post(app, "/camille-martin/echange-30-min/reserver", fields, cookie)).headers.get("location")!.split("?")[0]!;

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

describe("plannings", () => {
  it("enregistre le nombre de créneaux de chaque plage et refuse un nombre invalide", async () => {
    const { app, ctx } = await setup();
    const sid = "p".repeat(43);
    ctx.repo.createSession(sha256(sid), "admin@exemple.test", 60_000);
    const { cookie, token } = await csrf(app);
    const cookies = `${cookie}; sid=${sid}`;

    const blank = await (await app.request(`${BASE}/admin/disponibilites/nouveau`, { headers: { cookie: cookies } })).text();
    expect(blank).toContain('name="j1_debut" value="13:00"');
    expect(blank).toContain('name="j1_nb" value="2"');

    const fields = { _csrf: token, name: "Petites tranches", timeZone: "Europe/Paris", j1_debut: "13:00", j1_fin: "15:00", j1_nb: "2", j2_debut: "09:00", j2_fin: "12:00", j2_nb: "" };
    const invalid = await post(app, "/admin/disponibilites", { ...fields, j1_nb: "0" }, cookies);
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("Nombre de créneaux entre 1 et 20");

    const saved = await post(app, "/admin/disponibilites", fields, cookies);
    expect(saved.status).toBe(303);
    const id = Number(saved.headers.get("location")!.match(/disponibilites\/(\d+)/)![1]);
    const schedule = ctx.repo.getSchedule(id)!;
    expect(schedule.weekly[1]).toEqual([{ start: 13 * 60, end: 15 * 60, maxSlots: 2 }]);
    expect(schedule.weekly[2]).toEqual([{ start: 9 * 60, end: 12 * 60 }]);
    const list = await (await app.request(`${BASE}/admin/disponibilites`, { headers: { cookie: cookies } })).text();
    expect(list).toContain("lun. 13:00–15:00 (2 créneaux)");
  });
});

describe("plusieurs personnes", () => {
  type Ctx = Awaited<ReturnType<typeof setup>>["ctx"];

  // Session d'admin ouverte pour une adresse, espace créé comme à la première connexion.
  function signIn(ctx: Ctx, email: string, sid: string) {
    const user = ctx.repo.ensureUser(email);
    ctx.repo.createSession(sha256(sid), email, 60_000);
    return user;
  }

  it("une adresse du domaine autorisé ouvre son propre espace à la première connexion", async () => {
    const { app, ctx } = await setup();
    const start = await app.request(`${BASE}/auth/google/connexion`);
    const authorize = new URL(start.headers.get("location")!, BASE);
    const oauthCookie = start.headers.getSetCookie().find((c) => c.startsWith("oauth="))!.split(";")[0]!;
    const code = ctx.provider.issueCode({ email: "marie.dupont@42lausanne.ch", codeChallenge: authorize.searchParams.get("code_challenge")!, purpose: "login" });
    const res = await app.request(`${BASE}/auth/google/callback?state=${authorize.searchParams.get("state")}&code=${code}`, { headers: { cookie: oauthCookie } });
    expect(res.headers.get("location")).toBe("/admin");
    const sid = res.headers.getSetCookie().find((c) => c.startsWith("sid="))!.split(";")[0]!;

    const marie = ctx.repo.getUserByEmail("marie.dupont@42lausanne.ch")!;
    expect(marie.slug).toBe("marie-dupont");
    const types = await (await app.request(`${BASE}/admin/types`, { headers: { cookie: sid } })).text();
    expect(types).toContain("Aucun agenda connecté.");
    expect(types).not.toContain("Échange de 30 minutes");
    expect(await (await app.request(`${BASE}/marie-dupont`)).text()).toContain("Aucun rendez-vous proposé");
  });

  it("l'admin d'une personne ne voit ni ne modifie les données d'une autre", async () => {
    const { app, ctx } = await setup();
    const camille = demoUser(ctx);
    const et = eventType(ctx, "echange-30-min");
    const booking = await ctx.bookings.create({ eventType: et, start: (await firstSlots(ctx, et.slug))[0]!, name: "Jeanne", email: "j@exemple.fr", note: "", timeZone: "Europe/Paris" });
    const account = ctx.repo.listAccounts(camille.id)[0]!;
    signIn(ctx, "paul@42lausanne.ch", "q".repeat(43));
    const { cookie, token } = await csrf(app);
    const cookies = `${cookie}; sid=${"q".repeat(43)}`;
    const get = (path: string) => app.request(`${BASE}${path}`, { headers: { cookie: cookies } });

    for (const path of [`/admin/types/${et.id}`, `/admin/disponibilites/${et.scheduleId}`, `/admin/reservations/${booking.booking.id}`]) {
      expect((await get(path)).status).toBe(404);
    }
    for (const path of [`/admin/types/${et.id}/supprimer`, `/admin/disponibilites/${et.scheduleId}/supprimer`, `/admin/agendas/${account.id}/retirer`, `/admin/reservations/${booking.booking.id}/annuler`]) {
      expect((await post(app, path, { _csrf: token }, cookies)).status).toBe(404);
    }
    expect(eventType(ctx, "echange-30-min")).toBeTruthy();
    expect(ctx.repo.getBooking(booking.booking.id)?.status).toBe("confirmed");
    expect(ctx.repo.listAccounts(camille.id)).toHaveLength(1);

    for (const path of ["/admin/reservations", "/admin/types", "/admin/disponibilites", "/admin/agendas"]) {
      const html = await (await get(path)).text();
      expect(html).not.toContain("Jeanne");
      expect(html).not.toContain("Horaires de bureau");
      expect(html).not.toContain("moi@exemple.test");
    }

    // Les agendas et plannings d'une autre personne sont refusés dans les formulaires.
    const paulSchedule = ctx.repo.saveSchedule(ctx.repo.getUserByEmail("paul@42lausanne.ch")!.id, null, { name: "Paul", timeZone: "Europe/Paris", weekly: {} });
    const form = { _csrf: token, title: "Vol", slug: "vol", duration: "30", locationType: "meet", scheduleId: String(paulSchedule), destinationCalendarId: String(et.destinationCalendarId), interval: "", bufferBefore: "0", bufferAfter: "0", notice: "0", horizon: "30", dailyLimit: "", visibility: "public", active: "1" };
    const stolen = await post(app, "/admin/types", form, cookies);
    expect(stolen.status).toBe(400);
    expect(await stolen.text()).toContain("Choisissez un agenda modifiable.");
    const signature = await post(app, "/admin/signature", { _csrf: token, eventTypeId: String(et.id), maxSlots: "2" }, cookies);
    expect(signature.status).toBe(400);
  });

  it("chacun a sa page, ses adresses de types et son propre compte Google", async () => {
    const { app, ctx } = await setup();
    const marie = signIn(ctx, "marie@42lausanne.ch", "m".repeat(43));
    const scopes = ctx.provider.connectScopes;
    await expect(
      ctx.accounts.connect(marie.id, { identity: { subject: "mock-moi@exemple.test", email: "moi@exemple.test", emailVerified: true }, refreshToken: "mock-refresh:moi@exemple.test", scopes }),
    ).rejects.toBeInstanceOf(AccountTakenError);
    await ctx.accounts.connect(marie.id, { identity: { subject: "mock-marie@42lausanne.ch", email: "marie@42lausanne.ch", emailVerified: true }, refreshToken: "mock-refresh:marie@42lausanne.ch", scopes });
    const calendar = ctx.repo.listCalendars(marie.id).find((c) => c.isPrimary)!;
    const scheduleId = ctx.repo.saveSchedule(marie.id, null, { name: "Marie", timeZone: "Europe/Zurich", weekly: { 1: [{ start: 600, end: 720 }], 2: [{ start: 600, end: 720 }], 3: [{ start: 600, end: 720 }], 4: [{ start: 600, end: 720 }], 5: [{ start: 600, end: 720 }] } });
    // Même adresse de type que Camille : chacune sous sa propre page.
    ctx.repo.saveEventType(marie.id, null, { ...eventType(ctx, "echange-30-min"), title: "Café avec Marie", scheduleId, destinationCalendarId: calendar.id, blockingCalendarIds: [calendar.id] });

    const home = await (await app.request(`${BASE}/`)).text();
    expect(home).toContain('href="/camille-martin"');
    expect(home).toContain('href="/marie"');
    expect(await (await app.request(`${BASE}/marie/echange-30-min`)).text()).toContain("Café avec Marie");
    expect(await (await app.request(`${BASE}/camille-martin/echange-30-min`)).text()).toContain("Échange de 30 minutes");
    expect((await app.request(`${BASE}/marie/point-projet`)).status).toBe(404);
  });
});

describe("signature de mail", () => {
  it("image PNG dynamique, lisible depuis une autre origine et jamais en cache", async () => {
    const { app } = await setup();
    const res = await app.request(`${BASE}/camille-martin/signature.png`);
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
    const html = await (await app.request(`${BASE}/camille-martin/creneaux?tz=Europe/Paris`)).text();
    const links = html.match(/href="\/camille-martin\/echange-30-min\/reserver\?[^"]+"/g) ?? [];
    expect(links.length).toBe(3);
    expect(html).toContain("Cette semaine");
    expect(html).toContain('href="/camille-martin/echange-30-min?tz=Europe%2FParis"');
  });

  it("sans type configuré, la page renvoie vers la page de la personne", async () => {
    const { app, ctx } = await setup();
    ctx.repo.updateSignature(demoUser(ctx).id, { eventTypeId: null, maxSlots: 3 });
    const res = await app.request(`${BASE}/camille-martin/creneaux`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/camille-martin");
    expect((await app.request(`${BASE}/camille-martin/signature.png`)).status).toBe(200);
  });

  it("administration réservée, aperçu isolé avec sa propre politique", async () => {
    const { app, ctx } = await setup();
    expect((await app.request(`${BASE}/admin/signature`)).headers.get("location")).toBe("/admin/connexion");
    const sid = "s".repeat(43);
    ctx.repo.createSession(sha256(sid), "admin@exemple.test", 60_000);
    const page = await app.request(`${BASE}/admin/signature`, { headers: { cookie: `sid=${sid}` } });
    const html = await page.text();
    expect(html).toContain("Signature de mail");
    expect(html).toContain("http://localhost:3000/camille-martin/signature.png");
    const preview = await app.request(`${BASE}/admin/signature/apercu`, { headers: { cookie: `sid=${sid}` } });
    expect(preview.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(preview.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await preview.text()).toContain("Réserver un échange");
  });
});

describe("politique de confidentialité", () => {
  it("page publique liée depuis chaque page, avec la mention Limited Use", async () => {
    const { app } = await setup();
    const res = await app.request(`${BASE}/confidentialite`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Google API Services User Data Policy");
    expect(html).toContain("mailto:admin@exemple.test");
    expect(await (await app.request(`${BASE}/`)).text()).toContain('href="/confidentialite"');
  });
});
