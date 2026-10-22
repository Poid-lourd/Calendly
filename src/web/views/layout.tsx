import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { Settings } from "../../db/types.js";
import type { Assets } from "../context.js";

export interface PageMeta {
  title: string;
  assets: Assets;
  settings: Settings;
  csrf: string;
  scripts?: ("booking" | "admin")[];
  robots?: "noindex";
}

export function avatarUrl(settings: Settings): string | null {
  return settings.hasAvatar ? `/media/avatar?v=${settings.avatarUpdatedAt ?? 0}` : null;
}

export function Document(props: PageMeta & { children: Child; bodyClass: string }) {
  const siteName = props.settings.displayName || "Rendez-vous";
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
        <link rel="stylesheet" href={`/theme.css?v=${props.settings.accentColor.slice(1)}`} />
        {avatarUrl(props.settings) ? <link rel="icon" href={avatarUrl(props.settings)!} /> : null}
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
    </Document>
  );
}

export function HostLine(props: { settings: Settings; size?: "lg" }) {
  const url = avatarUrl(props.settings);
  if (!url && !props.settings.displayName) return null;
  return (
    <div class="info-host">
      {url ? <img class={props.size === "lg" ? "avatar avatar--lg" : "avatar"} src={url} alt="" width={40} height={40} /> : null}
      {props.settings.displayName ? <span class="host">{props.settings.displayName}</span> : null}
    </div>
  );
}
