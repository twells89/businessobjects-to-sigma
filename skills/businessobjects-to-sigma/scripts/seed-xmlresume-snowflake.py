#!/usr/bin/env python3
"""Seed the pinned MIT XML Résumé oracle into isolated Snowflake tables."""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from cryptography.hazmat.primitives import serialization

SOURCE_URL = (
    "https://raw.githubusercontent.com/craibuc/crystal-xmlresume/"
    "fda94e8ef9c71302b7076aecb6d2f9a11bf92b3d/resume.xml"
)
SOURCE_SHA256 = "dbcbe327324d07a4ac5778763103786138b58dc2d76c0f54a9472da859215de0"

TABLES = (
    "XMLRESUME_PROFILE",
    "XMLRESUME_DEGREES",
    "XMLRESUME_CERTIFICATIONS",
    "XMLRESUME_PROJECTS",
    "XMLRESUME_ACCOMPLISHMENTS",
    "XMLRESUME_PROJECT_LINES",
)


def text(element: ET.Element | None) -> str:
    return (element.text or "").strip() if element is not None else ""


def load_source(path: str | None) -> bytes:
    if path:
        data = Path(path).read_bytes()
    else:
        with urllib.request.urlopen(SOURCE_URL, timeout=60) as response:
            data = response.read()
    actual = hashlib.sha256(data).hexdigest()
    if actual != SOURCE_SHA256:
        raise RuntimeError(
            f"XML résumé SHA-256 mismatch: expected {SOURCE_SHA256}, got {actual}"
        )
    return data


