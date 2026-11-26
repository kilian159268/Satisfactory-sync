using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Time.Testing;
using SatisfactorySync.Core;

namespace SatisfactorySync.Tests;

public sealed class FakeDiskSpace : IDiskSpace
{
    public long Available { get; set; } = 100L * 1024 * 1024 * 1024;

    public long AvailableBytes(string path) => Available;
}

/// <summary>Ein echter Server (In-Memory-HTTP) mit eigenem Datenordner, steuerbarer Uhr und Speicherplatz.</summary>
public sealed class SyncServer(Action<SyncOptions>? configure = null) : WebApplicationFactory<Program>
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public string DataDir { get; } = Path.Combine(Path.GetTempPath(), "sync-tests", Guid.NewGuid().ToString("N"));

    public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(2026, 11, 26, 18, 0, 0, TimeSpan.Zero));

    public FakeDiskSpace Disk { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureServices(services =>
        {
            services.RemoveAll<SyncOptions>();
            // Viele Spieler pro Test: das Einlöse-Limit wird nur in einem eigenen Test geprüft.
            var options = new SyncOptions { DataDir = DataDir, RedeemPerMinute = 10_000 };
            configure?.Invoke(options);
            services.AddSingleton(options);
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(Clock);
            services.RemoveAll<IDiskSpace>();
            services.AddSingleton<IDiskSpace>(Disk);
        });
    }

    public SyncOptions Options => Services.GetRequiredService<SyncOptions>();

    public async Task<HttpClient> UserAsync(string name)
    {
        var code = Services.GetRequiredService<AuthService>().CreateInvites(1)[0];
        var anon = CreateClient();
        var res = await anon.PostAsJsonAsync("/api/auth/redeem", new { code, name });
        res.EnsureSuccessStatusCode();
        var token = (await res.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        try
        {
            Directory.Delete(DataDir, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}

/// <summary>Erzeugt .sav-Dateien mit gültigem Header (Format siehe SaveHeaderParser) und Zufallsdaten dahinter.</summary>
public static class SaveFactory
{
    public static byte[] Build(string session = "Fabrik", int playSeconds = 3600, int headerVersion = 13, int build = 416835, int payload = 4096, bool utf16Session = false)
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms, Encoding.UTF8, leaveOpen: true);
        w.Write(headerVersion);
        w.Write(46); // SaveVersion
        w.Write(build);
        if (headerVersion >= 14)
        {
            WriteFString(w, session + "_autosave_0");
        }

        WriteFString(w, "Persistent_Level");
        WriteFString(w, "?startloc=Grass Fields?sessionName=" + session);
        WriteFString(w, session, utf16Session);
        w.Write(playSeconds);
        w.Write(638_680_000_000_000_000L);
        w.Write((byte)1); // SessionVisibility
        w.Write(RandomNumberGenerator.GetBytes(payload));
        w.Flush();
        return ms.ToArray();
    }

    public static void WriteFString(BinaryWriter w, string s, bool utf16 = false)
    {
        if (utf16)
        {
            w.Write(-(s.Length + 1));
            w.Write(Encoding.Unicode.GetBytes(s + "\0"));
        }
        else
        {
            w.Write(s.Length + 1);
            w.Write(Encoding.Latin1.GetBytes(s + "\0"));
        }
    }

    public static string Sha(byte[] data) => Convert.ToHexStringLower(SHA256.HashData(data));
}

public static class ClientExtensions
{
    public static async Task<JsonElement> JsonAsync(this HttpResponseMessage res) =>
        await res.Content.ReadFromJsonAsync<JsonElement>(SyncServer.Json);

    public static async Task<JsonElement> WorldAsync(this HttpClient c) => await (await c.GetAsync("/api/world")).JsonAsync();

    public static async Task<int> VersionCountAsync(this HttpClient c) => (await (await c.GetAsync("/api/versions")).JsonAsync()).GetArrayLength();

    /// <summary>Id des Heads aus /api/world, 0 = keiner.</summary>
    public static long HeadId(JsonElement world) =>
        world.GetProperty("head").ValueKind == JsonValueKind.Null ? 0 : world.GetProperty("head").GetProperty("id").GetInt64();

    public static async Task<(long Token, long Head)> LeaseAsync(this HttpClient c)
    {
        var res = await c.PostAsync("/api/lease", null);
        res.EnsureSuccessStatusCode();
        var j = await res.JsonAsync();
        return (j.GetProperty("fencingToken").GetInt64(), j.GetProperty("headVersionId").GetInt64());
    }

    public static Task<HttpResponseMessage> UploadAsync(this HttpClient c, byte[] data, long? token, long baseVersion, string? key = null, string? sha = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/api/versions") { Content = new ByteArrayContent(data) };
        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        if (token is { } t)
        {
            req.Headers.Add("Lease-Token", t.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        req.Headers.Add("Base-Version", baseVersion.ToString(System.Globalization.CultureInfo.InvariantCulture));
        req.Headers.Add("Content-SHA256", sha ?? SaveFactory.Sha(data));
        req.Headers.Add("Idempotency-Key", key ?? Guid.NewGuid().ToString());
        return c.SendAsync(req);
    }

    public static Task<HttpResponseMessage> WithLeaseToken(this HttpClient c, HttpMethod method, string url, long token)
    {
        var req = new HttpRequestMessage(method, url);
        req.Headers.Add("Lease-Token", token.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return c.SendAsync(req);
    }
}
