using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using SatisfactorySync.Core.Data;
using SatisfactorySync.Core.Saves;

namespace SatisfactorySync.Core;

public sealed record UploadRequest(long? LeaseToken, long BaseVersionId, string Sha256, string IdempotencyKey);

/// <param name="Accepted">true = neuer Head; false = als Konfliktkopie gespeichert.</param>
public sealed record UploadResult(bool Accepted, VersionInfo Version, string? ConflictReason, string? Message);

/// <summary>
/// Lease, Fencing, Versionen, Anwesenheit (Plan 5). Alle Entscheidungen fallen in einer
/// serialisierten SQLite-Transaktion (<see cref="SyncDatabase.Write{T}"/>).
/// </summary>
public sealed class SyncService(SyncDatabase db, SyncOptions options, TimeProvider clock, IDiskSpace disk)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private const string VersionColumns = """
        v.id, v.number, v.sha256, v.size, v.play_seconds, v.build_version, v.session_name,
        u.name AS uploaded_by, v.uploaded_at, v.type, v.base_version_id, v.conflict_reason,
        v.restored_from, v.pruned, v.map_json IS NOT NULL AS has_map
        """;

    private long Now => clock.GetUtcNow().ToUnixTimeMilliseconds();

    // ---------------------------------------------------------------- Status

    public WorldStatus GetWorld() => db.Read(c =>
    {
        var (session, headId) = ReadWorld(c, null);
        var head = headId is { } h ? GetVersion(c, null, h) : null;
        return new WorldStatus(session, head, ReadHost(c, null), clock.GetUtcNow());
    });

    // ---------------------------------------------------------------- Lease

    public Result<LeaseGrant> AcquireLease(User user)
    {
        ArgumentNullException.ThrowIfNull(user);
        var now = Now;
        return db.Write<Result<LeaseGrant>>((c, tx) =>
        {
            var lease = ReadLease(c, tx);
            if (lease is not null && lease.ExpiresAt > now)
            {
                return Errors.LeaseHeld(ReadHost(c, tx)!);
            }

            var token = c.Scalar<long>(tx, "UPDATE fencing_counter SET value = value + 1 WHERE id = 1 RETURNING value");
            var (_, headId) = ReadWorld(c, tx);
            var leaseId = Guid.NewGuid().ToString("N");
            var expires = now + (long)options.LeaseDuration.TotalMilliseconds;
            c.Exec(tx, """
                INSERT OR REPLACE INTO leases(id, lease_id, user_id, fencing_token, base_version_id, acquired_at, expires_at, device_id)
                VALUES (1, $l, $u, $f, $b, $n, $e, $d)
                """, ("$l", leaseId), ("$u", user.Id), ("$f", token), ("$b", headId), ("$n", now), ("$e", expires), ("$d", user.DeviceId == 0 ? null : user.DeviceId));
            Audit(c, tx, user.Id, "lease_acquired", $"token={token}");
            var head = headId is { } h ? GetVersion(c, tx, h) : null;
            return Result<LeaseGrant>.Success(new LeaseGrant(leaseId, token, headId ?? 0, DateTimeOffset.FromUnixTimeMilliseconds(expires), head));
        });
    }

    /// <summary>
    /// Verlängert die Lease. Ist sie abgelaufen, aber hat seitdem niemand eine neue bekommen
    /// (Token ist noch das aktuelle), wird sie wiederbelebt – das ist sicher, weil jede neue Lease
    /// den Fencing-Zähler erhöhen würde.
    /// </summary>
    public Result<DateTimeOffset> Heartbeat(User user, long fencingToken)
    {
        ArgumentNullException.ThrowIfNull(user);
        var now = Now;
        return db.Write<Result<DateTimeOffset>>((c, tx) =>
        {
            if (!HoldsCurrentToken(c, tx, user, fencingToken))
            {
                return Errors.LeaseLost;
            }

            var expires = now + (long)options.LeaseDuration.TotalMilliseconds;
            c.Exec(tx, "UPDATE leases SET expires_at = $e WHERE id = 1", ("$e", expires));
            return Result<DateTimeOffset>.Success(DateTimeOffset.FromUnixTimeMilliseconds(expires));
        });
    }

    public Result<bool> ReleaseLease(User user, long fencingToken)
    {
        ArgumentNullException.ThrowIfNull(user);
        return db.Write<Result<bool>>((c, tx) =>
        {
            if (!HoldsCurrentToken(c, tx, user, fencingToken))
            {
                return Errors.LeaseLost;
            }

            c.Exec(tx, "DELETE FROM leases WHERE id = 1");
            Audit(c, tx, user.Id, "lease_released", $"token={fencingToken}");
            return Result<bool>.Success(true);
        });
    }

    /// <summary>
    /// Hängende Lease lösen: nur wenn abgelaufen oder vom hostenden Gerät selbst. Ein zweiter Zugang
    /// desselben Spielers darf eine laufende Host-Rolle nicht wegnehmen.
    /// </summary>
    public Result<bool> ForceRelease(User user)
    {
        ArgumentNullException.ThrowIfNull(user);
        var now = Now;
        return db.Write<Result<bool>>((c, tx) =>
        {
            var lease = ReadLease(c, tx);
            if (lease is null)
            {
                return Result<bool>.Success(false);
            }

            if (lease.ExpiresAt > now && !IsHostDevice(lease, user))
            {
                return Errors.LeaseActive;
            }

            c.Exec(tx, "DELETE FROM leases WHERE id = 1");
            Audit(c, tx, user.Id, "lease_force_released", $"token={lease.FencingToken}");
            return Result<bool>.Success(true);
        });
    }

    // ---------------------------------------------------------------- Upload

    /// <summary>Gespeicherte Antwort zu einem Idempotency-Key, falls es den Upload schon gab.</summary>
    public UploadResult? FindIdempotent(User user, string key)
    {
        ArgumentNullException.ThrowIfNull(user);
        var body = db.Read(c => c.Scalar<string>(null, "SELECT body FROM idempotency WHERE user_id = $u AND key = $k", ("$u", user.Id), ("$k", key)));
        return body is null ? null : JsonSerializer.Deserialize<UploadResult>(body, Json);
    }

    public bool HasRoomFor(long incomingBytes) =>
        disk.AvailableBytes(options.DataDir) - Math.Max(0, incomingBytes) >= options.MinFreeBytes;

    /// <summary>
    /// Plan 5.3: Datei in temporäre Datei streamen (nie in den RAM), Hash und Header prüfen,
    /// dann in einer Transaktion entweder neuer Head oder Konfliktkopie.
    /// </summary>
    public async Task<Result<UploadResult>> UploadAsync(User user, UploadRequest request, Stream body, long? contentLength, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(user);
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(body);

        if (string.IsNullOrWhiteSpace(request.IdempotencyKey) || request.IdempotencyKey.Length > 100)
        {
            return Errors.Invalid("invalid_idempotency_key", "Idempotency-Key fehlt oder ist zu lang.");
        }

        if (!Crypto.IsSha256Hex(request.Sha256))
        {
            return Errors.Invalid("invalid_sha256", "Content-SHA256 fehlt oder ist ungültig.");
        }

        if (FindIdempotent(user, request.IdempotencyKey) is { } earlier)
        {
            return Result<UploadResult>.Success(earlier);
        }

        if (contentLength > options.MaxUploadBytes)
        {
            return Errors.TooLarge;
        }

        if (!HasRoomFor(contentLength ?? 0))
        {
            return Errors.DiskFull;
        }

        var temp = Path.Combine(options.TempDir, $"{Guid.NewGuid():N}.part");
        try
        {
            var (sha, size) = await WriteTempAsync(body, temp, ct).ConfigureAwait(false);
            if (size > options.MaxUploadBytes)
            {
                return Errors.TooLarge;
            }

            if (!string.Equals(sha, request.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                return Errors.HashMismatch;
            }

            if (!HasRoomFor(0))
            {
                return Errors.DiskFull;
            }

            SaveHeader header;
            try
            {
                header = SaveHeaderParser.ParseFile(temp);
            }
            catch (SaveHeaderException ex)
            {
                return Errors.InvalidSave(ex.Message);
            }

            var outcome = Commit(user, request, temp, sha, size, header);
            if (outcome.Ok)
            {
                temp = null; // verschoben
                PruneFiles(outcome.Value!.Pruned);
            }

            return outcome.Ok ? Result<UploadResult>.Success(outcome.Value!.Result) : Result<UploadResult>.Fail(outcome.Error!);
        }
        finally
        {
            if (temp is not null && File.Exists(temp))
            {
                File.Delete(temp);
            }
        }
    }

    private sealed record CommitOutcome(UploadResult Result, IReadOnlyList<long> Pruned);

    private Result<CommitOutcome> Commit(User user, UploadRequest req, string temp, string sha, long size, SaveHeader header)
    {
        var now = Now;
        return db.Write<Result<CommitOutcome>>((c, tx) =>
        {
            // Erneut prüfen – ein paralleler Retry mit demselben Key könnte inzwischen fertig sein.
            var stored = c.Scalar<string>(tx, "SELECT body FROM idempotency WHERE user_id = $u AND key = $k", ("$u", user.Id), ("$k", req.IdempotencyKey));
            if (stored is not null)
            {
                File.Delete(temp);
                return Result<CommitOutcome>.Success(new CommitOutcome(JsonSerializer.Deserialize<UploadResult>(stored, Json)!, []));
            }

            var (session, headId) = ReadWorld(c, tx);
            if (session is not null && !string.Equals(session, header.SessionName, StringComparison.Ordinal))
            {
                return Errors.WrongSession(session, header.SessionName);
            }

            var head = headId is { } h ? GetVersion(c, tx, h) : null;
            var reason = ConflictReason(c, tx, user, req, headId, head, header, now);

            var type = reason is null ? VersionType.Normal : VersionType.Conflict;
            long? number = reason is null ? (c.Scalar<long?>(tx, "SELECT MAX(number) FROM versions") ?? 0) + 1 : null;
            var id = c.Scalar<long>(tx, """
                INSERT INTO versions(number, sha256, size, play_seconds, build_version, save_version, header_version,
                  session_name, uploaded_by, uploaded_at, type, base_version_id, fencing_token, conflict_reason)
                VALUES ($num, $sha, $size, $play, $build, $sv, $hv, $sess, $u, $t, $type, $base, $tok, $reason)
                RETURNING id
                """,
                ("$num", number), ("$sha", sha.ToLowerInvariant()), ("$size", size), ("$play", header.PlayDurationSeconds),
                ("$build", header.BuildVersion), ("$sv", header.SaveVersion), ("$hv", header.HeaderVersion),
                ("$sess", header.SessionName), ("$u", user.Id), ("$t", now), ("$type", type),
                ("$base", req.BaseVersionId), ("$tok", req.LeaseToken), ("$reason", reason));

            IReadOnlyList<long> pruned = [];
            if (reason is null)
            {
                c.Exec(tx, "UPDATE world SET head_version_id = $v, session_name = COALESCE(session_name, $s) WHERE id = 1", ("$v", id), ("$s", header.SessionName));
                c.Exec(tx, "UPDATE leases SET base_version_id = $v WHERE id = 1", ("$v", id));
                Audit(c, tx, user.Id, "version_uploaded", $"version={number}");
                pruned = MarkPrunable(c, tx, id, now);
            }
            else
            {
                Audit(c, tx, user.Id, "conflict_copy", $"id={id} reason={reason}");
            }

            var info = GetVersion(c, tx, id)!;
            var result = new UploadResult(reason is null, info, reason, reason is null ? null : ConflictMessage(reason));
            c.Exec(tx, "INSERT INTO idempotency(user_id, key, status, body, created_at) VALUES ($u, $k, $s, $b, $t)",
                ("$u", user.Id), ("$k", req.IdempotencyKey), ("$s", reason is null ? 201 : 409),
                ("$b", JsonSerializer.Serialize(result, Json)), ("$t", now));

            // Als letzter Schritt vor dem Commit atomar ablegen. Schlägt das fehl, wird zurückgerollt.
            PlaceFile(temp, id);
            return Result<CommitOutcome>.Success(new CommitOutcome(result, pruned));
        });
    }

    private static string? ConflictReason(SqliteConnection c, SqliteTransaction tx, User user, UploadRequest req, long? headId, VersionInfo? head, SaveHeader header, long now)
    {
        if (req.LeaseToken is not { } token)
        {
            return "no_lease";
        }

        var current = c.Scalar<long>(tx, "SELECT value FROM fencing_counter WHERE id = 1");
        var lease = ReadLease(c, tx);
        if (token != current || lease is null || lease.FencingToken != token || !IsHostDevice(lease, user))
        {
            return "stale_token";
        }

        if (lease.ExpiresAt <= now)
        {
            return "lease_expired";
        }

        if (req.BaseVersionId != (headId ?? 0))
        {
            return "base_mismatch";
        }

        if (head is not null && header.PlayDurationSeconds < head.PlaySeconds)
        {
            return "playtime_regressed";
        }

        return null;
    }

    private static string ConflictMessage(string reason) => reason switch
    {
        "no_lease" => "Ohne Host-Rolle hochgeladen. Als Konfliktkopie gespeichert.",
        "stale_token" => "Inzwischen hat jemand anderes gehostet. Als Konfliktkopie gespeichert.",
        "lease_expired" => "Die Host-Rolle war abgelaufen. Als Konfliktkopie gespeichert.",
        "base_mismatch" => "Der Stand auf dem Server ist neuer. Als Konfliktkopie gespeichert.",
        "playtime_regressed" => "Weniger Spielzeit als der aktuelle Stand. Als Konfliktkopie gespeichert.",
        _ => "Als Konfliktkopie gespeichert.",
    };

    private static async Task<(string Sha, long Size)> WriteTempAsync(Stream body, string temp, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[81920];
        long size = 0;
        var fs = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true);
        await using (fs.ConfigureAwait(false))
        {
            int read;
            while ((read = await body.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
            {
                hash.AppendData(buffer, 0, read);
                await fs.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                size += read;
            }

            await fs.FlushAsync(ct).ConfigureAwait(false);
            fs.Flush(flushToDisk: true);
        }

        return (Convert.ToHexStringLower(hash.GetHashAndReset()), size);
    }

    // ---------------------------------------------------------------- Versionen

    public IReadOnlyList<VersionInfo> ListVersions(int limit = 100) => db.Read(c =>
        c.Query(null, $"SELECT {VersionColumns} FROM versions v JOIN users u ON u.id = v.uploaded_by WHERE v.pruned = 0 ORDER BY v.id DESC LIMIT $l", MapVersion, ("$l", limit)));

    public Result<(VersionInfo Info, string Path)> OpenFile(long versionId)
    {
        var info = db.Read(c => GetVersion(c, null, versionId));
        if (info is null || info.Pruned || !File.Exists(VersionPath(versionId)))
        {
            return Errors.VersionNotFound;
        }

        return Result<(VersionInfo, string)>.Success((info, VersionPath(versionId)));
    }

    /// <summary>Alte Version (auch Konfliktkopie) als neue Version zum Head machen. Nur ohne aktiven Host.</summary>
    public Result<VersionInfo> Restore(User user, long versionId)
    {
        ArgumentNullException.ThrowIfNull(user);
        var now = Now;
        var source = VersionPath(versionId);
        var temp = Path.Combine(options.TempDir, $"{Guid.NewGuid():N}.restore");
        try
        {
            var result = db.Write<Result<VersionInfo>>((c, tx) =>
            {
                var lease = ReadLease(c, tx);
                if (lease is not null && lease.ExpiresAt > now)
                {
                    return Errors.HostActive;
                }

                var src = GetVersion(c, tx, versionId);
                if (src is null || src.Pruned || !File.Exists(source))
                {
                    return Errors.VersionNotFound;
                }

                if (!HasRoomFor(src.Size))
                {
                    return Errors.DiskFull;
                }

                File.Copy(source, temp);
                var number = (c.Scalar<long?>(tx, "SELECT MAX(number) FROM versions") ?? 0) + 1;
                var id = c.Scalar<long>(tx, """
                    INSERT INTO versions(number, sha256, size, play_seconds, build_version, save_version, header_version,
                      session_name, uploaded_by, uploaded_at, type, base_version_id, restored_from, map_json)
                    SELECT $num, sha256, size, play_seconds, build_version, save_version, header_version,
                      session_name, $u, $t, 'import', $base, id, map_json FROM versions WHERE id = $src
                    RETURNING id
                    """, ("$num", number), ("$u", user.Id), ("$t", now), ("$base", ReadWorld(c, tx).HeadId), ("$src", versionId));
                // Der Head bestimmt die Welt: auch der Sessionname folgt der zurückgeholten Version
                // (wichtig, wenn noch keine normale Version existierte und der Name leer war).
                c.Exec(tx, "UPDATE world SET head_version_id = $v, session_name = $s WHERE id = 1", ("$v", id), ("$s", src.SessionName));
                // Eine abgelaufene Lease darf nach dem Zurückholen nicht wiederbelebt werden.
                c.Exec(tx, "DELETE FROM leases WHERE id = 1");
                Audit(c, tx, user.Id, "version_restored", $"from={src.Label} to={number}");
                var info = GetVersion(c, tx, id)!;
                PlaceFile(temp, id);
                return Result<VersionInfo>.Success(info);
            });
            return result;
        }
        finally
        {
            if (File.Exists(temp))
            {
                File.Delete(temp);
            }
        }
    }

    public Result<bool> PutMap(User user, long versionId, string json)
    {
        ArgumentNullException.ThrowIfNull(user);
        ArgumentNullException.ThrowIfNull(json);
        if (json.Length > options.MaxMapBytes)
        {
            return Errors.TooLarge;
        }

        try
        {
            using var _ = JsonDocument.Parse(json);
        }
        catch (JsonException)
        {
            return Errors.Invalid("invalid_json", "Karten-Daten sind kein gültiges JSON.");
        }

        return db.Write<Result<bool>>((c, tx) =>
        {
            var owner = c.Scalar<long?>(tx, "SELECT uploaded_by FROM versions WHERE id = $v", ("$v", versionId));
            if (owner is null)
            {
                return Errors.VersionNotFound;
            }

            if (owner != user.Id)
            {
                return Errors.NotUploader;
            }

            c.Exec(tx, "UPDATE versions SET map_json = $j WHERE id = $v", ("$j", json), ("$v", versionId));
            return Result<bool>.Success(true);
        });
    }

    public Result<string> GetMap(long versionId)
    {
        var json = db.Read(c => c.Scalar<string>(null, "SELECT map_json FROM versions WHERE id = $v", ("$v", versionId)));
        return json is null ? Errors.MapNotFound : Result<string>.Success(json);
    }

    // ---------------------------------------------------------------- Anwesenheit

    public void SetPresence(User user, string status)
    {
        ArgumentNullException.ThrowIfNull(user);
        if (!PresenceStatus.IsValid(status))
        {
            throw new ArgumentException("Ungültiger Status.", nameof(status));
        }

        var now = Now;
        db.Write((c, tx) => c.Exec(tx, """
            INSERT INTO device_presence(user_id, device_id, status, last_seen) VALUES ($u, $d, $s, $t)
            ON CONFLICT(user_id, device_id) DO UPDATE SET status = excluded.status, last_seen = excluded.last_seen
            """, ("$u", user.Id), ("$d", user.DeviceId), ("$s", status), ("$t", now)));
    }

    public IReadOnlyList<CrewMember> GetCrew() => db.Read(c =>
    {
        var now = Now;
        var offlineAfter = (long)options.OfflineAfter.TotalMilliseconds;
        var lease = ReadLease(c, null);
        var hostId = lease is not null && lease.ExpiresAt > now ? lease.UserId : (long?)null;
        // Mehrere Geräte je Spieler: online, wenn eines online ist; „im Spiel“, wenn eines im Spiel ist.
        var devices = c.Query(null, "SELECT user_id, status, last_seen FROM device_presence",
            r => (UserId: r.GetInt64(0), Status: r.GetString(1), LastSeen: r.GetInt64(2)))
            .ToLookup(d => d.UserId);
        return c.Query(null, "SELECT id, name FROM users WHERE blocked = 0 ORDER BY name", r =>
        {
            var id = r.GetInt64(0);
            var mine = devices[id].ToList();
            long? lastSeen = mine.Count == 0 ? null : mine.Max(d => d.LastSeen);
            var onlineDevices = mine.Where(d => now - d.LastSeen <= offlineAfter).ToList();
            var online = onlineDevices.Count > 0;
            string? status = !online ? null
                : onlineDevices.Any(d => d.Status == PresenceStatus.InGame) ? PresenceStatus.InGame
                : PresenceStatus.Launcher;
            return new CrewMember(
                r.GetString(1),
                online,
                status,
                lastSeen is { } t ? DateTimeOffset.FromUnixTimeMilliseconds(t) : null,
                hostId == id);
        });
    });

    public IReadOnlyList<AuditEntry> GetAudit(int limit = 100) => db.Read(c => c.Query(null, """
        SELECT a.at, u.name, a.action, a.details FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC LIMIT $l
        """, r => new AuditEntry(DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(0)), r.NullableString("name"), r.GetString(2), r.NullableString("details")), ("$l", limit)));

    // ---------------------------------------------------------------- intern

    private sealed record LeaseRow(string LeaseId, long UserId, long FencingToken, long? BaseVersionId, long AcquiredAt, long ExpiresAt, long? DeviceId);

    private string VersionPath(long id) => Path.Combine(options.VersionsDir, id.ToString(CultureInfo.InvariantCulture) + ".sav");

    /// <summary>
    /// Legt die Datei per Umbenennen ab. Liegt dort schon eine (verwaiste) Datei, etwa nach einem
    /// Absturz zwischen Umbenennen und Commit, wird sie nach orphans/ verschoben, nie überschrieben.
    /// </summary>
    private void PlaceFile(string temp, long id)
    {
        var target = VersionPath(id);
        if (File.Exists(target))
        {
            var orphans = Path.Combine(options.DataDir, "orphans");
            Directory.CreateDirectory(orphans);
            File.Move(target, Path.Combine(orphans, $"{id}-{Now}.sav"));
        }

        File.Move(temp, target);
    }

    /// <summary>Gehört die Lease diesem Spieler UND diesem Zugang (Gerät)? Alte Leases ohne Gerät: nur Spieler.</summary>
    private static bool IsHostDevice(LeaseRow lease, User user) =>
        lease.UserId == user.Id && (lease.DeviceId is null || lease.DeviceId == user.DeviceId);

    private static LeaseRow? ReadLease(SqliteConnection c, SqliteTransaction? tx) =>
        c.Query(tx, "SELECT lease_id, user_id, fencing_token, base_version_id, acquired_at, expires_at, device_id FROM leases WHERE id = 1",
            r => new LeaseRow(r.GetString(0), r.GetInt64(1), r.GetInt64(2), r.NullableInt64("base_version_id"), r.GetInt64(4), r.GetInt64(5), r.NullableInt64("device_id"))).FirstOrDefault();

    private HostInfo? ReadHost(SqliteConnection c, SqliteTransaction? tx)
    {
        var now = Now;
        return c.Query(tx, "SELECT u.name, l.acquired_at, l.expires_at FROM leases l JOIN users u ON u.id = l.user_id WHERE l.id = 1",
            r => new HostInfo(
                r.GetString(0),
                DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(1)),
                DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(2)),
                r.GetInt64(2) <= now)).FirstOrDefault();
    }

    private static bool HoldsCurrentToken(SqliteConnection c, SqliteTransaction tx, User user, long token)
    {
        var lease = ReadLease(c, tx);
        var current = c.Scalar<long>(tx, "SELECT value FROM fencing_counter WHERE id = 1");
        return lease is not null && IsHostDevice(lease, user) && lease.FencingToken == token && token == current;
    }

    private static (string? Session, long? HeadId) ReadWorld(SqliteConnection c, SqliteTransaction? tx) =>
        c.Query(tx, "SELECT session_name, head_version_id FROM world WHERE id = 1", r => (r.NullableString("session_name"), r.NullableInt64("head_version_id"))).Single();

    private static VersionInfo? GetVersion(SqliteConnection c, SqliteTransaction? tx, long id) =>
        c.Query(tx, $"SELECT {VersionColumns} FROM versions v JOIN users u ON u.id = v.uploaded_by WHERE v.id = $id", MapVersion, ("$id", id)).FirstOrDefault();

    private static VersionInfo MapVersion(SqliteDataReader r)
    {
        var id = r.GetInt64(0);
        var number = r.NullableInt64("number");
        return new VersionInfo(
            id,
            number,
            number is { } n ? n.ToString(CultureInfo.InvariantCulture) : $"K-{id}",
            r.GetString(2),
            r.GetInt64(3),
            r.GetInt32(4),
            r.GetInt32(5),
            r.GetString(6),
            r.GetString(7),
            DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(8)),
            r.GetString(9),
            r.NullableInt64("base_version_id"),
            r.NullableString("conflict_reason"),
            r.NullableInt64("restored_from"),
            r.GetInt64(13) != 0,
            r.GetInt64(14) != 0);
    }

    private IReadOnlyList<long> MarkPrunable(SqliteConnection c, SqliteTransaction tx, long headId, long now)
    {
        var candidates = c.Query(tx, "SELECT id, number, type, uploaded_at FROM versions WHERE pruned = 0",
            r => new RetentionCandidate(r.GetInt64(0), r.NullableInt64("number"), r.GetString(2), DateTimeOffset.FromUnixTimeMilliseconds(r.GetInt64(3))));
        var prune = Retention.SelectPrunable(candidates, headId, DateTimeOffset.FromUnixTimeMilliseconds(now), options.KeepLatest, options.KeepDailyDays);
        foreach (var id in prune)
        {
            c.Exec(tx, "UPDATE versions SET pruned = 1 WHERE id = $i", ("$i", id));
        }

        return [.. prune];
    }

    /// <summary>Löscht Backup-Dateien erst nach dem Commit (eine zurückgerollte Transaktion darf nichts gelöscht haben).</summary>
    private void PruneFiles(IReadOnlyList<long> ids)
    {
        foreach (var id in ids)
        {
            try
            {
                File.Delete(VersionPath(id));
            }
            catch (IOException)
            {
                // Bleibt liegen; ist als pruned markiert und wird nicht mehr ausgeliefert.
            }
        }
    }

    private void Audit(SqliteConnection c, SqliteTransaction tx, long? userId, string action, string? details) =>
        c.Exec(tx, "INSERT INTO audit_log(at, user_id, action, details) VALUES ($t, $u, $a, $d)", ("$t", Now), ("$u", userId), ("$a", action), ("$d", details));
}
