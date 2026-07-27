#!/bin/bash
# Runs once, on the very first boot of the postgres volume.
#
# Creates the companion test database and enables the extensions Saga needs in both. The
# application never creates databases at runtime.
set -euo pipefail

TEST_DB="${POSTGRES_DB:-saga}_test"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  SELECT 'CREATE DATABASE ${TEST_DB}'
   WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${TEST_DB}')\gexec
EOSQL

for db in "$POSTGRES_DB" "$TEST_DB"; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
EOSQL
done

echo "saga: initialised databases ${POSTGRES_DB} and ${TEST_DB}"
