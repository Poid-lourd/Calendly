import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { selectSignatureSlots } from "../domain/signature.js";
import { log } from "../lib/log.js";
import { darken } from "./color.js";
import type { Deps, Env } from "./context.js";
import { csrf, requestLog, securityHeaders } from "./middleware.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes, loadSession } from "./routes/auth.js";
import { errorPage, notFound, publicRoutes } from "./routes/public.js";

export function createApp(deps: Deps): Hono<Env> {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("admin", null);
    await next();
  });
  app.use("*", requestLog);
  app.use("*", securityHeaders(deps.config));

  // Ressources statiques et techniques, sans cookie.
  if (deps.assets.dir) {
    app.use(
      "/assets/*",
      serveStatic({
        root: deps.assets.dir,
        rewriteRequestPath: (p) => p.replace(/^\/assets/, ""),
        onFound: (_p, c) => {
          c.header("Cache-Control", "public, max-age=31536000, immutable");
        },
      }),
    );
  }

  app.get("/healthz", (c) => {
    deps.repo.db.prepare("SELECT 1").get();
    return c.json({ status: "ok" });
  });

  app.get("/theme.css", (c) => {
    const accent = deps.repo.getSettings().accentColor;
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", c.req.query("v") ? "public, max-age=31536000, immutable" : "no-cache");
    return c.body(`:root{--accent:${accent};--accent-hover:${darken(accent)};}\n`);
  });

  // Image de la signature de mail : affichée par les messageries, donc ouverte aux autres origines et jamais mise en cache.
  app.get("/signature.png", async (c) => {
    const now = deps.now();
    const selection = await selectSignatureSlots(deps.repo, deps.availability, now);
    const png = deps.signature.render(selection, now);
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    c.header("Pragma", "no-cache");
    c.header("Expires", "0");
    c.header("Cross-Origin-Resource-Policy", "cross-origin");
    return c.body(new Uint8Array(png));
  });

  app.get("/media/avatar", (c) => {
    const avatar = deps.repo.getAvatar();
    if (!avatar) return c.body(null, 404);
    c.header("Content-Type", avatar.type);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(new Uint8Array(avatar.data));
  });

  // Taille maximale des requêtes : 2 Mo pour l'envoi d'image, 64 Ko ailleurs.
  const tooLarge = (c: Context) => c.text("Requête trop volumineuse", 413);
  const limitSmall: MiddlewareHandler<Env> = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
  const limitLarge: MiddlewareHandler<Env> = bodyLimit({ maxSize: 2 * 1024 * 1024 + 64 * 1024, onError: tooLarge });
  const limitBody: MiddlewareHandler<Env> = (c, next) => (c.req.path === "/admin/reglages" ? limitLarge(c, next) : limitSmall(c, next));
  app.use("*", limitBody);

  app.use(
    "*",
    csrf(deps.config, (c) =>
      errorPage(c, 403, "Session expirée", "La page a été ouverte trop longtemps ou depuis un autre site. Rechargez-la puis recommencez."),
    ),
  );
  app.use("*", loadSession);

  authRoutes(app);
  adminRoutes(app);
  publicRoutes(app);

  app.notFound((c) => notFound(c));
  app.onError((err, c) => {
    log.error("erreur non gérée", { path: c.req.path, err, stack: err.stack });
    return errorPage(c, 500, "Une erreur est survenue", "La demande n'a pas abouti. Réessayez dans quelques instants.");
  });
  return app;
}
