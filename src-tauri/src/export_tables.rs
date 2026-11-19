//! Export one or many tables: one file per table into a chosen folder, or everything into one
//! file (SQL script, Excel workbook with a sheet per table). Progress is streamed per table and
//! the export can be cancelled (`cancel_query` with the export id).

use std::io::Write;
use std::path::{Path, PathBuf};

use dbs_audit::{Category, Outcome};
use dbs_core::*;
use dbs_io::{ExportFormat, ExportOptions, Exporter};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::commands::{audit, check_filters, project_rows};
use crate::state::{AppState, FileGrant, GrantMode, APP_VERSION};

type R<T> = Result<T, DbError>;

const PAGE: usize = 5000;

#[derive(Debug, Deserialize)]
pub struct ExportTablesReq {
    pub export_id: String,
    pub session_id: String,
    pub tables: Vec<TableTarget>,
    /// A save-file grant (`one_file`) or a folder grant from `pick_folder`.
    pub grant: String,
    pub options: ExportOptions,
    /// Everything in one file (SQL, Excel, JSON Lines); otherwise one file per table.
    #[serde(default)]
    pub one_file: bool,
    /// File names (one per table, same order) when writing into a folder.
    #[serde(default)]
    pub file_names: Vec<String>,
    #[serde(default)]
    pub gzip: bool,
    /// Replace files that already exist in the folder.
    #[serde(default)]
    pub overwrite: bool,
    /// Only rows matching these (applies when exporting a single table).
    #[serde(default)]
    pub filters: Vec<FilterCondition>,
    /// SQL: what to write for each table.
    #[serde(default)]
    pub sql: SqlParts,
}

#[derive(Debug, Deserialize)]
pub struct SqlParts {
    #[serde(default)]
    pub drop: bool,
    #[serde(default)]
    pub structure: bool,
    #[serde(default = "yes")]
    pub data: bool,
}

impl Default for SqlParts {
    fn default() -> Self {
        Self { drop: false, structure: false, data: true }
    }
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExportProgress {
    /// Rows written so far for table `index`.
    Rows { index: usize, rows: u64 },
    /// Table `index` is complete.
    TableDone { index: usize, rows: u64, path: String },
}

#[derive(Debug, Serialize)]
pub struct ExportTablesReport {
    pub tables: usize,
    pub rows: u64,
    pub paths: Vec<String>,
}

fn io_err(e: std::io::Error) -> DbError {
    DbError::new(ErrorKind::Io, e.to_string())
}

/// Native "choose folder" dialog; the webview gets a grant to write files inside it.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle, st: State<'_, AppState>) -> R<Option<crate::commands::PickedFile>> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let Some(fp) = rx.await.map_err(|_| DbError::internal("dialog closed"))? else { return Ok(None) };
    let path = fp.into_path().map_err(|_| DbError::invalid("unsupported folder location"))?;
    let grant = Uuid::new_v4().to_string();
    let picked = crate::commands::PickedFile::new(&grant, &path);
    st.grants.lock().unwrap().insert(grant, FileGrant { path, mode: GrantMode::Folder });
    Ok(Some(picked))
}

/// A plain file name (no folders, no `..`, nothing hidden) for a file inside the granted folder.
pub(crate) fn safe_file_name(name: &str) -> R<String> {
    let n = name.trim();
    let bad = n.is_empty() || n.starts_with('.') || n.len() > 200 || n.chars().any(|c| matches!(c, '/' | '\\' | ':' | '\0') || c.is_control());
    if bad {
        return Err(DbError::invalid(format!("{name:?} is not a valid file name")));
    }
    Ok(n.to_string())
}

fn create(path: &Path, overwrite: bool, gzip: bool) -> R<Box<dyn Write + Send>> {
    let f = if overwrite { std::fs::File::create(path) } else { std::fs::OpenOptions::new().write(true).create_new(true).open(path) };
    let f =
        f.map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { DbError::invalid(format!("{} already exists", path.display())) } else { io_err(e) })?;
    let w = std::io::BufWriter::new(f);
    Ok(if gzip { Box::new(flate2::write::GzEncoder::new(w, flate2::Compression::default())) } else { Box::new(w) })
}

