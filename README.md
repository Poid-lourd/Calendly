# Rendez-vous

Prise de rendez-vous auto-hébergée et mono-utilisateur, adossée à Google Agenda.

- Pages publiques : liste des types de rendez-vous, puis jour, horaire, coordonnées et confirmation.
- Disponibilités calculées depuis Google Agenda (freebusy), sur plusieurs comptes et agendas, partagés compris.
- Chaque réservation crée un événement Google avec l'invité, un lien Meet si besoin, et les liens d'annulation et de reprogrammation. Les notifications sont envoyées par Google, sans serveur de messagerie.
- Administration sur `/admin` : comptes et agendas, plannings, types d'événements, réservations, réglages.

Un seul service Node.js, SQLite sur un volume, Caddy pour le HTTPS. Les choix techniques sont détaillés dans [DECISIONS.md](DECISIONS.md), l'architecture dans [PLAN.md](PLAN.md).

## Essayer en local, en mode simulé

```sh
docker compose up --build
```

Sans fichier `.env`, l'application démarre avec un fournisseur d'agenda simulé et des données de démonstration.

- Pages publiques : <https://localhost> (certificat de l'autorité locale de Caddy, accepter l'avertissement du navigateur).
- Administration : <https://localhost/admin>. L'écran de connexion Google est remplacé par un écran simulé ; l'adresse autorisée par défaut est `admin@exemple.test`.
- Une adresse commençant par `revoque` lors de la connexion d'un compte d'agenda simule une autorisation révoquée.

Sans Docker (Node.js 22.12 ou plus récent) :

```sh
npm ci
npm run dev:mock     # http://localhost:3000, admin@exemple.test
```

## Configurer Google Cloud

Une seule fois, avec le compte Google qui administrera l'application.

1. **Projet**. Ouvrir <https://console.cloud.google.com>, créer un projet (par exemple « Rendez-vous »).
2. **API Google Calendar**. Menu *API et services* → *Bibliothèque* → rechercher « Google Calendar API » → *Activer*.
3. **Écran de consentement**. Menu *Google Auth Platform* (anciennement *Écran de consentement OAuth*) → *Commencer*.
   - Nom de l'application, adresse d'assistance, coordonnées du développeur.
   - **Audience** :
     - *Interne* si tous les comptes Google à connecter (le vôtre et celui de l'agenda de l'entreprise) appartiennent à la même organisation Google Workspace que le projet.
     - *Externe* dans tous les autres cas (compte Gmail personnel, deux organisations différentes). Ensuite, dans *Audience*, cliquer sur **Publier l'application** pour passer en production. En statut *Test*, Google fait expirer les refresh tokens après 7 jours : les comptes se déconnecteraient chaque semaine.
     - En production sans validation Google, l'écran « Google n'a pas validé cette application » s'affiche à la connexion. C'est attendu pour un usage personnel : *Paramètres avancés* → *Accéder à Rendez-vous (non sécurisé)*.
4. **Scopes**. Menu *Accès aux données* → *Ajouter ou supprimer des champs d'application*. Ajouter :
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly` (liste des agendas)
   - `https://www.googleapis.com/auth/calendar.events.freebusy` (disponibilités)
   - `https://www.googleapis.com/auth/calendar.events` (création et modification des événements)

   Les trois derniers sont classés « sensibles » ; aucune validation n'est nécessaire pour un usage personnel avec l'avertissement ci-dessus.
5. **Client OAuth**. Menu *Clients* → *Créer un client* :
   - Type : *Application Web*.
   - URI de redirection autorisé : `https://VOTRE-DOMAINE/auth/google/callback` (exactement `BASE_URL` suivi de `/auth/google/callback`).
   - Aucune origine JavaScript n'est nécessaire.
6. **Identifiants**. Copier l'ID client et le code secret dans `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` du fichier `.env`.

### Si l'entreprise restreint les applications tierces

Si l'agenda de l'entreprise dépend d'un compte Google Workspace dont l'administrateur bloque les applications non approuvées, la connexion échoue avec « Accès bloqué ». L'administrateur Workspace doit autoriser l'ID client :

*Console d'administration* → *Sécurité* → *Accès et contrôle des données* → *Commandes des API* → *Gérer l'accès des applications tierces* → *Ajouter une application* → *ID client OAuth* → coller l'ID client → accès *Fiable* (ou *Limité* selon la politique de l'entreprise).

### Connecter les agendas

Dans `/admin/agendas`, *Connecter un compte Google* :

- Si votre compte voit déjà l'agenda de l'entreprise (agenda partagé avec vous et ajouté dans Google Agenda), un seul compte suffit : ses agendas partagés sont listés.
- Sinon, connectez les deux comptes l'un après l'autre. Chacun garde son propre jeton.

