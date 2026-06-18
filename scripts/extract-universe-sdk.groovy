#!/usr/bin/env groovy
/*
 * extract-universe-sdk.groovy — SAP BusinessObjects Universe → migration XML
 * ==========================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The BI RESTful Web Service (GET /biprws/sl/v1/universes/{id}) returns only the
 * business OUTLINE of a universe — object names, datatypes, folders. It does NOT
 * return each object's SELECT/WHERE (the actual calculation) nor the data
 * foundation (physical tables, columns, joins). That is an SAP design limit of
 * the REST API — even on 4.3 it stops at the outline. So a universe migration
 * driven purely by REST has no warehouse columns and no calculations to convert.
 *
 * The authoritative source for those is the Semantic Layer Java SDK. This script
 * opens the universe (.unx) via the SDK, walks the data foundation + the business
 * layer's RelationalBinding for every object, and writes an XML file in exactly
 * the shape the converter's `ingestBobjSdkXml()` consumes (MCP src/bobj.ts /
 * skill converters/bobj.mjs / the browser tool — all auto-detect a leading `<`).
 *
 * STATUS: coded to the documented SL SDK API. It has NOT been run against a live
 * BO server here (no SDK/server available in this environment) — expect to adjust
 * a getter name or two on first contact across 4.1/4.2/4.3. The OUTPUT shape is
 * verified end-to-end against Sigma via fixtures/efashion_universe.xml.
 *
 * PREREQUISITES
 * -------------
 *  1. SAP BO Client Tools (or BIP server) with the **Semantic Layer SDK**
 *     component installed. The SDK jars live under, e.g.:
 *       <BO_INSTALL>/SAP BusinessObjects Enterprise XI 4.0/java/lib/sl_sdk/...
 *  2. Groovy 2.x/3.x/4.x. Run with the SDK jars on the classpath:
 *       groovy -cp "<sdk_lib>/*" extract-universe-sdk.groovy <args>
 *     (or set CLASSPATH; the SDK ships a `setup/env.(sh|bat)` you can source.)
 *
 * USAGE
 * -----
 *   # From a local .unx (Information Design Tool retrieved it to disk):
 *   groovy -cp "$SL_SDK_LIB/*" extract-universe-sdk.groovy \
 *       --unx "/path/to/eFashion.unx" --out efashion_universe.xml
 *
 *   # From the CMS repository (logs on, retrieves the .unx to a temp dir):
 *   groovy -cp "$SL_SDK_LIB/*" extract-universe-sdk.groovy \
 *       --cms my-bo-host:6400 --user Administrator --password secret --auth secEnterprise \
 *       --universe "/Universes/eFashion/eFashion.unx" --out efashion_universe.xml
 *
 *   Add --json to emit the RWS-style JSON IR instead of XML (the converter
 *   accepts either). Default output is XML.
 *
 * Then feed the output to the converter:
 *   node scripts/migrate-universe.mjs --file efashion_universe.xml      # skill
 *   # or paste into the browser tool / pass to convert_bobj_to_sigma (MCP).
 */

import com.sap.sl.sdk.authoring.businesslayer.*
import com.sap.sl.sdk.authoring.datafoundation.*
import com.sap.sl.sdk.authoring.local.LocalResourceService
import com.sap.sl.sdk.authoring.cms.CmsResourceService
import com.sap.sl.sdk.framework.SlContext
import com.sap.sl.sdk.framework.security.AuthenticationService
import groovy.xml.MarkupBuilder
import groovy.json.JsonOutput

// ── arg parsing ──────────────────────────────────────────────────────────────
def opt = [auth: 'secEnterprise', out: null, json: false]
for (int i = 0; i < args.length; i++) {
    switch (args[i]) {
        case '--unx':       opt.unx = args[++i]; break
        case '--cms':       opt.cms = args[++i]; break
        case '--user':      opt.user = args[++i]; break
        case '--password':  opt.password = args[++i]; break
        case '--auth':      opt.auth = args[++i]; break
        case '--universe':  opt.universe = args[++i]; break   // CMS path to the .unx
        case '--out':       opt.out = args[++i]; break
        case '--json':      opt.json = true; break
        default: System.err.println("Unknown arg: ${args[i]}"); System.exit(2)
    }
}
if (!opt.unx && !(opt.cms && opt.universe)) {
    System.err.println('Provide either --unx <file> OR --cms <host:port> --universe <cms path> (+ --user/--password).')
    System.exit(2)
}

