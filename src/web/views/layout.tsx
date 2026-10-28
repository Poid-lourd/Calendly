import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { EventType, User } from "../../db/types.js";
import { DEFAULT_ACCENT } from "../color.js";
import type { Assets } from "../context.js";

export interface PageMeta {
  title: string;
  assets: Assets;
  // Personne dont c'est la page (nom, couleur, photo). null : page commune du site.
  host: User | null;
  csrf: string;
  scripts?: ("booking" | "admin")[];
  robots?: "noindex";
}

export type HostMeta = PageMeta & { host: User };

export function avatarUrl(user: User): string | null {
  return user.hasAvatar ? `/media/avatar/${user.id}?v=${user.avatarUpdatedAt ?? 0}` : null;
}

export const hostPath = (host: User): string => `/${host.slug}`;
export const eventPath = (host: User, et: EventType): string => `/${host.slug}/${et.slug}`;

export function Document(props: PageMeta & { children: Child; bodyClass: string }) {
  const siteName = props.host?.displayName || "Rendez-vous";
  const icon = props.host ? avatarUrl(props.host) : null;
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="fr">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="csrf-token" content={props.csrf} />
        {props.robots ? <meta name="robots" content="noindex, nofollow" /> : null}
        <title>{props.title === siteName ? siteName : `${props.title} · ${siteName}`}</title>
        <link rel="stylesheet" href={props.assets.css} />
        <link rel="stylesheet" href={`/theme.css?v=${(props.host?.accentColor ?? DEFAULT_ACCENT).slice(1)}`} />
        {icon ? <link rel="icon" href={icon} /> : null}
        {(props.scripts ?? []).map((s) => (
          <script src={props.assets[s]} defer />
        ))}
      </head>
      <body class={props.bodyClass}>
        <a class="skip" href="#contenu">
          Aller au contenu
        </a>
        {props.children}
      </body>
      </html>
    </>
  );
}

export function PublicPage(props: PageMeta & { children: Child }) {
  return (
    <Document {...props} bodyClass="public">
      <main id="contenu">{props.children}</main>
      <footer class="public-foot">
        <a href="/confidentialite">Confidentialité</a>
      </footer>
    </Document>
  );
}

export function HostLine(props: { host: User; size?: "lg" }) {
  const url = avatarUrl(props.host);
  if (!url && !props.host.displayName) return null;
  return (
    <div class="info-host">
      {url ? <img class={props.size === "lg" ? "avatar avatar--lg" : "avatar"} src={url} alt="" width={40} height={40} /> : null}
      {props.host.displayName ? <span class="host">{props.host.displayName}</span> : null}
    </div>
  );
}
