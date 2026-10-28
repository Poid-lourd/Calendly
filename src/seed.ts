import type { Repo } from "./db/repo.js";
import type { Accounts } from "./providers/accounts.js";
import { MOCK_COMPANY_CALENDAR } from "./providers/mock.js";

const H = (h: number, m = 0) => h * 60 + m;

// Données de démonstration pour le mode simulé, dans l'espace de owner (adresse de connexion à l'admin) :
// un compte Google connecté, un planning, trois types d'événements, la signature.
export async function seedDemo(repo: Repo, accounts: Accounts, owner: string, email = "moi@exemple.test"): Promise<boolean> {
  if (accounts.provider.kind !== "mock") throw new Error("Données de démonstration réservées au mode simulé");
  if (repo.getUserByEmail(owner)) return false;

  const user = repo.ensureUser(owner);
  repo.updateProfile(user.id, { displayName: "Camille Martin", accentColor: user.accentColor, slug: "camille-martin" });
  const account = await accounts.connect(user.id, {
    identity: { subject: `mock-${email}`, email, emailVerified: true },
    refreshToken: `mock-refresh:${email}`,
    scopes: accounts.provider.connectScopes,
  });
  const calendars = repo.listCalendars(user.id).filter((c) => c.accountId === account.id);
  const personal = calendars.find((c) => c.isPrimary)!;
  const company = calendars.find((c) => c.externalId === MOCK_COMPANY_CALENDAR)!;

  const office = [
    { start: H(9), end: H(12) },
    { start: H(14), end: H(18) },
  ];
  const scheduleId = repo.saveSchedule(user.id, null, {
    name: "Horaires de bureau",
    timeZone: "Europe/Paris",
    weekly: { 1: office, 2: office, 3: office, 4: office, 5: [{ start: H(9), end: H(12) }, { start: H(14), end: H(17) }], 6: [], 7: [] },
  });

  const common = {
    scheduleId,
    slotIntervalMinutes: null,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minNoticeMinutes: 240,
    maxHorizonDays: 60,
    dailyLimit: null,
    active: true,
  };
  const echangeId = repo.saveEventType(user.id, null, {
    ...common,
    slug: "echange-30-min",
    title: "Échange de 30 minutes",
    description: "Premier échange pour faire connaissance et cadrer votre besoin.",
    durationMinutes: 30,
    locationType: "meet",
    locationValue: "",
    destinationCalendarId: personal.id,
    bufferAfterMinutes: 10,
    visibility: "public",
    blockingCalendarIds: [personal.id, company.id],
  });
  repo.saveEventType(user.id, null, {
    ...common,
    slug: "point-projet",
    title: "Point projet",
    description: "Revue d'avancement dans nos locaux. Apportez vos documents.",
    durationMinutes: 60,
    locationType: "address",
    locationValue: "12 rue de la Paix, 75002 Paris",
    destinationCalendarId: company.id,
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
    minNoticeMinutes: 1440,
    maxHorizonDays: 30,
    dailyLimit: 2,
    visibility: "public",
    blockingCalendarIds: [personal.id, company.id],
  });
  repo.saveEventType(user.id, null, {
    ...common,
    slug: "appel",
    title: "Appel téléphonique",
    description: "Appel court pour une question précise.",
    durationMinutes: 15,
    locationType: "phone",
    locationValue: "+33 1 23 45 67 89",
    destinationCalendarId: personal.id,
    slotIntervalMinutes: 15,
    visibility: "unlisted",
    blockingCalendarIds: [personal.id],
  });
  repo.updateSignature(user.id, { eventTypeId: echangeId, maxSlots: 3 });
  return true;
}