/// Where each table goes: its own file in the folder, or all into the one granted file.
fn plan(req: &ExportTablesReq, g: &FileGrant) -> R<Vec<PathBuf>> {
    if req.one_file {
        if g.mode != GrantMode::Write {
            return Err(DbError::new(ErrorKind::Permission, "file grant does not allow this operation"));
        }
        return Ok(vec![g.path.clone(); req.tables.len()]);
    }
    if g.mode != GrantMode::Folder {
        return Err(DbError::new(ErrorKind::Permission, "folder access was not granted"));
    }
    if req.file_names.len() != req.tables.len() {
        return Err(DbError::invalid("one file name per table is required"));
    }
    let mut seen = std::collections::HashSet::new();
    req.file_names
        .iter()
        .map(|n| {
            let n = safe_file_name(n)?;
            if !seen.insert(n.to_lowercase()) {
                return Err(DbError::invalid(format!("two tables would be written to {n}")));
            }
            Ok(g.path.join(n))
        })
        .collect()
}

#[tauri::command]
pub async fn export_tables(st: State<'_, AppState>, req: ExportTablesReq, on_progress: tauri::ipc::Channel<ExportProgress>) -> R<ExportTablesReport> {
    if req.tables.is_empty() {
        return Err(DbError::invalid("choose at least one table"));
    }
    let s = st.session(&req.session_id)?;
    check_filters(s.conn.dialect(), &req.filters)?;
    let g = st.grants.lock().unwrap().get(&req.grant).cloned().ok_or_else(|| DbError::new(ErrorKind::Permission, "file access was not granted"))?;
    let paths = plan(&req, &g)?;
    let fmt = req.options.format;
    if req.one_file && !matches!(fmt, ExportFormat::SqlInsert | ExportFormat::Xlsx | ExportFormat::JsonLines) && req.tables.len() > 1 {
        return Err(DbError::invalid("this format writes one file per table; choose a folder"));
    }
    if req.gzip && fmt == ExportFormat::Xlsx {
        return Err(DbError::invalid("Excel files are already compressed"));
    }
    let token = CancellationToken::new();
    st.running.lock().unwrap().insert(req.export_id.clone(), token.clone());
    let res = run(&*s.conn, &req, &paths, &token, |p| {
        let _ = on_progress.send(p);
    })
    .await;
    st.running.lock().unwrap().remove(&req.export_id);
    let outcome = if res.is_ok() { Outcome::Success } else { Outcome::Failure };
    audit(&st, Category::Export, outcome, Some(&s.config), |e| {
        e.object = Some(req.tables.iter().map(|t| t.table.as_str()).collect::<Vec<_>>().join(", "));
        if let Ok(r) = &res {
            e.rows_affected = Some(r.rows);
        }
    });
    res
}

