using Microsoft.Data.Sqlite;

namespace SatisfactorySync.Core.Data;

/// <summary>
/// SQLite-Zugriff. Alle schreibenden Vorgänge laufen über <see cref="Write{T}"/>:
/// ein prozessweiter Lock plus <c>BEGIN IMMEDIATE</c>. Damit sind Lease-Vergabe und
/// Upload-Commit strikt serialisiert (Plan 5.3).
/// </summary>
public sealed class SyncDatabase
{
    private readonly string _connectionString;
    private readonly Lock _writeLock = new();

    public SyncDatabase(SyncOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        Directory.CreateDirectory(options.DataDir);
        Directory.CreateDirectory(options.VersionsDir);
        Directory.CreateDirectory(options.TempDir);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = options.DatabasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = true,
            DefaultTimeout = 30,
        }.ToString();
        Migrate();
    }

    public SqliteConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;";
        cmd.ExecuteNonQuery();
        return conn;
    }

    public T Read<T>(Func<SqliteConnection, T> work)
    {
        ArgumentNullException.ThrowIfNull(work);
        using var conn = Open();
        return work(conn);
    }

    public T Write<T>(Func<SqliteConnection, SqliteTransaction, T> work)
    {
        ArgumentNullException.ThrowIfNull(work);
        lock (_writeLock)
        {
            using var conn = Open();
            // deferred: false => Microsoft.Data.Sqlite sendet "BEGIN IMMEDIATE".
            using var tx = conn.BeginTransaction(deferred: false);
            var result = work(conn, tx);
            tx.Commit();
            return result;
        }
    }

    private void Migrate()
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS users(
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL UNIQUE COLLATE NOCASE,
              token_hash TEXT NOT NULL UNIQUE,
              blocked INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS invites(
              id INTEGER PRIMARY KEY,
              code_hash TEXT NOT NULL UNIQUE,
              created_at INTEGER NOT NULL,
              used_by INTEGER REFERENCES users(id),
              used_at INTEGER);
            CREATE TABLE IF NOT EXISTS versions(
              id INTEGER PRIMARY KEY,
              number INTEGER UNIQUE,
              sha256 TEXT NOT NULL,
              size INTEGER NOT NULL,
              play_seconds INTEGER NOT NULL,
              build_version INTEGER NOT NULL,
              save_version INTEGER NOT NULL,
              header_version INTEGER NOT NULL,
              session_name TEXT NOT NULL,
              uploaded_by INTEGER NOT NULL REFERENCES users(id),
              uploaded_at INTEGER NOT NULL,
              type TEXT NOT NULL CHECK(type IN ('normal','konflikt','import')),
              base_version_id INTEGER,
              fencing_token INTEGER,
              conflict_reason TEXT,
              restored_from INTEGER,
              pruned INTEGER NOT NULL DEFAULT 0,
              map_json TEXT);
            CREATE TABLE IF NOT EXISTS world(
              id INTEGER PRIMARY KEY CHECK(id = 1),
              session_name TEXT,
              head_version_id INTEGER REFERENCES versions(id));
            INSERT OR IGNORE INTO world(id, session_name, head_version_id) VALUES (1, NULL, NULL);
            CREATE TABLE IF NOT EXISTS fencing_counter(
              id INTEGER PRIMARY KEY CHECK(id = 1),
              value INTEGER NOT NULL);
            INSERT OR IGNORE INTO fencing_counter(id, value) VALUES (1, 0);
            CREATE TABLE IF NOT EXISTS leases(
              id INTEGER PRIMARY KEY CHECK(id = 1),
              lease_id TEXT NOT NULL,
              user_id INTEGER NOT NULL REFERENCES users(id),
              fencing_token INTEGER NOT NULL,
              base_version_id INTEGER,
              acquired_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS presence(
              user_id INTEGER PRIMARY KEY REFERENCES users(id),
              status TEXT NOT NULL CHECK(status IN ('launcher','im_spiel')),
              last_seen INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS audit_log(
              id INTEGER PRIMARY KEY,
              at INTEGER NOT NULL,
              user_id INTEGER,
              action TEXT NOT NULL,
              details TEXT);
            CREATE TABLE IF NOT EXISTS idempotency(
              user_id INTEGER NOT NULL,
              key TEXT NOT NULL,
              status INTEGER NOT NULL,
              body TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY(user_id, key));
            """;
        cmd.ExecuteNonQuery();

        // Ab 2026-11-26: mehrere Zugänge (Tokens/Geräte) pro Spieler, Anwesenheit pro Gerät,
        // an einen Spieler gebundene Einladungscodes. Bestehende Daten werden übernommen.
        AddColumnIfMissing(conn, "invites", "for_user_id", "INTEGER REFERENCES users(id)");
        AddColumnIfMissing(conn, "invites", "expires_at", "INTEGER");
        AddColumnIfMissing(conn, "leases", "device_id", "INTEGER");
        using var multi = conn.CreateCommand();
        multi.CommandText = """
            CREATE TABLE IF NOT EXISTS tokens(
              id INTEGER PRIMARY KEY,
              user_id INTEGER NOT NULL REFERENCES users(id),
              token_hash TEXT NOT NULL UNIQUE,
              created_at INTEGER NOT NULL);
            INSERT OR IGNORE INTO tokens(user_id, token_hash, created_at)
              SELECT id, token_hash, created_at FROM users;
            CREATE TABLE IF NOT EXISTS device_presence(
              user_id INTEGER NOT NULL REFERENCES users(id),
              device_id INTEGER NOT NULL,
              status TEXT NOT NULL CHECK(status IN ('launcher','im_spiel')),
              last_seen INTEGER NOT NULL,
              PRIMARY KEY(user_id, device_id));
            INSERT OR IGNORE INTO device_presence(user_id, device_id, status, last_seen)
              SELECT p.user_id, t.id, p.status, p.last_seen FROM presence p
              JOIN tokens t ON t.user_id = p.user_id;
            """;
        multi.ExecuteNonQuery();
    }

    private static void AddColumnIfMissing(SqliteConnection conn, string table, string column, string definition)
    {
        using var info = conn.CreateCommand();
        info.CommandText = $"SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = '{column}'";
        if (Convert.ToInt64(info.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture) > 0)
        {
            return;
        }

        using var alter = conn.CreateCommand();
        alter.CommandText = $"ALTER TABLE {table} ADD COLUMN {column} {definition}";
        alter.ExecuteNonQuery();
    }
}
