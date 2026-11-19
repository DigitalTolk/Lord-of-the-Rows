use std::io::Write;

use dbs_core::{ColumnMeta, DbError, DbResult, Dialect, ErrorKind, TableTarget, Value};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Json,
    JsonLines,
    SqlInsert,
    Markdown,
    Xml,
    Xlsx,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
    pub format: ExportFormat,
    #[serde(default = "yes")]
    pub header: bool,
    /// Text written for NULL in delimited formats.
    #[serde(default)]
    pub null_text: String,
    /// Neutralise spreadsheet formulas (=, +, -, @, tab, CR prefixes). On by default.
    #[serde(default = "yes")]
    pub formula_guard: bool,
    /// For SqlInsert.
    #[serde(default)]
    pub dialect: Option<Dialect>,
    #[serde(default)]
    pub table: Option<TableTarget>,
    #[serde(default = "default_batch")]
    pub rows_per_insert: usize,
    /// CSV field delimiter (default `,`; TSV always uses a tab).
    #[serde(default)]
    pub delimiter: Option<char>,
    /// CSV record terminator: `"\n"` (default) or `"\r\n"`.
    #[serde(default)]
    pub line_break: Option<String>,
    /// CSV: replace line breaks inside values with a space.
    #[serde(default)]
    pub newlines_to_space: bool,
    /// CSV: quote every field, not only those that need it.
    #[serde(default)]
    pub quote_all: bool,
}

fn yes() -> bool {
    true
}
fn default_batch() -> usize {
    100
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: ExportFormat::Csv,
            header: true,
            null_text: String::new(),
            formula_guard: true,
            dialect: None,
            table: None,
            rows_per_insert: 100,
            delimiter: None,
            line_break: None,
            newlines_to_space: false,
            quote_all: false,
        }
    }
}

fn io(e: std::io::Error) -> DbError {
    DbError::new(ErrorKind::Io, e.to_string())
}

/// OWASP CSV-injection mitigation: prefix risky leading characters with `'`
/// unless the cell is a plain number.
pub fn guard_formula(s: &str) -> std::borrow::Cow<'_, str> {
    let risky = matches!(s.chars().next(), Some('=' | '+' | '-' | '@' | '\t' | '\r'));
    if risky && s.parse::<f64>().is_err() {
        std::borrow::Cow::Owned(format!("'{s}"))
    } else {
        std::borrow::Cow::Borrowed(s)
    }
}

/// Incremental writer: `begin` → many `write_rows` → `finish`.
pub struct Exporter<W: Write> {
    out: W,
    opts: ExportOptions,
    columns: Vec<ColumnMeta>,
    rows_written: u64,
    csv: Option<CsvStyle>,
    xlsx: Option<(rust_xlsxwriter::Workbook, u32)>,
    /// Excel: index of the worksheet being written.
    sheet: usize,
}

