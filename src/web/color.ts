// Contraste WCAG 2.x entre deux couleurs hexadécimales.
function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isHexColor(v: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(v);
}

// Variante plus sombre pour le survol.
export function darken(hex: string, amount = 0.14): string {
  const [r, g, b] = rgb(hex);
  const f = (v: number) =>
    Math.round(v * (1 - amount))
      .toString(16)
      .padStart(2, "0");
  return `#${f(r)}${f(g)}${f(b)}`;
}
