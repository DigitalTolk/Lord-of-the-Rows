//! Activity against real servers: the process list, what stopping each process would do,
//! lock chains, and cancel / kill — all while the app's own session is busy.
//! Run: `docker compose run --rm dev cargo test -p dbs-drivers --test activity`
//! Skipped (with a printed notice) when DBS_IT is not set.
//!
//! The scenario on each engine:
//!   B updates a row inside an open transaction and stays idle (holds the row lock);
//!   C tries to update the same row and waits for B;
//!   D runs a long sleep;
//!   the app's own session runs its own long query (Activity must still respond).

use std::sync::Arc;
use std::time::{Duration, Instant};

use dbs_core::*;
use dbs_drivers::driver_for;
use dbs_safety::{assess_stop, StopImpact};
use mysql_async::prelude::Queryable;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn it_enabled() -> bool {
    if std::env::var("DBS_IT").is_err() {
        eprintln!("SKIPPED: DBS_IT not set (run inside docker compose)");
        return false;
    }
    true
}

fn cfg(engine: Engine, host: &str, user: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: Uuid::new_v4(),
        name: "it-activity".into(),
        engine,
        host: Some(host.into()),
        port: None,
        database: Some("dbs_test".into()),
        username: Some(user.into()),
        socket_path: None,
        tls: TlsConfig { mode: TlsMode::Disabled, ..Default::default() },
        ssh: None,
        environment: EnvironmentKind::Testing,
        read_only: false,
        color: None,
        group: None,
        tags: vec![],
        notes: None,
        favorite: false,
        connect_timeout_secs: 10,
        query_timeout_secs: None,
        init_sql: None,
        key_separator: None,
        managed_by: None,
        tunnel: None,
    }
}

fn find<'a>(list: &'a [SessionInfo], id: &str) -> &'a SessionInfo {
    list.iter().find(|s| s.id == id).unwrap_or_else(|| panic!("session {id} not listed: {list:#?}"))
}

