# Crystal Reports SDK extractor

This Windows-only utility opens a loose `.rpt` with SAP's supported Crystal
Reports for Visual Studio x64 SDK and writes the neutral
[`crystal-report-ir.schema.json`](../../schemas/crystal-report-ir.schema.json).
It can also export a PDF from the same report/data/parameter state for visual
comparison with the migrated Sigma report.

The repository does **not** redistribute SAP assemblies or the Crystal runtime.
Use this only under the license governing your Crystal installation and reports.

## Prerequisites

- Windows x64
- .NET Framework 4.8 developer tools
- SAP Crystal Reports for Visual Studio x64 SDK/runtime (SP40 or compatible)
- `CRYSTAL_SDK_DIR` pointing at the directory containing
  `CrystalDecisions.*.dll`

Typical SDK directories vary by SP and installation mode. Confirm the assembly
versions all match; mixing service packs causes loader failures.

## Build

```powershell
$env:CRYSTAL_SDK_DIR = 'C:\Program Files\SAP BusinessObjects\Crystal Reports for .NET Framework 4.0\Common\SAP BusinessObjects Enterprise XI 4.0\win64_x64'
dotnet build .\CrystalExtractor.csproj -c Release
```

## Extract and render

```powershell
.\bin\Release\net48\crystal-extractor.exe C:\reports\statement.rpt `
  --out C:\artifacts\statement.crystal-ir.json `
  --pdf C:\artifacts\statement.crystal.pdf `
  --parameter StatementDate=2026-08-19 `
  --parameter ReportingCurrency=0
```

Database credentials are accepted only through environment variables:

```powershell
$env:CRYSTAL_DB_SERVER = 'snowflake-odbc-dsn'
$env:CRYSTAL_DB_DATABASE = 'CRYSTAL_MIGRATION_DEMO'
$env:CRYSTAL_DB_USER = '...'
$env:CRYSTAL_DB_PASSWORD = '...'
```

The generic Crystal connection replacement API is provider-sensitive. For a
PostgreSQL-authored report rebound to Snowflake ODBC, use the SDK's
`DatabaseController.ReplaceConnection`/`SetTableLocation` flow for your exact
driver if the simple table logon update cannot verify the database. Never put
passwords or private keys in an exported IR file.

## Linux extraction smoke test

The project also accepts `rpt-rs` JSON through
`scripts/extract-crystal-rpt-rs.mjs`. That path is useful in CI and for the
public Meridian sample, but `rpt-rs` is an experimental reverse-engineered
parser—not SAP's supported extraction contract. The Windows SDK output remains
the production oracle.

## Known SDK-version checks

Crystal SDK getter availability varies by release. The extractor uses
reflection for optional RAS properties and emits warnings instead of dropping
them silently. Before declaring support for a service pack:

1. Build against that service pack's x64 assemblies.
2. Extract the owned fixture matrix.
3. Validate the IR schema.
4. Compare object/formula/link counts with Crystal Designer.
5. Export and visually compare the reference PDF.

