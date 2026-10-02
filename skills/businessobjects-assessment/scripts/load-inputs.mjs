import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

function walk(path, found = []) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(join(path, entry), found);
    }
    return found;
  }
  if (/\.(json|xml)$/i.test(path)) found.push(path);
  return found;
}

export function sniffArtifact(parsed, text) {
  if (parsed?.irVersion && parsed?.sections) return 'crystal';
  if (parsed?.document?.reports || parsed?.reports) return 'webi';
  if (typeof text === 'string' && text.trim().startsWith('<')) return 'universe';
  if (parsed?.universe || parsed?.classes || parsed?.tables || parsed?.dataFoundation || parsed?.joins) return 'universe';
  return null;
}

function artifactName(kind, parsed, text, file) {
  if (kind === 'crystal') return parsed?.report?.name || basename(file);
  if (kind === 'webi') return parsed?.document?.name || parsed?.name || basename(file);
  if (parsed?.universe?.name || parsed?.name) return parsed.universe?.name || parsed.name;
  const match = String(text || '').match(/<universe\b[^>]*\bname="([^"]+)"/i);
  return match?.[1] || basename(file);
}

export function loadInputs(paths) {
  const files = paths.flatMap(path => walk(path));
  const artifacts = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    let parsed = null;
    if (file.endsWith('.json')) {
      try { parsed = JSON.parse(text); } catch { continue; }
    }
    const kind = sniffArtifact(parsed, text);
    if (!kind) continue;
    const id = parsed?.id || parsed?.cms?.id || parsed?.source?.id || basename(file).replace(/\.(json|xml)$/i, '');
    artifacts.push({
      id: String(id),
      name: artifactName(kind, parsed, text, file),
      kind,
      specFile: file,
      raw: kind === 'universe' && file.endsWith('.xml') ? text : (parsed ?? text),
      cuid: parsed?.cuid || parsed?.source?.cuid || null,
    });
  }
  return artifacts;
}
