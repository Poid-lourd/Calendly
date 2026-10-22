#!/bin/sh
# Restaure une sauvegarde dans le volume de l'application. L'application est arrêtée pendant l'opération.
# Usage : scripts/restore.sh backups/app-AAAAMMJJ-HHMMSS.db [fichier compose]
set -eu
BACKUP="${1:?Indiquez le fichier de sauvegarde}"
COMPOSE_FILE="${2:-docker-compose.yml}"
cd "$(dirname "$0")/.."
[ -f "$BACKUP" ] || { echo "Fichier introuvable : $BACKUP" >&2; exit 1; }
docker compose -f "$COMPOSE_FILE" stop app
docker compose -f "$COMPOSE_FILE" run --rm --no-deps -T -v "$(pwd)/$BACKUP:/restore.db:ro" --entrypoint sh app \
  -c 'rm -f /data/app.db-wal /data/app.db-shm && cp /restore.db /data/app.db'
docker compose -f "$COMPOSE_FILE" start app
echo "Restauration terminée depuis $BACKUP"
