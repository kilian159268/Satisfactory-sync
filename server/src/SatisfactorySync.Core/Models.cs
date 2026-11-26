namespace SatisfactorySync.Core;

public sealed record User(long Id, string Name, bool Blocked);

public static class VersionType
{
    public const string Normal = "normal";
    public const string Conflict = "konflikt";
    public const string Import = "import";
}

public sealed record VersionInfo(
    long Id,
    long? Number,
    string Label,
    string Sha256,
    long Size,
    int PlaySeconds,
    int BuildVersion,
    string SessionName,
    string UploadedBy,
    DateTimeOffset UploadedAt,
    string Type,
    long? BaseVersionId,
    string? ConflictReason,
    long? RestoredFrom,
    bool Pruned,
    bool HasMap);

public sealed record HostInfo(string Name, DateTimeOffset Since, DateTimeOffset ExpiresAt, bool Expired);

public sealed record WorldStatus(string? SessionName, VersionInfo? Head, HostInfo? Host, DateTimeOffset ServerTime);

public sealed record LeaseGrant(string LeaseId, long FencingToken, long HeadVersionId, DateTimeOffset ExpiresAt, VersionInfo? Head);

public sealed record CrewMember(string Name, bool Online, string? Status, DateTimeOffset? LastSeen, bool IsHost);

public sealed record AuditEntry(DateTimeOffset At, string? User, string Action, string? Details);

public static class PresenceStatus
{
    public const string Launcher = "launcher";
    public const string InGame = "im_spiel";

    public static bool IsValid(string? s) => s is Launcher or InGame;
}
