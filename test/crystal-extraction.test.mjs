import { normalizeRptRsCrystal } from '../converters/crystal-rpt-rs.mjs';

const raw = {
  model: {
    version: 14,
    has_saved_data: false,
    summary_info: { title: 'Extraction Fixture', comments: '', author: '' },
    print_options: {
      content_width: 10466,
      content_height: 15398,
      margins: { top: 720, right: 720, bottom: 720, left: 720 },
      paper_orientation: 'Portrait',
      paper_size: 'PaperA4',
    },
    report_definition: {
      kind: 'ColumnarReport',
      style: 'Standard',
      areas: [{
        kind: 'Detail',
        name: 'DetailArea1',
        group_level: null,
        sections: [{
          kind: 'Detail',
          name: 'DetailSection1',
          height: 300,
          width: 10466,
          format: { suppress: { value: false, formula: null } },
          condition_formulas: [],
          objects: [{
            name: 'InvoiceId',
            kind: {
              Field: {
                data_source: '{invoice.invoice_id}',
                ref_kind: 'Database',
                font_color: {
                  color: { r: 0, g: 0, b: 0, a: 255 },
                  font: { name: 'Arial', size_pt: 9, bold: false, italic: false, underline: false },
                  condition_formulas: [],
                },
                format: { numeric: { decimal_places: 0, thousands_separator: false } },
              },
            },
            origin: { index: 0 },
            bounds: { left: 0, top: 0, width: 1000, height: 260 },
            format: { can_grow: false, suppress: { value: false }, condition_formulas: [] },
            border: { background_color: null, condition_formulas: [] },
          }, {
            name: 'Logo',
            kind: {
              Picture: {
                picture_type: 'Bitmap',
                data: '89504e470d0a1a0a',
                ole_ordinal: 1,
                location_formula: null,
              },
            },
            origin: { index: 1 },
            bounds: { left: 1200, top: 0, width: 400, height: 260 },
            format: { can_grow: false, suppress: { value: false }, condition_formulas: [] },
            border: { background_color: null, condition_formulas: [] },
          }],
        }],
      }],
    },
    data_definition: {
      field_definitions: [{
        name: 'Balance',
        value_type: 'Currency',
        kind: { Formula: { syntax: 'Crystal', text: '{invoice.amount_gross}', null_treatment: 'Exception' } },
      }, {
        name: 'Minimum',
        value_type: 'Currency',
        kind: {
          Parameter: {
            prompt_text: 'Minimum',
            allow_multiple_values: false,
            allow_null_value: false,
            optional_prompt: false,
            default_values: [0],
          },
        },
      }],
      groups: [],
      record_sorts: [],
      record_selection: '{@Balance} >= {?Minimum}',
      group_selection: '',
    },
    database: {
      tables: [{
        alias: 'invoice',
        name: 'invoice',
        qualified_name: 'meridian.public.invoice',
        command_text: null,
        class_name: 'Table',
        parameters: [],
        connection: {},
        data_fields: [{
          name: 'invoice_id',
          long_name: 'invoice.invoice_id',
          short_name: 'invoice_id',
          value_type: 'Int32s',
          length: 4,
        }, {
          name: 'amount_gross',
          long_name: 'invoice.amount_gross',
          short_name: 'amount_gross',
          value_type: 'Currency',
          length: 8,
        }],
      }],
      links: [],
    },
    subreports: [],
    report_options: {},
  },
};

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

console.log('rpt-rs Crystal extraction normalization');
const ir = normalizeRptRsCrystal(raw, { sourceName: 'fixture.rpt', extractorVersion: 'test' });
check(ir.irVersion === '1.0' && ir.source.kind === 'rpt-rs-json', 'normalizes extractor provenance');
check(ir.page.widthTwips === 11906 && ir.page.heightTwips === 16838, 'reconstructs total A4 twip size from content + margins');
check(ir.sections[0].kind === 'details', 'normalizes Detail section kind');
check(ir.sections[0].objects[0].fieldId === 'invoice.invoice_id', 'normalizes field binding');
check(ir.sections[0].objects[1].image.mimeType === 'image/png', 'detects embedded picture MIME type');
check(ir.sections[0].objects[1].image.dataBase64 === 'iVBORw0KGgo=', 'converts embedded hex picture to Base64');
check(!('data' in ir.sections[0].objects[1].extensions.sourceKindValue), 'does not duplicate raw hex in extensions');
check(ir.data.fields.length === 2 && ir.data.fields[0].table === 'invoice', 'uses table-level field definitions');
check(ir.data.formulas[0].name === 'Balance', 'normalizes formula fields');
check(ir.data.parameters[0].name === 'Minimum', 'normalizes parameters');
check(ir.report.recordSelectionFormula === '{@Balance} >= {?Minimum}', 'preserves record selection');

console.log(failures ? `\n❌ ${failures} extraction check(s) failed` : '\n✅ all extraction checks passed');
process.exit(failures ? 1 : 0);

