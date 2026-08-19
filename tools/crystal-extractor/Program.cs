using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using CrystalDecisions.CrystalReports.Engine;
using CrystalDecisions.Shared;

namespace CrystalExtractor
{
    internal static class Program
    {
        private const string IrVersion = "1.0";
        private const string ExtractorVersion = "0.1.0";

        private static readonly List<Dictionary<string, object>> Warnings =
            new List<Dictionary<string, object>>();

        private static int Main(string[] args)
        {
            if (args.Length == 0 || args.Contains("--help") || args.Contains("-h"))
            {
                Usage();
                return args.Length == 0 ? 2 : 0;
            }

            var input = Path.GetFullPath(args[0]);
            var output = Path.GetFullPath(Option(args, "--out") ??
                                          Path.ChangeExtension(input, ".crystal-ir.json"));
            var pdf = Option(args, "--pdf");
            if (pdf != null) pdf = Path.GetFullPath(pdf);

            if (!File.Exists(input))
            {
                Console.Error.WriteLine("Report not found: " + input);
                return 2;
            }

            try
            {
                using (var report = new ReportDocument())
                {
                    report.Load(input, OpenReportMethod.OpenReportByTempCopy);
                    ApplyDatabaseLogon(report);
                    ApplyParameters(report, args);

                    var ir = ExtractReport(report, input, true);
                    Directory.CreateDirectory(Path.GetDirectoryName(output) ?? ".");
                    var serializer = new JavaScriptSerializer
                    {
                        MaxJsonLength = int.MaxValue,
                        RecursionLimit = 256
                    };
                    File.WriteAllText(output, serializer.Serialize(ir), new UTF8Encoding(false));
                    Console.WriteLine("Crystal IR: " + output);

                    if (pdf != null)
                    {
                        try
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(pdf) ?? ".");
                            report.ExportToDisk(ExportFormatType.PortableDocFormat, pdf);
                            Console.WriteLine("Reference PDF: " + pdf);
                        }
                        catch (Exception ex)
                        {
                            Warn("pdf-export-failed", ex.Message, "$.source");
                            File.WriteAllText(output, serializer.Serialize(ir), new UTF8Encoding(false));
                            Console.Error.WriteLine("Reference PDF export failed: " + ex.Message);
                            return 3;
                        }
                    }
                }
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex);
                return 1;
            }
        }

        private static void Usage()
        {
            Console.WriteLine(
                "crystal-extractor report.rpt [--out report.crystal-ir.json] [--pdf oracle.pdf]\n" +
                "  [--parameter Name=Value ...]\n\n" +
                "Optional database rebinding uses environment variables only:\n" +
                "  CRYSTAL_DB_SERVER, CRYSTAL_DB_DATABASE, CRYSTAL_DB_USER,\n" +
                "  CRYSTAL_DB_PASSWORD, CRYSTAL_DB_INTEGRATED_SECURITY.\n\n" +
                "The extractor emits no passwords or private connection properties.");
        }

        private static string Option(IReadOnlyList<string> args, string name)
        {
            for (var i = 0; i < args.Count - 1; i++)
                if (args[i] == name) return args[i + 1];
            return null;
        }

        private static Dictionary<string, object> ExtractReport(
            ReportDocument report, string sourcePath, bool includeSourceMetadata)
        {
            var source = new Dictionary<string, object>
            {
                ["kind"] = "sap-dotnet-sdk",
                ["name"] = Path.GetFileName(sourcePath),
                ["path"] = sourcePath,
                ["sha256"] = Sha256(sourcePath),
                ["crystalVersion"] = typeof(ReportDocument).Assembly.GetName().Version?.ToString(),
                ["extractorVersion"] = ExtractorVersion,
                ["extractedAt"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            };

            var summary = report.SummaryInfo;
            var reportMeta = new Dictionary<string, object>
            {
                ["name"] = EmptyToNull(report.Name) ?? Path.GetFileNameWithoutExtension(sourcePath),
                ["title"] = EmptyToNull(summary.ReportTitle),
                ["description"] = EmptyToNull(summary.ReportComments),
                ["author"] = EmptyToNull(summary.ReportAuthor),
                ["recordSelectionFormula"] = EmptyToNull(report.RecordSelectionFormula),
                ["groupSelectionFormula"] = SafeString(report, "GroupSelectionFormula")
            };

            var page = ExtractPage(report);
            var sections = ExtractSections(report);
            var data = ExtractData(report);
            var subreports = ExtractSubreports(report, sourcePath);

            return new Dictionary<string, object>
            {
                ["irVersion"] = IrVersion,
                ["source"] = source,
                ["report"] = reportMeta,
                ["page"] = page,
                ["sections"] = sections,
                ["data"] = data,
                ["subreports"] = subreports,
                ["warnings"] = Warnings,
                ["extensions"] = new Dictionary<string, object>
                {
                    ["savedData"] = Safe(report, "HasSavedData"),
                    ["reportClientDocumentAvailable"] = Safe(report, "ReportClientDocument") != null
                }
            };
        }

        private static Dictionary<string, object> ExtractPage(ReportDocument report)
        {
            var options = report.PrintOptions;
            var margins = options.PageMargins;
            var orientation = options.PaperOrientation.ToString().ToLowerInvariant();
            if (!orientation.Contains("landscape") && !orientation.Contains("portrait"))
                orientation = "unknown";
            else
                orientation = orientation.Contains("landscape") ? "landscape" : "portrait";

            var width = SafeLong(Safe(Safe(report, "ReportClientDocument"), "ReportDefController"),
                                 "ReportDefinition.PageWidth");
            var height = SafeLong(Safe(Safe(report, "ReportClientDocument"), "ReportDefController"),
                                  "ReportDefinition.PageHeight");
            if (width <= 0 || height <= 0)
            {
                // Crystal reports store coordinates in twips. Letter is the most
                // conservative fallback; the warning prevents silent pagination drift.
                width = orientation == "landscape" ? 15840 : 12240;
                height = orientation == "landscape" ? 12240 : 15840;
                Warn("page-size-fallback",
                    "SDK did not expose PageWidth/PageHeight; used US Letter twips. Verify against the PDF oracle.",
                    "$.page");
            }

            return new Dictionary<string, object>
            {
                ["widthTwips"] = width,
                ["heightTwips"] = height,
                ["orientation"] = orientation,
                ["marginsTwips"] = new Dictionary<string, object>
                {
                    ["top"] = Convert.ToInt32(margins.topMargin),
                    ["right"] = Convert.ToInt32(margins.rightMargin),
                    ["bottom"] = Convert.ToInt32(margins.bottomMargin),
                    ["left"] = Convert.ToInt32(margins.leftMargin)
                },
                ["paperName"] = options.PaperSize.ToString(),
                ["printerName"] = EmptyToNull(options.PrinterName),
                ["dissociateFormattingPageSizeAndPrinterPaperSize"] =
                    Safe(options, "DissociatePageSizeAndPrinterPaperSize")
            };
        }

        private static List<Dictionary<string, object>> ExtractSections(ReportDocument report)
        {
            var result = new List<Dictionary<string, object>>();
            var index = 0;
            foreach (Section section in report.ReportDefinition.Sections)
            {
                var objects = new List<Dictionary<string, object>>();
                var z = 0;
                foreach (ReportObject obj in section.ReportObjects)
                    objects.Add(ExtractObject(obj, z++));

                var format = section.SectionFormat;
                result.Add(new Dictionary<string, object>
                {
                    ["id"] = "section-" + index++,
                    ["name"] = section.Name,
                    ["kind"] = SectionKind(section.Name),
                    ["groupIndex"] = GroupIndex(section.Name),
                    ["heightTwips"] = Convert.ToInt32(section.Height),
                    ["widthTwips"] = null,
                    ["visible"] = !format.EnableSuppress,
                    ["suppressFormula"] = FormulaText(format, "ConditionFormulas", "EnableSuppress"),
                    ["newPageBefore"] = Safe(format, "EnableNewPageBefore"),
                    ["newPageAfter"] = Safe(format, "EnableNewPageAfter"),
                    ["keepTogether"] = Safe(format, "EnableKeepTogether"),
                    ["objects"] = objects
                });
            }
            return result;
        }

        private static Dictionary<string, object> ExtractObject(ReportObject obj, int zIndex)
        {
            var kind = ObjectKind(obj);
            var item = new Dictionary<string, object>
            {
                ["id"] = StableId(obj.Name),
                ["name"] = obj.Name,
                ["kind"] = kind,
                ["xTwips"] = Convert.ToInt32(obj.Left),
                ["yTwips"] = Convert.ToInt32(obj.Top),
                ["widthTwips"] = Convert.ToInt32(obj.Width),
                ["heightTwips"] = Convert.ToInt32(obj.Height),
                ["zIndex"] = zIndex,
                ["text"] = obj is TextObject text ? text.Text : null,
                ["fieldId"] = obj is FieldObject field ? FieldReference(field) : null,
                ["formulaName"] = obj is FieldObject formulaField &&
                                  FieldReference(formulaField)?.StartsWith("@") == true
                    ? FieldReference(formulaField).Substring(1)
                    : null,
                ["summaryName"] = null,
                ["subreportName"] = obj is SubreportObject sub ? sub.SubreportName : null,
                ["format"] = ExtractFormat(obj),
                ["conditionFormulas"] = ExtractConditionFormulas(obj),
                ["image"] = ExtractImage(obj),
                ["extensions"] = ExtractObjectExtensions(obj)
            };

            if (kind == "unknown")
                Warn("unsupported-report-object",
                    "Object type " + obj.GetType().FullName + " is preserved only in extensions.",
                    "$.sections[].objects[" + obj.Name + "]");
            return item;
        }

        private static Dictionary<string, object> ExtractData(ReportDocument report)
        {
            var tables = new List<Dictionary<string, object>>();
            var fields = new List<Dictionary<string, object>>();
            foreach (Table table in report.Database.Tables)
            {
                var logon = table.LogOnInfo?.ConnectionInfo;
                var tableKind = table.GetType().Name.IndexOf("Command", StringComparison.OrdinalIgnoreCase) >= 0
                    ? "command"
                    : "table";
                tables.Add(new Dictionary<string, object>
                {
                    ["id"] = StableId(table.Name),
                    ["name"] = table.Name,
                    ["kind"] = tableKind,
                    ["database"] = EmptyToNull(logon?.DatabaseName),
                    ["schema"] = EmptyToNull(SafeString(table, "Owner")),
                    ["qualifiedName"] = EmptyToNull(table.Location),
                    ["alias"] = EmptyToNull(SafeString(table, "Name")),
                    ["commandSql"] = tableKind == "command"
                        ? SafeString(table, "CommandText") ?? SafeString(table, "Command")
                        : null,
                    ["connection"] = new Dictionary<string, object>
                    {
                        ["serverName"] = EmptyToNull(logon?.ServerName),
                        ["type"] = EmptyToNull(logon?.Type.ToString())
                    }
                });

                foreach (DatabaseFieldDefinition field in table.Fields)
                {
                    fields.Add(new Dictionary<string, object>
                    {
                        ["id"] = StableId(table.Name + "." + field.Name),
                        ["name"] = field.Name,
                        ["table"] = table.Name,
                        ["physicalName"] = field.Name,
                        ["dataType"] = field.ValueType.ToString()
                    });
                }
            }

            return new Dictionary<string, object>
            {
                ["tables"] = tables,
                ["links"] = ExtractLinks(report),
                ["fields"] = fields,
                ["formulas"] = ExtractFormulaFields(report),
                ["parameters"] = ExtractParameters(report),
                ["groups"] = ExtractGroups(report),
                ["sorts"] = ExtractCollection(report.DataDefinition.SortFields),
                ["summaries"] = ExtractCollection(report.DataDefinition.SummaryFields),
                ["runningTotals"] = ExtractCollection(report.DataDefinition.RunningTotalFields),
                ["sqlExpressions"] = ExtractCollection(report.DataDefinition.SQLExpressionFields)
            };
        }

        private static List<Dictionary<string, object>> ExtractFormulaFields(ReportDocument report)
        {
            var result = new List<Dictionary<string, object>>();
            foreach (FormulaFieldDefinition formula in report.DataDefinition.FormulaFields)
            {
                result.Add(new Dictionary<string, object>
                {
                    ["name"] = formula.Name,
                    ["text"] = formula.Text ?? "",
                    ["syntax"] = SafeString(formula, "Syntax")?.ToLowerInvariant() ?? "crystal",
                    ["valueType"] = formula.ValueType.ToString(),
                    ["evaluationTime"] = DetectEvaluationTime(formula.Text)
                });
            }
            return result;
        }

        private static List<Dictionary<string, object>> ExtractParameters(ReportDocument report)
        {
            var result = new List<Dictionary<string, object>>();
            foreach (ParameterFieldDefinition parameter in report.DataDefinition.ParameterFields)
            {
                result.Add(new Dictionary<string, object>
                {
                    ["name"] = parameter.Name,
                    ["prompt"] = EmptyToNull(parameter.PromptText),
                    ["dataType"] = parameter.ValueType.ToString(),
                    ["allowMultiple"] = Safe(parameter, "EnableAllowMultipleValue"),
                    ["allowNull"] = Safe(parameter, "EnableAllowNullValue"),
                    ["optional"] = Safe(parameter, "IsOptionalPrompt"),
                    ["defaultValues"] = Values(parameter.DefaultValues)
                });
            }
            return result;
        }

        private static List<Dictionary<string, object>> ExtractGroups(ReportDocument report)
        {
            var result = new List<Dictionary<string, object>>();
            var index = 0;
            foreach (Group group in report.DataDefinition.Groups)
            {
                result.Add(new Dictionary<string, object>
                {
                    ["name"] = "Group " + index++,
                    ["conditionField"] = SafeString(group, "ConditionField.FormulaName") ??
                                         SafeString(group, "ConditionField.Name") ?? "",
                    ["sortDirection"] = SafeString(group, "GroupOptions.SortDirection"),
                    ["repeatHeader"] = Safe(group, "GroupOptions.RepeatGroupHeader"),
                    ["keepTogether"] = Safe(group, "GroupOptions.KeepGroupTogether")
                });
            }
            return result;
        }

        private static List<Dictionary<string, object>> ExtractLinks(ReportDocument report)
        {
            var links = new List<Dictionary<string, object>>();
            try
            {
                var client = Safe(report, "ReportClientDocument");
                var dbController = Safe(client, "DatabaseController");
                var tableLinks = Enumerate(Safe(dbController, "Database.TableLinks") ??
                                           Safe(dbController, "TableLinks"));
                foreach (var link in tableLinks)
                {
                    links.Add(new Dictionary<string, object>
                    {
                        ["leftTable"] = SafeString(link, "SourceTableAlias") ??
                                        SafeString(link, "SourceTable.Name") ?? "",
                        ["leftFields"] = Names(Safe(link, "SourceFields")),
                        ["rightTable"] = SafeString(link, "TargetTableAlias") ??
                                         SafeString(link, "TargetTable.Name") ?? "",
                        ["rightFields"] = Names(Safe(link, "TargetFields")),
                        ["joinType"] = SafeString(link, "JoinType"),
                        ["cardinality"] = SafeString(link, "JoinCardinality")
                    });
                }
            }
            catch (Exception ex)
            {
                Warn("table-links-unavailable", ex.Message, "$.data.links");
            }
            return links;
        }

        private static List<Dictionary<string, object>> ExtractSubreports(
            ReportDocument report, string parentPath)
        {
            var result = new List<Dictionary<string, object>>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Section section in report.ReportDefinition.Sections)
            foreach (ReportObject obj in section.ReportObjects)
            {
                if (!(obj is SubreportObject sub) || !seen.Add(sub.SubreportName)) continue;
                try
                {
                    using (var child = report.OpenSubreport(sub.SubreportName))
                    {
                        result.Add(ExtractReport(
                            child, parentPath + "#" + sub.SubreportName, false));
                    }
                }
                catch (Exception ex)
                {
                    Warn("subreport-extraction-failed", ex.Message,
                        "$.subreports[" + sub.SubreportName + "]");
                }
            }
            return result;
        }

        private static void ApplyDatabaseLogon(ReportDocument report)
        {
            var server = Environment.GetEnvironmentVariable("CRYSTAL_DB_SERVER");
            var database = Environment.GetEnvironmentVariable("CRYSTAL_DB_DATABASE");
            var user = Environment.GetEnvironmentVariable("CRYSTAL_DB_USER");
            var password = Environment.GetEnvironmentVariable("CRYSTAL_DB_PASSWORD");
            var integrated = string.Equals(
                Environment.GetEnvironmentVariable("CRYSTAL_DB_INTEGRATED_SECURITY"),
                "true", StringComparison.OrdinalIgnoreCase);
            if (server == null && database == null && user == null && password == null) return;

            foreach (Table table in report.Database.Tables)
            {
                var info = table.LogOnInfo;
                if (server != null) info.ConnectionInfo.ServerName = server;
                if (database != null) info.ConnectionInfo.DatabaseName = database;
                if (user != null) info.ConnectionInfo.UserID = user;
                if (password != null) info.ConnectionInfo.Password = password;
                info.ConnectionInfo.IntegratedSecurity = integrated;
                table.ApplyLogOnInfo(info);
            }
        }

        private static void ApplyParameters(ReportDocument report, IReadOnlyList<string> args)
        {
            for (var i = 0; i < args.Count - 1; i++)
            {
                if (args[i] != "--parameter") continue;
                var pair = args[i + 1].Split(new[] { '=' }, 2);
                if (pair.Length != 2) throw new ArgumentException(
                    "--parameter must be Name=Value, got: " + args[i + 1]);
                report.SetParameterValue(pair[0], pair[1]);
            }
        }

        private static Dictionary<string, object> ExtractFormat(ReportObject obj)
        {
            var font = Safe(obj, "Font");
            return new Dictionary<string, object>
            {
                ["fontFamily"] = SafeString(font, "Name"),
                ["fontSizePoints"] = Safe(font, "Size"),
                ["bold"] = Safe(font, "Bold"),
                ["italic"] = Safe(font, "Italic"),
                ["underline"] = Safe(font, "Underline"),
                ["foregroundColor"] = ColorHex(Safe(obj, "Color")),
                ["backgroundColor"] = ColorHex(Safe(obj, "BackColor")),
                ["horizontalAlign"] = SafeString(obj, "ObjectFormat.HorizontalAlignment"),
                ["verticalAlign"] = SafeString(obj, "ObjectFormat.VerticalAlignment"),
                ["numberFormat"] = SafeString(obj, "ObjectFormat.NumericFormat"),
                ["dateFormat"] = SafeString(obj, "ObjectFormat.DateTimeFormat"),
                ["canGrow"] = Safe(obj, "ObjectFormat.EnableCanGrow"),
                ["suppress"] = Safe(obj, "ObjectFormat.EnableSuppress")
            };
        }

        private static Dictionary<string, object> ExtractConditionFormulas(ReportObject obj)
        {
            var result = new Dictionary<string, object>();
            var conditions = Safe(obj, "ObjectFormat.ConditionFormulas");
            if (conditions == null) return result;
            foreach (var name in new[]
            {
                "EnableSuppress", "Color", "BackColor", "FontColor", "FontBold",
                "FontItalic", "FontUnderline", "GraphicLocation"
            })
            {
                var text = FormulaText(conditions, null, name);
                if (!string.IsNullOrWhiteSpace(text)) result[name] = text;
            }
            return result;
        }

        private static object ExtractImage(ReportObject obj)
        {
            if (!(obj is PictureObject)) return null;
            return new Dictionary<string, object>
            {
                ["mimeType"] = null,
                ["dataBase64"] = null,
                ["sourcePath"] = SafeString(obj, "GraphicLocation"),
                ["sourceField"] = FormulaText(
                    Safe(obj, "ObjectFormat"), "ConditionFormulas", "GraphicLocation")
            };
        }

        private static Dictionary<string, object> ExtractObjectExtensions(ReportObject obj)
        {
            return new Dictionary<string, object>
            {
                ["runtimeType"] = obj.GetType().FullName,
                ["objectKind"] = obj.Kind.ToString(),
                ["tooltip"] = SafeString(obj, "ObjectFormat.ToolTipText"),
                ["hyperlink"] = SafeString(obj, "ObjectFormat.HyperlinkText")
            };
        }

        private static List<Dictionary<string, object>> ExtractCollection(object collection)
        {
            var result = new List<Dictionary<string, object>>();
            foreach (var item in Enumerate(collection))
            {
                result.Add(new Dictionary<string, object>
                {
                    ["name"] = SafeString(item, "Name") ?? item.ToString(),
                    ["field"] = SafeString(item, "DataSource.FormulaName") ??
                                SafeString(item, "DataSource.Name"),
                    ["operation"] = SafeString(item, "Operation"),
                    ["group"] = SafeString(item, "Group.ConditionField.FormulaName"),
                    ["resetCondition"] = SafeString(item, "ResetCondition"),
                    ["evaluateCondition"] = SafeString(item, "EvaluateCondition")
                });
            }
            return result;
        }

        private static List<object> Values(IEnumerable values)
        {
            var result = new List<object>();
            if (values == null) return result;
            foreach (var value in values)
                result.Add(Safe(value, "Value") ?? value?.ToString());
            return result;
        }

        private static string FieldReference(FieldObject field)
        {
            return SafeString(field, "DataSource.FormulaName") ??
                   SafeString(field, "DataSource.Name") ??
                   SafeString(field, "FieldFormat.FieldName");
        }

        private static string ObjectKind(ReportObject obj)
        {
            if (obj is TextObject) return "text";
            if (obj is FieldObject) return "field";
            if (obj is PictureObject) return "picture";
            if (obj is LineObject) return "line";
            if (obj is BoxObject) return "box";
            if (obj is ChartObject) return "chart";
            if (obj is CrossTabObject) return "crosstab";
            if (obj is SubreportObject) return "subreport";
            return "unknown";
        }

        private static string SectionKind(string name)
        {
            var n = (name ?? "").ToLowerInvariant().Replace(" ", "");
            if (n.StartsWith("reportheader") || n.StartsWith("rh")) return "report-header";
            if (n.StartsWith("pageheader") || n.StartsWith("ph")) return "page-header";
            if (n.StartsWith("groupheader") || n.StartsWith("gh")) return "group-header";
            if (n.StartsWith("detail") || n.StartsWith("d")) return "details";
            if (n.StartsWith("groupfooter") || n.StartsWith("gf")) return "group-footer";
            if (n.StartsWith("pagefooter") || n.StartsWith("pf")) return "page-footer";
            if (n.StartsWith("reportfooter") || n.StartsWith("rf")) return "report-footer";
            return "unknown";
        }

        private static object GroupIndex(string name)
        {
            var digits = new string((name ?? "").Where(char.IsDigit).ToArray());
            return int.TryParse(digits, out var index) ? (object)Math.Max(0, index - 1) : null;
        }

        private static string DetectEvaluationTime(string formula)
        {
            var f = formula ?? "";
            if (f.IndexOf("WhilePrintingRecords", StringComparison.OrdinalIgnoreCase) >= 0)
                return "while-printing-records";
            if (f.IndexOf("WhileReadingRecords", StringComparison.OrdinalIgnoreCase) >= 0)
                return "while-reading-records";
            return "default";
        }

        private static string FormulaText(object root, string intermediate, string property)
        {
            try
            {
                var target = string.IsNullOrEmpty(intermediate) ? root : Safe(root, intermediate);
                var formula = Safe(target, property);
                return SafeString(formula, "Text") ?? EmptyToNull(formula?.ToString());
            }
            catch
            {
                return null;
            }
        }

        private static object Safe(object root, string path)
        {
            if (root == null || string.IsNullOrWhiteSpace(path)) return root;
            object current = root;
            foreach (var part in path.Split('.'))
            {
                if (current == null) return null;
                var type = current.GetType();
                var property = type.GetProperty(part,
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                if (property != null)
                {
                    current = property.GetValue(current, null);
                    continue;
                }
                var field = type.GetField(part,
                    BindingFlags.Public | BindingFlags.Instance | BindingFlags.IgnoreCase);
                if (field == null) return null;
                current = field.GetValue(current);
            }
            return current;
        }

        private static string SafeString(object root, string path)
        {
            var value = Safe(root, path);
            return EmptyToNull(value?.ToString());
        }

        private static long SafeLong(object root, string path)
        {
            var value = Safe(root, path);
            if (value == null) return 0;
            try { return Convert.ToInt64(value, CultureInfo.InvariantCulture); }
            catch { return 0; }
        }

        private static IEnumerable<object> Enumerate(object value)
        {
            if (!(value is IEnumerable enumerable)) yield break;
            foreach (var item in enumerable) yield return item;
        }

        private static List<string> Names(object value)
        {
            return Enumerate(value)
                .Select(item => SafeString(item, "FormulaName") ??
                                SafeString(item, "Name") ?? item?.ToString())
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .ToList();
        }

        private static string ColorHex(object color)
        {
            if (color == null) return null;
            var r = Safe(color, "R");
            var g = Safe(color, "G");
            var b = Safe(color, "B");
            if (r == null || g == null || b == null) return null;
            return string.Format(CultureInfo.InvariantCulture, "#{0:X2}{1:X2}{2:X2}",
                Convert.ToInt32(r), Convert.ToInt32(g), Convert.ToInt32(b));
        }

        private static string StableId(string value)
        {
            var raw = value ?? "object";
            var safe = new string(raw.ToLowerInvariant()
                .Select(c => char.IsLetterOrDigit(c) ? c : '-').ToArray());
            while (safe.Contains("--")) safe = safe.Replace("--", "-");
            safe = safe.Trim('-');
            return string.IsNullOrEmpty(safe) ? "object" : safe;
        }

        private static string EmptyToNull(string value)
        {
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }

        private static string Sha256(string path)
        {
            if (!File.Exists(path)) return null;
            using (var stream = File.OpenRead(path))
            using (var hash = SHA256.Create())
                return BitConverter.ToString(hash.ComputeHash(stream))
                    .Replace("-", "").ToLowerInvariant();
        }

        private static void Warn(string code, string message, string path)
        {
            Warnings.Add(new Dictionary<string, object>
            {
                ["code"] = code,
                ["message"] = message,
                ["path"] = path
            });
        }
    }
}
