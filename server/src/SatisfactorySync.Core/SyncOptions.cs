namespace SatisfactorySync.Core;

public sealed class SyncOptions
{
    public const string Section = "Sync";

    /// <summary>Datenverzeichnis (SQLite + Save-Dateien), z. B. /var/lib/satisfactory-sync.</summary>
    public string DataDir { get; set; } = "data";

    public TimeSpan LeaseDuration { get; set; } = TimeSpan.FromMinutes(2);

    /// <summary>Nach dieser Zeit ohne Lebenszeichen gilt ein Spieler als offline.</summary>
    public TimeSpan OfflineAfter { get; set; } = TimeSpan.FromSeconds(90);

    /// <summary>Uploads werden abgelehnt, wenn danach weniger frei wäre.</summary>
    public long MinFreeBytes { get; set; } = 2L * 1024 * 1024 * 1024;

    public long MaxUploadBytes { get; set; } = 512L * 1024 * 1024;

    public int MaxMapBytes { get; set; } = 4 * 1024 * 1024;

    /// <summary>Aufbewahrung: die letzten N Versionen ...</summary>
    public int KeepLatest { get; set; } = 20;

    /// <summary>... plus eine pro Tag für so viele Tage (gilt auch für Konfliktkopien).</summary>
    public int KeepDailyDays { get; set; } = 30;

    public string DatabasePath => Path.Combine(DataDir, "sync.db");

    public string VersionsDir => Path.Combine(DataDir, "versions");

    public string TempDir => Path.Combine(DataDir, "tmp");
}
