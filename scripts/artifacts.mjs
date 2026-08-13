import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeConversionArtifacts(outputDir, artifacts) {
  mkdirSync(outputDir, { recursive: true });
  for (const [name, value] of Object.entries(artifacts)) {
    writeFileSync(join(outputDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
}
