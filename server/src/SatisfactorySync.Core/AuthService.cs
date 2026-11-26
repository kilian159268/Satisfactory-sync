using Microsoft.Data.Sqlite;
using SatisfactorySync.Core.Data;

namespace SatisfactorySync.Core;

/// <summary>Einladungscodes und persönliche Tokens (Plan 5.6). Gespeichert werden nur Hashes.</summary>
public sealed class AuthService(SyncDatabase db, TimeProvider clock)
{
    public const int MaxNameLength = 24;

    public IReadOnlyList<string> CreateInvites(int count)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(count, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(count, 50);
        var now = clock.GetUtcNow().ToUnixTimeMilliseconds();
        return db.Write((c, tx) =>
        {
            var codes = new List<string>(count);
            for (var i = 0; i < count; i++)
            {
                var code = Crypto.NewInviteCode();
                c.Exec(tx, "INSERT INTO invites(code_hash, created_at) VALUES ($h, $t)", ("$h", Crypto.Sha256Hex(code)), ("$t", now));
                codes.Add(code);
            }

            c.Exec(tx, "INSERT INTO audit_log(at, user_id, action, details) VALUES ($t, NULL, 'invites_created', $d)", ("$t", now), ("$d", count.ToString(System.Globalization.CultureInfo.InvariantCulture)));
            return (IReadOnlyList<string>)codes;
        });
    }

    /// <summary>Löst einen Einladungscode ein und gibt das persönliche Token zurück (nur dieses eine Mal sichtbar).</summary>
    public Result<string> Redeem(string? code, string? name)
    {
        var trimmed = name?.Trim() ?? string.Empty;
        if (trimmed.Length is 0 or > MaxNameLength || trimmed.Any(char.IsControl))
        {
            return Errors.Invalid("invalid_name", $"Name muss 1 bis {MaxNameLength} Zeichen haben.");
        }

        if (string.IsNullOrWhiteSpace(code))
        {
            return Errors.InviteInvalid;
        }

        var codeHash = Crypto.Sha256Hex(Crypto.NormalizeInviteCode(code));
        var now = clock.GetUtcNow().ToUnixTimeMilliseconds();
        return db.Write<Result<string>>((c, tx) =>
        {
            var inviteId = c.Scalar<long?>(tx, "SELECT id FROM invites WHERE code_hash = $h AND used_by IS NULL", ("$h", codeHash));
            if (inviteId is null)
            {
                return Errors.InviteInvalid;
            }

            if (c.Scalar<long?>(tx, "SELECT id FROM users WHERE name = $n", ("$n", trimmed)) is not null)
            {
                return Errors.NameTaken;
            }

            var token = Crypto.NewToken();
            var userId = c.Scalar<long>(tx, "INSERT INTO users(name, token_hash, created_at) VALUES ($n, $h, $t) RETURNING id", ("$n", trimmed), ("$h", Crypto.Sha256Hex(token)), ("$t", now));
            c.Exec(tx, "UPDATE invites SET used_by = $u, used_at = $t WHERE id = $i", ("$u", userId), ("$t", now), ("$i", inviteId));
            c.Exec(tx, "INSERT INTO audit_log(at, user_id, action, details) VALUES ($t, $u, 'joined', NULL)", ("$t", now), ("$u", userId));
            return Result<string>.Success(token);
        });
    }

    public User? Authenticate(string? token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 200)
        {
            return null;
        }

        var hash = Crypto.Sha256Hex(token);
        return db.Read(c => c.Query(null, "SELECT id, name, blocked FROM users WHERE token_hash = $h", MapUser, ("$h", hash)).FirstOrDefault()) is { Blocked: false } u ? u : null;
    }

    public IReadOnlyList<User> ListUsers() =>
        db.Read(c => c.Query(null, "SELECT id, name, blocked FROM users ORDER BY name", MapUser));

    public bool SetBlocked(string name, bool blocked)
    {
        var now = clock.GetUtcNow().ToUnixTimeMilliseconds();
        return db.Write((c, tx) =>
        {
            var id = c.Scalar<long?>(tx, "SELECT id FROM users WHERE name = $n", ("$n", name));
            if (id is null)
            {
                return false;
            }

            c.Exec(tx, "UPDATE users SET blocked = $b WHERE id = $i", ("$b", blocked ? 1 : 0), ("$i", id));
            c.Exec(tx, "INSERT INTO audit_log(at, user_id, action, details) VALUES ($t, $u, $a, NULL)", ("$t", now), ("$u", id), ("$a", blocked ? "blocked" : "unblocked"));
            return true;
        });
    }

    private static User MapUser(SqliteDataReader r) => new(r.GetInt64(0), r.GetString(1), r.GetInt64(2) != 0);
}