def parse_resume(data: bytes):
    root = ET.fromstring(data)
    metadata = root.find("metadata")
    person = root.find("person")
    address = person.find("address")
    contact = person.find("contact")
    profile = (
        1,
        metadata.get("lastModified"),
        metadata.get("author"),
        text(root.find("objective")),
        person.get("givenName"),
        person.get("surName"),
        f"{person.get('givenName')} {person.get('surName')}",
        text(address.find("room")),
        text(address.find("street")),
        text(address.find("city")),
        text(address.find("regionCode")),
        text(address.find("postalCode")),
        text(address.find("countryCode")),
        text(contact.find("phone")),
        text(contact.find("email")),
        text(contact.find("url")),
        text(contact.find("linkedIn")),
    )

    degrees = []
    for ordinal, degree in enumerate(root.findall("./academics/degrees/degree"), 1):
        level = text(degree.find("level"))
        major = text(degree.find("major"))
        minor = text(degree.find("minor"))
        degree_display = f"{level}: {major}" + (f", {minor}" if minor else "")
        degrees.append(
            (
                ordinal,
                degree.get("graduated"),
                level,
                major,
                minor,
                text(degree.find("institution")),
                degree_display,
            )
        )

    certifications = [
        (ordinal, text(certification))
        for ordinal, certification in enumerate(
            root.findall("./certifications/certification"), 1
        )
    ]

    projects = []
    accomplishments = []
    lines = []
    accomplishment_id = 0
    for project_ordinal, project in enumerate(root.findall("./projects/project"), 1):
        client = project.find("client")
        client_name = client.get("name")
        summary = text(project.find("summary"))
        technologies = text(project.find("technologies"))
        starting_date = project.get("startingDate")
        ending_date = project.get("endingDate")
        date_display = starting_date[:7]
        if ending_date:
            date_display += f" to {ending_date[:7]}"
        else:
            date_display += " to"
        project_accomplishments = [
            text(item) for item in project.findall("./accomplishments/accomplishment")
        ]
        projects.append(
            (
                project_ordinal,
                starting_date,
                ending_date,
                client_name,
                client.get("url"),
                text(client.find("location")),
                summary,
                technologies,
                date_display,
            )
        )
        for accomplishment_ordinal, accomplishment in enumerate(
            project_accomplishments, 1
        ):
            accomplishment_id += 1
            accomplishments.append(
                (
                    accomplishment_id,
                    project_ordinal,
                    accomplishment_ordinal,
                    accomplishment,
                )
            )
        display_lines = [
            ("client", client_name, date_display),
            ("summary", summary, ""),
            ("accomplishment", f"◦ {project_accomplishments[0]}", ""),
            ("accomplishment", f"◦ {project_accomplishments[1]}", ""),
            ("technologies", f"Technologies    {technologies}", ""),
        ]
        for line_ordinal, (line_kind, display_text, line_date) in enumerate(
            display_lines, 1
        ):
            lines.append(
                (
                    project_ordinal,
                    line_ordinal,
                    line_kind,
                    display_text,
                    line_date,
                )
            )
    return profile, degrees, certifications, projects, accomplishments, lines


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
    parser.add_argument("--source")
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
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    parsed = parse_resume(load_source(args.source))
    profile, degrees, certifications, projects, accomplishments, lines = parsed
    counts = (1, len(degrees), len(certifications), len(projects), len(accomplishments), len(lines))
    if counts != (1, 2, 4, 3, 6, 15):
        raise RuntimeError(f"Unexpected XML résumé census: {counts}")
    if args.dry_run:
        print(
            "Validated XML résumé: profiles=1, degrees=2, certifications=4, "
            "projects=3, accomplishments=6, project_lines=15"
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
            cursor.execute(
                """
CREATE OR REPLACE TABLE XMLRESUME_PROFILE (
  resume_id INTEGER, last_modified TIMESTAMP_NTZ, author VARCHAR, objective VARCHAR,
  given_name VARCHAR, surname VARCHAR, full_name VARCHAR, room VARCHAR,
  street VARCHAR, city VARCHAR, region_code VARCHAR, postal_code VARCHAR,
  country_code VARCHAR, phone VARCHAR, email VARCHAR, url VARCHAR, linkedin VARCHAR
)"""
            )
            cursor.execute(
                """
CREATE OR REPLACE TABLE XMLRESUME_DEGREES (
  degree_ordinal INTEGER, graduated DATE, level VARCHAR, major VARCHAR,
  minor VARCHAR, institution VARCHAR, degree_display VARCHAR
)"""
            )
            cursor.execute(
                """
CREATE OR REPLACE TABLE XMLRESUME_CERTIFICATIONS (
  certification_ordinal INTEGER, certification VARCHAR
)"""
            )
            cursor.execute(
                """
CREATE OR REPLACE TABLE XMLRESUME_PROJECTS (
  project_ordinal INTEGER, starting_date DATE, ending_date DATE,
  client_name VARCHAR, client_url VARCHAR, location VARCHAR,
  summary VARCHAR, technologies VARCHAR, date_display VARCHAR
)"""
            )
            cursor.execute(
                """
CREATE OR REPLACE TABLE XMLRESUME_ACCOMPLISHMENTS (
  accomplishment_id INTEGER, project_ordinal INTEGER,
  accomplishment_ordinal INTEGER, accomplishment VARCHAR
)"""
            )
            cursor.execute(
                """
CREATE OR REPLACE TABLE XMLRESUME_PROJECT_LINES (
  project_ordinal INTEGER, line_ordinal INTEGER, line_kind VARCHAR,
  display_text VARCHAR, date_display VARCHAR
)"""
            )
            cursor.execute(
                """
INSERT INTO XMLRESUME_PROFILE
VALUES (%s, TO_TIMESTAMP_NTZ(%s), %s, %s, %s, %s, %s, %s, %s,
  %s, %s, %s, %s, %s, %s, %s, %s)
""",
                profile,
            )
            cursor.executemany(
                """
INSERT INTO XMLRESUME_DEGREES
VALUES (%s, TO_DATE(%s), %s, %s, %s, %s, %s)
""",
                degrees,
            )
            cursor.executemany(
                "INSERT INTO XMLRESUME_CERTIFICATIONS VALUES (%s, %s)",
                certifications,
            )
            cursor.executemany(
                """
INSERT INTO XMLRESUME_PROJECTS
VALUES (%s, TO_DATE(%s), TO_DATE(%s), %s, %s, %s, %s, %s, %s)
""",
                projects,
            )
            cursor.executemany(
                "INSERT INTO XMLRESUME_ACCOMPLISHMENTS VALUES (%s, %s, %s, %s)",
                accomplishments,
            )
            cursor.executemany(
                "INSERT INTO XMLRESUME_PROJECT_LINES VALUES (%s, %s, %s, %s, %s)",
                lines,
            )
            if args.consumer_role:
                cursor.execute(
                    f'GRANT USAGE ON DATABASE "{args.database}" TO ROLE "{args.consumer_role}"'
                )
                cursor.execute(
                    f'GRANT USAGE ON SCHEMA "{args.database}"."{args.schema}" '
                    f'TO ROLE "{args.consumer_role}"'
                )
                for table in TABLES:
                    cursor.execute(
                        f'GRANT SELECT ON TABLE "{args.database}"."{args.schema}"."{table}" '
                        f'TO ROLE "{args.consumer_role}"'
                    )
            checks = []
            for table in TABLES:
                cursor.execute(f"SELECT COUNT(*) FROM {table}")
                checks.append(cursor.fetchone()[0])
            if tuple(checks) != (1, 2, 4, 3, 6, 15):
                raise RuntimeError(f"Snowflake XML résumé census failed: {checks}")
            print(
                f"Seeded {args.database}.{args.schema}: profile=1, degrees=2, "
                "certifications=4, projects=3, accomplishments=6, project_lines=15"
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
        print(f"seed-xmlresume-snowflake failed: {error}", file=sys.stderr)
        raise SystemExit(1)
