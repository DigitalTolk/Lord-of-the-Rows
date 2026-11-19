# Changelog

## 0.2.7
- **Export tables.** Right-click a table (or a database in the rail) → **Export…**, or use the export button in a table's toolbar or "Export tables…" in the command palette. Tick any tables of the connection (a whole database at once), choose a format and where it goes:
  - CSV/TSV: header row, delimiter (comma, semicolon, tab, pipe), NULL as empty / `NULL` / `\N`, quoting, LF or CRLF, line breaks in values to spaces, and protection against spreadsheet formulas. JSON as an array or JSON Lines. SQL with `DROP TABLE IF EXISTS`, `CREATE TABLE` and INSERTs (rows per INSERT). Excel as one workbook with a sheet per table.
  - One file, or a file per table in a folder, named from a pattern (`{table}`, `{schema}`, `{database}`, `{date}`, `{time}`) with a live preview; gzip; existing files are kept unless you choose to replace them. From a filtered table: only the matching rows.
  - Progress per table, Cancel at any time; your last settings are remembered.
- Fix: exporting a large table could repeat or skip rows (the first 5,000 were read unordered).

## 0.2.6
- Tabs belong to the database they were opened for. Query and table tabs show only while that database is selected, so a query written for one database is never shown, or run, against another. Switching database goes back to the tab you last used there (or opens an empty query tab if it has none), and each database in the rail shows how many tabs it has open.

