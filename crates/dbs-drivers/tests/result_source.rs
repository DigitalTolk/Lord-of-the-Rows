//! Query results carry each column's source schema, table and column, which the app
//! needs to edit a query result in place. Aliases keep their real column name;
//! expressions have no source.
//! Run: `docker compose run --rm dev cargo test -p dbs-drivers --test result_source`
//! Skipped (with a printed notice) when DBS_IT is not set.

use dbs_core::*;
use dbs_drivers::driver_for;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn it_enabled() -> bool {
    if std::env::var("DBS_IT").is_err() {
        eprintln!("SKIPPED: DBS_IT not set (run inside docker compose)");
        return false;
    }
    true
}

fn cfg(engine: Engine, host: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: Uuid::new_v4(),
        name: "it-result-source".into(),
        engine,
        host: Some(host.into()),
        port: None,
        database: Some("dbs_test".into()),
        username: Some("dbs_test".into()),
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

/// Runs `setup`, then `query`, then `cleanup` (the databases are shared with other tests and the
/// e2e suite, so nothing is left behind), and returns the query's columns.
async fn columns(engine: Engine, host_var: &str, setup: &str, query: &str, cleanup: &str) -> Vec<ColumnMeta> {
    let host = std::env::var(host_var).unwrap_or("localhost".into());
    let c = driver_for(engine).expect("driver").connect(&cfg(engine, &host), ConnectSecrets { password: Some("dbs_test".into()) }).await.expect("connect");
    let run = |sql: &str| {
        let sql = sql.to_string();
        let c = &c;
        async move { c.execute(&sql, &ExecOptions::default(), CancellationToken::new()).await.unwrap_or_else(|e| panic!("{sql}: {e:?}")) }
    };
    run(setup).await;
    let r = run(query).await;
    run(cleanup).await;
    r.into_iter().rev().find_map(|s| s.result).expect("result set").columns
}

fn source(c: &ColumnMeta) -> (Option<&str>, Option<&str>, Option<&str>) {
    (c.schema.as_deref(), c.table.as_deref(), c.column.as_deref())
}

const MYSQL_SETUP: &str = "DROP TABLE IF EXISTS rs_orders; DROP TABLE IF EXISTS rs_customers;
    CREATE TABLE rs_customers (id int PRIMARY KEY, name varchar(50));
    CREATE TABLE rs_orders (id int PRIMARY KEY, customer_id int, total int);
    INSERT INTO rs_customers VALUES (1, 'a'); INSERT INTO rs_orders VALUES (10, 1, 5)";
const QUERY: &str = "SELECT o.id, o.customer_id AS cust, o.total + 1 AS plus, c.name FROM rs_orders o JOIN rs_customers c ON c.id = o.customer_id";

async fn check_mysql(engine: Engine, host_var: &str) {
    let cols = columns(engine, host_var, MYSQL_SETUP, QUERY, "DROP TABLE rs_orders; DROP TABLE rs_customers").await;
    assert_eq!(source(&cols[0]), (Some("dbs_test"), Some("rs_orders"), Some("id")));
    assert_eq!(source(&cols[1]), (Some("dbs_test"), Some("rs_orders"), Some("customer_id")), "alias keeps the real column");
    assert_eq!(cols[1].name, "cust");
    assert_eq!(source(&cols[2]).1, None, "an expression has no source table");
    assert_eq!(source(&cols[3]), (Some("dbs_test"), Some("rs_customers"), Some("name")));
}

#[tokio::test]
async fn mysql_result_columns_name_their_source() {
    if it_enabled() {
        check_mysql(Engine::MySql, "DBS_IT_MYSQL_HOST").await;
    }
}

#[tokio::test]
async fn mariadb_result_columns_name_their_source() {
    if it_enabled() {
        check_mysql(Engine::MariaDb, "DBS_IT_MARIADB_HOST").await;
    }
}

#[tokio::test]
async fn postgres_result_columns_name_their_source() {
    if !it_enabled() {
        return;
    }
    let setup = "DROP SCHEMA IF EXISTS rs CASCADE; CREATE SCHEMA rs;
        CREATE TABLE rs.rs_customers (id int PRIMARY KEY, name text);
        CREATE TABLE rs.rs_orders (id int PRIMARY KEY, customer_id int, total int);
        INSERT INTO rs.rs_customers VALUES (1, 'a'); INSERT INTO rs.rs_orders VALUES (10, 1, 5)";
    let query = QUERY.replace("rs_orders o", "rs.rs_orders o").replace("rs_customers c", "rs.rs_customers c");
    let cols = columns(Engine::Postgres, "DBS_IT_PG_HOST", setup, &query, "DROP SCHEMA rs CASCADE").await;
    assert_eq!(source(&cols[0]), (Some("rs"), Some("rs_orders"), Some("id")));
    assert_eq!(source(&cols[1]), (Some("rs"), Some("rs_orders"), Some("customer_id")), "alias keeps the real column");
    assert_eq!(cols[1].name, "cust");
    assert_eq!(source(&cols[2]).1, None, "an expression has no source table");
    assert_eq!(source(&cols[3]), (Some("rs"), Some("rs_customers"), Some("name")));
}
