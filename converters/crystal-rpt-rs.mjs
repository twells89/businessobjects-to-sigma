/**
 * Normalize rpt-rs' lossless Crystal model JSON into this repository's
 * versioned Crystal migration IR.
 *
 * rpt-rs is an experimental, reverse-engineered parser. This adapter exists for
 * Linux CI and public-sample validation; the official SAP SDK extractor under
 * tools/crystal-extractor remains the production extraction contract.
 */

import { createHash } from 'node:crypto';

export function normalizeRptRsCrystal(input, options = {}) {
  const raw = typeof input === 'string' ? JSON.parse(input) : input;
  if (raw?.irVersion === '1.0') return raw;
  const model = raw?.model || raw?.report || raw;
  if (!model?.report_definition || !model?.data_definition) {
    throw new Error('Not an rpt-rs report JSON document (missing model.report_definition/data_definition)');
  }

  const warnings = [];
  const sourceName = options.sourceName || options.sourcePath || 'report.rpt';
  const po = model.print_options || {};
  const margins = po.margins || {};
  const contentWidth = number(po.content_width);
  const contentHeight = number(po.content_height);

  const sections = [];
  for (const area of model.report_definition.areas || []) {
    for (const section of area.sections || []) {
      const kind = sectionKind(section.kind || area.kind);
      const objects = (section.objects || []).map((object, index) =>
        normalizeObject(object, index, warnings));
      sections.push({
        id: stableId(section.name || `${kind}-${sections.length + 1}`),
        name: section.name || `${kind} ${sections.length + 1}`,
        kind,
        groupIndex: area.group_level == null ? null : number(area.group_level),
        heightTwips: number(section.height),
        widthTwips: number(section.width) || contentWidth || null,
        visible: !conditionValue(section.format?.suppress),
        suppressFormula: section.format?.suppress?.formula || null,
        newPageBefore: boolOrNull(section.format?.new_page_before),
        newPageAfter: boolOrNull(section.format?.new_page_after),
        keepTogether: boolOrNull(section.format?.keep_together),
        objects,
        extensions: {
          areaName: area.name,
          areaKind: unionTag(area.kind),
          areaFormat: area.format || null,
          conditionFormulas: section.condition_formulas || [],
          sourceFormat: section.format || {},
        },
      });
    }
  }

  const definitions = model.data_definition.field_definitions || [];
  const data = {
    tables: (model.database?.tables || []).map(normalizeTable),
    links: (model.database?.links || []).map(normalizeLink),
    // rpt-rs' global Database field definitions intentionally omit the table
    // alias; the authoritative binding lives on database.tables[].data_fields.
    // Read from there so duplicate names such as customer.name/city.name remain
    // distinct and the source adapter can build real physical columns.
    fields: (model.database?.tables || []).flatMap(table =>
      (table.data_fields || []).map(field => normalizeTableField(table, field))),
    formulas: definitions.filter(d => unionTag(d.kind) === 'Formula').map(normalizeFormulaField),
    parameters: definitions.filter(d => unionTag(d.kind) === 'Parameter').map(normalizeParameter),
    groups: (model.data_definition.groups || []).map((group, index) => ({
      name: `Group ${index + 1}`,
      conditionField: normalizeRef(group.condition_field),
      sortDirection: group.sort?.direction || null,
      repeatHeader: boolOrNull(group.area_format?.repeat_group_header),
      keepTogether: boolOrNull(group.area_format?.keep_group_together),
      extensions: group,
    })),
    sorts: (model.data_definition.record_sorts || []).map(sort => ({
      name: normalizeRef(sort.field) || `Sort`,
      field: normalizeRef(sort.field),
      direction: sort.direction || null,
      kind: sort.kind || null,
      topN: sort.topn || null,
    })),
    summaries: definitions.filter(d => unionTag(d.kind) === 'Summary').map((definition, index) => {
      const summary = unionValue(definition.kind) || {};
      return {
        name: definition.name || `Summary ${index + 1}`,
        field: normalizeRef(summary.summarized_field),
        operation: summary.operation || null,
        groupIndex: summary.group_index,
        valueType: definition.value_type || null,
        extensions: summary,
      };
    }),
    runningTotals: definitions.filter(d => unionTag(d.kind) === 'RunningTotal').map(definition => {
      const running = unionValue(definition.kind) || {};
      return {
        name: definition.name,
        field: normalizeRef(running.summarized_field),
        operation: running.operation || null,
        resetCondition: running.reset || null,
        evaluateCondition: running.evaluation || null,
        extensions: running,
      };
    }),
    sqlExpressions: definitions.filter(d => unionTag(d.kind) === 'SqlExpression').map(definition => ({
      name: definition.name,
      text: unionValue(definition.kind)?.text || '',
      valueType: definition.value_type || null,
    })),
  };

  const subreports = (model.subreports || []).map(sub => {
    const child = normalizeRptRsCrystal(
      { model: sub.report },
      { sourceName: `${sourceName}#${sub.name}` },
    );
    child.report.name = sub.name || child.report.name;
    child.extensions = {
      ...(child.extensions || {}),
      subreportLinks: sub.links || [],
    };
    return child;
  });

  for (const section of sections) {
    for (const object of section.objects) {
      if (['chart', 'crosstab', 'ole', 'map', 'unknown'].includes(object.kind)) {
        warnings.push({
          code: 'unsupported-report-object',
          message: `${object.kind} object "${object.name}" requires a targeted Sigma report fallback.`,
          path: `$.sections[${section.id}].objects[${object.id}]`,
          sourceValue: object.extensions?.sourceKind,
        });
      }
    }
  }

  return {
    irVersion: '1.0',
    source: {
      kind: 'rpt-rs-json',
      name: sourceName.split(/[\\/]/).pop(),
      path: options.sourcePath || null,
      sha256: options.sourceSha256 || (typeof input === 'string'
        ? createHash('sha256').update(input).digest('hex')
        : null),
      crystalVersion: model.version == null ? null : String(model.version),
      extractorVersion: options.extractorVersion || null,
      extractedAt: options.extractedAt || null,
    },
    report: {
      name: model.summary_info?.title || sourceName.replace(/\.rpt$/i, '').split(/[\\/]/).pop(),
      title: model.summary_info?.title || null,
      description: model.summary_info?.comments || null,
      author: model.summary_info?.author || null,
      recordSelectionFormula: model.data_definition.record_selection || null,
      groupSelectionFormula: model.data_definition.group_selection || null,
    },
    page: {
      widthTwips: contentWidth + number(margins.left) + number(margins.right),
      heightTwips: contentHeight + number(margins.top) + number(margins.bottom),
      orientation: String(po.paper_orientation || '').toLowerCase().includes('landscape')
        ? 'landscape'
        : String(po.paper_orientation || '').toLowerCase().includes('portrait')
          ? 'portrait'
          : 'unknown',
      marginsTwips: {
        top: number(margins.top),
        right: number(margins.right),
        bottom: number(margins.bottom),
        left: number(margins.left),
      },
      paperName: po.paper_size || null,
      printerName: po.printer_name || po.saved_printer_name || null,
      dissociateFormattingPageSizeAndPrinterPaperSize: null,
    },
    sections,
    data,
    subreports,
    warnings,
    extensions: {
      authoringVersion: model.authoring_version || null,
      hasSavedData: model.has_saved_data === true,
      reportKind: model.report_definition.kind || null,
      reportStyle: model.report_definition.style || null,
      sourceReportOptions: model.report_options || {},
    },
  };
}

