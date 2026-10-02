import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

export function renderMarkdown({ inventory, coverage, plan }) {
  const rollup = coverage.rollup;
  const lines = [
    '# BusinessObjects → Sigma — migration assessment',
    '',
    `Generated ${rollup.generatedAt}. Read-only: no BusinessObjects object was modified and Sigma was not called.`,
    '',
    rollup.usageNote,
    '',
    '## Estate',
    '',
    `- Universes: ${rollup.n_universes}`,
    `- Web Intelligence documents: ${rollup.n_webi}`,
    `- Crystal Reports: ${rollup.n_crystal}`,
    `- Auto-migratable features: ${rollup.pct_auto}%`,
    '',
    '## Shortlist',
    '',
    '| Name | Kind | Tag | Complexity | Score |',
    '|---|---|---|---|---|',
  ];
  for (const artifact of coverage.artifacts) {
    lines.push(`| ${artifact.name} | ${artifact.kind} | ${artifact.tag} | ${artifact.complexity} | ${artifact.score} |`);
  }
  lines.push('', '## Gaps', '');
  for (const gap of rollup.gap_histogram) {
    lines.push(`- **${gap.signal}** (${gap.bucket}, ${gap.count}): ${gap.remediation}`);
  }
  lines.push('', '## Waves', '');
  for (const wave of plan.waves) {
    lines.push(`### Wave ${wave.id} — ${wave.title}`, '');
    if (!wave.members.length) lines.push('None.', '');
    for (const member of wave.members) lines.push(`- ${member.kind}: ${member.name} — \`${member.handoff}\``);
    lines.push('');
  }
  if (plan.prerequisites.length) {
    lines.push('## Prerequisites', '');
    for (const item of plan.prerequisites) lines.push(`- ${item.action}: ${item.name} (${item.kind})`);
    lines.push('');
  }
  if (plan.blocked.length) {
    lines.push('## Blocked until a prerequisite lands', '');
    for (const item of plan.blocked) lines.push(`- ${item.name}: ${item.reason}`);
    lines.push('');
  }
  lines.push('## Handoff', '', 'Do not auto-convert. Pick a wave, then run the dry-run command from the converter skill directory.', '');
  if (inventory?.warnings?.length) {
    lines.push('## Inventory warnings', '');
    for (const warning of inventory.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function renderHtml({ inventory, coverage, plan }) {
  const rollup = coverage.rollup;
  const rows = coverage.artifacts.map(artifact => `<tr><td>${escapeHtml(artifact.name)}</td><td>${escapeHtml(artifact.kind)}</td><td>${escapeHtml(artifact.tag)}</td><td>${escapeHtml(artifact.complexity)}</td><td>${escapeHtml(artifact.score)}</td></tr>`).join('');
  const gaps = rollup.gap_histogram.map(gap => `<tr><td>${escapeHtml(gap.signal)}</td><td>${escapeHtml(gap.bucket)}</td><td>${gap.count}</td><td>${escapeHtml(gap.remediation)}</td></tr>`).join('');
  const waves = plan.waves.map(wave => `<section><h2>Wave ${wave.id} — ${escapeHtml(wave.title)}</h2><ul>${wave.members.map(member => `<li><strong>${escapeHtml(member.name)}</strong> <code>${escapeHtml(member.handoff)}</code></li>`).join('') || '<li>None</li>'}</ul></section>`).join('');
  const prerequisites = plan.prerequisites.map(item => `<li>${escapeHtml(item.action)}: ${escapeHtml(item.name)}</li>`).join('') || '<li>None</li>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>BusinessObjects migration assessment</title>
<style>
  body { margin: 0; font: 14px/1.5 "Segoe UI", sans-serif; color: #292929; background: #fafafa; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  h2 { font-size: 18px; margin-top: 28px; }
  .banner { background: #fff; border: 1px solid #e5e5e5; padding: 12px 14px; }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 16px 0; }
  .kpi { background: #fff; border: 1px solid #e5e5e5; padding: 12px; }
  .kpi b { display: block; font-size: 22px; }
  table { width: 100%; border-collapse: collapse; background: #fff; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
  code { font-family: ui-monospace, monospace; font-size: 12px; }
  @media print { body { background: #fff; } .banner, .kpi, table { break-inside: avoid; } }
</style>
</head>
<body>
<main>
  <h1>BusinessObjects → Sigma</h1>
  <p class="banner">Read-only assessment generated ${escapeHtml(rollup.generatedAt)}. It was written locally and is not uploaded. ${escapeHtml(rollup.usageNote)}</p>
  <div class="kpis">
    <div class="kpi"><b>${rollup.n_universes}</b>Universes</div>
    <div class="kpi"><b>${rollup.n_webi}</b>Web Intelligence</div>
    <div class="kpi"><b>${rollup.n_crystal}</b>Crystal Reports</div>
    <div class="kpi"><b>${rollup.pct_auto}%</b>Auto-migratable features</div>
    <div class="kpi"><b>${rollup.by_tag['needs-review'] || 0}</b>Need review</div>
    <div class="kpi"><b>${(rollup.by_tag['needs-export'] || 0) + (rollup.by_tag['extract-first'] || 0) + (rollup.by_tag['needs-capture'] || 0)}</b>Need source extraction</div>
  </div>
  <h2>Inventory</h2>
  <table><thead><tr><th>Name</th><th>Kind</th><th>Tag</th><th>Complexity</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Gaps</h2>
  <table><thead><tr><th>Signal</th><th>Bucket</th><th>Count</th><th>Remediation</th></tr></thead><tbody>${gaps}</tbody></table>
  ${waves}
  <h2>Prerequisites</h2>
  <ul>${prerequisites}</ul>
  <h2>Next step</h2>
  <p>Choose a wave with the user. Run the dry-run command from <code>skills/businessobjects-to-sigma</code>. Inventory warnings: ${escapeHtml((inventory?.warnings || []).join(' ') || 'none')}.</p>
</main>
</body>
</html>
`;
}

export function writeReadouts(outDir, model) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'readout.md'), renderMarkdown(model));
  writeFileSync(join(outDir, 'readout.html'), renderHtml(model));
}
