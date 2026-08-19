#!/usr/bin/env python3
"""Seed the pinned Meridian Crystal sample into an isolated Snowflake database.

The upstream SQL is deterministic synthetic data under MPL-2.0. This script
downloads the pinned file, extracts only the tables used by the customer
statement, translates the small PostgreSQL dialect surface, and creates one
wide view that Sigma Reports can bind to directly.

No secrets are printed. Key-pair authentication follows the exact environment
contract supplied by the user:
  SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PRIVATE_KEY,
  SNOWFLAKE_WAREHOUSE, SNOWFLAKE_ROLE.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import serialization

UPSTREAM_COMMIT = "3f5beb51dd34d36c4a4326280d25f473b44889d1"
SEED_URL = (
    "https://raw.githubusercontent.com/MrSrsen/rpt-rs/"
    f"{UPSTREAM_COMMIT}/tests/meridian/sql/meridian.sql"
)
SEED_GIT_BLOB_SHA1 = "31bf15b84763b9587ea539647486e2797a9b5dba"

TABLES = (
    "country",
    "province",
    "city",
    "customer",
    "invoice",
    "payment_status",
    "payment",
    "exchange_rate",
)

DDL = {
    "country": """
CREATE OR REPLACE TABLE country (
  country_id INTEGER PRIMARY KEY,
  region_id INTEGER NOT NULL,
  iso2 VARCHAR(2) NOT NULL,
  iso3 VARCHAR(3) NOT NULL,
  name VARCHAR(60) NOT NULL,
  currency_code VARCHAR(3) NOT NULL
)""",
    "province": """
CREATE OR REPLACE TABLE province (
  province_id INTEGER PRIMARY KEY,
  country_id INTEGER NOT NULL,
  code VARCHAR(6) NOT NULL,
  name VARCHAR(60) NOT NULL
)""",
    "city": """
CREATE OR REPLACE TABLE city (
  city_id INTEGER PRIMARY KEY,
  province_id INTEGER NOT NULL,
  name VARCHAR(60) NOT NULL,
  latitude NUMBER(9,6) NOT NULL,
  longitude NUMBER(9,6) NOT NULL,
  population INTEGER NOT NULL
)""",
    "customer": """
CREATE OR REPLACE TABLE customer (
  customer_id INTEGER PRIMARY KEY,
  city_id INTEGER NOT NULL,
  industry_id INTEGER NOT NULL,
  name VARCHAR(120) NOT NULL,
  account_code VARCHAR(20) NOT NULL,
  credit_limit NUMBER(14,2) NOT NULL,
  currency_code VARCHAR(3) NOT NULL,
  since_date DATE NOT NULL,
  sales_rep_id INTEGER,
  tier VARCHAR(20) NOT NULL,
  is_active BOOLEAN NOT NULL,
  logo BINARY
)""",
    "invoice": """
CREATE OR REPLACE TABLE invoice (
  invoice_id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  currency_code VARCHAR(3) NOT NULL,
  amount_net NUMBER(14,2) NOT NULL,
  tax_amount NUMBER(14,2) NOT NULL,
  amount_gross NUMBER(14,2) NOT NULL,
  status_id INTEGER NOT NULL
)""",
    "payment_status": """
CREATE OR REPLACE TABLE payment_status (
  id INTEGER PRIMARY KEY,
  code VARCHAR(10) NOT NULL,
  name VARCHAR(30) NOT NULL,
  sort_order INTEGER NOT NULL
)""",
    "payment": """
CREATE OR REPLACE TABLE payment (
  payment_id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL,
  payment_date DATE NOT NULL,
  amount NUMBER(14,2) NOT NULL,
  method VARCHAR(20) NOT NULL,
  currency_code VARCHAR(3) NOT NULL
)""",
    "exchange_rate": """
CREATE OR REPLACE TABLE exchange_rate (
  currency_code VARCHAR(3) NOT NULL,
  rate_date DATE NOT NULL,
  rate_to_usd NUMBER(18,8) NOT NULL,
  PRIMARY KEY (currency_code, rate_date)
)""",
}

VIEWS = (
    """
