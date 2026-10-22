// Limitation de débit en mémoire, par fenêtre fixe. Suffisant pour un seul processus.
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  // Retourne vrai si la requête est autorisée.
  allow(key: string, limit: number, windowMs: number): boolean {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