impl<W: Write> Exporter<W> {
    pub fn begin(mut out: W, columns: &[ColumnMeta], opts: ExportOptions) -> DbResult<Self> {
        let mut csv = None;
        let mut xlsx = None;
        match opts.format {
            ExportFormat::Csv | ExportFormat::Tsv => {
                let style = CsvStyle::from_options(&opts)?;
                if opts.header {
                    let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
                    out.write_all(&style.bytes(&[names])?).map_err(io)?;
                }
                csv = Some(style);
            }
            ExportFormat::Json => out.write_all(b"[\n").map_err(io)?,
            ExportFormat::Markdown => {
                let names: Vec<String> = columns.iter().map(|c| md_escape(&c.name)).collect();
                writeln!(out, "| {} |", names.join(" | ")).map_err(io)?;
                writeln!(out, "|{}", " --- |".repeat(columns.len())).map_err(io)?;
            }
            ExportFormat::Xml => {
                out.write_all(b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rows>\n").map_err(io)?;
            }
            ExportFormat::Xlsx => {
                let mut wb = rust_xlsxwriter::Workbook::new();
                let ws = wb.add_worksheet_with_constant_memory().map_err(xl)?;
                if opts.header {
                    let bold = rust_xlsxwriter::Format::new().set_bold();
                    for (i, c) in columns.iter().enumerate() {
                        ws.write_string_with_format(0, i as u16, &c.name, &bold).map_err(xl)?;
                    }
                }
                xlsx = Some((wb, if opts.header { 1 } else { 0 }));
            }
            ExportFormat::SqlInsert => {
                if opts.table.is_none() {
                    return Err(DbError::invalid("SQL export requires a target table name"));
                }
            }
            ExportFormat::JsonLines => {}
        }
        Ok(Self { out, opts, columns: columns.to_vec(), rows_written: 0, csv, xlsx, sheet: 0 })
    }

    fn cell_text<'a>(&self, v: &'a Value) -> std::borrow::Cow<'a, str> {
        match v.to_plain() {
            None => std::borrow::Cow::Owned(self.opts.null_text.clone()),
            Some(s) => {
                if self.opts.formula_guard && matches!(v, Value::Text(_) | Value::Other { .. } | Value::Json(_)) {
                    std::borrow::Cow::Owned(guard_formula(&s).into_owned())
                } else {
                    std::borrow::Cow::Owned(s)
                }
            }
        }
    }

    pub fn write_rows(&mut self, rows: &[Vec<Value>]) -> DbResult<()> {
        match self.opts.format {
            ExportFormat::Csv | ExportFormat::Tsv => {
                let flat = self.opts.newlines_to_space;
                let cell = |v: &Value| {
                    let s = self.cell_text(v).into_owned();
                    if flat && s.contains(['\n', '\r']) {
                        s.replace("\r\n", " ").replace(['\n', '\r'], " ")
                    } else {
                        s
                    }
                };
                let recs: Vec<Vec<String>> = rows.iter().map(|r| r.iter().map(cell).collect()).collect();
                let bytes = self.csv.as_ref().expect("csv style").bytes(&recs)?;
                self.out.write_all(&bytes).map_err(io)?;
            }
            ExportFormat::Json | ExportFormat::JsonLines => {
                for r in rows {
                    let obj: serde_json::Map<String, serde_json::Value> = self.columns.iter().zip(r).map(|(c, v)| (c.name.clone(), to_json(v))).collect();
                    let s = serde_json::to_string(&obj).map_err(|e| DbError::internal(e.to_string()))?;
                    if self.opts.format == ExportFormat::Json {
                        if self.rows_written > 0 {
                            self.out.write_all(b",\n").map_err(io)?;
                        }
                        self.out.write_all(b"  ").map_err(io)?;
                    }
                    self.out.write_all(s.as_bytes()).map_err(io)?;
                    if self.opts.format == ExportFormat::JsonLines {
                        self.out.write_all(b"\n").map_err(io)?;
                    }
                    self.rows_written += 1;
                }
                return Ok(());
            }
            ExportFormat::Markdown => {
                for r in rows {
                    let cells: Vec<String> = r.iter().map(|v| md_escape(&v.to_plain().unwrap_or_else(|| "NULL".into()))).collect();
                    writeln!(self.out, "| {} |", cells.join(" | ")).map_err(io)?;
                }
            }
            ExportFormat::Xml => {
                for r in rows {
                    self.out.write_all(b"  <row>").map_err(io)?;
                    for (c, v) in self.columns.iter().zip(r) {
                        let tag = xml_name(&c.name);
                        match v.to_plain() {
                            None => write!(self.out, "<{tag} null=\"true\"/>").map_err(io)?,
                            Some(s) => write!(self.out, "<{tag}>{}</{tag}>", xml_escape(&s)).map_err(io)?,
                        }
                    }
                    self.out.write_all(b"</row>\n").map_err(io)?;
                }
            }
            ExportFormat::SqlInsert => {
                let d = self.opts.dialect.unwrap_or(Dialect::Generic);
                let t = d.qualified(self.opts.table.as_ref().unwrap())?;
                let cols = self.columns.iter().map(|c| d.quote_ident(&c.name)).collect::<DbResult<Vec<_>>>()?.join(", ");
                for chunk in rows.chunks(self.opts.rows_per_insert.max(1)) {
                    let vals: Vec<String> = chunk.iter().map(|r| format!("({})", r.iter().map(|v| d.literal(v)).collect::<Vec<_>>().join(", "))).collect();
                    writeln!(self.out, "INSERT INTO {t} ({cols}) VALUES\n  {};", vals.join(",\n  ")).map_err(io)?;
                }
            }
            ExportFormat::Xlsx => {
                let guard = self.opts.formula_guard;
                let (wb, row) = self.xlsx.as_mut().unwrap();
                let ws = wb.worksheet_from_index(self.sheet).map_err(xl)?;
                for r in rows {
                    if *row >= 1_048_576 {
                        return Err(DbError::invalid("XLSX is limited to 1,048,576 rows; use CSV for larger exports"));
                    }
                    for (i, v) in r.iter().enumerate() {
                        let col = i as u16;
                        match v {
                            Value::Null => {}
                            Value::Int(n) => {
                                ws.write_number(*row, col, *n as f64).map_err(xl)?;
                            }
                            Value::Float(f) => {
                                ws.write_number(*row, col, *f).map_err(xl)?;
                            }
                            Value::Bool(b) => {
                                ws.write_boolean(*row, col, *b).map_err(xl)?;
                            }
                            other => {
                                // Strings are written as strings, never as formulas.
                                let s = other.to_plain().unwrap_or_default();
                                let s = if guard { guard_formula(&s).into_owned() } else { s };
                                let s: String = s.chars().take(32_767).collect();
                                ws.write_string(*row, col, &s).map_err(xl)?;
                            }
                        }
                    }
                    *row += 1;
                }
            }
        }
        self.rows_written += rows.len() as u64;
        Ok(())
    }

    /// Excel only: name the worksheet being written (Excel's rules: at most 31 characters,
    /// none of `[]:*?/\\`, unique in the workbook — the name is adjusted to fit).
    pub fn name_sheet(&mut self, name: &str) -> DbResult<()> {
        let Some((wb, _)) = self.xlsx.as_mut() else { return Ok(()) };
        let taken: Vec<String> = (0..self.sheet).filter_map(|i| wb.worksheet_from_index(i).ok().map(|w| w.name())).collect();
        let name = sheet_name(name, &taken);
        wb.worksheet_from_index(self.sheet).map_err(xl)?.set_name(name).map_err(xl)?;
        Ok(())
    }

    /// Excel only: continue in a new worksheet (named `name`) with its own columns, so several
    /// tables go into one workbook.
    pub fn next_sheet(&mut self, name: &str, columns: &[ColumnMeta]) -> DbResult<()> {
        let header = self.opts.header;
        let Some((wb, row)) = self.xlsx.as_mut() else { return Err(DbError::invalid("only Excel exports have sheets")) };
        let ws = wb.add_worksheet_with_constant_memory().map_err(xl)?;
        if header {
            let bold = rust_xlsxwriter::Format::new().set_bold();
            for (i, c) in columns.iter().enumerate() {
                ws.write_string_with_format(0, i as u16, &c.name, &bold).map_err(xl)?;
            }
        }
        *row = u32::from(header);
        self.sheet += 1;
        self.columns = columns.to_vec();
        self.name_sheet(name)
    }

    /// Close this table's output (as `finish`) and hand the writer back, so the next table can
    /// continue in the same file (SQL scripts, JSON Lines).
    pub fn into_inner(mut self) -> DbResult<W> {
        self.close()?;
        Ok(self.out)
    }

    pub fn finish(mut self) -> DbResult<u64> {
        self.close()?;
        Ok(self.rows_written)
    }

    fn close(&mut self) -> DbResult<()> {
        match self.opts.format {
            ExportFormat::Json => self.out.write_all(b"\n]\n").map_err(io)?,
            ExportFormat::Xml => self.out.write_all(b"</rows>\n").map_err(io)?,
            ExportFormat::Xlsx => {
                let (mut wb, _) = self.xlsx.take().unwrap();
                let buf = wb.save_to_buffer().map_err(xl)?;
                self.out.write_all(&buf).map_err(io)?;
            }
            _ => {}
        }
        self.out.flush().map_err(io)?;
        Ok(())
    }
}

