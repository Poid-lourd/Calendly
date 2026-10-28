# Rendez-vous

Prise de rendez-vous auto-hébergée, adossée à Google Agenda. Chaque personne autorisée a son propre espace : sa page, ses agendas, ses plannings et ses types de rendez-vous.

- Pages publiques : liste des personnes, page de chaque personne (`/son-nom`) avec ses types de rendez-vous, puis jour, horaire, coordonnées et confirmation (`/son-nom/type`).
- Disponibilités calculées depuis Google Agenda (freebusy), sur plusieurs comptes et agendas, partagés compris.
- Chaque réservation crée un événement Google avec l'invité, un lien Meet si besoin, et les liens d'annulation et de reprogrammation. Les notifications sont envoyées par Google, sans serveur de messagerie.
- Administration sur `/admin` : chaque personne n'y voit que son espace (comptes et agendas, plannings, types d'événements, réservations, signature, réglages).

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

Une seule fois, avec le compte Google qui administrera l'application. Le même client OAuth sert à tout le monde : chaque personne se connecte ensuite avec son propre compte.

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

### Plusieurs personnes

Toute adresse listée dans `ADMIN_EMAILS`, ou d'un domaine listé dans `ADMIN_DOMAINS` (par exemple `ADMIN_DOMAINS=exemple.fr`), peut se connecter à `/admin`. Son espace est créé à la première connexion, avec une page à l'adresse tirée de son email (`prenom.nom@exemple.fr` donne `/prenom-nom`, modifiable dans *Réglages*). Chacun connecte son propre compte Google : un compte déjà connecté par une autre personne est refusé. Les agendas partagés restent utilisables par tous, chacun via son compte.

Tant que l'application OAuth n'est pas validée par Google, chaque personne voit l'avertissement « application non validée » à la connexion de ses agendas, et le nombre d'utilisateurs est limité à 100.

Chaque plage du planning accepte un nombre de créneaux. Exemple : lundi 13:00–15:00, 2 créneaux. Le site ne propose alors que deux rendez-vous dans la plage, choisis parmi les horaires libres des agendas bloquants et espacés au mieux (13:00 et 14:00 si tout est libre). Une réservation en consomme un. Sans nombre, tous les horaires libres de la plage sont proposés.

## Signature de mail

Le menu *Signature* de l'admin génère un bloc à ajouter à votre signature :

- un titre « Réserver un échange » ;
- une image qui montre quelques créneaux libres de la semaine (1 à 4, répartis un par jour en priorité), recalculée par le serveur à chaque ouverture du message. Elle mène à une page qui liste ces créneaux, chacun réservable en un clic ;
- un lien « Plus de disponibilités dans les semaines à venir » vers le calendrier complet.

S'il ne reste rien cette semaine, l'image montre la semaine suivante. Les heures de l'image sont celles du planning (le fuseau du destinataire est inconnu à l'ouverture d'un mail) ; la page de réservation, elle, s'affiche dans le fuseau du visiteur.

Dans Infomaniak Mail : *Paramètres* → *Signatures* → votre adresse → nouvelle signature → édition du code source HTML → coller le code copié depuis l'admin à la suite de votre signature habituelle. À la rédaction, la signature se choisit dans le menu déroulant des signatures. D'après la FAQ Infomaniak, la gestion de plusieurs signatures dépend de l'offre (my kSuite+).

Une messagerie qui bloque les images affiche le titre, le texte alternatif et le lien vers le calendrier. Les messageries qui passent par un proxy d'images peuvent garder une copie quelques minutes.

## Déployer sur une VM

### En une commande (Ubuntu)

Une fois connecté en SSH à la VM :

```sh
curl -fsSL https://raw.githubusercontent.com/Poid-lourd/calendly/main/scripts/install-vm.sh | bash
```

Le script installe Docker, clone le dépôt dans `~/rendez-vous`, pose les questions nécessaires (domaine, mode Google ou simulé, adresses admin, identifiants OAuth), génère `ENCRYPTION_KEY`, démarre l'application derrière Caddy, ouvre les ports 80 et 443 si ufw est actif et programme une sauvegarde quotidienne. Sans nom de domaine, il propose une adresse `IP.sslip.io` qui obtient un vrai certificat HTTPS. En mode simulé, il génère une adresse admin aléatoire qui sert de mot de passe sur l'écran de connexion simulé.

Pour mettre à jour ensuite, lancer la copie locale du script, qui récupère la dernière version (`git pull`), sauvegarde, reconstruit et conserve `.env` :

```sh
bash ~/rendez-vous/scripts/install-vm.sh
```

La copie locale évite le cache de `raw.githubusercontent.com`, qui peut servir une version du script vieille de quelques minutes.

### Pas à pas

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
| `ADMIN_EMAILS` | adresses autorisées sur `/admin`, chacune avec son espace ; la première reçoit les données d'une installation antérieure |
| `ADMIN_DOMAINS` | domaines dont toutes les adresses sont autorisées sur `/admin` |
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

- Pas d'écran de gestion des personnes : retirer une adresse de `ADMIN_EMAILS` ou `ADMIN_DOMAINS` coupe son accès à l'admin, mais sa page publique reste en ligne.
- Un seul processus applicatif : la limitation de débit et le cache de disponibilités (30 secondes) sont en mémoire.
- Lors d'une reprogrammation, la période de l'événement actuel est retirée des occupations Google uniquement si freebusy la renvoie telle quelle ; si elle est fusionnée avec un autre événement contigu, l'ancienne plage reste bloquée.
- Les agendas partagés n'apparaissent que s'ils figurent dans la liste d'agendas du compte Google.
- Le lien Meet est lu dans la réponse de Google ; si la conférence n'est pas encore prête, la page de confirmation renvoie vers l'invitation.
- Les heures d'administration s'affichent dans le fuseau du planning concerné.
