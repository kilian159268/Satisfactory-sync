using System.Security.Cryptography;
using System.Text;

namespace SatisfactorySync.Core;

public static class Crypto
{
    // Crockford-Base32 ohne I, L, O, U – gut abzulesen und abzutippen.
    private const string CodeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    public static string Sha256Hex(string value) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    public static string NewToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Einladungscode im Format XXXX-XXXX-XXXX (60 Bit Zufall).</summary>
    public static string NewInviteCode()
    {
        var sb = new StringBuilder(14);
        for (var i = 0; i < 12; i++)
        {
            if (i is 4 or 8)
            {
                sb.Append('-');
            }

            sb.Append(CodeAlphabet[RandomNumberGenerator.GetInt32(CodeAlphabet.Length)]);
        }

        return sb.ToString();
    }

    /// <summary>Normalisiert Eingaben (Kleinbuchstaben, Leerzeichen, fehlende Bindestriche).</summary>
    public static string NormalizeInviteCode(string code)
    {
        ArgumentNullException.ThrowIfNull(code);
        var chars = code.ToUpperInvariant().Where(char.IsLetterOrDigit).ToArray();
        return chars.Length == 12 ? $"{new string(chars, 0, 4)}-{new string(chars, 4, 4)}-{new string(chars, 8, 4)}" : new string(chars);
    }

    public static bool IsSha256Hex(string? value) =>
        value is { Length: 64 } && value.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f') or (>= 'A' and <= 'F'));
}
