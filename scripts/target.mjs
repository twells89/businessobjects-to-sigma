const DEFAULT_TARGET = {
  webi: 'workbook',
  crystal: 'report',
};

const TARGETS = new Set(['workbook', 'report']);

/**
 * Resolve the shared --target contract. Omitted and `auto` are source-aware;
 * explicit workbook/report values are honored for either report source.
 */
export function resolveTarget(sourceType, requested = 'auto') {
  const source = String(sourceType || '').toLowerCase();
  const value = String(requested || 'auto').toLowerCase();
  if (!(source in DEFAULT_TARGET)) {
    throw new Error(`Unsupported source type "${sourceType}"; expected webi or crystal`);
  }
  if (value === 'auto') {
    return {
      sourceType: source,
      requestedTarget: requested || 'auto',
      resolvedTarget: DEFAULT_TARGET[source],
      automatic: true,
    };
  }
  if (!TARGETS.has(value)) {
    throw new Error(`Invalid --target "${requested}"; expected auto, workbook, or report`);
  }
  return {
    sourceType: source,
    requestedTarget: value,
    resolvedTarget: value,
    automatic: false,
  };
}

export function targetWritePolicy(sourceType, resolvedTarget) {
  if (sourceType === 'webi' && resolvedTarget === 'workbook') {
    return {
      createFlagRequired: false,
      note: 'Webi workbook compatibility mode creates on a non-dry run.',
    };
  }
  return {
    createFlagRequired: true,
    note: `Persistent ${resolvedTarget} creation requires --create.`,
  };
}