// ── open the SL context + load the universe (business layer + data foundation) ─
def slContext = SlContext.create()
def blPath, dfPath, workDir

try {
    if (opt.unx) {
        // Local .unx: the SDK's LocalResourceService unpacks it into .blx + .dfx.
        def local = slContext.getService(LocalResourceService.class)
        workDir = new File(opt.unx).getAbsoluteFile().getParent()
        local.setResourceFolder(workDir)
        // retrieveUniverse returns the relative .blx path; the .dfx is referenced by it.
        blPath = local.retrieveUniverse(new File(opt.unx).getName())
    } else {
        // CMS: log on, then retrieve the .unx from the repository to a temp folder.
        def authSvc = slContext.getService(AuthenticationService.class)
        authSvc.login(opt.cms, opt.user, opt.password ?: '', opt.auth)
        def cms = slContext.getService(CmsResourceService.class)
        workDir = File.createTempDir('bo-unx').getAbsolutePath()
        cms.setResourceFolder(workDir)
        blPath = cms.retrieveUniverse(opt.universe)   // pulls .unx → .blx/.dfx on disk
    }

    def local = slContext.getService(LocalResourceService.class)
    local.setResourceFolder(workDir)
    RelationalBusinessLayer businessLayer = (RelationalBusinessLayer) local.load(blPath)
    // The business layer references its data foundation; load it for tables/joins.
    dfPath = businessLayer.getDataFoundationPath() ?: businessLayer.getDataFoundationName()
    def dataFoundation = (RelationalDataFoundation) local.load(dfPath)

    def model = buildModel(businessLayer, dataFoundation)

    def text = opt.json ? toJson(model) : toXml(model)
    if (opt.out) { new File(opt.out).text = text; System.err.println("Wrote ${opt.out}") }
    else { println text }
} finally {
    try { slContext?.close() } catch (ignored) {}
}

// ── walk the SDK objects into a plain map (the IR the converter ingests) ──────
def buildModel(businessLayer, dataFoundation) {
    def tables = []
    dataFoundation.getTables().each { t ->
        tables << [
            name    : safe { t.getName() },
            catalog : safe { t.getCatalog() } ?: safe { t.getDatabase() },
            schema  : safe { t.getSchema() } ?: safe { t.getQualifier() } ?: safe { t.getOwner() },
            columns : safe { t.getColumns() }?.collect { c ->
                          [name: safe { c.getName() }, dataType: ('' + safe { c.getDataType() })]
                      } ?: [],
        ]
    }

    def joins = []
    safe { dataFoundation.getJoins() }?.each { j ->
        joins << [
            expression : safe { j.getExpression() } ?: safe { j.getStatement() },
            cardinality: '' + (safe { j.getCardinality() } ?: ''),
        ]
    }

    // Business layer: walk the folder/object tree, reading each object's
    // RelationalBinding for its SELECT (and WHERE, for predefined filters).
    def objects = []
    def filters = []
    walkFolder(businessLayer.getRootFolder(), null, objects, filters)

    return [name: safe { businessLayer.getName() } ?: 'BusinessObjects Universe',
            tables: tables, joins: joins, objects: objects, filters: filters]
}

def walkFolder(folder, parentClass, objects, filters) {
    def className = (safe { folder.getName() }) ?: parentClass
    safe { folder.getChildren() }?.each { child ->
        if (isFolder(child)) {
            walkFolder(child, className, objects, filters)
        } else if (isFilter(child)) {
            filters << [name: safe { child.getName() } ?: 'Filter',
                        where: bindingText(child, true)]
        } else {
            def select = bindingText(child, false)
            if (!select && !safe { child.getName() }) return
            objects << [
                name       : safe { child.getName() } ?: 'Object',
                className  : className,
                qualification: qualificationOf(child),
                dataType   : '' + (safe { child.getDataType() } ?: ''),
                aggregation: '' + (safe { child.getAggregationFunction() }
                                   ?: safe { child.getProjectionFunction() } ?: ''),
                select     : select,
                description: safe { child.getDescription() },
            ]
        }
    }
}

