/**
 * Read-only BusinessObjects inventory.
 *
 * Typed Semantic Layer / Raylight lists are merged with CMS query rows so the
 * assessment can see folder, owner, and timestamp metadata when the service
 * pack exposes it. CMS queries fall back to narrower column lists. Nothing
 * here writes to BusinessObjects or Sigma.
 */
import {
  asArray,
  boBaseUrl,
  cmsQuery,
  listUniversesDetailed,
  listWebiDocumentsDetailed,
  logon,
  redact,
  redactSecrets,
} from './bo-rws.mjs';

const INFO_QUERIES = [
  "SELECT SI_ID, SI_CUID, SI_NAME, SI_KIND, SI_PARENTID, SI_OWNER, SI_UPDATE_TS, SI_CREATION_TIME, SI_INSTANCE FROM CI_INFOOBJECTS WHERE SI_INSTANCE = 0 AND SI_KIND IN ('Webi','CrystalReport','Folder')",
  "SELECT SI_ID, SI_CUID, SI_NAME, SI_KIND, SI_PARENTID, SI_INSTANCE FROM CI_INFOOBJECTS WHERE SI_INSTANCE = 0 AND SI_KIND IN ('Webi','CrystalReport','Folder')",
  "SELECT SI_ID, SI_NAME, SI_KIND FROM CI_INFOOBJECTS WHERE SI_KIND IN ('Webi','CrystalReport') AND SI_INSTANCE = 0",
];

const UNIVERSE_QUERIES = [
  "SELECT SI_ID, SI_CUID, SI_NAME, SI_KIND, SI_PARENTID, SI_OWNER, SI_UPDATE_TS, SI_CREATION_TIME FROM CI_APPOBJECTS WHERE SI_KIND IN ('Universe','DSL.Universe')",
  "SELECT SI_ID, SI_CUID, SI_NAME, SI_KIND, SI_PARENTID FROM CI_APPOBJECTS WHERE SI_KIND IN ('Universe','DSL.Universe')",
  "SELECT SI_ID, SI_NAME, SI_KIND FROM CI_APPOBJECTS WHERE SI_KIND IN ('Universe','DSL.Universe')",
];

export function asText(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    return asText(value.SI_NAME ?? value.si_name ?? value.name ?? value.title ?? value.SI_ID ?? value.id);
  }
  return null;
}

export function kindFromContentType(contentType) {
  const value = String(contentType || '');
  if (/universe/i.test(value)) return 'universe';
  if (/webi/i.test(value)) return 'webi';
  if (/crystal/i.test(value)) return 'crystal';
  if (/folder/i.test(value)) return 'folder';
  return 'other';
}

function field(row, ...keys) {
  for (const key of keys) {
    if (row?.[key] != null && row[key] !== '') return row[key];
  }
  return null;
}

export function normalizeCmsRow(row) {
  const contentType = asText(field(row, 'SI_KIND', 'si_kind', 'kind', 'type'));
  const id = field(row, 'SI_ID', 'si_id', 'id');
  return {
    id,
    cuid: asText(field(row, 'SI_CUID', 'si_cuid', 'cuid')),
    name: asText(field(row, 'SI_NAME', 'si_name', 'name')) || asText(field(row, 'SI_CUID', 'cuid')) || (id == null ? '' : String(id)),
    kind: kindFromContentType(contentType),
    contentType,
    parentId: field(row, 'SI_PARENTID', 'si_parentid', 'parentId'),
    owner: asText(field(row, 'SI_OWNER', 'si_owner', 'owner')),
    updatedAt: asText(field(row, 'SI_UPDATE_TS', 'si_update_ts', 'updatedAt', 'updated')),
    createdAt: asText(field(row, 'SI_CREATION_TIME', 'si_creation_time', 'createdAt')),
    instance: field(row, 'SI_INSTANCE', 'si_instance', 'instance'),
    path: asText(field(row, 'path', 'SI_PATH', 'si_path')),
    sourceType: 'cms',
  };
}

function fillRecord(primary, extra = {}) {
  const merged = { ...extra, ...primary };
  for (const key of ['cuid', 'contentType', 'parentId', 'owner', 'updatedAt', 'createdAt', 'path', 'instance']) {
    if ((merged[key] == null || merged[key] === '') && extra[key] != null && extra[key] !== '') merged[key] = extra[key];
  }
  if (!merged.kind) merged.kind = extra.kind || kindFromContentType(merged.contentType);
  return merged;
}

export function mergeByKind(typedItems, cmsItems, kind) {
  const extras = cmsItems.filter(item => item.kind === kind && item.id != null);
  const byId = new Map(extras.map(item => [String(item.id), item]));
  const seen = new Set();
  const merged = [];
  for (const typed of asArray(typedItems)) {
    const id = typed.id ?? typed.cuid;
    if (id == null) continue;
    const extra = byId.get(String(id)) || {};
    seen.add(String(id));
    merged.push(fillRecord({
      id,
      cuid: asText(typed.cuid || typed.CUID),
      name: asText(typed.name) || asText(typed.cuid) || String(id),
      kind,
      contentType: asText(typed.type || typed.kind) || extra.contentType || null,
      parentId: typed.parentId ?? typed.parent?.id ?? null,
      owner: asText(typed.owner),
      updatedAt: asText(typed.updated || typed.updatedAt),
      createdAt: asText(typed.createdAt),
      path: asText(typed.path),
      instance: typed.instance ?? null,
      sourceType: 'rws',
    }, extra));
  }
  for (const extra of extras) {
    if (!seen.has(String(extra.id))) merged.push({ ...extra });
  }
  return merged.filter(item => item.kind !== 'crystal' || item.instance == null || Number(item.instance) === 0);
}