function normalizeObject(object, zIndex, warnings) {
  const tag = unionTag(object.kind);
  const value = unionValue(object.kind) || {};
  const { data: embeddedHex, ...sourceKindValue } = value;
  const bounds = object.bounds || {};
  const sourceKind = tag || 'Unknown';
  const kind = {
    Text: 'text',
    Field: fieldObjectKind(value),
    Picture: 'picture',
    Line: 'line',
    Box: 'box',
    Chart: 'chart',
    Crosstab: 'crosstab',
    CrossTab: 'crosstab',
    Subreport: 'subreport',
    Ole: 'ole',
    OLE: 'ole',
    Map: 'map',
  }[sourceKind] || 'unknown';

  const format = normalizeFormat(object, value);
  const dataSource = value.data_source || null;
  const result = {
    id: stableId(object.name || `${sourceKind}-${zIndex + 1}`),
    name: object.name || `${sourceKind} ${zIndex + 1}`,
    kind,
    xTwips: number(bounds.left),
    yTwips: number(bounds.top),
    widthTwips: number(bounds.width),
    heightTwips: number(bounds.height),
    zIndex,
    text: tag === 'Text' ? value.text || value.rtf || '' : null,
    fieldId: kind === 'field' ? normalizeRef(dataSource) : null,
    formulaName: kind === 'formula' ? normalizeRef(dataSource) : null,
    summaryName: kind === 'summary' ? normalizeRef(dataSource) : null,
    subreportName: kind === 'subreport' ? value.subreport_name || null : null,
    format,
    conditionFormulas: conditionFormulaMap(
      object.format?.condition_formulas,
      object.border?.condition_formulas,
      value.font_color?.condition_formulas,
    ),
    image: kind === 'picture' ? {
      mimeType: imageMime(embeddedHex),
      dataBase64: hexToBase64(embeddedHex),
      sourcePath: value.location_formula || null,
      sourceField: normalizeRef(value.location_formula),
      embedOrdinal: value.ole_ordinal ?? null,
    } : null,
    extensions: {
      sourceKind,
      origin: object.origin || null,
      sourceKindValue,
      embeddedImageBytes: typeof embeddedHex === 'string'
        ? Math.floor(embeddedHex.length / 2)
        : null,
      border: object.border || null,
    },
  };

  if (kind === 'field' && !result.fieldId) {
    warnings.push({
      code: 'missing-field-binding',
      message: `Field object "${result.name}" has no recognized data source.`,
      path: `$.sections[].objects[${result.id}]`,
      sourceValue: dataSource,
    });
  }
  return result;
}

