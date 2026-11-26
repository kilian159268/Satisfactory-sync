using Microsoft.Data.Sqlite;
using SatisfactorySync.Core.Data;

namespace SatisfactorySync.Core;

/// <summary>Ergebnis einer Einlösung: das neue Token (nur dieses eine Mal sichtbar) und der Spielername.</summary>
public sealed record Redeemed(string Token, string Name, bool Linked);

/// <summary>Ein Verknüpfungscode für einen weiteren Zugang desselben Spielers.</summary>
public sealed record LinkCode(string Code, DateTimeOffset ExpiresAt);

/// <summary>
/// Einladungscodes und persönliche Tokens (Plan 5.6). Gespeichert werden nur Hashes.
/// Ein Spieler kann mehrere Zugänge haben (zweites Spielkonto, zweiter PC); jeder Zugang hat ein
/// eigenes Token, alle gehören zur selben Person (ein Name, ein Verlauf).
/// </summary>
public sealed class AuthService(SyncDatabase db, TimeProvider clock)
{
    public const int MaxNameLength = 24;

    /// <summary>So lange ist ein Verknüpfungscode gültig.</summary>
    public static readonly TimeSpan LinkCodeValidity = TimeSpan.FromHours(24);

    public IReadOnlyList<string> CreateInvites(int count)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(count, 1);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(count, 50);
        var now = Now;
        return db.Write((c, tx) =>
        {
            var codes = new List<string>(count);
            for (var i = 0; i < count; i++)
            {
                var code = Crypto.NewInviteCode();
                c.Exec(tx, "INSERT INTO invites(code_hash, created_at) VALUES ($h, $t)", ("$h", Crypto.Sha256Hex(code)), ("$t", now));
                codes.Add(code);
            }

            Audit(c, tx, null, "invites_created", count.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return (IReadOnlyList<string>)codes;
        });
    }

    /// <summary>Code für einen weiteren Zugang dieses Spielers (vom Launcher aus).</summary>
    public LinkCode CreateLinkCode(User user)
    {
        ArgumentNullException.ThrowIfNull(user);
        return db.Write((c, tx) => InsertLinkCode(c, tx, user.Id, user.Id));
    }

    /// <summary>Code für einen weiteren Zugang des Spielers <paramref name="name"/> (Kommandozeile des Betreibers).</summary>
    public LinkCode? CreateLinkCodeFor(string name)
    {
        return db.Write((c, tx) =>
        {
            var id = c.Scalar<long?>(tx, "SELECT id FROM users WHERE name = $n", ("$n", name));
            return id is null ? null : InsertLinkCode(c, tx, id.Value, null);
        });
    }

    private LinkCode InsertLinkCode(SqliteConnection c, SqliteTransaction tx, long forUser, long? byUser)
    {
        var now = Now;
        var expires = now + (long)LinkCodeValidity.TotalMilliseconds;
        var code = Crypto.NewInviteCode();
        c.Exec(tx, "INSERT INTO invites(code_hash, created_at, for_user_id, expires_at) VALUES ($h, $t, $u, $e)",
            ("$h", Crypto.Sha256Hex(code)), ("$t", now), ("$u", forUser), ("$e", expires));
        Audit(c, tx, byUser ?? forUser, "link_code_created", null);
        return new LinkCode(code, DateTimeOffset.FromUnixTimeMilliseconds(expires));
    }

