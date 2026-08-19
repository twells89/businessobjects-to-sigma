#!/usr/bin/env python3
"""Seed the public PettyCash Crystal/PDF oracle into isolated Snowflake data."""

from __future__ import annotations

import argparse
import os
import sys

from cryptography.hazmat.primitives import serialization

ROWS = (
    (1, "2016-06-01", "Withdraw", "1082", "Maintanance Charge", 1, 400.00),
    (2, "2016-06-06", "Withdraw", "000", "Auto Charge", 1, 40.00),
    (3, "2016-06-07", "Withdraw", "C1989", "Tissue", 3, 147.00),
    (4, "2016-06-13", "Withdraw", "1229", "Packaged drinking water", 2, 100.00),
    (5, "2016-06-22", "Withdraw", "C2802", "Cleaning Kit", 1, 109.00),
    (6, "2016-06-24", "Withdraw", "003", "Monthly cleaning charge", 1, 1250.00),
    (7, "2016-06-28", "Withdraw", "1280", "Packaged Drinking water", 2, 100.00),
    (8, "2016-06-29", "Withdraw", "C1991", "Sugar", 1, 42.00),
    (9, "2016-06-29", "Withdraw", "C1991", "Tissue", 2, 98.00),
)

TABLE = "PETTYCASH_MONTHLY_REPORT_ROWS"


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

    pem = os.environ["SNOWFLAKE_PRIVATE_KEY"].replace("\\n", "\n").encode()
    private_key = serialization.load_pem_private_key(pem, password=None)
    return snowflake.connector.connect(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        private_key=private_key,
        warehouse=os.environ["SNOWFLAKE_WAREHOUSE"],
        role=os.environ["SNOWFLAKE_ROLE"],
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--database",
        default=os.environ.get("CRYSTAL_SNOWFLAKE_DATABASE", "CRYSTAL_MIGRATION_DEMO"),
    )
    parser.add_argument(
        "--schema",
        default=os.environ.get("CRYSTAL_SNOWFLAKE_SCHEMA", "PUBLIC"),
    )
    parser.add_argument(
        "--consumer-role",
        default=os.environ.get("CRYSTAL_SIGMA_ROLE"),
        help="Optional Snowflake role that Sigma uses to read the seeded table",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.dry_run:
        print(
            f"Validated PettyCash PDF oracle: {len(ROWS)} rows, "
            f"withdraw total {sum(row[6] for row in ROWS):.2f}"
        )
        print(f"Target: {args.database}.{args.schema}.{TABLE} (dry run)")
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
            cursor.execute(
                f"""
CREATE OR REPLACE TABLE {TABLE} (
  id INTEGER NOT NULL,
  entry_date DATE NOT NULL,
  transaction_type VARCHAR(30) NOT NULL,
  receipt_no VARCHAR(20) NOT NULL,
  item_name VARCHAR(120) NOT NULL,
  qty INTEGER NOT NULL,
  amount NUMBER(12,2) NOT NULL,
  opening_date DATE NOT NULL,
  frozen_date DATE NOT NULL,
  opened_by VARCHAR(120) NOT NULL,
  opening_balance NUMBER(12,2) NOT NULL,
  withdraw_total NUMBER(12,2) NOT NULL,
  deposit_total NUMBER(12,2) NOT NULL,
  closing_balance NUMBER(12,2) NOT NULL,
  month_name VARCHAR(20) NOT NULL,
  report_year INTEGER NOT NULL
)
"""
            )
            cursor.executemany(
                f"""
INSERT INTO {TABLE} (
  id, entry_date, transaction_type, receipt_no, item_name, qty, amount,
  opening_date, frozen_date, opened_by, opening_balance, withdraw_total,
  deposit_total, closing_balance, month_name, report_year
) SELECT %s, TO_DATE(%s), %s, %s, %s, %s, %s, TO_DATE('2016-06-01'),
  TO_DATE('2016-07-01'), 'Smijith Kumaran', 4913.67, 2286.00, 0.00,
  2627.67, 'June', 2016
""",
                ROWS,
            )
            if args.consumer_role:
                cursor.execute(
                    f'GRANT USAGE ON DATABASE "{args.database}" '
                    f'TO ROLE "{args.consumer_role}"'
                )
                cursor.execute(
                    f'GRANT USAGE ON SCHEMA "{args.database}"."{args.schema}" '
                    f'TO ROLE "{args.consumer_role}"'
                )
                cursor.execute(
                    f'GRANT SELECT ON TABLE "{args.database}"."{args.schema}"."{TABLE}" '
                    f'TO ROLE "{args.consumer_role}"'
                )
            cursor.execute(
                f"SELECT COUNT(*), SUM(amount), MAX(closing_balance) FROM {TABLE}"
            )
            count, withdraw_total, closing_balance = cursor.fetchone()
            if (count, float(withdraw_total), float(closing_balance)) != (
                9,
                2286.0,
                2627.67,
            ):
                raise RuntimeError(
                    "PettyCash seed validation failed: "
                    f"{count}, {withdraw_total}, {closing_balance}"
                )
            print(
                f"Seeded {args.database}.{args.schema}.{TABLE}: "
                f"{count} rows, withdraw total {withdraw_total}, "
                f"closing balance {closing_balance}"
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
        print(f"seed-pettycash-snowflake failed: {error}", file=sys.stderr)
        raise SystemExit(1)