function normalizeFormat(object, kindValue) {
  const font = kindValue.font_color?.font || {};
  const color = kindValue.font_color?.color;
  const border = object.border || {};
  const format = object.format || {};
  const numeric = kindValue.format?.currency_numeric || kindValue.format?.numeric || {};
  return {
    fontFamily: font.name || null,
    fontSizePoints: font.size_pt ?? null,
    bold: boolOrNull(font.bold),
    italic: boolOrNull(font.italic),
    underline: boolOrNull(font.underline),
    foregroundColor: rgbaHex(color),
    backgroundColor: rgbaHex(border.background_color),
    horizontalAlign: format.horizontal_alignment || null,
    verticalAlign: format.vertical_alignment || null,
    numberFormat: numericFormat(numeric),
    dateFormat: kindValue.format?.date || null,
    canGrow: boolOrNull(format.can_grow),
    suppress: conditionValue(format.suppress),
  };
}

function normalizeTable(table) {
  const qn = table.qualified_name || table.name || '';
  const parts = qn.split('.').filter(Boolean);
  const connection = table.connection || {};
  return {
    id: stableId(table.alias || table.name),
    name: table.alias || table.name,
    kind: table.command_text ? 'command' : inferTableKind(table),
    database: parts.length >= 3 ? parts[0] : null,
    schema: parts.length >= 2 ? parts[parts.length - 2] : null,
    qualifiedName: qn || null,
    alias: table.alias || null,
    commandSql: table.command_text || null,
    connection: {
      kind: unionTag(connection.kind) || connection.kind || null,
      server: connection.server_name || connection.server || null,
      database: connection.database_name || connection.database || null,
    },
    extensions: {
      className: table.class_name || null,
      parameters: table.parameters || [],
      dataFields: table.data_fields || [],
    },
  };
}

function inferTableKind(table) {
  const name = String(table.qualified_name || table.name || '').toLowerCase();
  if (name.endsWith('_latest') || name.endsWith('_totals')) return 'view';
  return 'table';
}

function normalizeLink(link) {
  return {
    leftTable: link.source_table_alias,
    leftFields: (link.source_fields || []).map(normalizeRef),
    rightTable: link.target_table_alias,
    rightFields: (link.target_fields || []).map(normalizeRef),
    joinType: link.join_kind || null,
    cardinality: null,
    operator: link.operator || null,
  };
}

function normalizeTableField(table, definition) {
  const longName = definition.long_name || `${table.alias || table.name}.${definition.name}`;
  const normalized = normalizeRef(longName);
  const parts = normalized.split('.');
  return {
    id: stableId(normalized || definition.name),
    name: definition.name,
    table: parts.length > 1 ? parts.slice(0, -1).join('.') : table.alias || table.name || null,
    physicalName: parts.at(-1) || definition.name,
    dataType: definition.value_type || null,
    extensions: {
      description: definition.description || null,
      length: definition.length ?? null,
      shortName: definition.short_name || null,
      tableName: table.name || null,
      tableAlias: table.alias || null,
    },
  };
}

