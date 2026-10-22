import type { Hono, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { pkcePair, randomToken, safeEqual, sha256 } from "../../lib/crypto.js";
import { log } from "../../lib/log.js";
import { MissingScopesError } from "../../providers/accounts.js";
import type { OAuthPurpose } from "../../providers/types.js";
import { type Ctx, type Env, field } from "../context.js";
import { clientIp, cookieName } from "../middleware.js";
import { LoginPage, MockConsentPage } from "../views/auth.js";
import { errorPage, meta } from "./public.js";

const SESSION_TTL = 7 * 24 * 3600 * 1000;
const STATE_TTL = 10 * 60 * 1000;

export function redirectUri(c: Ctx): string {
  return new URL("/auth/google/callback", c.get("deps").config.baseUrl).toString();
}

// Charge la session admin si présente.
export const loadSession: MiddlewareHandler<Env> = async (c, next) => {
  const deps = c.get("deps");
  const sid = getCookie(c, cookieName(deps.config, "sid"));
  let admin: { email: string } | null = null;
  if (sid) {
    const session = deps.repo.getSession(sha256(sid));
    if (session && deps.config.adminEmails.includes(session.email)) admin = session;
  }
  c.set("admin", admin);
  await next();
};

export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.get("admin")) return c.redirect("/admin/connexion", 302);
  await next();
};

function startOAuth(c: Ctx, purpose: OAuthPurpose): Response {
  const deps = c.get("deps");
  const state = randomToken();
  const { verifier, challenge } = pkcePair();
  deps.repo.saveOAuthState(state, verifier, purpose, STATE_TTL);
  setCookie(c, cookieName(deps.config, "oauth"), state, {
    httpOnly: true,
    secure: deps.config.secureCookies,
    sameSite: "Lax",
    path: "/",
    maxAge: STATE_TTL / 1000,
  });
  return c.redirect(deps.provider.authorizationUrl({ state, codeChallenge: challenge, purpose, redirectUri: redirectUri(c) }), 302);
}

