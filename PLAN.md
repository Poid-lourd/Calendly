# Plan

Alternative à Calendly auto-hébergée, un espace par personne autorisée, un seul service Node.js avec SQLite.

## Architecture

```
navigateur ──HTTPS──> Caddy ──HTTP──> app (Node 22, Hono, rendu serveur)
                                        ├── SQLite (volume /data)
                                        └── CalendarProvider
                                              ├── GoogleProvider (OAuth, Calendar API v3)
                                              └── MockProvider (CALENDAR_PROVIDER=mock)
```

- Rendu HTML côté serveur (Hono JSX). Chaque écran fonctionne sans JavaScript.
  Un petit script client (TypeScript, esbuild) ajoute la détection du fuseau,
  la navigation clavier dans le calendrier et le rechargement partiel du calendrier.
- Un seul processus. `better-sqlite3` est synchrone, une transaction `BEGIN IMMEDIATE`
  ne peut pas être entrelacée avec une autre requête, ce qui garantit l'absence de double réservation.
- Le fournisseur d'agenda est une interface (`src/providers/types.ts`).
  Le mode simulé remplace Google pour l'OAuth (connexion admin et connexion des comptes),
  la liste des agendas, le freebusy et les événements, avec un état persistant en base.
- Luxon gère tous les fuseaux et changements d'heure.

## Modèle de données

| Table | Rôle |
|---|---|
| `users` | personne autorisée : email de connexion, adresse de page (unique), nom affiché, photo (blob), couleur d'accent, signature |
| `admin_sessions` | sessions admin (hash du jeton, email, expiration) |
| `oauth_states` | state, code_verifier PKCE, but (`login` ou `connect`), expiration |
| `google_accounts` | personne, email, sub (unique), refresh token chiffré, scopes, statut (`connected`, `disconnected`), dernière erreur |
| `calendars` | agendas de chaque compte (id Google, nom, fuseau, rôle d'accès, principal) |
| `schedules` | plannings, personne, nom, fuseau |
| `schedule_rules` | plages hebdomadaires (jour ISO, minute début, minute fin, nombre de créneaux facultatif), plusieurs par jour |
| `schedule_overrides` | exceptions par date. une ligne sans horaires = journée indisponible |
| `event_types` | personne, slug (unique par personne), titre, description, durée, lieu, planning, agenda de destination, intervalle, tampons, préavis, horizon, plafond quotidien, visibilité, actif |
| `event_type_calendars` | agendas bloquants d'un type d'événement |
| `bookings` | créneau (UTC, ms), invité, note, fuseau invité, statut (`pending`, `confirmed`, `cancelled`), hash du jeton, id et agenda de l'événement Google, lien Meet |
| `mock_events` | événements du fournisseur simulé |

## Règles de disponibilité

1. Plages du planning pour chaque date locale du planning (exception de date prioritaire sur la règle hebdomadaire).
2. Candidats espacés de l'intervalle à partir du début de chaque plage, la durée doit tenir dans la plage.
3. Exclusion si préavis non respecté, au-delà de l'horizon, plafond quotidien atteint.
4. Exclusion si `[début - tampon avant, fin + tampon après]` chevauche une période occupée.
   Périodes occupées = freebusy Google des agendas bloquants + agenda de destination,
   plus les réservations locales non annulées sur ces agendas.
5. Plage avec un nombre de créneaux N : parmi ses candidats libres (étape 4), N au plus sont proposés,
   réservations actives du planning dans la plage comprises. Choix glouton dans l'ordre, espacement minimal
   durée de la plage / N, puis complément avec les candidats restants. Le choix porte sur toute la plage,
   avant les filtres de période et de préavis, pour rester identique entre l'affichage et la réservation.
6. Si un compte nécessaire est déconnecté ou si Google renvoie une erreur, aucun créneau n'est proposé.

## Réservation

1. Validation des entrées, honeypot, limitation de débit, CSRF.
2. Recalcul des créneaux disponibles pour le jour concerné avec un freebusy frais.
3. Transaction `BEGIN IMMEDIATE`. revérification des réservations locales et du plafond, insertion `pending` avec un id d'événement Google généré localement.
4. Création de l'événement Google (`sendUpdates=all`, Meet via `conferenceData`).
5. Passage en `confirmed`. En cas d'échec Google, suppression de la ligne `pending`.
6. Au démarrage, les lignes `pending` anciennes sont réconciliées avec Google (événement présent = confirmée, absent = supprimée).

## Étapes

1. Plan, squelette du projet, outillage (TypeScript strict, ESLint, Vitest, Playwright).
2. Configuration, base SQLite, migrations, chiffrement.
3. Calcul des créneaux et tests unitaires.
4. Fournisseurs Google et simulé, OAuth (state, PKCE, offline), tests du client Google.
5. Service de réservation, annulation, reprogrammation, test de concurrence.
6. Interface web publique et admin, sécurité (CSRF, en-têtes, débit, cookies).
7. Docker, Caddy, sauvegarde, README, DECISIONS, .env.example.
8. E2E Playwright, captures d'écran, auto-revue du design et corrections.
