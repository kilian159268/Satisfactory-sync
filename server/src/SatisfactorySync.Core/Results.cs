namespace SatisfactorySync.Core;

public enum ErrorKind
{
    Invalid,
    Unauthorized,
    NotFound,
    Conflict,
    Unprocessable,
    TooLarge,
    InsufficientStorage,
}

/// <param name="Code">Maschinenlesbar, stabil (für den Launcher).</param>
/// <param name="Message">Kurz, auf Deutsch, für die Anzeige.</param>
public sealed record SyncError(ErrorKind Kind, string Code, string Message, object? Details = null);

public sealed class Result<T>
{
    private Result(T? value, SyncError? error)
    {
        Value = value;
        Error = error;
    }

    public T? Value { get; }

    public SyncError? Error { get; }

    public bool Ok => Error is null;

#pragma warning disable CA1000 // Fabrikmethoden auf generischem Typ sind hier gewollt.
    public static Result<T> Success(T value) => new(value, null);

    public static Result<T> Fail(SyncError error) => new(default, error);
#pragma warning restore CA1000

    public static implicit operator Result<T>(SyncError error) => Fail(error);
}

public static class Errors
{
    public static SyncError LeaseHeld(HostInfo host) =>
        new(ErrorKind.Conflict, "lease_held", $"{host.Name} hostet gerade.", host);

    public static readonly SyncError LeaseLost =
        new(ErrorKind.Conflict, "lease_lost", "Die Host-Rolle ist nicht mehr gültig.");

    public static readonly SyncError LeaseActive =
        new(ErrorKind.Conflict, "lease_active", "Jemand hostet gerade. Lösen geht erst nach Ablauf.");

    public static readonly SyncError HostActive =
        new(ErrorKind.Conflict, "host_active", "Geht nur, wenn niemand hostet.");

    public static readonly SyncError VersionNotFound =
        new(ErrorKind.NotFound, "version_not_found", "Version nicht gefunden.");

    public static readonly SyncError MapNotFound =
        new(ErrorKind.NotFound, "map_not_found", "Keine Karte zu dieser Version.");

    public static readonly SyncError HashMismatch =
        new(ErrorKind.Invalid, "hash_mismatch", "Prüfsumme stimmt nicht. Bitte erneut hochladen.");

    public static readonly SyncError DiskFull =
        new(ErrorKind.InsufficientStorage, "disk_full", "Speicher auf dem Server ist voll. Dein Stand bleibt lokal.");

    public static readonly SyncError TooLarge =
        new(ErrorKind.TooLarge, "too_large", "Datei ist zu groß.");

    public static SyncError InvalidSave(string why) =>
        new(ErrorKind.Unprocessable, "invalid_save", $"Kein gültiger Spielstand: {why}");

    public static SyncError WrongSession(string expected, string actual) =>
        new(ErrorKind.Unprocessable, "wrong_session", $"Falscher Spielstand „{actual}“, erwartet „{expected}“.", new { expected, actual });

    public static SyncError Invalid(string code, string message) => new(ErrorKind.Invalid, code, message);

    public static readonly SyncError InviteInvalid =
        new(ErrorKind.Unauthorized, "invite_invalid", "Einladungscode ungültig oder schon benutzt.");

    public static readonly SyncError NameTaken =
        new(ErrorKind.Conflict, "name_taken", "Der Name ist schon vergeben.");
}
