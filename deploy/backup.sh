#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mode="${1:-}"
if [[ -n "$mode" && "$mode" != --local-only ]]; then
  echo "Uso: bash deploy/backup.sh [--local-only]" >&2
  exit 1
fi

backup_dir="${ZEVEM_BACKUP_DIR:-/var/backups/zevem}"
install -d -m 700 "$backup_dir"
exec 9>"$backup_dir/.lock"
flock -n 9

temporary_archive="$(mktemp "$backup_dir/.zevem.XXXXXXXX")"
trap 'rm -f -- "$temporary_archive"' EXIT

# A API de backup do SQLite inclui as transações confirmadas no WAL.
docker compose exec -T backend sh -s > "$temporary_archive" <<'CONTAINER'
set -eu
umask 077
work="$(mktemp -d)"
trap 'rm -f -- "$work/apple-green.db" "$work/apple-green.db-wal" "$work/apple-green.db-shm"; rmdir "$work"' EXIT
node -e '
  const { join } = require("node:path");
  const Database = require("better-sqlite3");
  const source = new Database(join(process.env.DATA_DIR, "apple-green.db"), { readonly: true });
  async function run() {
    const destination = process.argv[1];
    try { await source.backup(destination); }
    finally { source.close(); }
    const backup = new Database(destination, { readonly: true });
    try {
      if (backup.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Falha de integridade no SQLite");
    } finally { backup.close(); }
  }
  run().catch(error => { console.error(error); process.exitCode = 1; });
' "$work/apple-green.db"
tar -cf - -C "$work" apple-green.db -C "$DATA_DIR" uploads
CONTAINER

archive="$backup_dir/zevem.tar"
tar -tf "$temporary_archive" > /dev/null
mv -f -- "$temporary_archive" "$archive"
echo "Backup local criado: $archive"

if [[ "$mode" == --local-only ]]; then
  exit 0
fi

config_file="${RESTIC_CONFIG_FILE:-/etc/zevem-backup/r2.env}"
set -a
source "$config_file"
set +a
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY não informado}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE não informado}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID não informado}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY não informado}"

backup_host="zevem-$(hostname)"
restic backup "$archive" --tag zevem --host "$backup_host"
restic forget --tag zevem --host "$backup_host" \
  --keep-daily 3 --keep-weekly 2 --keep-monthly 3 --prune
echo "Backup criptografado do Zevem no R2 concluído."