CREATE OR REPLACE VIEW invoice_payment_totals AS
SELECT invoice_id, SUM(amount) AS paid_total
FROM payment
GROUP BY invoice_id
""",
    """
CREATE OR REPLACE VIEW exchange_rate_latest AS
SELECT currency_code, rate_to_usd
FROM exchange_rate
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY currency_code ORDER BY rate_date DESC
) = 1
""",
    """
CREATE OR REPLACE VIEW customer_statement_rows AS
WITH invoice_payment AS (
  SELECT invoice_id, SUM(amount) AS paid_total
  FROM payment
  GROUP BY invoice_id
),
latest_rate AS (
  SELECT currency_code, rate_to_usd
  FROM exchange_rate
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY currency_code ORDER BY rate_date DESC
  ) = 1
)
SELECT
  i.invoice_id,
  'INV-' || LPAD(TO_VARCHAR(i.invoice_id), 6, '0') AS invoice_number,
  i.invoice_date,
  i.due_date,
  ps.code AS status_code,
  ps.name AS status_name,
  i.currency_code,
  i.amount_net,
  i.tax_amount,
  i.amount_gross AS charges,
  COALESCE(ip.paid_total, 0) AS payments,
  i.amount_gross - COALESCE(ip.paid_total, 0) AS balance,
  DATEDIFF('day', i.due_date, CURRENT_DATE()) AS aging_days,
  CASE
    WHEN DATEDIFF('day', i.due_date, CURRENT_DATE()) <= 0 THEN 'Current'
    WHEN DATEDIFF('day', i.due_date, CURRENT_DATE()) <= 30 THEN '1-30'
    WHEN DATEDIFF('day', i.due_date, CURRENT_DATE()) <= 60 THEN '31-60'
    WHEN DATEDIFF('day', i.due_date, CURRENT_DATE()) <= 90 THEN '61-90'
    ELSE '90+'
  END AS aging_bucket,
  (i.amount_gross - COALESCE(ip.paid_total, 0)) /
    NULLIF(lr.rate_to_usd, 0) AS usd_balance,
  c.customer_id,
  c.account_code,
  c.name AS customer_name,
  c.credit_limit,
  c.currency_code AS customer_currency_code,
  ci.name AS city_name,
  p.code AS province_code,
  p.name AS province_name,
  co.name AS country_name