## 0.2.5
- Edit query results in place (MySQL, MariaDB, PostgreSQL). When a result's columns come from one table and its primary key is in the result, double-click a cell to change it and commit with **Commit** or ⌘S. Each change is an update by primary key that only applies if the row still has the value you saw, with the same SQL preview and production confirmation as the table view. Aliased columns write to their real column; expressions, joins and results without the key stay read-only, and the results toolbar says why.
- **Choose columns**: pick which columns the grid shows (toolbar button or a column header's right-click menu), in the order you pick them; Clear shows them all again.
- **Jump to** (⌘J / Ctrl+J): type a column name (hidden ones too), a row number, or a value to find in the loaded rows.
- Security: Wasmtime (plugin runtime) updated to 50.0.2.

## 0.2.4
- Connection rail menus (right-click): on a connection, New query, Open database…, Refresh, **Move to new window** (its query and table tabs and the current database go with it), **Open in new window**, Edit connection, **Close connection** and **Close other connections**; on an opened database, Open, New query, Refresh, Copy name, Close and **Close other databases**.

## 0.2.3
- Linux and Windows builds. Every release now ships for Linux (x86_64 and arm64: AppImage, `.deb`, `.rpm`) and Windows (x86_64 installer, installs for your user only, no admin rights needed) next to macOS, and in-app updates work on all of them. The Windows installer is not code-signed yet: on first run choose **More info → Run anyway**. See the README for installation.
- Fix: a PostgreSQL connection set up with a socket file now explains that sockets aren't available on Windows instead of failing to build there.

## 0.2.2
- Activity: see what is running on the server right now, and stop it safely. Open it from the status bar (it shows how many queries are running and turns amber/red when one is slow or blocking) or with ⇧⌘A; it also replaces the session list in Monitor. Sessions that block others come first as a lock chain (who holds the lock, who waits and for how long), then running queries with a duration bar, with idle connections and server threads folded away. Search and filter by user, database or client; live updates pause while you hover or select so rows don't move under the pointer.
- Every session says what stopping it would do, worked out from the query and its open transaction: "No changes to undo", "Rolls back 120,000 changed rows", "Schema change — may leave things half done", "Server thread — can't be stopped", and so on, colour-coded from safe to danger. **Cancel query** stops just the statement and keeps the connection; **Kill connection** ends it and rolls back its transaction. The confirmation spells out what will be lost; dangerous stops and any kill on production need the connection name typed. Several sessions can be cancelled or killed together. Server threads, replication and the app's own connection can't be stopped, and read-only connections show the actions disabled with the reason. Every stop is re-checked against the live server first and written to the audit log.
- Activity stays responsive while your own query is running: it reads the server on its own side connection. MySQL/MariaDB use the process list with InnoDB transaction and lock-wait details (seeing other users' sessions needs the PROCESS privilege); PostgreSQL uses `pg_stat_activity` and `pg_blocking_pids`.

## 0.2.1
- Faster table opening, especially over a VPN: rows show first and the table's structure loads after them (like DataGrip / TablePlus); autocomplete reads a schema's columns in one query, shared by all query tabs, instead of describing every table one by one; the exact row count runs by itself only for tables up to ~100k rows (bigger ones show ~estimate or "500+", click for the exact count). Measured with 50 ms latency and 152 tables: opening a 200k-row table with a query tab open went from 1.25 s to 0.27 s.
- In-app updates: the app checks for a new release on launch and every 6 hours and shows an **Update <version>** button in the header (and a toast) when one is out. It opens Settings → Updates with the release notes and **Install & restart**; nothing installs without a click. Updates are signature-checked before install. Turn checking off in Settings → Updates. Apps installed with Homebrew update the same way.
- Fix: ⌘↵ / ⇧⌘↵ in the query editor could fail with "Unhandled: … getValue" after another query editor had been closed (e.g. after switching database). Editor shortcuts now belong to their own editor.
- Fix: choosing a TablePlus export file (`.tableplusconnection`) in Import now explains that those files are encrypted and to pick TablePlus under "On this computer", instead of a garbled message.

## 0.2.0
- Access requests: request time-limited database access from an access-management service without leaving the app. The app speaks its own documented, product-neutral **Access API** ([docs/access-api.md](docs/access-api.md)), so any service that implements it works. Add a provider, sign in through the browser (single sign-on, PKCE + loopback redirect; the session token stays in the OS keychain), pick a database grouped by environment, choose read-only or read & write and the databases, give a reason, and follow the request (waiting for your manager → provisioning with a live log → ready). **Connect** fetches the password once into the keychain and opens the connection; later connects reuse it. Approvers get an Approvals inbox (approve / reject with a reason). Saved connections show a key badge with the time left, warn 15 minutes before the access ends, and when it ends (or the request is revoked) the password is wiped and the connection is marked "Expired — request again". Providers plug in through a provider-neutral interface (`crates/dbs-access`).
- Access requests, continued: Active / Pending / History filters with search and environment chips; an Approvals "Decided" tab; a request detail drawer (timeline, provisioning log, reveals left, copyable connection details); optional ticket references; one-click "Request again"; expiry banners in the workspace (15 and 5 minutes) and a graceful "Access ended" state that keeps your tabs; a Dock badge, "Review" toasts and multi-select approve for approvers; command palette entries; preconfigured providers (`providers.json`) and `lordoftherows://access` links for company rollout.
- Import: saved passwords from another app's keychain (TablePlus) are no longer read during import, which made macOS ask once per connection. Each is read the first time you connect to that connection (one prompt), then kept in this app's keychain. Bringing passwords along is now on by default.
- Connection list: select several connections and delete them in one go — ⌘A in the list selects all shown, ⌘-click / ⇧-click pick several or a range, the right-click menu has Select / Select all, and the bottom-bar Delete (or the selection toolbar) deletes the selection after one confirmation that counts production connections.

- Fix: MySQL/MariaDB with SSL mode PREFERRED now falls back to an unencrypted connection when the TLS handshake fails (e.g. a server that only speaks TLS 1.0/1.1), matching MySQL's own definition of the mode. REQUIRED and VERIFY modes never fall back.

- Connection rail: every open connection shows its environment tag (LOCAL, DEV, STAGING, PROD…); production connections also get a red outline, so it is always clear where queries run.

- Connection form: tagging a remote connection Production raises SSL mode PREFERRED/DISABLED to REQUIRED automatically (with a note) instead of blocking the form; a stronger mode you picked is kept.

- Fix: double-clicking a connection on the start screen opened it twice. A connection that is already open in the window is now switched to, and repeated clicks while it is connecting are ignored.

## 0.1.2
- Redis key browser: logical databases (db0, db1, …) as schemas with key counts (sidebar, schema rail, Open database picker); a lazily expanded namespace tree (configurable separator, bounded SCAN batches with "Load more"); a SCAN-paged key grid (key, type, TTL, size, value preview) with a server-side Key pattern; values by type (string/JSON, hash, list, set, sorted set, stream, JSON documents) paged in the detail panel; staged key edits (set, TTL, rename, delete, field/member add/remove) previewed as commands and committed through the safety policy. `KEYS` is never used.
- Import connections from other database tools (TablePlus, DBeaver, Sequel Ace / Sequel Pro, pgAdmin, DataGrip) or a list of connection URLs, with a preview, duplicate detection, groups and environment tags kept, and optional import of TablePlus passwords from the macOS Keychain.
- Fix: after Stop or a timeout on MySQL/MariaDB, the next query could fail with "Query execution was interrupted".
- Fix: the pending-changes preview stayed open (showing the previous tab's statements) after switching tabs.

## 0.1.1
- Fix: drag and drop inside the app (moving connections into groups, reordering tabs) did not work on macOS.

## 0.1.0
- Drivers: PostgreSQL, MySQL, MariaDB, SQLite, Redis.
- Desktop UI with a familiar workflow: launcher, connection rail, per-connection tabs, SQL editor, grid, structure, ER, monitor, palette.
- Staged editing with SQL review and conflict detection; PK-ordered paging.
- Production safe mode (Rust-enforced), read-only sessions, tamper-evident audit log.
- TLS verification (custom CA), SSH tunnels with strict host keys and jump hosts.
- Import/export (CSV, TSV, JSON, JSONL, SQL, XLSX, Markdown, XML), schema diff & migrations, backups.
- Tests: 97 Rust, 15 frontend, 35 end-to-end (WebDriver, real databases).
