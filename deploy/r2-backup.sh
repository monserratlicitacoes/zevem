#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

config_file="${RESTIC_CONFIG_FILE:-/etc/zevem-backup/r2.env}"
backup_dir="${ZEVEM_BACKUP_DIR:-/var/backups/zevem}"
archive="$backup_dir/zevem.tar"
backup_host="zevem-$(hostname)"

set -a
# shellcheck disable=SC1090
source "$config_file"
set +a
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY não informado}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE não informado}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID não informado}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY não informado}"

exec 9>"$backup_dir/.lock"
flock -n 9
test -s "$archive"
restic backup "$archive" --tag zevem --host "$backup_host"
restic forget --tag zevem --host "$backup_host" \
  --keep-daily 3 --keep-weekly 2 --keep-monthly 3 --prune
echo "Backup criptografado do Zevem no R2 concluído."