FROM invoice i
JOIN customer c ON i.customer_id = c.customer_id
JOIN city ci ON c.city_id = ci.city_id
JOIN province p ON ci.province_id = p.province_id
JOIN country co ON p.country_id = co.country_id
JOIN payment_status ps ON i.status_id = ps.id
LEFT JOIN invoice_payment ip ON i.invoice_id = ip.invoice_id
LEFT JOIN latest_rate lr ON i.currency_code = lr.currency_code
WHERE i.amount_gross - COALESCE(ip.paid_total, 0) >= 0
""",
)


def git_blob_sha1(data: bytes) -> str:
    header = f"blob {len(data)}\0".encode()
    return hashlib.sha1(header + data).hexdigest()


def load_seed(path: str | None) -> str:
    if path:
        data = Path(path).read_bytes()
    else:
        with urllib.request.urlopen(SEED_URL, timeout=60) as response:
            data = response.read()
    actual = git_blob_sha1(data)
    if actual != SEED_GIT_BLOB_SHA1:
        raise RuntimeError(
            f"Meridian seed blob mismatch: expected {SEED_GIT_BLOB_SHA1}, got {actual}"
        )
    return data.decode("utf-8")


def statements(sql: str):
    """Split SQL on semicolons outside single-quoted strings."""
    start = 0
    in_string = False
    index = 0
    while index < len(sql):
        char = sql[index]
        if char == "'":
            if in_string and index + 1 < len(sql) and sql[index + 1] == "'":
                index += 2
                continue
            in_string = not in_string
        elif char == ";" and not in_string:
            statement = sql[start:index].strip()
            if statement:
                yield statement
            start = index + 1
        index += 1
    trailing = sql[start:].strip()
    if trailing:
        yield trailing


def selected_inserts(sql: str):
    wanted = set(TABLES)
    for statement in statements(sql):
        match = re.match(r"(?is)^INSERT\s+INTO\s+([A-Za-z_][\w]*)\b", statement)
        if match and match.group(1).lower() in wanted:
            yield match.group(1).lower(), translate_insert(statement)


def translate_insert(statement: str) -> str:
    # Binary logos are irrelevant to the first Sigma report (the image object is
    # explicitly logged as a degradation). Avoid moving several MB of encoded
    # PostgreSQL bytea through Snowflake.
    statement = re.sub(r"E?'\\x[0-9A-Fa-f]*'(?:::bytea)?", "NULL", statement)
    statement = statement.replace("::bytea", "")
    return statement


def connection():
    try:
        import snowflake.connector
    except ImportError as error:
        raise RuntimeError(
            "Install requirements-crystal.txt before seeding Snowflake"
        ) from error

    required = [
        "SNOWFLAKE_ACCOUNT",
        "SNOWFLAKE_USER",
        "SNOWFLAKE_PRIVATE_KEY",
        "SNOWFLAKE_WAREHOUSE",
        "SNOWFLAKE_ROLE",
    ]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError("Missing Snowflake environment variables: " + ", ".join(missing))

    private_key = serialization.load_pem_private_key(
        os.environ["SNOWFLAKE_PRIVATE_KEY"].encode(),
        password=None,
    )
    return snowflake.connector.connect(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        private_key=private_key,
        warehouse=os.environ["SNOWFLAKE_WAREHOUSE"],
        role=os.environ["SNOWFLAKE_ROLE"],
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="Local pinned meridian.sql; otherwise download it")
    parser.add_argument(
        "--database",
        default=os.environ.get("CRYSTAL_SNOWFLAKE_DATABASE", "CRYSTAL_MIGRATION_DEMO"),
    )
    parser.add_argument(
        "--schema",
        default=os.environ.get("CRYSTAL_SNOWFLAKE_SCHEMA", "PUBLIC"),
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    seed = load_seed(args.source)
    inserts = list(selected_inserts(seed))
    counts = {table: 0 for table in TABLES}
    for table, _ in inserts:
        counts[table] += 1

    if args.dry_run:
        print(
            f"Validated pinned Meridian seed; {len(inserts)} INSERT batches: "
            + ", ".join(f"{table}={count}" for table, count in counts.items())
        )
        print(
            f"Target: {args.database}.{args.schema}.CUSTOMER_STATEMENT_ROWS "
            "(dry run; no Snowflake connection opened)"
        )
        return 0

    conn = connection()
    try:
        cursor = conn.cursor()
        try:
            cursor.execute(f'CREATE DATABASE IF NOT EXISTS "{args.database}"')
            cursor.execute(
                f'CREATE SCHEMA IF NOT EXISTS "{args.database}"."{args.schema}"'
            )
            cursor.execute(f'USE DATABASE "{args.database}"')
            cursor.execute(f'USE SCHEMA "{args.schema}"')

            cursor.execute("DROP VIEW IF EXISTS customer_statement_rows")
            cursor.execute("DROP VIEW IF EXISTS exchange_rate_latest")
            cursor.execute("DROP VIEW IF EXISTS invoice_payment_totals")

            for table in TABLES:
                cursor.execute(DDL[table])
            for table, statement in inserts:
                cursor.execute(statement)
            for view in VIEWS:
                cursor.execute(view)

            cursor.execute(
                "SELECT COUNT(*) AS rows, COUNT(DISTINCT customer_id) AS customers, "
                "ROUND(SUM(balance), 2) AS balance "
                "FROM customer_statement_rows"
            )
            row_count, customers, balance = cursor.fetchone()
            print(
                f"Seeded {args.database}.{args.schema}: "
                f"{row_count} statement rows, {customers} customers, balance {balance}"
            )
            print(
                f"Sigma source path: [{args.database}, {args.schema}, CUSTOMER_STATEMENT_ROWS]"
            )
        finally:
            cursor.close()
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"seed-crystal-snowflake failed: {error}", file=sys.stderr)
        raise SystemExit(1)