Créez ensuite un planning dans *Disponibilités*, puis un type d'événement en choisissant l'agenda de destination (où l'événement est créé) et les agendas bloquants.

## Déployer sur une VM

Prérequis : Docker Engine avec le plugin Compose, un nom de domaine dont l'enregistrement DNS pointe vers la VM, ports 80 et 443 ouverts.

```sh
git clone https://github.com/Poid-lourd/calendly.git rendez-vous
cd rendez-vous
cp .env.example .env
openssl rand -base64 32          # valeur de ENCRYPTION_KEY
nano .env                        # DOMAIN, ADMIN_EMAILS, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ENCRYPTION_KEY
docker compose up -d --build
docker compose logs -f app       # « serveur démarré »
```

Caddy obtient le certificat Let's Encrypt pour `DOMAIN` au premier accès. Ouvrir `https://DOMAIN/admin`, se connecter avec une adresse de `ADMIN_EMAILS`, puis connecter les agendas.

L'état de santé est exposé sur `/healthz` et utilisé par le `HEALTHCHECK` de l'image.

### Derrière un reverse proxy existant

Si la VM a déjà un proxy (nginx, Traefik, Apache) qui gère TLS, utilisez `docker-compose.proxy.yml` : il ne lance que l'application, sur `127.0.0.1:3000`.

```sh
# .env : BASE_URL=https://rdv.exemple.fr, plus les variables Google et ENCRYPTION_KEY
docker compose -f docker-compose.proxy.yml up -d --build
```

Exemple nginx :

```nginx
server {
    listen 443 ssl;
    server_name rdv.exemple.fr;
    # ssl_certificate ... ; ssl_certificate_key ... ;
    client_max_body_size 3m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`TRUST_PROXY=true` est déjà défini dans le fichier compose : l'adresse du visiteur est lue dans `X-Forwarded-For` pour la limitation de débit. Le proxy doit transmettre cet en-tête et l'application ne doit pas être joignable directement depuis l'extérieur.

## Mettre à jour

```sh
scripts/backup.sh
git pull
docker compose up -d --build
```

Les migrations de base de données s'appliquent au démarrage. Avec la variante proxy, ajouter `-f docker-compose.proxy.yml` aux commandes `docker compose` et le passer en argument aux scripts.

## Sauvegarder et restaurer

La base SQLite est dans le volume Docker `app_data` (`/data/app.db` dans le conteneur).

```sh
scripts/backup.sh                                   # copie cohérente à chaud dans ./backups, 30 dernières conservées
scripts/restore.sh backups/app-20261022-140351.db   # arrête l'application, remplace la base, redémarre
```

La sauvegarde utilise l'API de sauvegarde en ligne de SQLite et vérifie l'intégrité de la copie. Exemple de sauvegarde quotidienne à 3 h :

```cron
0 3 * * * cd /home/deploy/rendez-vous && scripts/backup.sh >> backups/backup.log 2>&1
```

Copiez aussi `backups/` et le fichier `.env` hors de la VM : sans `ENCRYPTION_KEY`, les jetons Google sauvegardés sont illisibles et les comptes doivent être reconnectés.

## Variables d'environnement

Toutes sont décrites dans [.env.example](.env.example).

| Variable | Rôle |
|---|---|
| `CALENDAR_PROVIDER` | `google` ou `mock` |
| `DOMAIN` | domaine servi par Caddy |
| `BASE_URL` | URL publique, par défaut `https://DOMAIN` |
| `ADMIN_EMAILS` | adresses autorisées sur `/admin` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | client OAuth Google |
| `ENCRYPTION_KEY` | clé de chiffrement des refresh tokens (32 octets, base64) |
| `DEMO_SEED` | données de démonstration en mode simulé |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` |

## Développement

```sh
npm ci
npm run dev:mock        # serveur en mode simulé
npm run lint            # ESLint
npm run typecheck       # TypeScript
npm test                # tests unitaires et d'intégration (Vitest)
npm run test:e2e        # parcours complet et audit d'accessibilité dans Chromium (Playwright)
npm run screenshots     # captures 390 px et 1440 px dans docs/screenshots
```

Les tests couvrent le calcul des créneaux (tampons, préavis, horizon, plafond, exceptions, agendas multiples, changements d'heure à Paris et New York, visiteur dans un autre fuseau), l'absence de double réservation sous requêtes simultanées, le client Google sur des réponses d'API simulées, la sécurité HTTP, le parcours réservation, reprogrammation, annulation (avec et sans JavaScript, au clavier, dans un autre fuseau) et l'accessibilité WCAG 2.1 AA de chaque écran avec axe-core.

```
src/
  server.ts            démarrage, migrations, arrêt propre
  config.ts            variables d'environnement
  db/                  schéma, migrations, accès aux données
  domain/              créneaux, disponibilités, réservations
  providers/           interface d'agenda, Google, simulé, comptes connectés
  web/                 routes, vues, sécurité
  client/              scripts navigateur
  styles/              feuille de style
tests/                 unitaires, intégration, Playwright
docs/screenshots/      captures de chaque écran
```

Si `npm ci` doit passer par un proxy d'entreprise pendant `docker build`, fournir les secrets BuildKit facultatifs : `docker build --secret id=npmrc,src=$HOME/.npmrc --secret id=npm_ca,src=ca.crt .`

## Captures

Chaque écran, états vides, de chargement et d'erreur compris, en 390 px et 1440 px : [docs/screenshots](docs/screenshots).

## Limites connues

- Mono-utilisateur : une seule personne reçoit les rendez-vous, même si plusieurs adresses peuvent administrer.
- Un seul processus applicatif : la limitation de débit et le cache de disponibilités (30 secondes) sont en mémoire.
- Lors d'une reprogrammation, la période de l'événement actuel est retirée des occupations Google uniquement si freebusy la renvoie telle quelle ; si elle est fusionnée avec un autre événement contigu, l'ancienne plage reste bloquée.
- Les agendas partagés n'apparaissent que s'ils figurent dans la liste d'agendas du compte Google.
- Le lien Meet est lu dans la réponse de Google ; si la conférence n'est pas encore prête, la page de confirmation renvoie vers l'invitation.
- Les heures d'administration s'affichent dans le fuseau du planning concerné.