/// Delimiter, record terminator and quoting for CSV/TSV output.
struct CsvStyle {
    delim: u8,
    crlf: bool,
    quote_all: bool,
}

impl CsvStyle {
    fn from_options(o: &ExportOptions) -> DbResult<Self> {
        let delim = if o.format == ExportFormat::Tsv {
            b'\t'
        } else {
            match o.delimiter {
                None => b',',
                Some(c) if c.is_ascii() && !matches!(c, '"' | '\n' | '\r') => c as u8,
                Some(c) => return Err(DbError::invalid(format!("{c:?} can't be used as a CSV delimiter"))),
            }
        };
        let crlf = match o.line_break.as_deref() {
            None | Some("\n") => false,
            Some("\r\n") => true,
            Some(other) => return Err(DbError::invalid(format!("unsupported line break {other:?}"))),
        };
        Ok(Self { delim, crlf, quote_all: o.quote_all })
    }

    fn bytes(&self, recs: &[Vec<String>]) -> DbResult<Vec<u8>> {
        let mut w = csv::WriterBuilder::new()
            .delimiter(self.delim)
            .terminator(if self.crlf { csv::Terminator::CRLF } else { csv::Terminator::Any(b'\n') })
            .quote_style(if self.quote_all { csv::QuoteStyle::Always } else { csv::QuoteStyle::Necessary })
            .has_headers(false)
            .from_writer(Vec::new());
        for r in recs {
            w.write_record(r).map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))?;
        }
        w.into_inner().map_err(|e| DbError::new(ErrorKind::Io, e.to_string()))
    }
}