export function folderPath(item, byId) {
  const names = [];
  const seen = new Set();
  let current = item;
  while (current?.parentId != null) {
    const parent = byId.get(String(current.parentId));
    if (!parent || seen.has(String(parent.id))) break;
    seen.add(String(parent.id));
    if (parent.name) names.push(parent.name);
    current = parent;
  }
  return names.reverse().concat(item.name || String(item.id)).join('/');
}

/**
 * Keep Webi/Crystal descendants of folderId. Universes live in CI_APPOBJECTS
 * and are included even when they are outside the report folder tree.
 */
export function selectFolderScope(items, folderId) {
  const folders = items.filter(item => item.kind === 'folder');
  const content = items.filter(item => item.kind !== 'folder');
  if (folderId == null || folderId === '') {
    return { items: content, folders, unscopedUniverses: false };
  }
  const children = new Map();
  for (const item of items) {
    const parent = item.parentId == null ? '' : String(item.parentId);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }
  const keep = new Set();
  const queue = [String(folderId)];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of children.get(id) || []) {
      keep.add(child);
      if (child.kind === 'folder' && child.id != null) queue.push(String(child.id));
    }
  }
  const scoped = content.filter(item => keep.has(item));
  const universesOutside = content.filter(item => item.kind === 'universe' && !keep.has(item));
  return {
    items: [...scoped, ...universesOutside],
    folders: folders.filter(item => keep.has(item)),
    unscopedUniverses: universesOutside.length > 0,
  };
}

function withPaths(items, folders) {
  const byId = new Map();
  for (const item of [...folders, ...items]) {
    if (item.id != null) byId.set(String(item.id), item);
  }
  return items.map(item => ({ ...item, path: item.path || folderPath(item, byId) }));
}

async function safeList(load, warnings, label) {
  try {
    const result = await load();
    if (result && result.complete === false) {
      warnings.push(`${label}: list is incomplete (${result.items.length} of ${result.advertisedTotal}).`);
    }
    return result || { items: [], pages: 0, advertisedTotal: null, complete: false };
  } catch (error) {
    warnings.push(`${label}: ${redactSecrets(error.message)}`);
    return { items: [], pages: 0, advertisedTotal: null, complete: false };
  }
}

async function cmsQueryFallback(queries, label) {
  let lastError = null;
  for (let index = 0; index < queries.length; index++) {
    try {
      const rows = await cmsQuery(queries[index]);
      return {
        rows,
        warning: index > 0
          ? `${label}: owner/timestamp properties were not available on this service pack; inventory continues with ids and names.`
          : null,
      };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    rows: [],
    warning: `${label}: CMS query failed (${redactSecrets(lastError?.message || 'unknown error')}).`,
  };
}

function completeness(result, count) {
  return {
    pages: result?.pages || 0,
    advertisedTotal: result?.advertisedTotal ?? null,
    complete: result?.complete !== false && count >= 0,
    count,
  };
}

export async function discoverRepository({ folderId = null, strict = false } = {}) {
  await logon();
  const warnings = [];
  const universeList = await safeList(() => listUniversesDetailed({ strict }), warnings, 'universes');
  const webiList = await safeList(() => listWebiDocumentsDetailed({ strict }), warnings, 'webi');
  const info = await cmsQueryFallback(INFO_QUERIES, 'Webi/Crystal CMS');
  const universeCms = await cmsQueryFallback(UNIVERSE_QUERIES, 'Universe CMS');
  if (info.warning) warnings.push(info.warning);
  if (universeCms.warning) warnings.push(universeCms.warning);

  const cmsItems = [...info.rows, ...universeCms.rows].map(normalizeCmsRow).filter(item => item.id != null);
  const merged = [
    ...mergeByKind(universeList.items, cmsItems, 'universe'),
    ...mergeByKind(webiList.items, cmsItems, 'webi'),
    ...mergeByKind([], cmsItems, 'crystal'),
    ...cmsItems.filter(item => item.kind === 'folder'),
  ];
  const scoped = selectFolderScope(merged, folderId);
  if (scoped.unscopedUniverses) {
    warnings.push('Folder scope applies to Web Intelligence and Crystal Reports. Universes outside that folder are still listed because they live in the semantic-layer repository.');
  }
  const items = withPaths(scoped.items, scoped.folders);
  const universes = items.filter(item => item.kind === 'universe');
  const webiDocuments = items.filter(item => item.kind === 'webi');
  const crystalReports = items.filter(item => item.kind === 'crystal');
  const inventory = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    source: { baseUrl: boBaseUrl(), folderId: folderId == null || folderId === '' ? null : String(folderId) },
    pagination: {
      universePages: universeList.pages || 0,
      webiPages: webiList.pages || 0,
    },
    completeness: {
      universes: completeness(universeList, universes.length),
      webiDocuments: completeness(webiList, webiDocuments.length),
      crystalReports: {
        pages: 1,
        advertisedTotal: null,
        complete: !/CMS query failed/.test(info.warning || ''),
        count: crystalReports.length,
      },
      folderScope: {
        folderId: folderId == null || folderId === '' ? null : String(folderId),
        unscopedUniverses: scoped.unscopedUniverses,
      },
    },
    warnings,
    universes,
    webiDocuments,
    crystalReports,
    folders: scoped.folders,
  };
  return redact(inventory);
}
