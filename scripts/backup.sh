#!/bin/sh
# Sauvegarde la base SQLite du conteneur dans ./backups et conserve les 30 dernières.
# Usage : scripts/backup.sh [fichier compose]   (par défaut docker-compose.yml)
set -eu
COMPOSE_FILE="${1:-docker-compose.yml}"
cd "$(dirname "$0")/.."
mkdir -p backups
INNER=$(docker compose -f "$COMPOSE_FILE" exec -T app node scripts/backup.mjs | tail -n 1)
NAME=$(basename "$INNER")
docker compose -f "$COMPOSE_FILE" cp "app:$INNER" "backups/$NAME"
docker compose -f "$COMPOSE_FILE" exec -T app rm -f "$INNER"
ls -1t backups/app-*.db 2>/dev/null | tail -n +31 | xargs -r rm -f
echo "Sauvegarde : backups/$NAME"
