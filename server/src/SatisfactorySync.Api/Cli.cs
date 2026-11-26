using System.Globalization;
using SatisfactorySync.Core;

namespace SatisfactorySync.Api;

/// <summary>Kommandozeile für die Einrichtung auf dem Server (Plan 5.6).</summary>
internal static class Cli
{
    public static int Run(string command, string[] args, IServiceProvider services, TextWriter? stdout = null, TextWriter? stderr = null)
    {
        var auth = services.GetRequiredService<AuthService>();
        var output = stdout ?? Console.Out;
        var error = stderr ?? Console.Error;
        switch (command)
        {
            case "invite":
                var count = 1;
                if (args is ["--count", var n, ..] && (!int.TryParse(n, NumberStyles.None, CultureInfo.InvariantCulture, out count) || count is < 1 or > 50))
                {
                    error.WriteLine("--count erwartet eine Zahl von 1 bis 50.");
                    return 2;
                }

                foreach (var code in auth.CreateInvites(count))
                {
                    output.WriteLine(code);
                }

                return 0;

            case "users":
                foreach (var u in auth.ListUsers())
                {
                    output.WriteLine(u.Blocked ? $"{u.Name} (gesperrt)" : u.Name);
                }

                return 0;

            case "block" or "unblock" when args.Length == 1:
                if (auth.SetBlocked(args[0], command == "block"))
                {
                    output.WriteLine(command == "block" ? $"{args[0]} gesperrt." : $"{args[0]} entsperrt.");
                    return 0;
                }

                error.WriteLine($"Unbekannter Spieler: {args[0]}");
                return 1;

            default:
                error.WriteLine("""
                    Befehle:
                      invite [--count N]   Einladungscodes erzeugen (je Spieler einer)
                      users                Spieler auflisten
                      block NAME           Zugang sperren
                      unblock NAME         Zugang entsperren
                    """);
                return 2;
        }
    }
}
