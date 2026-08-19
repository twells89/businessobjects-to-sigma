#!/usr/bin/env groovy
/**
 * BI Platform CMS/RAS Crystal extractor → Crystal migration IR 1.0.
 *
 * Run on a machine with the BO BI Platform Java SDK + RAS jars:
 *
 *   groovy -cp "$BO_SDK_LIB/*" scripts/extract-crystal-cms.groovy \
 *     --cms cms.example.com:6400 --user svc_migration --password '...' \
 *     --auth secEnterprise --id 12345 --out-dir ./crystal-ir
 *
 * Passwords are used only for the SDK logon and never written to IR.
 * Crystal/BI service-pack APIs vary; optional getters are read defensively and
 * produce warnings. Validate a representative report before batch extraction.
 */

import groovy.json.JsonOutput
import com.crystaldecisions.sdk.framework.CrystalEnterprise
import com.crystaldecisions.sdk.occa.infostore.IInfoStore
import com.crystaldecisions.sdk.occa.managedreports.IReportAppFactory
import com.crystaldecisions.sdk.occa.report.application.OpenReportOptions

import java.security.MessageDigest
import java.time.Instant

def arg = { String name, String fallback = null ->
  int index = args.findIndexOf { it == name }
  index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
def flag = { String name -> args.contains(name) }
def required = { String name, String envName = null ->
  String value = arg(name, envName ? System.getenv(envName) : null)
  if (!value) throw new IllegalArgumentException("Missing ${name}${envName ? " / ${envName}" : ''}")
  value
}
def cms = required('--cms', 'BO_CMS')
def user = required('--user', 'BO_USER')
def password = required('--password', 'BO_PASSWORD')
def auth = arg('--auth', System.getenv('BO_AUTH') ?: 'secEnterprise')
def id = arg('--id')
def all = flag('--all')
def outDir = new File(arg('--out-dir', 'artifacts/crystal/cms'))
if (!id && !all) throw new IllegalArgumentException('Pass --id <SI_ID> or --all')
outDir.mkdirs()

def warnings = []
def warn = { String code, String message, String path ->
  warnings << [code: code, message: message, path: path]
}

def prop
prop = { Object object, String path ->
  if (object == null) return null
  Object current = object
  for (String part : path.split(/\./)) {
    if (current == null) return null
    try {
      String getter = 'get' + part[0].toUpperCase() + part.substring(1)
      def method = current.metaClass.respondsTo(current, getter)
      current = method ? current."${getter}"() : current."${part}"
    } catch (Throwable ignored) {
      try {
        String getter = 'is' + part[0].toUpperCase() + part.substring(1)
        current = current."${getter}"()
      } catch (Throwable ignoredAgain) {
        return null
      }
    }
  }
  current
}
def list = { Object collection ->
  if (collection == null) return []
  def result = []
  try {
    for (def item : collection) result << item
  } catch (Throwable ignored) {
    Integer size = (prop(collection, 'size') ?: prop(collection, 'count') ?: 0) as Integer
    for (int i = 0; i < size; i++) {
      try { result << collection.get(i) } catch (Throwable ignoredItem) {}
    }
  }
  result
}
def text = { Object value ->
  String result = value == null ? null : value.toString()
  result?.trim() ? result : null
}
def number = { Object value, int fallback = 0 ->
  try { return value == null ? fallback : Math.round(value as Double) as Integer }
  catch (Throwable ignored) { return fallback }
}
def stableId = { String value ->
  String idValue = (value ?: 'object').toLowerCase()
    .replaceAll(/[^a-z0-9]+/, '-').replaceAll(/^-|-$/, '')
  idValue ?: 'object'
}
def sectionKind = { Object kind, String name ->
  String key = "${kind ?: ''} ${name ?: ''}".toLowerCase().replaceAll(/\s+/, '')
  if (key.contains('reportheader')) return 'report-header'
  if (key.contains('pageheader')) return 'page-header'
  if (key.contains('groupheader')) return 'group-header'
  if (key.contains('detail')) return 'details'
  if (key.contains('groupfooter')) return 'group-footer'
  if (key.contains('pagefooter')) return 'page-footer'
  if (key.contains('reportfooter')) return 'report-footer'
  'unknown'
}
def objectKind = { Object object ->
  String key = object?.class?.simpleName?.toLowerCase() ?: ''
  if (key.contains('text')) return 'text'
  if (key.contains('field')) return 'field'
  if (key.contains('picture') || key.contains('image')) return 'picture'
  if (key.contains('line')) return 'line'
  if (key.contains('box')) return 'box'
  if (key.contains('chart')) return 'chart'
  if (key.contains('crosstab')) return 'crosstab'
  if (key.contains('subreport')) return 'subreport'
  if (key.contains('ole')) return 'ole'
  if (key.contains('map')) return 'map'
  'unknown'
}
def conditionFormula = { Object owner, String name ->
  def formulas = prop(owner, 'conditionFormulas')
  def formula = prop(formulas, name)
  text(prop(formula, 'text') ?: formula)
}
def format = { Object object ->
  def source = prop(object, 'format') ?: prop(object, 'objectFormat')
  def font = prop(object, 'font') ?: prop(source, 'font')
  [
    fontFamily: text(prop(font, 'name')),
    fontSizePoints: prop(font, 'size'),
    bold: prop(font, 'bold'),
    italic: prop(font, 'italic'),
    underline: prop(font, 'underline'),
    foregroundColor: text(prop(object, 'color')),
    backgroundColor: text(prop(object, 'backgroundColor')),
    horizontalAlign: text(prop(source, 'horizontalAlignment')),
    verticalAlign: text(prop(source, 'verticalAlignment')),
    numberFormat: text(prop(source, 'numericFormat')),
    dateFormat: text(prop(source, 'dateTimeFormat')),
    canGrow: prop(source, 'canGrow') ?: prop(source, 'enableCanGrow'),
    suppress: prop(source, 'suppress') ?: prop(source, 'enableSuppress')
  ]
}
def normalizeObject = { Object object, int index, String path ->
  String name = text(prop(object, 'name')) ?: "Object ${index + 1}"
  String kind = objectKind(object)
  if (kind == 'unknown') warn('unsupported-report-object',
    "Unrecognized RAS object ${object.class.name}", path)
  def field = prop(object, 'dataSource')
  String formulaName = text(prop(field, 'formulaName'))
  String fieldName = text(prop(field, 'name'))
  [
    id: stableId(name),
    name: name,
    kind: kind,
    xTwips: number(prop(object, 'left') ?: prop(object, 'x')),
    yTwips: number(prop(object, 'top') ?: prop(object, 'y')),
    widthTwips: number(prop(object, 'width')),
    heightTwips: number(prop(object, 'height')),
    zIndex: index,
    text: kind == 'text' ? text(prop(object, 'text')) : null,
    fieldId: kind == 'field' && !(formulaName?.startsWith('@')) ? (formulaName ?: fieldName) : null,
    formulaName: formulaName?.startsWith('@') ? formulaName.substring(1) : null,
    summaryName: null,
    subreportName: kind == 'subreport' ? text(prop(object, 'subreportName')) : null,
    format: format(object),
    conditionFormulas: [
      suppress: conditionFormula(prop(object, 'format') ?: prop(object, 'objectFormat'), 'enableSuppress'),
      color: conditionFormula(prop(object, 'format') ?: prop(object, 'objectFormat'), 'color'),
      backgroundColor: conditionFormula(prop(object, 'format') ?: prop(object, 'objectFormat'), 'backgroundColor'),
      graphicLocation: conditionFormula(prop(object, 'format') ?: prop(object, 'objectFormat'), 'graphicLocation')
    ].findAll { it.value },
    image: kind == 'picture' ? [
      mimeType: null,
      dataBase64: null,
      sourcePath: text(prop(object, 'graphicLocation')),
      sourceField: conditionFormula(prop(object, 'format') ?: prop(object, 'objectFormat'), 'graphicLocation')
    ] : null,
    extensions: [runtimeType: object.class.name]
  ]
}

def normalizeClient
normalizeClient = { Object client, String reportName, String sourceId ->
  warnings = []
  def reportDef = prop(prop(client, 'reportDefController'), 'reportDefinition')
  def dataDef = prop(prop(client, 'dataDefController'), 'dataDefinition')
  def database = prop(prop(client, 'databaseController'), 'database')
  def printOptions = prop(prop(client, 'printOutputController'), 'printOptions')
  def margins = prop(printOptions, 'pageMargins') ?: prop(reportDef, 'pageMargins')

  def sections = []
  int sectionIndex = 0
  list(prop(reportDef, 'areas')).each { area ->
    list(prop(area, 'sections')).each { section ->
      String sectionName = text(prop(section, 'name')) ?: "Section ${sectionIndex + 1}"
      def objects = list(prop(section, 'reportObjects')).withIndex().collect { object, objectIndex ->
        normalizeObject(object, objectIndex as int,
          "\$.sections[${sectionIndex}].objects[${objectIndex}]")
      }
      sections << [
        id: stableId(sectionName),
        name: sectionName,
        kind: sectionKind(prop(section, 'kind') ?: prop(area, 'kind'), sectionName),
        groupIndex: prop(area, 'groupLevel'),
        heightTwips: number(prop(section, 'height')),
        widthTwips: number(prop(section, 'width'), 0) ?: null,
        visible: !(prop(prop(section, 'format'), 'enableSuppress') ?: false),
        suppressFormula: conditionFormula(prop(section, 'format'), 'enableSuppress'),
        newPageBefore: prop(prop(section, 'format'), 'enableNewPageBefore'),
        newPageAfter: prop(prop(section, 'format'), 'enableNewPageAfter'),
        keepTogether: prop(prop(section, 'format'), 'enableKeepTogether'),
        objects: objects
      ]
      sectionIndex++
    }
  }

  def tables = list(prop(database, 'tables')).collect { table ->
    String name = text(prop(table, 'alias')) ?: text(prop(table, 'name')) ?: 'table'
    [
      id: stableId(name),
      name: name,
      kind: table.class.simpleName.toLowerCase().contains('command') ? 'command' : 'table',
      database: text(prop(prop(table, 'connectionInfo'), 'databaseName')),
      schema: text(prop(table, 'owner')),
      qualifiedName: text(prop(table, 'qualifiedName') ?: prop(table, 'name')),
      alias: text(prop(table, 'alias')),
      commandSql: text(prop(table, 'commandText')),
      connection: [
        kind: text(prop(prop(table, 'connectionInfo'), 'kind')),
        server: text(prop(prop(table, 'connectionInfo'), 'serverName'))
      ]
    ]
  }
  def fields = []
  list(prop(database, 'tables')).each { table ->
    String tableName = text(prop(table, 'alias')) ?: text(prop(table, 'name'))
    list(prop(table, 'dataFields') ?: prop(table, 'fields')).each { field ->
      String fieldName = text(prop(field, 'name'))
      fields << [
        id: stableId("${tableName}.${fieldName}"),
        name: fieldName,
        table: tableName,
        physicalName: fieldName,
        dataType: text(prop(field, 'valueType'))
      ]
    }
  }
  def links = list(prop(database, 'tableLinks')).collect { link ->
    [
      leftTable: text(prop(link, 'sourceTableAlias') ?: prop(prop(link, 'sourceTable'), 'name')),
      leftFields: list(prop(link, 'sourceFields')).collect {
        text(prop(it, 'formulaName') ?: prop(it, 'name'))
      },
      rightTable: text(prop(link, 'targetTableAlias') ?: prop(prop(link, 'targetTable'), 'name')),
      rightFields: list(prop(link, 'targetFields')).collect {
        text(prop(it, 'formulaName') ?: prop(it, 'name'))
      },
      joinType: text(prop(link, 'joinType')),
      cardinality: text(prop(link, 'joinCardinality'))
    ]
  }
  def formulas = list(prop(dataDef, 'formulaFields')).collect { formula ->
    String formulaText = text(prop(formula, 'text')) ?: ''
    [
      name: text(prop(formula, 'name')),
      text: formulaText,
      syntax: text(prop(formula, 'syntax'))?.toLowerCase() ?: 'crystal',
      valueType: text(prop(formula, 'valueType')),
      evaluationTime: formulaText =~ /(?i)WhilePrintingRecords/ ? 'while-printing-records' :
        formulaText =~ /(?i)WhileReadingRecords/ ? 'while-reading-records' : 'default'
    ]
  }
  def parameters = list(prop(dataDef, 'parameterFields')).collect { parameter ->
    [
      name: text(prop(parameter, 'name')),
      prompt: text(prop(parameter, 'promptText')),
      dataType: text(prop(parameter, 'valueType')),
      allowMultiple: prop(parameter, 'allowMultipleValues') ?: prop(parameter, 'enableAllowMultipleValue'),
      allowNull: prop(parameter, 'allowNullValue') ?: prop(parameter, 'enableAllowNullValue'),
      optional: prop(parameter, 'optionalPrompt') ?: prop(parameter, 'isOptionalPrompt'),
      defaultValues: list(prop(parameter, 'defaultValues')).collect { prop(it, 'value') ?: it.toString() }
    ]
  }
  def groups = list(prop(dataDef, 'groups')).withIndex().collect { group, groupIndex ->
    [
      name: "Group ${groupIndex + 1}",
      conditionField: text(prop(prop(group, 'conditionField'), 'formulaName') ?:
        prop(prop(group, 'conditionField'), 'name')),
      sortDirection: text(prop(prop(group, 'groupOptions'), 'sortDirection')),
      repeatHeader: prop(prop(group, 'groupOptions'), 'repeatGroupHeader'),
      keepTogether: prop(prop(group, 'groupOptions'), 'keepGroupTogether')
    ]
  }

  def subreports = []
  def subController = prop(client, 'subreportController')
  list(prop(subController, 'subreportNames')).each { subName ->
    try {
      def child = subController.getSubreportClientDocument(subName)
      subreports << normalizeClient(child, subName.toString(), "${sourceId}#${subName}")
      child.close()
    } catch (Throwable error) {
      warn('subreport-extraction-failed', error.message, "\$.subreports[${subName}]")
    }
  }

  int left = number(prop(margins, 'left') ?: prop(margins, 'leftMargin'), 720)
  int right = number(prop(margins, 'right') ?: prop(margins, 'rightMargin'), 720)
  int top = number(prop(margins, 'top') ?: prop(margins, 'topMargin'), 720)
  int bottom = number(prop(margins, 'bottom') ?: prop(margins, 'bottomMargin'), 720)
  int pageWidth = number(prop(reportDef, 'pageWidth') ?: prop(printOptions, 'pageWidth'), 12240)
  int pageHeight = number(prop(reportDef, 'pageHeight') ?: prop(printOptions, 'pageHeight'), 15840)

  [
    irVersion: '1.0',
    source: [
      kind: 'sap-java-ras',
      name: reportName,
      path: sourceId,
      sha256: null,
      crystalVersion: text(prop(client, 'productVersion')),
      extractorVersion: '0.1.0',
      extractedAt: Instant.now().toString()
    ],
    report: [
      name: reportName,
      title: text(prop(prop(client, 'summaryInfo'), 'reportTitle')),
      description: text(prop(prop(client, 'summaryInfo'), 'reportComments')),
      author: text(prop(prop(client, 'summaryInfo'), 'reportAuthor')),
      recordSelectionFormula: text(prop(dataDef, 'recordFilter.freeEditingText') ?:
        prop(dataDef, 'recordSelectionFormula')),
      groupSelectionFormula: text(prop(dataDef, 'groupFilter.freeEditingText') ?:
        prop(dataDef, 'groupSelectionFormula'))
    ],
    page: [
      widthTwips: pageWidth,
      heightTwips: pageHeight,
      orientation: text(prop(printOptions, 'paperOrientation'))?.toLowerCase()?.contains('landscape') ?
        'landscape' : 'portrait',
      marginsTwips: [top: top, right: right, bottom: bottom, left: left],
      paperName: text(prop(printOptions, 'paperSize')),
      printerName: text(prop(printOptions, 'printerName')),
      dissociateFormattingPageSizeAndPrinterPaperSize:
        prop(printOptions, 'dissociatePageSizeAndPrinterPaperSize')
    ],
    sections: sections,
    data: [
      tables: tables,
      links: links,
      fields: fields,
      formulas: formulas,
      parameters: parameters,
      groups: groups,
      sorts: [],
      summaries: [],
      runningTotals: [],
      sqlExpressions: []
    ],
    subreports: subreports,
    warnings: warnings,
    extensions: [cmsId: sourceId]
  ]
}

def session = null
try {
  session = CrystalEnterprise.getSessionMgr().logon(user, password, cms, auth)
  IInfoStore infoStore = (IInfoStore) session.getService('', 'InfoStore')
  IReportAppFactory reportFactory = (IReportAppFactory) session.getService('', 'RASReportFactory')
  String where = id ? "SI_ID = ${id as Integer}" :
    "SI_KIND = 'CrystalReport' AND SI_INSTANCE = 0"
  def reports = infoStore.query(
    "SELECT SI_ID, SI_CUID, SI_NAME, SI_KIND, SI_INSTANCE FROM CI_INFOOBJECTS WHERE ${where}"
  )
  int extracted = 0
  for (def infoObject : reports) {
    if (prop(infoObject, 'instance') == true) continue
    String reportId = prop(infoObject, 'id').toString()
    String reportName = text(prop(infoObject, 'title')) ?: "Crystal ${reportId}"
    def client = null
    try {
      client = reportFactory.openDocument(
        infoObject,
        OpenReportOptions._openAsReadOnly,
        Locale.US
      )
      def ir = normalizeClient(client, reportName, "cms:${reportId}")
      File output = new File(outDir, "${stableId(reportName)}-${reportId}.crystal-ir.json")
      output.text = JsonOutput.prettyPrint(JsonOutput.toJson(ir))
      println "Crystal IR: ${output.absolutePath}"
      extracted++
    } catch (Throwable error) {
      System.err.println "Crystal ${reportId} (${reportName}) failed: ${error.message}"
      if (id) throw error
    } finally {
      try { client?.close() } catch (Throwable ignored) {}
    }
  }
  println "Extracted ${extracted} Crystal report definition(s)."
} finally {
  try { session?.logoff() } catch (Throwable ignored) {}
}

