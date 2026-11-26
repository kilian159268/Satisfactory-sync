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
            case "invite" when args is ["--for", var forName]:
                var link = auth.CreateLinkCodeFor(forName);
                if (link is null)
                {
                    error.WriteLine($"Unbekannter Spieler: {forName}");
                    return 1;
                }

                output.WriteLine(link.Code);
                error.WriteLine($"Weiterer Zugang für {forName}, gültig bis {link.ExpiresAt.ToLocalTime():dd.MM. HH:mm}.");
                return 0;

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
                var devices = auth.DeviceCounts();
                foreach (var u in auth.ListUsers())
                {
                    var deviceCount = devices.GetValueOrDefault(u.Name, 1);
                    var extra = deviceCount > 1 ? $" ({deviceCount} Zugänge)" : string.Empty;
                    output.WriteLine(u.Blocked ? $"{u.Name}{extra} (gesperrt)" : $"{u.Name}{extra}");
                }

                return 0;

            case "link" when args.Length == 2:
                var linked = auth.LinkUsers(args[0], args[1]);
                if (!linked.Ok)
                {
                    error.WriteLine(linked.Error!.Message);
                    return 1;
                }

                output.WriteLine($"{args[1]} ist jetzt ein weiterer Zugang von {linked.Value}.");
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
                      invite --for NAME    Code für einen weiteren Zugang von NAME (24 Std. gültig)
                      link NAME ZWEIT      Spieler ZWEIT mit NAME zusammenführen (ZWEIT wird Zugang von NAME)
                      users                Spieler auflisten
                      block NAME           Zugang sperren
                      unblock NAME         Zugang entsperren
                    """);
                return 2;
        }
    }
}