function normalizeFormulaField(definition) {
  const formula = unionValue(definition.kind) || {};
  const text = formula.text || '';
  return {
    name: definition.name,
    text,
    syntax: String(formula.syntax || 'unknown').toLowerCase(),
    valueType: definition.value_type || null,
    evaluationTime: /WhilePrintingRecords/i.test(text)
      ? 'while-printing-records'
      : /WhileReadingRecords/i.test(text)
        ? 'while-reading-records'
        : 'default',
    extensions: {
      nullTreatment: formula.null_treatment || null,
      options: formula.options ?? null,
    },
  };
}

function normalizeParameter(definition) {
  const parameter = unionValue(definition.kind) || {};
  return {
    name: definition.name,
    prompt: parameter.prompt_text || null,
    dataType: definition.value_type || parameter.value_kind || null,
    allowMultiple: boolOrNull(parameter.allow_multiple_values),
    allowNull: boolOrNull(parameter.allow_null_value),
    optional: boolOrNull(parameter.optional_prompt),
    defaultValues: parameter.default_values || [],
    extensions: {
      currentValues: parameter.current_values || [],
      initialValues: parameter.initial_values || [],
      dynamicLov: parameter.dynamic_lov || null,
      parameterType: parameter.parameter_type || null,
    },
  };
}

function fieldObjectKind(value) {
  const refKind = String(value.ref_kind || '').toLowerCase();
  if (refKind.includes('formula')) return 'formula';
  if (refKind.includes('summary')) return 'summary';
  if (refKind.includes('running')) return 'running-total';
  return 'field';
}

function sectionKind(value) {
  const tag = unionTag(value) || String(value || '');
  return {
    ReportHeader: 'report-header',
    PageHeader: 'page-header',
    GroupHeader: 'group-header',
    Detail: 'details',
    Details: 'details',
    GroupFooter: 'group-footer',
    PageFooter: 'page-footer',
    ReportFooter: 'report-footer',
  }[tag] || 'unknown';
}

function conditionFormulaMap(...collections) {
  const result = {};
  for (const collection of collections.filter(Array.isArray)) {
    for (const formula of collection) {
      const name = formula?.name || formula?.property || `condition${Object.keys(result).length + 1}`;
      const text = formula?.text || formula?.formula || formula?.value;
      if (text != null && String(text).trim()) result[name] = String(text);
    }
  }
  return result;
}

function conditionValue(value) {
  if (value && typeof value === 'object' && 'value' in value) return value.value === true;
  return value === true;
}

function numericFormat(format) {
  if (!format || typeof format !== 'object' || Object.keys(format).length === 0) return null;
  const decimals = Number.isInteger(format.decimal_places) ? format.decimal_places : 2;
  const prefix = format.currency_symbol_text || '';
  return `${prefix}${format.thousands_separator ? ',' : ''}.${decimals}f`;
}

function rgbaHex(color) {
  if (!color || [color.r, color.g, color.b].some(v => v == null)) return null;
  return `#${[color.r, color.g, color.b]
    .map(v => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

function hexToBase64(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value) || value.length % 2) return null;
  return Buffer.from(value, 'hex').toString('base64');
}

function imageMime(value) {
  if (typeof value !== 'string') return null;
  const hex = value.toLowerCase();
  if (hex.startsWith('89504e47')) return 'image/png';
  if (hex.startsWith('ffd8ff')) return 'image/jpeg';
  if (hex.startsWith('47494638')) return 'image/gif';
  if (hex.startsWith('424d')) return 'image/bmp';
  return 'application/octet-stream';
}

function unionTag(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value)[0] || null;
  }
  return value == null ? null : String(value);
}

function unionValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const key = Object.keys(value)[0];
  return key ? value[key] : null;
}

export function normalizeRef(value) {
  return String(value || '')
    .trim()
    .replace(/^\{/, '')
    .replace(/\}$/, '')
    .replace(/^[@?]/, '');
}

function stableId(value) {
  return String(value || 'object')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'object';
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

