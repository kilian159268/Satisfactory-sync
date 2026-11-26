namespace SatisfactorySync.Core;

public sealed record RetentionCandidate(long Id, long? Number, string Type, DateTimeOffset UploadedAt);

/// <summary>Plan 5.4: die letzten N Versionen + eine pro Tag für M Tage. Der Head bleibt immer.</summary>
public static class Retention
{
    public static IReadOnlySet<long> SelectPrunable(
        IEnumerable<RetentionCandidate> versions,
        long? headId,
        DateTimeOffset now,
        int keepLatest,
        int keepDailyDays)
    {
        ArgumentNullException.ThrowIfNull(versions);
        var all = versions.ToList();
        var keep = new HashSet<long>();
        if (headId is { } h)
        {
            keep.Add(h);
        }

        var cutoff = now.AddDays(-keepDailyDays);
        var mainLine = all.Where(v => v.Type != VersionType.Conflict).OrderByDescending(v => v.Number ?? 0).ThenByDescending(v => v.Id).ToList();

        foreach (var v in mainLine.Take(keepLatest))
        {
            keep.Add(v.Id);
        }

        foreach (var day in mainLine.Where(v => v.UploadedAt >= cutoff).GroupBy(v => v.UploadedAt.UtcDateTime.Date))
        {
            keep.Add(day.First().Id);
        }

        foreach (var c in all.Where(v => v.Type == VersionType.Conflict && v.UploadedAt >= cutoff))
        {
            keep.Add(c.Id);
        }

        return all.Where(v => !keep.Contains(v.Id)).Select(v => v.Id).ToHashSet();
    }
}
