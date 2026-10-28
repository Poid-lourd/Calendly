# Décisions

Choix faits là où le cahier des charges laissait la main, avec la raison.

## Stack

| Choix | Raison |
|---|---|
| Node.js 22, TypeScript strict | Typage de bout en bout, un seul langage côté serveur et navigateur, image Docker légère. |
| Hono et Hono JSX, rendu serveur | Framework minimal et typé. Les pages fonctionnent sans JavaScript ; le script client ne fait qu'améliorer (fuseau, clavier, rechargement partiel). Pas de bibliothèque de composants : le style est écrit à la main. |
| SQLite via better-sqlite3 | Exigé (un seul service, volume). API synchrone : une transaction `BEGIN IMMEDIATE` ne peut pas être entrelacée avec une autre requête du même processus, et SQLite sérialise les écrivains entre processus. Binaires précompilés fournis par le paquet, pas de compilation dans l'image. |
| Luxon | Bibliothèque éprouvée pour les fuseaux IANA et les changements d'heure. Aucun calcul d'offset manuel. |
| Zod | Validation des formulaires et de la configuration. |
| esbuild | Compilation du serveur et des ressources navigateur en quelques dizaines de millisecondes, noms de fichiers avec hash. |
| Vitest, Playwright | Tests unitaires et d'intégration rapides ; parcours de bout en bout et captures dans un vrai navigateur. |
| IBM Plex Sans | Police unique, auto-hébergée (paquet Fontsource), chiffres tabulaires par défaut. Ni Inter, ni Roboto, ni Arial. |

## Produit

- **Langue** : le gabarit indiquait `[LANGUE]` sans valeur. Interface en français, langue de la demande.
- **Fuseau de l'administration** : les heures d'une réservation s'affichent dans le fuseau du planning de son type d'événement. Pour les autres dates de l'admin, fuseau du premier planning, sinon `Europe/Paris`.
- **Réservation en quatre temps** : jour, horaire, coordonnées, confirmation. Les étapes 1 et 2 partagent une page (calendrier et horaires côte à côte sur desktop, l'un sous l'autre sur mobile), comme le prévoit la mise en page demandée.
- **Fuseau du visiteur** : détecté par le navigateur, mémorisé dans un cookie `tz`, modifiable par une liste. Sans JavaScript, le fuseau du planning sert de valeur par défaut.
- **Téléphone** : le numéro saisi dans le type d'événement est celui à appeler ; il figure dans le lieu de l'invitation. Le formulaire public reste limité à nom, email et note, comme demandé.
- **Horizon** : nombre de jours calendaires à partir d'aujourd'hui, dans le fuseau du planning, aujourd'hui compris.
- **Plafond quotidien** : par type d'événement, compté par date du fuseau du planning.
- **Tampons** : le créneau, tampons compris, ne doit chevaucher aucune période occupée. Les tampons d'une réservation existante protègent aussi les créneaux voisins. Les périodes occupées Google ne sont pas élargies (on ignore leur nature).
- **Intervalle** : par défaut égal à la durée. Les créneaux partent du début de chaque plage. Lors d'un changement d'heure, ils avancent en temps réel : une plage 00:00–06:00 un jour de passage à l'heure d'été donne cinq créneaux d'une heure (01:00 puis 03:00).
- **Nombre de créneaux par plage** : facultatif. Une plage 13:00–15:00 limitée à 2 propose 13:00 et 14:00 si les agendas sont libres, sinon les horaires libres les plus espacés de la plage. Une réservation dans la plage (tous types du planning) consomme un créneau sans être remplacée. Le choix se fait sur la plage entière, préavis et période demandée appliqués ensuite : un créneau passé n'est pas remplacé et la vérification d'une réservation retrouve le même choix. Les agendas sont donc interrogés sur des journées entières.
- **Nouveau planning** : pré-rempli avec deux créneaux le lundi de 13:00 à 15:00, le mardi et le jeudi de 09:00 à 11:00, plutôt qu'une semaine de bureau.
- **Agendas bloquants par défaut** : l'agenda de destination et les agendas dont un compte connecté est propriétaire (agenda principal, agendas créés ou délégués). Les agendas en lecture seule (jours fériés, collègues) restent à cocher.
- **Exceptions** : une exception remplace entièrement la semaine type pour la date. Une exception sans plage rend la journée indisponible.
- **Fin de plage à minuit** : saisie `00:00` en fin de plage.
- **Agenda de destination** : seuls les agendas avec droit de modification (propriétaire, modification) sont proposés. Il est toujours pris en compte pour les disponibilités, coché ou non.
- **Compte déconnecté ou erreur Google** : aucun créneau n'est proposé pour les types concernés (refus plutôt que risque de double réservation). L'admin affiche l'alerte et le bouton de reconnexion.
- **Réservation interrompue** : l'identifiant de l'événement Google est généré avant l'appel. Au démarrage, une réservation restée « en cours » plus de deux minutes est confirmée si l'événement existe chez Google, supprimée sinon. Idem pour une reprogrammation interrompue.
- **Annulation** : description de l'événement mise à jour sans notification (motif), puis suppression avec `sendUpdates=all` : Google envoie l'annulation aux invités.
- **Reprogrammation** : même réservation, même lien, même événement Google déplacé avec `sendUpdates=all`. L'horaire actuel n'est pas proposé. Les deux plages restent bloquées pendant l'appel à Google.
- **Visibilité** : un type non listé n'apparaît pas sur l'accueil mais reste réservable par son lien. Un type inactif n'est plus réservable ; ses réservations restent gérables. Un type avec réservations ne peut pas être supprimé, seulement désactivé.
- **Suppression d'un compte Google** : impossible tant qu'un type d'événement utilise l'un de ses agendas. Le refresh token est révoqué chez Google.
- **Agendas listés** : `calendarList` de chaque compte, agendas masqués et partagés compris. Un agenda partagé doit figurer dans la liste du compte (ajouté dans Google Agenda).
- **Photo ou logo** : stockée en base (PNG, JPEG, WebP, 1 Mo), type vérifié sur les octets. SVG refusé (risque de script).
- **Couleur d'accent** : refusée si le contraste avec le blanc est inférieur à 4,5:1, pour garder les boutons et la sélection conformes WCAG AA.
- **Ordre des types d'événements** : ordre de création.