async fn until<F, Fut>(what: &str, mut f: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let t0 = Instant::now();
    while !f().await {
        assert!(t0.elapsed() < Duration::from_secs(10), "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test]
async fn mysql_activity() {
    if !it_enabled() {
        return;
    }
    mysql_family_activity(Engine::MySql, &std::env::var("DBS_IT_MYSQL_HOST").unwrap_or("localhost".into())).await;
}

/// MariaDB has no performance_schema.processlist / data_lock_waits: the fallbacks are used.
#[tokio::test]
async fn mariadb_activity() {
    if !it_enabled() {
        return;
    }
    mysql_family_activity(Engine::MariaDb, &std::env::var("DBS_IT_MARIADB_HOST").unwrap_or("localhost".into())).await;
}

async fn mysql_family_activity(engine: Engine, host: &str) {
    // Seeing other users' threads and InnoDB transactions needs PROCESS: use root.
    let app: Arc<dyn DatabaseConnection> =
        Arc::from(driver_for(engine).unwrap().connect(&cfg(engine, host, "root"), ConnectSecrets { password: Some("dbs_root_test".into()) }).await.unwrap());
    let opts = mysql_async::Opts::from_url(&format!("mysql://root:dbs_root_test@{host}:3306/dbs_test")).unwrap();
    let mut setup = mysql_async::Conn::new(opts.clone()).await.unwrap();
    setup.query_drop("DROP TABLE IF EXISTS activity_it").await.unwrap();
    setup.query_drop("CREATE TABLE activity_it (id INT PRIMARY KEY, n INT) ENGINE=InnoDB").await.unwrap();
    setup.query_drop("INSERT INTO activity_it VALUES (1, 0), (2, 0)").await.unwrap();

    let mut b = mysql_async::Conn::new(opts.clone()).await.unwrap();
    let b_id = b.id().to_string();
    b.query_drop("START TRANSACTION").await.unwrap();
    b.query_drop("UPDATE activity_it SET n = n + 1 WHERE id = 1").await.unwrap();

    let mut c = mysql_async::Conn::new(opts.clone()).await.unwrap();
    let c_id = c.id().to_string();
    let c_task = tokio::spawn(async move { c.query_drop("UPDATE activity_it SET n = 5 WHERE id = 1").await });

    let mut d = mysql_async::Conn::new(opts.clone()).await.unwrap();
    let d_id = d.id().to_string();
    let d_task = tokio::spawn(async move {
        let t0 = Instant::now();
        // A long plain read (no side-effect functions such as SLEEP, which are rated "unknown").
        // MySQL caps recursion with cte_max_recursion_depth, MariaDB with max_recursive_iterations.
        let _ = d.query_drop("SET SESSION cte_max_recursion_depth = 4294967295").await;
        let _ = d.query_drop("SET SESSION max_recursive_iterations = 4294967295").await;
        let _ = d.query_drop("WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 2000000000) SELECT COUNT(*) FROM r").await;
        t0.elapsed()
    });

    // The app's own session is busy for a while.
    let busy = app.clone();
    let own_task = tokio::spawn(async move { busy.execute("SELECT SLEEP(8)", &ExecOptions::default(), CancellationToken::new()).await });
    tokio::time::sleep(Duration::from_millis(1200)).await;

    let t0 = Instant::now();
    let list = app.list_sessions().await.unwrap();
    // The listing must come back while the app's own query is still running (it reads the
    // server on its side connection). Timed against a long busy query rather than a tight
    // budget: CI shares a few cores with the other engines' heavy test queries.
    assert!(!own_task.is_finished(), "Activity waited for the busy session ({:?})", t0.elapsed());
    assert!(t0.elapsed() < Duration::from_secs(5), "Activity listing took {:?}", t0.elapsed());

    let sb = find(&list, &b_id);
    assert!(sb.in_transaction && sb.trx_writes, "{sb:?}");
    assert_eq!(sb.trx_rows_modified, Some(1));
    let ab = assess_stop(sb, app.dialect());
    assert_eq!(ab.impact, StopImpact::OpenTransaction);
    assert!(!ab.can_cancel && ab.can_kill && ab.kill_discards_transaction);

    let sc = find(&list, &c_id);
    assert!(sc.blocked_by.as_deref().unwrap_or("").split(',').any(|x| x == b_id), "C waits for B: {sc:?}");
    assert_eq!(assess_stop(sc, app.dialect()).impact, StopImpact::UndoWrite);

    let sd = find(&list, &d_id);
    let ad = assess_stop(sd, app.dialect());
    assert_eq!(ad.impact, StopImpact::NothingToUndo);
    assert!(ad.can_cancel);

    let own: Vec<_> = list.iter().filter(|s| s.own).collect();
    assert_eq!(own.len(), 1, "exactly one own session: {list:#?}");
    assert!(!assess_stop(own[0], app.dialect()).can_kill, "own session is not killable");
    // The event scheduler (on by default in MySQL 8) is a server thread.
    if let Some(sched) = list.iter().find(|s| s.user.as_deref() == Some("event_scheduler")) {
        assert!(sched.system);
        assert_eq!(assess_stop(sched, app.dialect()).impact, StopImpact::System);
    }

    // Cancel D's statement: SLEEP returns early, the connection stays.
    app.cancel_session_query(&d_id).await.unwrap();
    let took = tokio::time::timeout(Duration::from_secs(5), d_task).await.expect("cancelled sleep returns").unwrap();
    assert!(took < Duration::from_secs(10), "{took:?}");

    // Kill B: its transaction rolls back, the lock is released and C goes through.
    app.kill_session(&b_id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), c_task).await.expect("C proceeds once B is gone").unwrap().unwrap();
    until("B gone", || {
        let app = app.clone();
        let b_id = b_id.clone();
        async move { !app.list_sessions().await.unwrap().iter().any(|s| s.id == b_id) }
    })
    .await;
    let n: Option<i32> = setup.query_first("SELECT n FROM activity_it WHERE id = 1").await.unwrap();
    assert_eq!(n, Some(5), "B's +1 was rolled back, C's update applied");

    own_task.await.unwrap().unwrap();
    setup.query_drop("DROP TABLE activity_it").await.unwrap();
}

#[tokio::test]
async fn postgres_activity() {
    if !it_enabled() {
        return;
    }
    let host = std::env::var("DBS_IT_PG_HOST").unwrap_or("localhost".into());
    let app: Arc<dyn DatabaseConnection> = Arc::from(
        driver_for(Engine::Postgres)
            .unwrap()
            .connect(&cfg(Engine::Postgres, &host, "dbs_test"), ConnectSecrets { password: Some("dbs_test".into()) })
            .await
            .unwrap(),
    );
    let raw = || async {
        let (client, conn) =
            tokio_postgres::connect(&format!("host={host} user=dbs_test password=dbs_test dbname=dbs_test"), tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(conn);
        let pid: i32 = client.query_one("SELECT pg_backend_pid()", &[]).await.unwrap().get(0);
        (client, pid.to_string())
    };
    let (setup, _) = raw().await;
    setup
        .batch_execute("DROP TABLE IF EXISTS activity_it; CREATE TABLE activity_it (id int PRIMARY KEY, n int); INSERT INTO activity_it VALUES (1, 0), (2, 0)")
        .await
        .unwrap();

    let (b, b_id) = raw().await;
    b.batch_execute("BEGIN; UPDATE activity_it SET n = n + 1 WHERE id = 1").await.unwrap();

    let (c, c_id) = raw().await;
    let c_task = tokio::spawn(async move { c.execute("UPDATE activity_it SET n = 5 WHERE id = 1", &[]).await.map(|_| ()) });

    let (d, d_id) = raw().await;
    let d_task = tokio::spawn(async move { d.execute("SELECT pg_sleep(30)", &[]).await.map(|_| ()) });

    let busy = app.clone();
    let own_task = tokio::spawn(async move { busy.execute("SELECT pg_sleep(8)", &ExecOptions::default(), CancellationToken::new()).await });
    tokio::time::sleep(Duration::from_millis(1200)).await;

    let t0 = Instant::now();
    let list = app.list_sessions().await.unwrap();
    // The listing must come back while the app's own query is still running (it reads the
    // server on its side connection). Timed against a long busy query rather than a tight
    // budget: CI shares a few cores with the other engines' heavy test queries.
    assert!(!own_task.is_finished(), "Activity waited for the busy session ({:?})", t0.elapsed());
    assert!(t0.elapsed() < Duration::from_secs(5), "Activity listing took {:?}", t0.elapsed());

    let sb = find(&list, &b_id);
    assert_eq!(sb.state.as_deref(), Some("idle in transaction"));
    assert!(sb.in_transaction && sb.trx_writes, "{sb:?}");
    assert_eq!(assess_stop(sb, Dialect::Postgres).impact, StopImpact::OpenTransaction);

    let sc = find(&list, &c_id);
    assert_eq!(sc.blocked_by.as_deref(), Some(b_id.as_str()), "C waits for B");
    assert_eq!(assess_stop(sc, Dialect::Postgres).impact, StopImpact::UndoWrite);

    let ad = assess_stop(find(&list, &d_id), Dialect::Postgres);
    assert_eq!(ad.impact, StopImpact::NothingToUndo);
    assert!(ad.can_cancel);

    let own: Vec<_> = list.iter().filter(|s| s.own).collect();
    assert_eq!(own.len(), 1, "exactly one own session: {list:#?}");
    assert!(own[0].query.as_deref().unwrap_or("").contains("pg_sleep(8)"));

    // Cancel D: pg_sleep is interrupted with "canceling statement due to user request".
    app.cancel_session_query(&d_id).await.unwrap();
    let r = tokio::time::timeout(Duration::from_secs(5), d_task).await.expect("cancel interrupts the sleep").unwrap();
    assert_eq!(r.unwrap_err().code(), Some(&tokio_postgres::error::SqlState::QUERY_CANCELED), "statement cancelled");

    // Kill B: its transaction rolls back and C goes through.
    app.kill_session(&b_id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), c_task).await.expect("C proceeds once B is gone").unwrap().unwrap();
    let n: i32 = setup.query_one("SELECT n FROM activity_it WHERE id = 1", &[]).await.unwrap().get(0);
    assert_eq!(n, 5, "B's +1 was rolled back, C's update applied");
    // Nothing to cancel on an idle session.
    assert!(app.cancel_session_query(&b_id).await.is_err());

    own_task.await.unwrap().unwrap();
    setup.batch_execute("DROP TABLE activity_it").await.unwrap();
}
