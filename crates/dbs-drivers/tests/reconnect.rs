//! A MySQL session whose connection the server dropped (idle timeout, laptop sleep, VPN
//! change) reconnects instead of failing with "Connection to the server is closed" forever.
//! The drop is simulated by killing the app's connection from a second one.
//! Run: `docker compose run --rm dev cargo test -p dbs-drivers --test reconnect`
//! Skipped (with a printed notice) when DBS_IT is not set.

use dbs_core::*;
use dbs_drivers::driver_for;
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

fn host() -> String {
    std::env::var("DBS_IT_MYSQL_HOST").unwrap_or("localhost".into())
}

async fn connect() -> Box<dyn DatabaseConnection> {
    let cfg: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": Uuid::new_v4(), "name": "it-reconnect", "engine": "my_sql", "host": host(), "database": "dbs_test",
        "username": "dbs_test", "tls": { "mode": "disabled" }, "environment": "testing",
        "init_sql": "SET @lotr_marker = 42"
    }))
    .unwrap();
    driver_for(Engine::MySql).unwrap().connect(&cfg, ConnectSecrets { password: Some("dbs_test".into()) }).await.unwrap()
}

async fn run(c: &dyn DatabaseConnection, sql: &str) -> DbResult<Vec<StatementResult>> {
    c.execute(sql, &ExecOptions::default(), CancellationToken::new()).await
}

fn first_text(r: &[StatementResult]) -> String {
    let rows = &r.iter().rev().find_map(|s| s.result.as_ref()).expect("result").rows;
    rows[0][0].to_plain().unwrap_or_default()
}

/// Kill the app's connection from outside, as the server does when it drops it.
async fn drop_connection(c: &dyn DatabaseConnection) {
    let id = first_text(&run(c, "SELECT CONNECTION_ID()").await.unwrap());
    let opts = mysql_async::OptsBuilder::default().ip_or_hostname(host()).user(Some("dbs_test")).pass(Some("dbs_test")).db_name(Some("dbs_test"));
    let mut other = mysql_async::Conn::new(opts).await.unwrap();
    other.query_drop(format!("KILL CONNECTION {id}")).await.unwrap();
    other.disconnect().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
}

#[tokio::test]
async fn mysql_reconnects_after_the_server_drops_the_connection() {
    if !it_enabled() {
        return;
    }
    let c = connect().await;
    run(&*c, "DROP TABLE IF EXISTS rc_t; CREATE TABLE rc_t (id INT PRIMARY KEY)").await.unwrap();
    c.use_schema("dbs_test").await.unwrap();

    // A read right after the drop works: reconnected, same database, init SQL applied again.
    drop_connection(&*c).await;
    let r = run(&*c, "SELECT DATABASE(), @lotr_marker").await.expect("read after a dropped connection");
    let rows = &r[0].result.as_ref().unwrap().rows;
    assert_eq!(rows[0][0].to_plain().as_deref(), Some("dbs_test"));
    assert_eq!(rows[0][1].to_plain().as_deref(), Some("42"));

    // Metadata (the object tree) survives a drop too.
    drop_connection(&*c).await;
    assert!(c.list_objects(None).await.expect("objects after a dropped connection").iter().any(|o| o.name == "rc_t"));

    // A write is never repeated automatically: it reports the lost connection, the next one works.
    drop_connection(&*c).await;
    let e = run(&*c, "INSERT INTO rc_t VALUES (1)").await.expect_err("a write is not retried");
    assert_eq!(e.kind, ErrorKind::Connection);
    run(&*c, "INSERT INTO rc_t VALUES (2)").await.expect("next write runs on the new connection");

    // A transaction cut off by a drop is reported (the server rolled it back), once.
    run(&*c, "BEGIN; INSERT INTO rc_t VALUES (3)").await.unwrap();
    drop_connection(&*c).await;
    let _ = run(&*c, "SELECT 1").await; // fails on the dead connection (not retried: a transaction was open)
    let e = run(&*c, "SELECT 1").await.expect_err("the lost transaction is reported");
    assert!(e.message.contains("rolled it back"), "{}", e.message);
    let n = first_text(&run(&*c, "SELECT COUNT(*) FROM rc_t WHERE id = 3").await.unwrap());
    assert_eq!(n, "0", "the transaction's insert was rolled back");

    run(&*c, "DROP TABLE rc_t").await.unwrap();
}
