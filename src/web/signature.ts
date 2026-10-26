import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { DateTime } from "luxon";
import type { SignatureSelection } from "../domain/signature.js";
import { woffToSfnt } from "../lib/woff.js";

// Image de la signature de mail et bloc HTML à coller dans la messagerie.
// L'image est recalculée à chaque ouverture du message : elle montre les créneaux libres du moment.

export const SIGNATURE_WIDTH = 480;
export const SIGNATURE_HEIGHT = 112;
const SCALE = 2;
const FONT = "IBM Plex Sans";
const TEXT = "#171716";
const TEXT_2 = "#5c5c58";
const LINE = "#8a8a85";
const CACHE_TTL = 60_000;

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function zoneCaption(zone: string, at: number): string {
  const city = (zone.split("/").pop() ?? zone).replaceAll("_", " ");
  const offset = DateTime.fromMillis(at, { zone }).toFormat("ZZ").replace("-", "−");
  return `Heure de ${city} (UTC${offset})`;
}

export function signatureSvg(selection: SignatureSelection, now: number): string {
  const parts: string[] = [];
  // Les fichiers Fontsource déclarent une famille par graisse : « IBM Plex Sans Medium », « IBM Plex Sans SemiBold ».
  const family = (weight: number) => (weight >= 600 ? `${FONT} SemiBold` : weight >= 500 ? `${FONT} Medium` : FONT);
  const text = (x: number, y: number, size: number, weight: number, color: string, value: string) =>
    parts.push(
      `<text x="${x}" y="${y}" font-family="${family(weight)}" font-size="${size}" fill="${color}">${escapeXml(value)}</text>`,
    );

  if (selection.status === "ok") {
    text(0, 15, 13, 500, TEXT_2, selection.week === "current" ? "Cette semaine" : "Semaine prochaine");
    const chipW = 112;
    const gap = 8;
    selection.slots.forEach((s, i) => {
      const x = i * (chipW + gap) + 0.5;
      const d = DateTime.fromMillis(s, { zone: selection.zone }).setLocale("fr");
      parts.push(`<rect x="${x}" y="24.5" width="${chipW - 1}" height="55" rx="4" fill="#ffffff" stroke="${LINE}" stroke-width="1"/>`);
      text(x + 12, 46, 13, 400, TEXT_2, capitalize(d.toFormat("ccc d LLL")));
      text(x + 12, 68, 17, 600, TEXT, d.toFormat("HH:mm"));
    });
    text(0, 104, 12, 400, TEXT_2, `${zoneCaption(selection.zone, now)} · cliquer pour réserver`);
  } else if (selection.status === "empty") {
    text(0, 44, 15, 600, TEXT, "Aucun créneau libre cette semaine");
    text(0, 68, 13, 400, TEXT_2, "Les semaines suivantes sont accessibles par le lien ci-dessous.");
  } else {
    text(0, 44, 15, 600, TEXT, "Disponibilités en ligne");
    text(0, 68, 13, 400, TEXT_2, "Cliquer pour choisir un horaire.");
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIGNATURE_WIDTH * SCALE}" height="${SIGNATURE_HEIGHT * SCALE}" viewBox="0 0 ${SIGNATURE_WIDTH} ${SIGNATURE_HEIGHT}">`,
    `<rect width="${SIGNATURE_WIDTH}" height="${SIGNATURE_HEIGHT}" fill="#ffffff"/>`,
    ...parts,
    "</svg>",
  ].join("");
}

export class SignatureRenderer {
  private readonly fontFiles: string[];
  private readonly cache = new Map<string, { expires: number; png: Buffer }>();

  // Les polices WOFF du site sont converties en TrueType dans un dossier temporaire, lisible par le moteur de rendu.
  constructor(woffFiles: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "rdv-polices-"));
    this.fontFiles = woffFiles.map((file) => {
      const target = path.join(dir, `${path.basename(file, ".woff")}.ttf`);
      writeFileSync(target, woffToSfnt(readFileSync(file)));
      return target;
    });
  }

  render(selection: SignatureSelection, now: number): Buffer {
    const key = JSON.stringify([selection.status, selection.week, selection.zone, selection.slots]);
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.png;
    const svg = signatureSvg(selection, now);
    const png = new Resvg(svg, {
      font: { fontFiles: this.fontFiles, loadSystemFonts: false, defaultFontFamily: FONT },
      background: "#ffffff",
    })
      .render()
      .asPng();
    if (this.cache.size > 50) this.cache.clear();
    this.cache.set(key, { expires: now + CACHE_TTL, png });
    return png;
  }
}

// Bloc HTML de signature, compatible avec les messageries : tableau, styles en ligne, URL absolues.
export function signatureHtml(opts: { baseUrl: URL; slug: string; accent: string }): string {
  const url = (p: string) => new URL(p, opts.baseUrl).toString();
  const font = "font-family:'IBM Plex Sans',-apple-system,'Segoe UI',Helvetica,sans-serif;";
  return [
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:16px;">`,
    `<tr><td style="padding:0 0 8px 0;${font}font-size:14px;font-weight:600;color:${TEXT};">Réserver un échange</td></tr>`,
    `<tr><td style="padding:0;"><a href="${url("/creneaux")}" style="text-decoration:none;">`,
    `<img src="${url("/signature.png")}" width="${SIGNATURE_WIDTH}" height="${SIGNATURE_HEIGHT}" alt="Voir les créneaux disponibles cette semaine" style="display:block;width:100%;max-width:${SIGNATURE_WIDTH}px;height:auto;border:0;">`,
    `</a></td></tr>`,
    `<tr><td style="padding:8px 0 0 0;${font}font-size:13px;"><a href="${url(`/${opts.slug}`)}" style="color:${opts.accent};text-decoration:underline;">Plus de disponibilités dans les semaines à venir</a></td></tr>`,
    `</table>`,
  ].join("\n");
}
