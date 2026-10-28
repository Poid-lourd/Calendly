#!/usr/bin/env bash
# Installation ou mise à jour sur une VM Ubuntu, en une commande :
#   curl -fsSL https://raw.githubusercontent.com/Poid-lourd/calendly/main/scripts/install-vm.sh | bash
# Mises à jour : bash ~/rendez-vous/scripts/install-vm.sh (le fichier .env existant est conservé).
set -euo pipefail

REPO_URL="https://github.com/Poid-lourd/calendly.git"
APP_DIR="${APP_DIR:-$HOME/rendez-vous}"

say() { printf '\n== %s\n' "$*"; }
ask() {
  # Lecture depuis le terminal, même quand le script arrive par un pipe. Une réponse vide est redemandée.
  local prompt="$1" default="${2:-}" answer=""
  if [ -n "$default" ]; then prompt="$prompt [$default]"; fi
  while [ -z "$answer" ]; do
    read -r -p "$prompt : " answer </dev/tty
    answer="${answer:-$default}"
  done
  printf '%s' "$answer"
}

valid_domain() {
  printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$'
}

# Tout le script est dans main(), appelée à la dernière ligne : bash lit ainsi le fichier en entier avant de l'exécuter.
# Sinon, avec curl | bash, une commande qui lit l'entrée standard (docker compose exec) avalerait la suite du script.
main() {
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | $SUDO sh
fi
if [ -n "$SUDO" ] && ! id -nG "$USER" | grep -qw docker; then
  $SUDO usermod -aG docker "$USER"
fi
# Le groupe docker n'est actif qu'à la prochaine session : on passe par sudo en attendant.
if docker info >/dev/null 2>&1; then DOCKER="docker"; else DOCKER="$SUDO docker"; fi
$DOCKER compose version >/dev/null

say "Code source"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  if ! command -v git >/dev/null 2>&1; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git >/dev/null; fi
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

if [ ! -f .env ]; then
  say "Configuration (fichier .env)"
  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
  DEFAULT_DOMAIN=""
  if [ -n "$PUBLIC_IP" ]; then DEFAULT_DOMAIN="$(printf '%s' "$PUBLIC_IP" | tr . -).sslip.io"; fi
  echo "Nom de domaine dont le DNS pointe vers cette VM. Sans domaine, l'adresse sslip.io proposée fonctionne avec HTTPS."
  DOMAIN="$(ask "Domaine" "$DEFAULT_DOMAIN" | tr '[:upper:]' '[:lower:]')"
  while ! valid_domain "$DOMAIN"; do
    echo "« $DOMAIN » n'est pas un nom de domaine valide."
    DOMAIN="$(ask "Domaine" "$DEFAULT_DOMAIN" | tr '[:upper:]' '[:lower:]')"
  done
  MODE="$(ask "Fournisseur d'agenda, google ou mock (simulé)" "google")"
  ENCRYPTION_KEY="$(openssl rand -base64 32)"

  if [ "$MODE" = "google" ]; then
    ADMIN_EMAILS="$(ask "Adresses Google autorisées sur /admin, séparées par des virgules")"
    GOOGLE_CLIENT_ID="$(ask "GOOGLE_CLIENT_ID")"
    GOOGLE_CLIENT_SECRET="$(ask "GOOGLE_CLIENT_SECRET")"
    DEMO_SEED="false"
  else
    MODE="mock"
    # En mode simulé, l'écran de connexion accepte toute adresse saisie : une adresse aléatoire tient lieu de mot de passe.
    ADMIN_EMAILS="admin-$(openssl rand -hex 8)@demo.invalid"
    GOOGLE_CLIENT_ID=""
    GOOGLE_CLIENT_SECRET=""
    DEMO_SEED="true"
  fi

  umask 077
  cat >.env <<EOF
# Généré par scripts/install-vm.sh. Voir .env.example pour le détail de chaque variable.
CALENDAR_PROVIDER=$MODE
DOMAIN=$DOMAIN
ADMIN_EMAILS=$ADMIN_EMAILS
# Domaines dont toutes les adresses Google peuvent ouvrir leur espace, par exemple ADMIN_DOMAINS=exemple.fr
ADMIN_DOMAINS=
GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=$GOOGLE_CLIENT_SECRET
# Ne pas perdre ni changer cette clé : elle chiffre les jetons Google en base.
ENCRYPTION_KEY=$ENCRYPTION_KEY
DEMO_SEED=$DEMO_SEED
LOG_LEVEL=info
EOF
  umask 022
else
  say "Configuration existante conservée (.env)"
fi

DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2-)"
if ! valid_domain "$DOMAIN"; then
  echo "DOMAIN invalide dans $APP_DIR/.env : « $DOMAIN »." >&2
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -n "$IP" ]; then EXAMPLE="$(printf '%s' "$IP" | tr . -).sslip.io"; else EXAMPLE="rdv.exemple.fr"; fi
  echo "Corrigez la ligne DOMAIN= (par exemple DOMAIN=$EXAMPLE) puis relancez ce script." >&2
  exit 1