async fn run(
    conn: &dyn DatabaseConnection,
    req: &ExportTablesReq,
    paths: &[PathBuf],
    token: &CancellationToken,
    progress: impl Fn(ExportProgress),
) -> R<ExportTablesReport> {
    let d = conn.dialect();
    let mut report = ExportTablesReport { tables: 0, rows: 0, paths: vec![] };
    let mut shared: Option<Box<dyn Write + Send>> = None;
    let mut workbook: Option<Exporter<Box<dyn Write + Send>>> = None;
    for (i, target) in req.tables.iter().enumerate() {
        if token.is_cancelled() {
            return Err(DbError::new(ErrorKind::Cancelled, "export cancelled"));
        }
        let filters = if req.tables.len() == 1 { req.filters.clone() } else { vec![] };
        let desc = conn.describe_table(target).await.ok();
        // Stable paging needs an order: the primary key when there is one.
        let order: Vec<(String, SortDir)> = desc.as_ref().map(|d| d.primary_key.iter().map(|c| (c.clone(), SortDir::Asc)).collect()).unwrap_or_default();
        let first = conn.fetch_table(target, &PageRequest { offset: 0, limit: PAGE as u64, order_by: order.clone(), filters: filters.clone() }).await?;
        let mut opts = req.options.clone();
        opts.table = Some(target.clone());
        opts.dialect = Some(d);
        let path = &paths[i];
        let sql = opts.format == ExportFormat::SqlInsert;

        // Excel into one workbook: one exporter, a sheet per table.
        let into_workbook = req.one_file && opts.format == ExportFormat::Xlsx;
        let mut own: Option<Exporter<Box<dyn Write + Send>>> = None;
        if into_workbook {
            match workbook.as_mut() {
                Some(ex) => ex.next_sheet(&target.table, &first.columns)?,
                None => {
                    let mut ex = Exporter::begin(create(path, true, false)?, &first.columns, opts.clone())?;
                    ex.name_sheet(&target.table)?;
                    workbook = Some(ex);
                }
            }
        } else {
            let mut w: Box<dyn Write + Send> = if req.one_file {
                match shared.take() {
                    Some(w) => w,
                    None => {
                        let mut w = create(path, true, req.gzip)?;
                        if sql {
                            writeln!(w, "-- Exported by Lord of the Rows {APP_VERSION}\n").map_err(io_err)?;
                        }
                        w
                    }
                }
            } else {
                create(path, req.overwrite, req.gzip)?
            };
            if sql {
                let name = d.qualified(target)?;
                writeln!(w, "-- {name}").map_err(io_err)?;
                if req.sql.drop {
                    writeln!(w, "DROP TABLE IF EXISTS {name};").map_err(io_err)?;
                }
                if req.sql.structure {
                    match desc.as_ref().and_then(|d| d.ddl.as_deref()) {
                        Some(ddl) => writeln!(w, "{};", ddl.trim().trim_end_matches(';')).map_err(io_err)?,
                        None => writeln!(w, "-- (structure not available for {name})").map_err(io_err)?,
                    }
                }
            }
            if !sql || req.sql.data {
                own = Some(Exporter::begin(w, &first.columns, opts.clone())?);
            } else {
                writeln!(w).map_err(io_err)?;
                if req.one_file {
                    shared = Some(w);
                } else {
                    w.flush().map_err(io_err)?;
                }
            }
        }

        let mut rows = 0u64;
        if let Some(ex) = own.as_mut().or(workbook.as_mut().filter(|_| into_workbook)) {
            ex.write_rows(&first.rows)?;
            rows = first.rows.len() as u64;
            progress(ExportProgress::Rows { index: i, rows });
            let mut last = first.rows.len();
            while last == PAGE {
                if token.is_cancelled() {
                    return Err(DbError::new(ErrorKind::Cancelled, "export cancelled"));
                }
                let page =
                    conn.fetch_table(target, &PageRequest { offset: rows, limit: PAGE as u64, order_by: order.clone(), filters: filters.clone() }).await?;
                last = page.rows.len();
                ex.write_rows(&project_rows(&first.columns, page.columns, page.rows))?;
                rows += last as u64;
                progress(ExportProgress::Rows { index: i, rows });
            }
        }
        if let Some(ex) = own {
            // One file: keep writing to it after this table; otherwise close the table's file.
            if req.one_file {
                shared = Some(ex.into_inner()?);
            } else {
                ex.finish()?;
            }
        }
        report.tables += 1;
        report.rows += rows;
        let shown = path.to_string_lossy().into_owned();
        if !report.paths.contains(&shown) {
            report.paths.push(shown.clone());
        }
        progress(ExportProgress::TableDone { index: i, rows, path: shown });
    }
    if let Some(ex) = workbook {
        ex.finish()?;
    }
    if let Some(mut w) = shared {
        w.flush().map_err(io_err)?;
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against the docker-compose MySQL (DBS_IT): a CSV per table into a folder, one SQL script
    /// with structure and data, and one Excel workbook with a sheet per table.
    #[tokio::test]
    async fn exports_real_tables() {
        if std::env::var("DBS_IT").is_err() {
            eprintln!("SKIPPED: DBS_IT not set");
            return;
        }
        let host = std::env::var("DBS_IT_MYSQL_HOST").unwrap_or("localhost".into());
        let cfg: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": Uuid::new_v4(), "name": "it-export", "engine": "my_sql", "host": host, "database": "dbs_test",
            "username": "dbs_test", "tls": { "mode": "disabled" }, "environment": "testing"
        }))
        .unwrap();
        let conn = dbs_drivers::driver_for(Engine::MySql).unwrap().connect(&cfg, ConnectSecrets { password: Some("dbs_test".into()) }).await.unwrap();
        conn.execute(
            "DROP TABLE IF EXISTS ex_a; DROP TABLE IF EXISTS ex_b; CREATE TABLE ex_a (id INT PRIMARY KEY, note TEXT);
             CREATE TABLE ex_b (k VARCHAR(10) PRIMARY KEY); INSERT INTO ex_a VALUES (1, 'line\nbreak'), (2, NULL); INSERT INTO ex_b VALUES ('x')",
            &ExecOptions::default(),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let tables =
            vec![TableTarget { schema: Some("dbs_test".into()), table: "ex_a".into() }, TableTarget { schema: Some("dbs_test".into()), table: "ex_b".into() }];
        let mut r = req(false, &["ex_a", "ex_b"]);
        r.tables = tables.clone();
        r.options.delimiter = Some(';');
        r.options.newlines_to_space = true;
        r.options.null_text = "NULL".into();
        let paths: Vec<PathBuf> = r.file_names.iter().map(|n| dir.path().join(n)).collect();
        let seen = std::sync::Mutex::new(vec![]);
        let rep = run(&*conn, &r, &paths, &CancellationToken::new(), |p| seen.lock().unwrap().push(p)).await.unwrap();
        assert_eq!((rep.tables, rep.rows), (2, 3));
        assert_eq!(std::fs::read_to_string(&paths[0]).unwrap(), "id;note\n1;line break\n2;NULL\n");
        assert_eq!(std::fs::read_to_string(&paths[1]).unwrap(), "k\nx\n");
        assert!(matches!(seen.lock().unwrap().last(), Some(ExportProgress::TableDone { index: 1, rows: 1, .. })));
        // Existing files are not replaced unless asked.
        assert!(run(&*conn, &r, &paths, &CancellationToken::new(), |_| {}).await.is_err());

        let mut sql = req(true, &["ex_a", "ex_b"]);
        sql.tables = tables.clone();
        sql.options.format = ExportFormat::SqlInsert;
        sql.sql = SqlParts { drop: true, structure: true, data: true };
        let out = dir.path().join("all.sql");
        run(&*conn, &sql, &[out.clone(), out.clone()], &CancellationToken::new(), |_| {}).await.unwrap();
        let text = std::fs::read_to_string(&out).unwrap();
        for want in ["DROP TABLE IF EXISTS `dbs_test`.`ex_a`;", "CREATE TABLE `ex_a`", "INSERT INTO `dbs_test`.`ex_a`", "CREATE TABLE `ex_b`", "('x');"] {
            assert!(text.contains(want), "{want} missing in:\n{text}");
        }

        let mut xl = req(true, &["ex_a", "ex_b"]);
        xl.tables = tables;
        xl.options.format = ExportFormat::Xlsx;
        let book = dir.path().join("all.xlsx");
        run(&*conn, &xl, &[book.clone(), book.clone()], &CancellationToken::new(), |_| {}).await.unwrap();
        assert!(std::fs::read(&book).unwrap().starts_with(b"PK"));

        // Cancelled before it starts: nothing is exported.
        let t = CancellationToken::new();
        t.cancel();
        assert_eq!(run(&*conn, &sql, &[out.clone(), out], &t, |_| {}).await.unwrap_err().kind, ErrorKind::Cancelled);
        conn.execute("DROP TABLE ex_a; DROP TABLE ex_b", &ExecOptions::default(), CancellationToken::new()).await.unwrap();
    }

    #[test]
    fn file_names_stay_inside_the_folder() {
        assert_eq!(safe_file_name(" orders.csv ").unwrap(), "orders.csv");
        for bad in ["", "../x.csv", "a/b.csv", "a\\b.csv", ".hidden", "c:x", "a\nb"] {
            assert!(safe_file_name(bad).is_err(), "{bad:?}");
        }
    }

    fn req(one_file: bool, names: &[&str]) -> ExportTablesReq {
        ExportTablesReq {
            export_id: "e".into(),
            session_id: "s".into(),
            tables: names.iter().map(|n| TableTarget { schema: None, table: n.to_string() }).collect(),
            grant: "g".into(),
            options: ExportOptions::default(),
            one_file,
            file_names: names.iter().map(|n| format!("{n}.csv")).collect(),
            gzip: false,
            overwrite: false,
            filters: vec![],
            sql: SqlParts::default(),
        }
    }

    #[test]
    fn plan_checks_the_grant_and_duplicate_names() {
        let folder = FileGrant { path: PathBuf::from("/tmp/out"), mode: GrantMode::Folder };
        let file = FileGrant { path: PathBuf::from("/tmp/out.sql"), mode: GrantMode::Write };
        assert_eq!(plan(&req(false, &["a", "b"]), &folder).unwrap(), vec![PathBuf::from("/tmp/out/a.csv"), PathBuf::from("/tmp/out/b.csv")]);
        assert!(plan(&req(false, &["a", "A"]), &folder).is_err(), "same name, different case");
        assert!(plan(&req(false, &["a"]), &file).is_err(), "a file grant is not a folder");
        assert!(plan(&req(true, &["a"]), &folder).is_err(), "a folder grant is not a file");
        assert_eq!(plan(&req(true, &["a", "b"]), &file).unwrap().len(), 2);
    }
}
