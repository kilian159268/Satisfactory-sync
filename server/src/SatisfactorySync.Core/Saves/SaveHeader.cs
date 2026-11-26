using System.Text;

namespace SatisfactorySync.Core.Saves;

/// <summary>Die Felder aus dem unkomprimierten Kopf einer Satisfactory-.sav-Datei, die der Sync braucht.</summary>
public sealed record SaveHeader(
    int HeaderVersion,
    int SaveVersion,
    int BuildVersion,
    string? SaveName,
    string MapName,
    string SessionName,
    int PlayDurationSeconds,
    long SaveDateTicks);

public sealed class SaveHeaderException(string message) : Exception(message);

/// <summary>
/// Liest nur den Kopf einer .sav-Datei (wenige KB).
/// ANNAHME (Plan Kapitel 14, „Header-Format eines aktuellen Saves“): Reihenfolge nach
/// @etothepii/satisfactory-file-parser: int32 HeaderVersion, int32 SaveVersion, int32 BuildVersion,
/// [ab HeaderVersion 14: FString SaveName], FString MapName, FString MapOptions, FString SessionName,
/// int32 PlayDurationSeconds, int64 SaveDateTime (Ticks). Alles danach wird ignoriert.
/// Muss mit einem echten Save aus dem aktuellen Spiel geprüft werden; Anpassungen nur hier.
/// </summary>
public static class SaveHeaderParser
{
    /// <summary>Ab dieser Header-Version steht vor MapName noch der Save-Name.</summary>
    public const int SaveNameFromHeaderVersion = 14;

    private const int MaxStringBytes = 8 * 1024;
    private const int MaxHeaderVersion = 64;

    public static SaveHeader Parse(Stream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        using var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: true);
        try
        {
            var headerVersion = reader.ReadInt32();
            if (headerVersion is < 1 or > MaxHeaderVersion)
            {
                throw new SaveHeaderException($"Unbekannte Header-Version {headerVersion}.");
            }

            var saveVersion = reader.ReadInt32();
            var buildVersion = reader.ReadInt32();
            string? saveName = headerVersion >= SaveNameFromHeaderVersion ? ReadFString(reader) : null;
            var mapName = ReadFString(reader);
            _ = ReadFString(reader); // MapOptions
            var sessionName = ReadFString(reader);
            var playSeconds = reader.ReadInt32();
            var saveTicks = reader.ReadInt64();

            if (string.IsNullOrWhiteSpace(sessionName))
            {
                throw new SaveHeaderException("Sessionname fehlt.");
            }

            if (playSeconds < 0 || saveVersion < 0 || buildVersion < 0)
            {
                throw new SaveHeaderException("Unplausible Werte im Header.");
            }

            return new SaveHeader(headerVersion, saveVersion, buildVersion, saveName, mapName, sessionName, playSeconds, saveTicks);
        }
        catch (EndOfStreamException)
        {
            throw new SaveHeaderException("Datei endet mitten im Header.");
        }
    }

    public static SaveHeader ParseFile(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096);
        return Parse(fs);
    }

    /// <summary>Unreal-FString: int32 Länge inkl. Nullzeichen; positiv = 8-Bit, negativ = UTF-16LE.</summary>
    private static string ReadFString(BinaryReader reader)
    {
        var length = reader.ReadInt32();
        if (length == 0)
        {
            return string.Empty;
        }

        if (length > 0)
        {
            if (length > MaxStringBytes)
            {
                throw new SaveHeaderException("Zeichenkette im Header zu lang.");
            }

            var bytes = reader.ReadBytes(length);
            if (bytes.Length != length)
            {
                throw new EndOfStreamException();
            }

            return Encoding.Latin1.GetString(bytes, 0, length - 1);
        }

        if (length == int.MinValue || -length > MaxStringBytes / 2)
        {
            throw new SaveHeaderException("Zeichenkette im Header zu lang.");
        }

        var chars = -length;
        var data = reader.ReadBytes(chars * 2);
        if (data.Length != chars * 2)
        {
            throw new EndOfStreamException();
        }

        return Encoding.Unicode.GetString(data, 0, (chars - 1) * 2);
    }
}