export function authRoutes(app: Hono<Env>): void {
  app.get("/admin/connexion", (c) => {
    if (c.get("admin")) return c.redirect("/admin", 302);
    const deps = c.get("deps");
    const code = c.req.query("erreur");
    const errors: Record<string, string> = {
      "non-autorise": "Cette adresse n'est pas autorisée à administrer ce site.",
      refus: "La connexion a été annulée.",
      echec: "La connexion a échoué. Réessayez.",
      expire: "La demande de connexion a expiré. Réessayez.",
    };
    return c.html(
      <LoginPage meta={{ ...meta(c, "Connexion"), robots: "noindex" }} error={code ? errors[code] : undefined} mock={deps.provider.kind === "mock"} />,
    );
  });

  app.get("/auth/google/connexion", (c) => {
    const deps = c.get("deps");
    if (!deps.limiter.allow(`login:${clientIp(c, deps.config.trustProxy)}`, 20, 10 * 60_000)) {
      return errorPage(c, 429, "Trop de demandes", "Patientez quelques minutes avant de réessayer.");
    }
    return startOAuth(c, "login");
  });

  app.get("/admin/agendas/connecter", requireAdmin, (c) => startOAuth(c, "connect"));

  app.get("/auth/google/callback", async (c) => {
    const deps = c.get("deps");
    const state = c.req.query("state") ?? "";
    const cookieState = getCookie(c, cookieName(deps.config, "oauth")) ?? "";
    deleteCookie(c, cookieName(deps.config, "oauth"), { path: "/", secure: deps.config.secureCookies });
    const stored = state ? deps.repo.consumeOAuthState(state) : null;
    if (!stored || !cookieState || !safeEqual(state, cookieState)) {
      return c.redirect("/admin/connexion?erreur=expire", 302);
    }
    const failTarget = stored.purpose === "login" ? "/admin/connexion" : "/admin/agendas";
    if (c.req.query("error")) return c.redirect(`${failTarget}?erreur=refus`, 302);
    const code = c.req.query("code");
    if (!code) return c.redirect(`${failTarget}?erreur=echec`, 302);

    let tokens;
    try {
      tokens = await deps.provider.exchangeCode({ code, codeVerifier: stored.codeVerifier, redirectUri: redirectUri(c) });
    } catch (err) {
      log.warn("échange du code OAuth impossible", { purpose: stored.purpose, err });
      return c.redirect(`${failTarget}?erreur=echec`, 302);
    }

    if (stored.purpose === "login") {
      const email = tokens.identity.email;
      if (!tokens.identity.emailVerified || !deps.config.adminEmails.includes(email)) {
        log.warn("connexion admin refusée", { email });
        return c.redirect("/admin/connexion?erreur=non-autorise", 302);
      }
      const sid = randomToken();
      deps.repo.createSession(sha256(sid), email, SESSION_TTL);
      setCookie(c, cookieName(deps.config, "sid"), sid, {
        httpOnly: true,
        secure: deps.config.secureCookies,
        sameSite: "Lax",
        path: "/",
        maxAge: SESSION_TTL / 1000,
      });
      log.info("connexion admin", { email });
      return c.redirect("/admin", 302);
    }

    if (!c.get("admin")) return c.redirect("/admin/connexion", 302);
    try {
      const account = await deps.accounts.connect(tokens);
      log.info("compte Google connecté", { email: account.email });
      return c.redirect(`/admin/agendas?ok=${account.status === "connected" ? "connecte" : "connecte-erreur"}`, 302);
    } catch (err) {
      if (err instanceof MissingScopesError) return c.redirect("/admin/agendas?erreur=autorisations", 302);
      log.error("connexion du compte impossible", { err });
      return c.redirect("/admin/agendas?erreur=echec", 302);
    }
  });

  app.post("/admin/deconnexion", (c) => {
    const deps = c.get("deps");
    const name = cookieName(deps.config, "sid");
    const sid = getCookie(c, name);
    if (sid) deps.repo.deleteSession(sha256(sid));
    deleteCookie(c, name, { path: "/", secure: deps.config.secureCookies });
    return c.redirect("/admin/connexion", 303);
  });

  // Écran de consentement du fournisseur simulé. N'existe qu'avec CALENDAR_PROVIDER=mock.
  app.get("/auth/mock/authorize", (c) => {
    const deps = c.get("deps");
    if (!deps.mock) return c.notFound();
    const purpose = c.req.query("purpose") === "connect" ? "connect" : "login";
    return c.html(
      <MockConsentPage
        meta={{ ...meta(c, "Connexion simulée"), robots: "noindex" }}
        purpose={purpose}
        state={c.req.query("state") ?? ""}
        challenge={c.req.query("code_challenge") ?? ""}
        email={purpose === "login" ? (deps.config.adminEmails[0] ?? "") : "moi@exemple.test"}
      />,
    );
  });

  app.post("/auth/mock/authorize", async (c) => {
    const deps = c.get("deps");
    if (!deps.mock) return c.notFound();
    const body = await c.req.parseBody({ all: true });
    const state = field(body, "state");
    const target = new URL(redirectUri(c));
    target.searchParams.set("state", state);
    if (field(body, "decision") !== "autoriser") {
      target.searchParams.set("error", "access_denied");
    } else {
      const email = field(body, "email").trim().toLowerCase();
      const purpose = field(body, "purpose") === "connect" ? "connect" : "login";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return c.html(
          <MockConsentPage
            meta={{ ...meta(c, "Connexion simulée"), robots: "noindex" }}
            purpose={purpose}
            state={state}
            challenge={field(body, "code_challenge")}
            email={email}
            error="Adresse email invalide."
          />,
          400,
        );
      }
      target.searchParams.set("code", deps.mock.issueCode({ email, codeChallenge: field(body, "code_challenge"), purpose }));
    }
    return c.redirect(target.pathname + target.search, 303);
  });
}