// RelationalBinding carries the real SELECT/WHERE. APIs differ slightly across
// versions, so try the common shapes before giving up.
def bindingText(obj, wantWhere) {
    def b = safe { obj.getRelationalBinding() } ?: safe { obj.getBinding() }
    if (b == null) {
        // Some object types expose select/where directly.
        return wantWhere ? safe { obj.getWhere() } : safe { obj.getSelect() }
    }
    return wantWhere ? (safe { b.getWhere() } ?: safe { b.getWhereClause() })
                     : (safe { b.getSelect() } ?: safe { b.getSelectClause() })
}

def qualificationOf(obj) {
    def q = safe { obj.getQualification() }
    if (q) return ('' + q)
    def cn = obj.getClass().getSimpleName().toLowerCase()
    if (cn.contains('measure')) return 'Measure'
    if (cn.contains('attribute') || cn.contains('detail')) return 'Attribute'
    return 'Dimension'
}

def isFolder(o)  { def cn = o.getClass().getSimpleName().toLowerCase(); cn.contains('folder') || safe { o.getChildren() } != null }
def isFilter(o)  { def cn = o.getClass().getSimpleName().toLowerCase(); cn.contains('filter') || cn.contains('condition') }

/** Best-effort getter — returns null instead of throwing when an API is absent. */
def safe(Closure c) { try { return c() } catch (ignored) { return null } }

// ── emit: XML (default) matching ingestBobjSdkXml's expected shape ────────────
def toXml(model) {
    def sw = new StringWriter()
    sw << '<?xml version="1.0" encoding="UTF-8"?>\n'
    def xml = new MarkupBuilder(sw)
    xml.universe(name: model.name) {
        dataFoundation {
            tables {
                model.tables.each { t ->
                    def attrs = [name: t.name]
                    if (t.catalog) attrs.catalog = t.catalog
                    if (t.schema)  attrs.schema = t.schema
                    table(attrs) {
                        t.columns.each { c -> column(name: c.name, dataType: c.dataType ?: 'String') }
                    }
                }
            }
            joins {
                model.joins.each { j ->
                    def attrs = [:]; if (j.cardinality) attrs.cardinality = j.cardinality
                    join(attrs) { if (j.expression) expression(j.expression) }
                }
            }
        }
        businessLayer {
            // Group objects under their folder/class name for readability.
            model.objects.groupBy { it.className ?: 'Objects' }.each { cls, objs ->
                folder(name: cls) {
                    objs.each { o ->
                        def attrs = [name: o.name, qualification: o.qualification]
                        if (o.aggregation) attrs.aggregation = o.aggregation
                        if (o.dataType)    attrs.dataType = o.dataType
                        item(attrs) {
                            relationalBinding { if (o.select) select(o.select) }
                            if (o.description) description(o.description)
                        }
                    }
                }
            }
            conditions {
                model.filters.each { f -> filter(name: f.name) { if (f.where) where(f.where) } }
            }
        }
    }
    return sw.toString()
}

// ── emit: JSON (RWS-style IR) when --json is passed ───────────────────────────
def toJson(model) {
    def classes = model.objects.groupBy { it.className ?: 'Objects' }.collect { cls, objs ->
        [name: cls, objects: objs.collect { o ->
            def m = [name: o.name, type: o.qualification, select: o.select]
            if (o.aggregation) m.aggregation = o.aggregation
            if (o.description) m.description = o.description
            m
        }]
    }
    def out = [universe: [
        name   : model.name,
        classes: classes,
        tables : model.tables.collect { [name: it.name, database: it.catalog, schema: it.schema] },
        joins  : model.joins.collect { [expression: it.expression, cardinality: it.cardinality] },
        filters: model.filters.collect { [name: it.name, where: it.where] },
    ]]
    return JsonOutput.prettyPrint(JsonOutput.toJson(out))
}