/// A valid, unique Excel worksheet name for `want`.
fn sheet_name(want: &str, taken: &[String]) -> String {
    let clean: String = want.chars().map(|c| if matches!(c, '[' | ']' | ':' | '*' | '?' | '/' | '\\') { '_' } else { c }).collect();
    let clean = clean.trim_matches('\'').to_string();
    let base: String = if clean.is_empty() { "Sheet".into() } else { clean.chars().take(31).collect() };
    let free = |n: &str| !taken.iter().any(|t| t.eq_ignore_ascii_case(n));
    if free(&base) {
        return base;
    }
    (2..)
        .map(|i| {
            let sfx = format!(" ({i})");
            format!("{}{sfx}", base.chars().take(31 - sfx.len()).collect::<String>())
        })
        .find(|n| free(n))
        .unwrap()
}

fn xl(e: rust_xlsxwriter::XlsxError) -> DbError {
    DbError::new(ErrorKind::Io, e.to_string())
}

pub fn to_json(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Null => J::Null,
        Value::Bool(b) => J::Bool(*b),
        Value::Int(i) => J::from(*i),
        Value::Float(f) => serde_json::Number::from_f64(*f).map(J::Number).unwrap_or(J::Null),
        Value::Json(j) => j.clone(),
        Value::Array(a) => J::Array(a.iter().map(to_json).collect()),
        // BigInt/Decimal stay strings to preserve precision.
        other => J::String(other.to_plain().unwrap_or_default()),
    }
}

fn md_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('|', "\\|").replace('\n', "<br>").replace('\r', "")
}

