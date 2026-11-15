#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
cd "$(dirname "${BASH_SOURCE[0]}")/.."

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
