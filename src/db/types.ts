export type AccountStatus = "connected" | "disconnected";
export type LocationType = "meet" | "phone" | "address" | "text";
export type Visibility = "public" | "unlisted";
export type BookingStatus = "pending" | "confirmed" | "cancelled";

// Personne qui reçoit des rendez-vous. Son espace est créé à sa première connexion à l'admin.
export interface User {
  id: number;
  // Adresse Google de connexion à l'admin.
  email: string;
  // Adresse de sa page publique : /slug.
  slug: string;
  displayName: string;
  accentColor: string;
  hasAvatar: boolean;
  avatarUpdatedAt: number | null;
  // Signature de mail : type d'événement proposé et nombre de créneaux montrés.
  signatureEventTypeId: number | null;
  signatureMaxSlots: number;
}

export interface GoogleAccount {
  id: number;
  userId: number;
  subject: string;
  email: string;
  refreshTokenEnc: string | null;
  scopes: string[];
  status: AccountStatus;
  lastError: string | null;
  connectedAt: number;
  syncedAt: number | null;
}

export interface Calendar {
  id: number;
  accountId: number;
  externalId: string;
  summary: string;
  timeZone: string | null;
  accessRole: string;
  isPrimary: boolean;
  present: boolean;
}

export interface MinuteRange {
  start: number;
  end: number;
  // Nombre de créneaux proposés dans la plage, réservations comprises. Absent : tous les créneaux libres.
  maxSlots?: number;
}

export interface Schedule {
  id: number;
  userId: number;
  name: string;
  timeZone: string;
}

export interface ScheduleDetail extends Schedule {
  // Index 1 (lundi) à 7 (dimanche), norme ISO.
  weekly: Record<number, MinuteRange[]>;
  // Date locale AAAA-MM-JJ. Tableau vide : journée indisponible.
  overrides: Record<string, MinuteRange[]>;
}

export interface EventType {
  id: number;
  userId: number;
  // Unique pour une même personne : la page est /slug-de-la-personne/slug.
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  locationType: LocationType;
  locationValue: string;
  scheduleId: number;
  destinationCalendarId: number;
  slotIntervalMinutes: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxHorizonDays: number;
  dailyLimit: number | null;
  visibility: Visibility;
  active: boolean;
  position: number;
  blockingCalendarIds: number[];
}

export interface Booking {
  id: number;
  eventTypeId: number;
  calendarId: number | null;
  startAt: number;
  endAt: number;
  pendingStartAt: number | null;
  pendingEndAt: number | null;
  title: string;
  locationType: LocationType;
  locationValue: string;
  inviteeName: string;
  inviteeEmail: string;
  inviteeNote: string;
  inviteeTimeZone: string;
  status: BookingStatus;
  externalEventId: string;
  meetUrl: string | null;
  cancelReason: string | null;
  cancelledBy: "invitee" | "host" | null;
  cancelledAt: number | null;
  rescheduledAt: number | null;
  createdAt: number;
}