fn xml_escape(s: &str) -> String {
    s.chars()
        .filter(|c| matches!(*c, '\t' | '\n' | '\r') || !c.is_control())
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn xml_name(s: &str) -> String {
    let mut n: String = s.chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
    if n.is_empty() || n.chars().next().is_some_and(|c| c.is_ascii_digit() || c == '-') {
        n.insert(0, '_');
    }
    n
}

/// Convenience: export a whole in-memory result (selection / clipboard).
pub fn export_to_string(columns: &[ColumnMeta], rows: &[Vec<Value>], opts: ExportOptions) -> DbResult<String> {
    if opts.format == ExportFormat::Xlsx {
        return Err(DbError::invalid("XLSX cannot be copied as text"));
    }
    let mut buf = Vec::new();
    let mut e = Exporter::begin(&mut buf, columns, opts)?;
    e.write_rows(rows)?;
    e.finish()?;
    String::from_utf8(buf).map_err(|e| DbError::internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<ColumnMeta> {
        ["id", "name"].iter().map(|n| ColumnMeta { name: n.to_string(), type_name: String::new(), nullable: None, table: None, ..Default::default() }).collect()
    }
    fn rows() -> Vec<Vec<Value>> {
        vec![
            vec![Value::Int(1), Value::Text("=HYPERLINK(\"http://evil\")".into())],
            vec![Value::Int(-2), Value::Null],
            vec![Value::BigInt("9007199254740993".into()), Value::Text("a,\"b\"\nc".into())],
        ]
    }

    #[test]
    fn csv_guards_formulas_and_quotes() {
        let s = export_to_string(&cols(), &rows(), ExportOptions::default()).unwrap();
        assert!(s.starts_with("id,name\n"));
        assert!(s.contains("'=HYPERLINK"), "{s}");
        assert!(s.contains("-2,"), "negative numbers untouched: {s}");
        assert!(s.contains("\"a,\"\"b\"\"\nc\""));
    }

    #[test]
    fn guard_rules() {
        assert_eq!(guard_formula("=1+1"), "'=1+1");
        assert_eq!(guard_formula("-5"), "-5");
        assert_eq!(guard_formula("-cmd"), "'-cmd");
        assert_eq!(guard_formula("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(guard_formula("plain"), "plain");
    }

    #[test]
    fn json_keeps_bigints_as_strings() {
        let s = export_to_string(&cols(), &rows(), ExportOptions { format: ExportFormat::Json, ..Default::default() }).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v[2]["id"], serde_json::json!("9007199254740993"));
        assert_eq!(v[1]["name"], serde_json::Value::Null);
    }

    #[test]
    fn jsonl_and_markdown() {
        let s = export_to_string(&cols(), &rows(), ExportOptions { format: ExportFormat::JsonLines, ..Default::default() }).unwrap();
        assert_eq!(s.lines().count(), 3);
        let s = export_to_string(&cols(), &rows(), ExportOptions { format: ExportFormat::Markdown, ..Default::default() }).unwrap();
        assert!(s.contains("| id | name |"));
        assert!(s.contains("<br>"));
    }

    #[test]
    fn csv_options_delimiter_line_break_quoting_newlines() {
        let o = ExportOptions {
            delimiter: Some(';'),
            line_break: Some("\r\n".into()),
            newlines_to_space: true,
            null_text: "NULL".into(),
            formula_guard: false,
            ..Default::default()
        };
        let s = export_to_string(&cols(), &rows(), o).unwrap();
        assert_eq!(s, "id;name\r\n1;\"=HYPERLINK(\"\"http://evil\"\")\"\r\n-2;NULL\r\n9007199254740993;\"a,\"\"b\"\" c\"\r\n");
        let all = export_to_string(&cols(), &rows()[1..2], ExportOptions { quote_all: true, ..Default::default() }).unwrap();
        assert_eq!(all, "\"id\",\"name\"\n\"-2\",\"\"\n");
        assert!(export_to_string(&cols(), &rows(), ExportOptions { delimiter: Some('"'), ..Default::default() }).is_err());
        assert!(export_to_string(&cols(), &rows(), ExportOptions { line_break: Some("\t".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn excel_sheet_per_table() {
        let mut buf = Vec::new();
        let mut e = Exporter::begin(&mut buf, &cols(), ExportOptions { format: ExportFormat::Xlsx, ..Default::default() }).unwrap();
        e.name_sheet("orders").unwrap();
        e.write_rows(&rows()).unwrap();
        e.next_sheet("ORDERS", &cols()[..1]).unwrap();
        e.write_rows(&[vec![Value::Int(7)]]).unwrap();
        assert_eq!(e.finish().unwrap(), 4);
        assert!(buf.starts_with(b"PK"));
        assert_eq!(sheet_name("a/b:c", &[]), "a_b_c");
        assert_eq!(sheet_name("orders", &["Orders".into()]), "orders (2)");
        assert_eq!(sheet_name(&"x".repeat(40), &["x".repeat(31)]).chars().count(), 31);
        assert!(Exporter::begin(Vec::new(), &cols(), ExportOptions::default()).unwrap().next_sheet("x", &cols()).is_err());
    }

    #[test]
    fn sql_insert_escapes() {
        let o = ExportOptions {
            format: ExportFormat::SqlInsert,
            dialect: Some(Dialect::Postgres),
            table: Some(TableTarget { schema: Some("public".into()), table: "t".into() }),
            rows_per_insert: 2,
            ..Default::default()
        };
        let r = vec![vec![Value::Int(1), Value::Text("O'Brien'); DROP TABLE x; --".into())]];
        let s = export_to_string(&cols(), &r, o).unwrap();
        assert_eq!(s, "INSERT INTO \"public\".\"t\" (\"id\", \"name\") VALUES\n  (1, 'O''Brien''); DROP TABLE x; --');\n");
    }

    #[test]
    fn xml_escapes() {
        let r = vec![vec![Value::Int(1), Value::Text("<a>&\u{1}".into())]];
        let s = export_to_string(&cols(), &r, ExportOptions { format: ExportFormat::Xml, ..Default::default() }).unwrap();
        assert!(s.contains("<name>&lt;a&gt;&amp;</name>"), "{s}");
    }

    #[test]
    fn xlsx_produces_zip() {
        let mut buf = Vec::new();
        let mut e = Exporter::begin(&mut buf, &cols(), ExportOptions { format: ExportFormat::Xlsx, ..Default::default() }).unwrap();
        e.write_rows(&rows()).unwrap();
        e.finish().unwrap();
        assert_eq!(&buf[..2], b"PK");
    }
}
