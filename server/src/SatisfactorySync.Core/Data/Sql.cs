using Microsoft.Data.Sqlite;

namespace SatisfactorySync.Core.Data;

internal static class Sql
{
    public static SqliteCommand Cmd(this SqliteConnection conn, SqliteTransaction? tx, string sql, params (string Name, object? Value)[] args)
    {
        var cmd = conn.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = sql;
        foreach (var (name, value) in args)
        {
            cmd.Parameters.AddWithValue(name, value ?? DBNull.Value);
        }

        return cmd;
    }

    public static int Exec(this SqliteConnection conn, SqliteTransaction? tx, string sql, params (string Name, object? Value)[] args)
    {
        using var cmd = conn.Cmd(tx, sql, args);
        return cmd.ExecuteNonQuery();
    }

    public static T? Scalar<T>(this SqliteConnection conn, SqliteTransaction? tx, string sql, params (string Name, object? Value)[] args)
    {
        using var cmd = conn.Cmd(tx, sql, args);
        var value = cmd.ExecuteScalar();
        if (value is null or DBNull)
        {
            return default;
        }

        var target = Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T);
        return (T)Convert.ChangeType(value, target, System.Globalization.CultureInfo.InvariantCulture);
    }

    public static List<T> Query<T>(this SqliteConnection conn, SqliteTransaction? tx, string sql, Func<SqliteDataReader, T> map, params (string Name, object? Value)[] args)
    {
        using var cmd = conn.Cmd(tx, sql, args);
        using var reader = cmd.ExecuteReader();
        var list = new List<T>();
        while (reader.Read())
        {
            list.Add(map(reader));
        }

        return list;
    }

    public static long? NullableInt64(this SqliteDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetInt64(i);
    }

    public static string? NullableString(this SqliteDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetString(i);
    }
}
