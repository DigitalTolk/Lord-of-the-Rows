//! What stopping another session does, so Activity can say it before you click.
//!
//! Two actions, with different consequences:
//! * **Cancel query** stops the running statement. The server rolls back that statement
//!   (on transactional tables); the connection and its open transaction stay.
//! * **Kill connection** ends the session. Its whole open transaction is rolled back, and
//!   the application on the other end loses its connection.
//!
//! The assessment combines the running statement (classified like any script), the
//! server's live transaction data and the kind of thread. It is advisory: the backend
//! still refuses to stop system threads and asks for confirmation.

use dbs_core::{Dialect, SessionInfo};
use serde::Serialize;

use crate::{classify_script, Risk};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopSeverity {
    /// Nothing to undo.
    Safe,
    /// Work is rolled back; can take a while and hold locks meanwhile.
    Caution,
    /// Leaves data half-changed, or interrupts a backup.
    Danger,
    /// Must not be stopped from here (server / replication threads).
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopImpact {
    /// A read (or session statement) without uncommitted changes: it just stops.
    NothingToUndo,
    /// Idle, no open transaction.
    Idle,
    /// Idle inside a transaction that changed data: killing discards those changes.
    OpenTransaction,
    /// A running write: the server rolls it back, which can take as long as it ran.
    UndoWrite,
    /// A write on tables without transactions (e.g. MyISAM): rows already changed stay changed.
    PartialWrite,
    /// A schema change (ALTER, CREATE INDEX, DROP…) is rolled back; big tables can stay locked meanwhile.
    SchemaChange,
    /// Cannot tell what it does (procedure call, dynamic SQL, admin command).
    Unknown,
    /// A backup in progress (mysqldump, pg_dump, FLUSH TABLES WITH READ LOCK).
    Backup,
    /// Replication, event scheduler, autovacuum or another server thread.
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StopAssessment {
    pub impact: StopImpact,
    pub severity: StopSeverity,
    /// Killing the connection also rolls back the open transaction's earlier changes.
    pub kill_discards_transaction: bool,
    /// Rows the open transaction has changed so far, when the server reports it.
    pub rows: Option<i64>,
    /// A statement is running (there is something to cancel).
    pub can_cancel: bool,
    /// The connection may be killed from here (not a system thread, not this app's own session).
    pub can_kill: bool,
}

fn is_running(s: &SessionInfo) -> bool {
    let idle_state = s.state.as_deref().is_some_and(|st| st.starts_with("idle"));
    let sleeping = s.command.as_deref() == Some("Sleep");
    s.query.as_deref().is_some_and(|q| !q.trim().is_empty()) && !idle_state && !sleeping
}

/// mysqldump / pg_dump sessions and global read locks taken for backups.
fn is_backup(s: &SessionInfo) -> bool {
    let q = s.query.as_deref().unwrap_or("").trim_start().to_ascii_uppercase();
    let client = s.client.as_deref().unwrap_or("").to_ascii_lowercase();
    q.starts_with("FLUSH TABLES WITH READ LOCK")
        || q.contains("SQL_NO_CACHE */ * FROM")
        || q.starts_with("/*!40100 SET @@SQL_MODE")
        || client.starts_with("pg_dump")
        || client.starts_with("pg_basebackup")
}

fn write_impact(a: &mut StopAssessment, s: &SessionInfo, d: Dialect) {
    // A running InnoDB write always has a transaction; when the server reports
    // transaction data and there is none, the table does not support transactions.
    if d == Dialect::MySql && s.trx_info && !s.in_transaction {
        a.impact = StopImpact::PartialWrite;
        a.severity = StopSeverity::Danger;
    } else {
        a.impact = StopImpact::UndoWrite;
        a.severity = StopSeverity::Caution;
    }
}

/// What stopping `s` would do. `d` is the server's dialect.
pub fn assess_stop(s: &SessionInfo, d: Dialect) -> StopAssessment {
    let running = is_running(s);
    let discards = s.trx_writes;
    let mut a = StopAssessment {
        impact: StopImpact::Idle,
        severity: StopSeverity::Safe,
        kill_discards_transaction: discards,
        rows: s.trx_rows_modified.filter(|n| *n > 0),
        can_cancel: running,
        can_kill: !s.own,
    };
    if s.system {
        a.impact = StopImpact::System;
        a.severity = StopSeverity::Blocked;
        a.can_cancel = false;
        a.can_kill = false;
        return a;
    }
    if is_backup(s) {
        a.impact = StopImpact::Backup;
        a.severity = StopSeverity::Danger;
        return a;
    }
    if !running {
        if discards {
            a.impact = StopImpact::OpenTransaction;
            a.severity = StopSeverity::Caution;
        }
        return a;
    }
    let first = classify_script(s.query.as_deref().unwrap_or(""), d).into_iter().next();
    let (risk, verb) = first.map(|c| (c.risk, c.verb)).unwrap_or((Risk::Unknown, String::new()));
    let dml = matches!(verb.as_str(), "INSERT" | "REPLACE" | "UPSERT" | "MERGE" | "UPDATE" | "DELETE" | "LOAD" | "COPY" | "WITH");
    match risk {
        Risk::Read | Risk::Session => {
            a.impact = StopImpact::NothingToUndo;
            a.severity = if discards { StopSeverity::Caution } else { StopSeverity::Safe };
        }
        Risk::Write => write_impact(&mut a, s, d),
        // DELETE without WHERE etc. are "destructive" writes; DROP / TRUNCATE are schema changes.
        Risk::Destructive if dml => write_impact(&mut a, s, d),
        Risk::Schema | Risk::Destructive => {
            a.impact = StopImpact::SchemaChange;
            a.severity = StopSeverity::Caution;
        }
        Risk::Unknown | Risk::Admin => {
            a.impact = StopImpact::Unknown;
            a.severity = StopSeverity::Caution;
        }
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn running(q: &str) -> SessionInfo {
        SessionInfo {
            id: "7".into(),
            query: Some(q.into()),
            command: Some("Query".into()),
            state: Some("executing".into()),
            trx_info: true,
            ..Default::default()
        }
    }

    #[test]
    fn a_plain_read_is_safe_to_stop() {
        let a = assess_stop(&running("SELECT COUNT(*) FROM audit_log WHERE created_at > NOW() - INTERVAL 1 DAY"), Dialect::MySql);
        assert_eq!((a.impact, a.severity), (StopImpact::NothingToUndo, StopSeverity::Safe));
        assert!(a.can_cancel && a.can_kill && !a.kill_discards_transaction);
    }

    #[test]
    fn a_read_inside_a_transaction_that_wrote_is_not_safe_to_kill() {
        let mut s = running("SELECT * FROM orders WHERE id = 1");
        s.in_transaction = true;
        s.trx_writes = true;
        s.trx_rows_modified = Some(50_000);
        let a = assess_stop(&s, Dialect::MySql);
        assert_eq!((a.impact, a.severity), (StopImpact::NothingToUndo, StopSeverity::Caution));
        assert!(a.kill_discards_transaction);
        assert_eq!(a.rows, Some(50_000));
    }

    #[test]
    fn a_transactional_write_is_rolled_back() {
        let mut s = running("UPDATE orders SET status = 'paid' WHERE created_at < '2026-01-01'");
        s.in_transaction = true;
        s.trx_writes = true;
        s.trx_rows_modified = Some(120_000);
        let a = assess_stop(&s, Dialect::MySql);
        assert_eq!((a.impact, a.severity, a.rows), (StopImpact::UndoWrite, StopSeverity::Caution, Some(120_000)));
        // PostgreSQL writes are always transactional.
        let a = assess_stop(&running("DELETE FROM sessions WHERE expires_at < now()"), Dialect::Postgres);
        assert_eq!(a.impact, StopImpact::UndoWrite);
    }

    #[test]
    fn a_mysql_write_without_a_transaction_leaves_a_partial_change() {
        let a = assess_stop(&running("UPDATE legacy_myisam SET x = 1"), Dialect::MySql);
        assert_eq!((a.impact, a.severity), (StopImpact::PartialWrite, StopSeverity::Danger));
        // Without transaction data (no PROCESS privilege) it cannot be told apart: assume a normal write.
        let mut s = running("UPDATE t SET x = 1");
        s.trx_info = false;
        assert_eq!(assess_stop(&s, Dialect::MySql).impact, StopImpact::UndoWrite);
    }

    #[test]
    fn a_read_calling_side_effect_functions_is_not_called_safe() {
        // SLEEP / GET_LOCK / pg_advisory_lock hold resources or have effects the classifier cannot rule out.
        for q in ["SELECT SLEEP(30)", "SELECT GET_LOCK('job', 10)"] {
            assert_eq!(assess_stop(&running(q), Dialect::MySql).impact, StopImpact::Unknown, "{q}");
        }
    }

    #[test]
    fn schema_changes_and_unknown_statements_need_care() {
        assert_eq!(assess_stop(&running("ALTER TABLE orders ADD COLUMN note TEXT"), Dialect::MySql).impact, StopImpact::SchemaChange);
        assert_eq!(assess_stop(&running("CREATE INDEX idx ON orders(status)"), Dialect::Postgres).impact, StopImpact::SchemaChange);
        let a = assess_stop(&running("CALL rebuild_totals()"), Dialect::MySql);
        assert_eq!((a.impact, a.severity), (StopImpact::Unknown, StopSeverity::Caution));
    }

    #[test]
    fn idle_sessions_have_nothing_to_cancel() {
        let s = SessionInfo { id: "9".into(), command: Some("Sleep".into()), trx_info: true, ..Default::default() };
        let a = assess_stop(&s, Dialect::MySql);
        assert_eq!((a.impact, a.severity, a.can_cancel, a.can_kill), (StopImpact::Idle, StopSeverity::Safe, false, true));
        // PostgreSQL keeps the last query text on idle sessions: it is not running.
        let s = SessionInfo { id: "9".into(), state: Some("idle".into()), query: Some("UPDATE t SET x = 1".into()), trx_info: true, ..Default::default() };
        assert_eq!(assess_stop(&s, Dialect::Postgres).impact, StopImpact::Idle);
    }

    #[test]
    fn idle_in_a_transaction_that_wrote_discards_it_on_kill() {
        let s = SessionInfo {
            id: "9".into(),
            state: Some("idle in transaction".into()),
            query: Some("UPDATE accounts SET balance = balance - 10 WHERE id = 1".into()),
            in_transaction: true,
            trx_writes: true,
            trx_info: true,
            ..Default::default()
        };
        let a = assess_stop(&s, Dialect::Postgres);
        assert_eq!((a.impact, a.severity), (StopImpact::OpenTransaction, StopSeverity::Caution));
        assert!(!a.can_cancel && a.can_kill && a.kill_discards_transaction);
    }

    #[test]
    fn system_threads_cannot_be_stopped() {
        let s = SessionInfo { id: "5".into(), user: Some("event_scheduler".into()), command: Some("Daemon".into()), system: true, ..Default::default() };
        let a = assess_stop(&s, Dialect::MySql);
        assert_eq!((a.impact, a.severity, a.can_cancel, a.can_kill), (StopImpact::System, StopSeverity::Blocked, false, false));
    }

    #[test]
    fn backups_are_flagged() {
        assert_eq!(assess_stop(&running("FLUSH TABLES WITH READ LOCK"), Dialect::MySql).impact, StopImpact::Backup);
        assert_eq!(assess_stop(&running("SELECT /*!40001 SQL_NO_CACHE */ * FROM `orders`"), Dialect::MySql).impact, StopImpact::Backup);
        let mut s = running("COPY public.orders (id) TO stdout;");
        s.client = Some("pg_dump 10.0.0.5".into());
        let a = assess_stop(&s, Dialect::Postgres);
        assert_eq!((a.impact, a.severity), (StopImpact::Backup, StopSeverity::Danger));
    }

    #[test]
    fn your_own_session_can_be_cancelled_but_not_killed() {
        let mut s = running("SELECT SLEEP(100)");
        s.own = true;
        let a = assess_stop(&s, Dialect::MySql);
        assert!(a.can_cancel && !a.can_kill);
    }
}