    /// <summary>
    /// Löst einen Code ein. Normaler Einladungscode → neuer Spieler mit <paramref name="name"/>.
    /// Verknüpfungscode → neuer Zugang für den bestehenden Spieler; der Name wird dann ignoriert.
    /// </summary>
    public Result<Redeemed> Redeem(string? code, string? name)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return Errors.InviteInvalid;
        }

        var codeHash = Crypto.Sha256Hex(Crypto.NormalizeInviteCode(code));
        var trimmed = name?.Trim() ?? string.Empty;
        var now = Now;
        return db.Write<Result<Redeemed>>((c, tx) =>
        {
            var invite = c.Query(tx, "SELECT id, for_user_id, expires_at FROM invites WHERE code_hash = $h AND used_by IS NULL",
                r => (Id: r.GetInt64(0), ForUser: r.NullableInt64("for_user_id"), ExpiresAt: r.NullableInt64("expires_at")),
                ("$h", codeHash)).FirstOrDefault();
            if (invite == default || (invite.ExpiresAt is { } exp && exp <= now))
            {
                return Errors.InviteInvalid;
            }

            var token = Crypto.NewToken();
            var tokenHash = Crypto.Sha256Hex(token);
            if (invite.ForUser is { } existing)
            {
                var owner = c.Query(tx, "SELECT id, name, blocked FROM users WHERE id = $u", MapUser, ("$u", existing)).FirstOrDefault();
                if (owner is null || owner.Blocked)
                {
                    return Errors.InviteInvalid;
                }

                c.Exec(tx, "INSERT INTO tokens(user_id, token_hash, created_at) VALUES ($u, $h, $t)", ("$u", owner.Id), ("$h", tokenHash), ("$t", now));
                c.Exec(tx, "UPDATE invites SET used_by = $u, used_at = $t WHERE id = $i", ("$u", owner.Id), ("$t", now), ("$i", invite.Id));
                Audit(c, tx, owner.Id, "device_linked", null);
                return Result<Redeemed>.Success(new Redeemed(token, owner.Name, Linked: true));
            }

            if (trimmed.Length is 0 or > MaxNameLength || trimmed.Any(char.IsControl))
            {
                return Errors.Invalid("invalid_name", $"Name muss 1 bis {MaxNameLength} Zeichen haben.");
            }

            if (c.Scalar<long?>(tx, "SELECT id FROM users WHERE name = $n", ("$n", trimmed)) is not null)
            {
                return Errors.NameTaken;
            }

            var userId = c.Scalar<long>(tx, "INSERT INTO users(name, token_hash, created_at) VALUES ($n, $h, $t) RETURNING id", ("$n", trimmed), ("$h", tokenHash), ("$t", now));
            c.Exec(tx, "INSERT INTO tokens(user_id, token_hash, created_at) VALUES ($u, $h, $t)", ("$u", userId), ("$h", tokenHash), ("$t", now));
            c.Exec(tx, "UPDATE invites SET used_by = $u, used_at = $t WHERE id = $i", ("$u", userId), ("$t", now), ("$i", invite.Id));
            Audit(c, tx, userId, "joined", null);
            return Result<Redeemed>.Success(new Redeemed(token, trimmed, Linked: false));
        });
    }

    public User? Authenticate(string? token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 200)
        {
            return null;
        }

        var hash = Crypto.Sha256Hex(token);
        var user = db.Read(c => c.Query(null,
            "SELECT u.id, u.name, u.blocked, t.id FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $h",
            r => new User(r.GetInt64(0), r.GetString(1), r.GetInt64(2) != 0, r.GetInt64(3)),
            ("$h", hash)).FirstOrDefault());
        return user is { Blocked: false } ? user : null;
    }

    public IReadOnlyList<User> ListUsers() =>
        db.Read(c => c.Query(null, "SELECT id, name, blocked FROM users ORDER BY name", MapUser));

    /// <summary>Anzahl Zugänge je Spieler (für die Kommandozeile).</summary>
    public IReadOnlyDictionary<string, int> DeviceCounts() =>
        db.Read(c => c.Query(null, "SELECT u.name, COUNT(t.id) FROM users u LEFT JOIN tokens t ON t.user_id = u.id GROUP BY u.id",
            r => (Name: r.GetString(0), Count: r.GetInt32(1)))).ToDictionary(x => x.Name, x => x.Count, StringComparer.OrdinalIgnoreCase);

    public bool SetBlocked(string name, bool blocked)
    {
        return db.Write((c, tx) =>
        {
            var id = c.Scalar<long?>(tx, "SELECT id FROM users WHERE name = $n", ("$n", name));
            if (id is null)
            {
                return false;
            }

            c.Exec(tx, "UPDATE users SET blocked = $b WHERE id = $i", ("$b", blocked ? 1 : 0), ("$i", id));
            Audit(c, tx, id, blocked ? "blocked" : "unblocked", null);
            return true;
        });
    }

    /// <summary>
    /// Führt Spieler <paramref name="merge"/> in <paramref name="keep"/> zusammen: alle Zugänge, Versionen,
    /// Verlaufseinträge und eine laufende Host-Rolle gehen auf <paramref name="keep"/> über, dann wird
    /// <paramref name="merge"/> entfernt. Für einen Spieler, der zwei Einladungscodes eingelöst hat.
    /// </summary>
    public Result<string> LinkUsers(string keep, string merge)
    {
        return db.Write<Result<string>>((c, tx) =>
        {
            var keepId = c.Scalar<long?>(tx, "SELECT id FROM users WHERE name = $n", ("$n", keep));
            var mergeId = c.Scalar<long?>(tx, "SELECT id FROM users WHERE name = $n", ("$n", merge));
            if (keepId is null || mergeId is null)
            {
                return Errors.Invalid("unknown_user", $"Unbekannter Spieler: {(keepId is null ? keep : merge)}");
            }

            if (keepId == mergeId)
            {
                return Errors.Invalid("same_user", "Das ist derselbe Spieler.");
            }

            (string Sql, string Name)[] moves =
            [
                ("UPDATE tokens SET user_id = $k WHERE user_id = $m", "tokens"),
                ("UPDATE versions SET uploaded_by = $k WHERE uploaded_by = $m", "versions"),
                ("UPDATE audit_log SET user_id = $k WHERE user_id = $m", "audit"),
                ("UPDATE invites SET used_by = $k WHERE used_by = $m", "invites_used"),
                ("UPDATE invites SET for_user_id = $k WHERE for_user_id = $m", "invites_for"),
                ("UPDATE leases SET user_id = $k WHERE user_id = $m", "lease"),
                ("UPDATE OR IGNORE device_presence SET user_id = $k WHERE user_id = $m", "presence"),
                ("DELETE FROM device_presence WHERE user_id = $m", "presence_rest"),
                ("DELETE FROM presence WHERE user_id = $m", "old_presence"),
                ("UPDATE OR IGNORE idempotency SET user_id = $k WHERE user_id = $m", "idempotency"),
                ("DELETE FROM idempotency WHERE user_id = $m", "idempotency_rest"),
            ];
            foreach (var (sql, _) in moves)
            {
                c.Exec(tx, sql, ("$k", keepId), ("$m", mergeId));
            }

            c.Exec(tx, "DELETE FROM users WHERE id = $m", ("$m", mergeId));
            var keepName = c.Scalar<string>(tx, "SELECT name FROM users WHERE id = $k", ("$k", keepId))!;
            Audit(c, tx, keepId, "users_linked", $"{merge} → {keepName}");
            return Result<string>.Success(keepName);
        });
    }

    private long Now => clock.GetUtcNow().ToUnixTimeMilliseconds();

    private void Audit(SqliteConnection c, SqliteTransaction tx, long? userId, string action, string? details) =>
        c.Exec(tx, "INSERT INTO audit_log(at, user_id, action, details) VALUES ($t, $u, $a, $d)", ("$t", Now), ("$u", userId), ("$a", action), ("$d", details));

    private static User MapUser(SqliteDataReader r) => new(r.GetInt64(0), r.GetString(1), r.GetInt64(2) != 0);
}
