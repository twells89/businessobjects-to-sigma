import { translateCrystalFormula } from '../converters/crystal-formula.mjs';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

function formula(source) {
  return translateCrystalFormula(source);
}

console.log('Crystal formula translator');

let result = formula('"INV-" & ToText({invoice.invoice_id},"000000")');
check(result.sigma === '"INV-" & Text([Invoice Id], "000000")', `invoice number → ${result.sigma}`);
check(result.placement === 'dm' && result.fullyTranslated, 'simple formula is fully translated for DM placement');

result = formula('IIf(IsNull({payments.paid_total}), 0, {payments.paid_total})');
check(result.sigma === 'If(IsNull([Paid Total]), 0, [Paid Total])', `IIf/IsNull → ${result.sigma}`);

result = formula('Not IsNull({payments.paid_total})');
check(result.sigma === 'Not(IsNull([Paid Total]))', `Not IsNull → ${result.sigma}`);

result = formula('{invoice.amount_gross} - {@PaidAmount}');
check(result.sigma === '[Amount Gross] - [PaidAmount]', `field + formula refs → ${result.sigma}`);
check(result.dependencies.includes('Amount Gross') && result.dependencies.includes('PaidAmount'), 'dependencies captured');

result = formula('DateDiff("d", {invoice.due_date}, CDate({?StatementDate}))');
check(result.sigma === 'DateDiff("day", [Due Date], Date([p-statementdate]))', `DateDiff/CDate/parameter → ${result.sigma}`);
check(result.placement === 'report' && result.parameters[0] === 'StatementDate', 'parameter forces report placement');

result = formula('If {@AgingDays} <= 0 Then "Current" Else If {@AgingDays} <= 30 Then "1-30" Else "30+"');
check(
  result.sigma === 'If([AgingDays] <= 0, "Current", If([AgingDays] <= 30, "1-30", "30+"))',
  `nested If/Then/Else → ${result.sigma}`,
);

result = formula('CCur({@Balance}) / {rates.rate_to_usd}');
check(result.sigma === '[Balance] / [Rate to Usd]', `CCur cast removed → ${result.sigma}`);
check(result.warnings.some(warning => /numeric cast removed/.test(warning)), 'removed cast is surfaced');

result = formula('"A" & Chr(13) & "B"');
check(result.sigma === '"A" & "\\n" & "B"', `Chr(13) → newline (${result.sigma})`);

result = formula('Sum ({@Balance})');
check(result.sigma === 'Sum([Balance])' && result.kind === 'measure', 'Sum becomes a measure');

result = formula('WhilePrintingRecords; Shared NumberVar total := total + 1; total');
check(result.sigma === 'Null()', 'multi-pass statement degrades to Null()');
check(result.source.includes('WhilePrintingRecords') && result.warnings.length >= 2, 'unsupported source preserved with warnings');

console.log(failures ? `\n❌ ${failures} Crystal formula check(s) failed` : '\n✅ all Crystal formula checks passed');
process.exit(failures ? 1 : 0);

