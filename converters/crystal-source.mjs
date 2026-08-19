/**
 * Crystal report data definition → the existing BusinessObjects universe IR.
 *
 * This deliberately reuses converters/bobj.mjs for warehouse tables, joins,
 * remapping, relationship direction, and View generation. Crystal formulas are
 * handled separately; this adapter only describes physical report fields.
 */

import { sigmaDisplayName } from '../helpers.mjs';

export function crystalSourceToBobj(ir, options = {}) {
  if (!ir?.data) throw new Error('crystalSourceToBobj: expected Crystal IR with data');
  const {
    database,
    schema,
    factTable = inferFactTable(ir),
    includeUnusedFields = false,
  } = options;
  const warnings = [];

  const referenced = new Set();
  for (const section of ir.sections || []) {
    for (const object of section.objects || []) {
      if (object.fieldId) referenced.add(normalizePhysicalRef(object.fieldId));
    }
  }
  for (const formula of ir.data.formulas || []) {
    for (const ref of formula.text.matchAll(/\{(?![@?])([^}]+)\}/g)) {
      referenced.add(normalizePhysicalRef(ref[1]));
    }
  }
  for (const ref of String(ir.report?.recordSelectionFormula || '').matchAll(/\{(?![@?])([^}]+)\}/g)) {
    referenced.add(normalizePhysicalRef(ref[1]));
  }

  const tables = (ir.data.tables || []).map(table => ({
    name: table.name || table.alias,
    database: database || table.database || undefined,
    schema: schema || table.schema || undefined,
  }));

  const objects = [];
  for (const field of ir.data.fields || []) {
    const table = field.table;
    const physical = field.physicalName || field.name;
    if (!table || !physical) {
      warnings.push(`Crystal field "${field.name}" has no physical table/column binding — skipped.`);
      continue;
    }
    const ref = normalizePhysicalRef(`${table}.${physical}`);
    if (!includeUnusedFields && referenced.size && !referenced.has(ref)) continue;
    objects.push({
      name: sigmaDisplayName(field.name || physical),
      type: 'Dimension',
      select: `${table}.${physical}`,
      className: sigmaDisplayName(table),
      description: `Crystal source field ${table}.${physical}`,
    });
  }

  const joins = (ir.data.links || []).flatMap(link => {
    const count = Math.min(link.leftFields?.length || 0, link.rightFields?.length || 0);
    if (!count) {
      warnings.push(`Crystal link ${link.leftTable} → ${link.rightTable} has no paired fields — skipped.`);
      return [];
    }
    const expressions = [];
    for (let i = 0; i < count; i++) {
      expressions.push(`${link.leftTable}.${link.leftFields[i]} = ${link.rightTable}.${link.rightFields[i]}`);
    }
    const cardinality = cardinalityFor(link.leftTable, link.rightTable, factTable, link.cardinality);
    if (!link.cardinality) {
      warnings.push(
        `Crystal link ${link.leftTable} → ${link.rightTable} carries no cardinality; inferred ${cardinality}. Verify the source side is many-grain.`,
      );
    }
    return [{
      left: link.leftTable,
      right: link.rightTable,
      expression: expressions.join(' AND '),
      cardinality,
    }];
  });

  for (const table of ir.data.tables || []) {
    if (table.kind === 'command') {
      warnings.push(`Crystal command table "${table.name}" requires a Sigma Custom SQL source; it is not emitted as a warehouse table.`);
    } else if (table.kind === 'stored-procedure') {
      warnings.push(`Crystal stored procedure "${table.name}" is not auto-migrated; remodel it as a table/view or Custom SQL.`);
    }
  }

  if (!factTable) {
    warnings.push('Could not infer the Crystal report fact/detail table; Sigma relationship direction may need manual correction.');
  }

  return {
    universe: {
      name: `${ir.report?.name || 'Crystal Report'} Data`,
      objects,
      tables,
      joins,
      filters: ir.report?.recordSelectionFormula
        ? [{
            name: 'Crystal Record Selection',
            where: ir.report.recordSelectionFormula,
          }]
        : [],
    },
    factTable,
    warnings,
    stats: {
      tables: tables.length,
      fields: objects.length,
      joins: joins.length,
      commands: (ir.data.tables || []).filter(t => t.kind === 'command').length,
    },
  };
}

export function inferFactTable(ir) {
  const detailFields = new Map();
  for (const section of ir.sections || []) {
    if (section.kind !== 'details') continue;
    for (const object of section.objects || []) {
      const ref = object.fieldId || object.formulaName;
      if (!ref || !String(ref).includes('.')) continue;
      const table = String(ref).split('.')[0];
      detailFields.set(table, (detailFields.get(table) || 0) + 1);
    }
  }
  if (detailFields.size) {
    return [...detailFields.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  // Fall back to the most-linked table, preferring common transactional names.
  const degree = new Map();
  for (const link of ir.data?.links || []) {
    degree.set(link.leftTable, (degree.get(link.leftTable) || 0) + 1);
    degree.set(link.rightTable, (degree.get(link.rightTable) || 0) + 1);
  }
  const transactional = [...degree.keys()].find(name =>
    /fact|detail|line|invoice|order|transaction/i.test(name));
  if (transactional) return transactional;
  return [...degree.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

function cardinalityFor(left, right, factTable, sourceCardinality) {
  if (sourceCardinality) return sourceCardinality;
  // Crystal's link arrays are normally emitted FK/source → PK/target. Keep
  // that direction for dimension chains when the detail fact does not touch
  // the link directly; every inference remains a surfaced warning.
  if (!factTable) return 'many-to-one';
  if (same(left, factTable) && !same(right, factTable)) return 'many-to-one';
  if (same(right, factTable) && !same(left, factTable)) return 'one-to-many';
  return 'many-to-one';
}

function normalizePhysicalRef(value) {
  return String(value || '')
    .replace(/^\{|\}$/g, '')
    .replace(/"/g, '')
    .trim()
    .toUpperCase();
}

function same(a, b) {
  return String(a || '').toUpperCase() === String(b || '').toUpperCase();
}

