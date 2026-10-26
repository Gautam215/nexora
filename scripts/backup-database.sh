#!/bin/sh
# Nexora production backup: a pg_dump custom-format dump plus a
# tarball of the private file directory, both timestamped.
#
# Required environment:
#   BACKUP_DATABASE_URL   Connection string for a superuser or
#                         another BYPASSRLS role. NOT the migrator:
#                         `notifications` has FORCE ROW LEVEL
#                         SECURITY, so even its owner cannot COPY it
#                         out and a migrator-role dump fails. The
#                         dump records the migrator as owner of every
#                         object, so a restore keeps ownership.
#   NEXORA_PRIVATE_FILE_DIR
#                         Production private-file directory (same
#                         value the application runs with).
#   BACKUP_DIR              Destination directory (created if needed).
#                         Defaults to ./backups.
#
# Usage: BACKUP_DATABASE_URL=... NEXORA_PRIVATE_FILE_DIR=... sh scripts/backup-database.sh
# The script fails loudly (non-zero exit, no partial "success") when
# either part fails, and verifies the dump file is non-empty. Keep
# the run's stdout as the audit trail. Restore procedure: see
# docs/deployment.md §7.
set -eu

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL must be set (superuser/BYPASSRLS, not the migrator)}"
: "${NEXORA_PRIVATE_FILE_DIR:?NEXORA_PRIVATE_FILE_DIR must be set}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

DUMP_FILE="$BACKUP_DIR/nexora-db-$STAMP.dump"
FILES_FILE="$BACKUP_DIR/nexora-files-$STAMP.tar.gz"

echo "nexora backup: dumping database to $DUMP_FILE"
# No --no-owner: the dump records the migrator as owner of every
# object, so a restore keeps ownership (verified in the restore
# rehearsal, see IMPLEMENTATION_PLAN.md Phase 4 item 5).
pg_dump --format=custom --dbname="$BACKUP_DATABASE_URL" --file="$DUMP_FILE"
if [ ! -s "$DUMP_FILE" ]; then
  echo "nexora backup: FAILED — dump file is empty: $DUMP_FILE" >&2
  exit 1
fi

echo "nexora backup: archiving $NEXORA_PRIVATE_FILE_DIR to $FILES_FILE"
tar -czf "$FILES_FILE" -C "$(dirname "$NEXORA_PRIVATE_FILE_DIR")" "$(basename "$NEXORA_PRIVATE_FILE_DIR")"
if [ ! -s "$FILES_FILE" ]; then
  echo "nexora backup: FAILED — file archive is empty: $FILES_FILE" >&2
  exit 1
fi

echo "nexora backup: OK"
echo "  database: $DUMP_FILE"
echo "  files:    $FILES_FILE"