## Signature de mail

- **Créneaux vivants dans un mail** : une signature est du HTML figé au moment de l'envoi, sans JavaScript. Seule une image, chargée à l'ouverture du message, peut montrer les créneaux du moment. Elle est générée en PNG (les messageries n'affichent pas le SVG), toujours avec un code 200, et n'est jamais mise en cache (`no-store`).
- **Une image cliquable plutôt qu'un lien par créneau** : un lien par créneau figerait des horaires peut-être pris depuis. L'image mène à `/creneaux`, qui recalcule la même sélection et lie chaque créneau au formulaire de réservation, avec revérification à la soumission.
- **Sélection partielle** : 1 à 4 créneaux (3 par défaut), un par jour d'abord en alternant matin et après-midi, puis d'autres espacés d'au moins deux heures. Semaine en cours, sinon semaine suivante.
- **Fuseau de l'image** : celui du planning, indiqué sous les créneaux.
- **Rendu** : resvg (binaires précompilés, sans compilation) et la police du site. Les fichiers WOFF de Fontsource sont convertis en TrueType au démarrage, la conversion WOFF 1.0 étant une simple décompression des tables.
- **Origine** : l'image est servie avec `Cross-Origin-Resource-Policy: cross-origin` pour s'afficher dans un webmail ; le reste du site garde `same-origin`.
- **Aperçu dans l'admin** : le bloc utilise des styles en ligne, requis par les messageries mais interdits par la politique de sécurité des pages. Il s'affiche dans un cadre servi avec sa propre politique.
- **Langue** : français, comme le reste de l'application.

## Sécurité

- **Scopes Google** : connexion admin `openid email` seulement. Connexion d'un agenda : `calendar.calendarlist.readonly` (liste des agendas), `calendar.events.freebusy` (disponibilités sur les agendas accessibles, partagés compris), `calendar.events` (création et modification d'événements, y compris dans un agenda partagé dont on n'est pas propriétaire, ce que `calendar.events.owned` ne permettrait pas). Scopes vérifiés dans la référence de la bibliothèque officielle `@googleapis/calendar`.
- **OAuth** : `state` aléatoire stocké en base (usage unique, 10 minutes) et lié au navigateur par un cookie ; PKCE S256 ; `access_type=offline` et `prompt=consent` pour la connexion d'agenda ; refus si l'utilisateur décoche un scope.
- **Jeton d'identité** : lu directement depuis le point de terminaison token de Google en TLS ; émetteur, audience et expiration vérifiés (OpenID Connect Core 3.1.3.7).
- **Refresh tokens** : AES-256-GCM, clé `ENCRYPTION_KEY`. En mode simulé sans clé, une clé de développement fixe est utilisée avec un avertissement.
- **invalid_grant** : le compte passe « déconnecté » avec le motif, les appels suivants échouent sans requête réseau, l'application continue.
- **CSRF** : jeton en double soumission (cookie HttpOnly et champ de formulaire) et contrôle de l'en-tête `Origin`. `Referrer-Policy: same-origin` pour que les navigateurs envoient `Origin` sur les POST.
- **Cookies** : HttpOnly, SameSite=Lax, préfixe `__Host-` et Secure dès que `BASE_URL` est en HTTPS.
- **En-têtes** : CSP stricte (`'self'` uniquement, aucun style ni script en ligne), `X-Frame-Options: DENY`, `nosniff`, HSTS en HTTPS, COOP, CORP, Permissions-Policy.
- **Débit** : fenêtres fixes en mémoire par adresse IP (réservation 10 par 10 minutes, gestion par lien 20 par 10 minutes, calendrier 120 par minute, connexion 20 par 10 minutes). Derrière un proxy, l'adresse est l'entrée la plus à droite de `X-Forwarded-For`, la seule non falsifiable par le client.
- **Pot de miel** : champ caché `site_web` ; s'il est rempli, la demande est refusée.
- **Jetons de gestion** : 32 octets aléatoires, seul leur SHA-256 est stocké.
- **Taille des requêtes** : 64 Ko, 2 Mo pour l'envoi d'image.
- **Conteneur** : utilisateur `node` (uid 1000), données dans le volume `/data`. Installation des dépendances avec `--ignore-scripts`.

## Exploitation

- **Une seule commande en local** : `docker compose up` sans `.env` lance le mode simulé avec des données de démonstration, servi en HTTPS par Caddy sur `https://localhost` (autorité de certification locale de Caddy, avertissement du navigateur attendu).
- **Proxy existant** : `docker-compose.proxy.yml`, sans Caddy, application sur `127.0.0.1:3000`.
- **Sauvegarde** : API de sauvegarde en ligne de SQLite (cohérente avec WAL, sans arrêt), vérification `integrity_check`, rotation des 30 dernières copies.
- **Migrations** : appliquées au démarrage, chacune dans une transaction.
- **Journaux** : JSON sur la sortie standard. Les jetons de gestion sont masqués dans les chemins journalisés.
- **Build derrière un proxy d'entreprise** : secrets BuildKit facultatifs `npmrc` et `npm_ca`, sans effet s'ils sont absents.

## Fournisseur simulé

- Activé par `CALENDAR_PROVIDER=mock`. Il remplace Google pour la connexion admin (écran de consentement simulé, avec state et PKCE vérifiés), la connexion de comptes, la liste des agendas, les disponibilités et les événements.
- Chaque compte simulé expose son agenda principal, l'agenda partagé « Événements entreprise » (modification) et « Jours fériés en France » (lecture seule).
- Occupations récurrentes réalistes (déjeuner en semaine, réunions le mardi et le jeudi) et événements créés conservés en base.
- Une adresse commençant par `revoque` simule une autorisation révoquée (`invalid_grant`).