fi
MODE="$(grep -E '^CALENDAR_PROVIDER=' .env | cut -d= -f2-)"
ADMIN_EMAILS="$(grep -E '^ADMIN_EMAILS=' .env | cut -d= -f2-)"

say "Pare-feu"
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow OpenSSH >/dev/null
  $SUDO ufw allow 80/tcp >/dev/null
  $SUDO ufw allow 443/tcp >/dev/null
  $SUDO ufw allow 443/udp >/dev/null
  echo "Ports 80 et 443 ouverts dans ufw."
else
  echo "ufw inactif. Vérifiez que le groupe de sécurité du fournisseur ouvre les ports 80 et 443."
fi

say "Démarrage"
if $DOCKER compose ps --status running --services 2>/dev/null | grep -q '^app$'; then
  scripts/backup.sh </dev/null >/dev/null 2>&1 && echo "Sauvegarde faite avant mise à jour, dossier backups/."
fi
$DOCKER compose up -d --build </dev/null

printf 'Attente de l application'
for _ in $(seq 1 60); do
  if $DOCKER compose ps app --format '{{.Status}}' | grep -q healthy; then break; fi
  printf '.'
  sleep 2
done
echo

say "Sauvegarde quotidienne"
CRON_LINE="17 3 * * * cd $APP_DIR && scripts/backup.sh >> backups/backup.log 2>&1"
# crontab -l échoue quand l'utilisateur n'a encore aucune tâche : ce cas ne doit pas interrompre le script.
CURRENT_CRON="$(crontab -l 2>/dev/null || true)"
if ! command -v crontab >/dev/null 2>&1; then
  echo "cron absent : sauvegarde non programmée. Installez-le avec sudo apt-get install cron puis relancez ce script."
elif printf '%s\n' "$CURRENT_CRON" | grep -qF "scripts/backup.sh"; then
  echo "Déjà programmée."
else
  mkdir -p backups
  printf '%s\n%s\n' "$CURRENT_CRON" "$CRON_LINE" | sed '/^$/d' | crontab -
  echo "Sauvegarde programmée chaque nuit à 3 h 17 dans $APP_DIR/backups."
fi

say "Terminé"
echo "Site public : https://$DOMAIN"
echo "Administration : https://$DOMAIN/admin"
if [ "$MODE" = "google" ]; then
  echo "URI de redirection à déclarer dans le client OAuth Google : https://$DOMAIN/auth/google/callback"
else
  echo "Mode simulé. Adresse à saisir sur l'écran de connexion simulé : $ADMIN_EMAILS"
fi
echo "Journaux : cd $APP_DIR && docker compose logs -f app"
echo "Mise à jour : bash $APP_DIR/scripts/install-vm.sh"
if [ -n "$SUDO" ] && [ "$DOCKER" != "docker" ]; then
  echo "Reconnectez-vous en SSH pour utiliser docker sans sudo."
fi
}

main "$@"
