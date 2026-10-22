import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config.js";
import { randomToken, safeEqual } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import type { Ctx, Env } from "./context.js";

export function cookieName(config: Config, base: string): string {
  return config.secureCookies ? `__Host-${base}` : base;
}

export function securityHeaders(config: Config): MiddlewareHandler<Env> {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    h.set("Content-Security-Policy", csp);
    h.set("X-Content-Type-Options", "nosniff");
    h.set("X-Frame-Options", "DENY");
    // same-origin conserve l'en-tête Origin sur les POST, nécessaire à la vérification CSRF.
    h.set("Referrer-Policy", "same-origin");
    h.set("Cross-Origin-Opener-Policy", "same-origin");
    h.set("Cross-Origin-Resource-Policy", "same-origin");
    h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    if (config.secureCookies) h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    const type = h.get("content-type") ?? "";
    if (type.startsWith("text/html") && !h.has("cache-control")) h.set("Cache-Control", "no-store");
  };
}

// Masque les jetons de gestion dans les journaux.
function redact(path: string): string {
  return path.replace(/^\/b\/[^/]+/, "/b/:jeton").replace(/^\/auth\/google\/callback.*/, "/auth/google/callback");
}

export const requestLog: MiddlewareHandler<Env> = async (c, next) => {
  const start = performance.now();
  await next();
  if (c.req.path === "/healthz") return;
  log.info("requête", {
    method: c.req.method,
    path: redact(c.req.path),
    status: c.res.status,
    ms: Math.round(performance.now() - start),
  });
};

export function clientIp(c: Ctx, trustProxy: boolean): string {
  if (trustProxy) {
    // Entrée la plus à droite : ajoutée par le proxy de confiance, non falsifiable par le client.
    const xff = c.req.header("x-forwarded-for");
    const last = xff?.split(",").pop()?.trim();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? "inconnu";
  } catch {
    return "inconnu";
  }
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Jeton CSRF en double soumission : cookie HttpOnly et champ _csrf (ou en-tête x-csrf-token), plus contrôle de l'origine.
export function csrf(config: Config, onFail: (c: Ctx) => Response | Promise<Response>): MiddlewareHandler<Env> {
  const name = cookieName(config, "csrf");
  const origin = config.baseUrl.origin;
  return async (c, next) => {
    let token = getCookie(c, name);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      token = randomToken();
      setCookie(c, name, token, { httpOnly: true, secure: config.secureCookies, sameSite: "Lax", path: "/" });
    }
    c.set("csrf", token);
    if (!UNSAFE.has(c.req.method)) return next();

    const requestOrigin = c.req.header("origin");
    const fetchSite = c.req.header("sec-fetch-site");
    if (requestOrigin && requestOrigin !== origin) return onFail(c);
    if (!requestOrigin && fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return onFail(c);

    let sent = c.req.header("x-csrf-token") ?? "";
    if (!sent) {
      const type = c.req.header("content-type") ?? "";
      if (type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data")) {
        const body = await c.req.parseBody({ all: true });
        const v = body._csrf;
        sent = typeof v === "string" ? v : "";
      }
    }
    if (!sent || !getCookie(c, name) || !safeEqual(sent, token)) return onFail(c);
    return next();
  };
}
