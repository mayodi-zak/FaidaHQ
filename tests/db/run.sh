#!/usr/bin/env bash
# Runs the database tests on a throwaway PostgreSQL database.
# Usage: PGHOST=/tmp/pg PGPORT=55432 PGUSER=postgres tests/db/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=faidahq_test
psql -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d $DB -f tests/db/supabase_stub.sql
for f in supabase/migrations/*.sql; do psql -q -v ON_ERROR_STOP=1 -d $DB -f "$f"; done
psql -q -v ON_ERROR_STOP=1 -d $DB -t -A -f tests/db/rls_test.sql | grep -E "^ok|passed"
echo "Database tests passed"
