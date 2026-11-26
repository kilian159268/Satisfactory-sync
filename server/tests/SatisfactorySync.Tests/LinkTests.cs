using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using SatisfactorySync.Api;
using SatisfactorySync.Core;
using SatisfactorySync.Core.Data;

namespace SatisfactorySync.Tests;

/// <summary>Mehrere Zugänge pro Spieler (zweites Spielkonto / zweiter PC), Verknüpfen, Zusammenführen.</summary>
public sealed class LinkTests : IDisposable
{
    private readonly SyncServer _server = new();

    public void Dispose() => _server.Dispose();

    private AuthService Auth => _server.Services.GetRequiredService<AuthService>();

    private async Task<HttpClient> RedeemAsync(string code, string name = "egal")
    {
        var res = await _server.CreateClient().PostAsJsonAsync("/api/auth/redeem", new { code, name });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var token = (await res.JsonAsync()).GetProperty("token").GetString();
        var client = _server.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    private static async Task<string> LinkCodeAsync(HttpClient c)
    {
        var res = await c.PostAsync("/api/me/link-code", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await res.JsonAsync()).GetProperty("code").GetString()!;
    }

    [Fact]
    public async Task LinkCode_SecondAccount_IsSamePerson()
    {
        var first = await _server.UserAsync("Mira");
        var code = await LinkCodeAsync(first);

        var res = await _server.CreateClient().PostAsJsonAsync("/api/auth/redeem", new { code, name = "Zweitkonto" });
        var body = await res.JsonAsync();
        Assert.Equal("Mira", body.GetProperty("name").GetString());
        Assert.True(body.GetProperty("linked").GetBoolean());

        var second = await RedeemAsyncFromBody(body);
        Assert.Equal("Mira", (await (await second.GetAsync("/api/me")).JsonAsync()).GetProperty("name").GetString());
        var crew = await (await first.GetAsync("/api/crew")).JsonAsync();
        Assert.Single(crew.EnumerateArray());
    }

    private async Task<HttpClient> RedeemAsyncFromBody(JsonElement body)
    {
        var client = _server.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body.GetProperty("token").GetString());
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/me")).StatusCode);
        return client;
    }

    [Fact]
    public async Task LinkCode_WorksOnce_AndExpiresAfter24h()
    {
        var first = await _server.UserAsync("Mira");
        var code = await LinkCodeAsync(first);
        await RedeemAsync(code);
        var again = await _server.CreateClient().PostAsJsonAsync("/api/auth/redeem", new { code, name = "x" });
        Assert.Equal(HttpStatusCode.Unauthorized, again.StatusCode);

        var late = await LinkCodeAsync(first);
        _server.Clock.Advance(TimeSpan.FromHours(24) + TimeSpan.FromSeconds(1));
        var expired = await _server.CreateClient().PostAsJsonAsync("/api/auth/redeem", new { code = late, name = "x" });
        Assert.Equal(HttpStatusCode.Unauthorized, expired.StatusCode);
        Assert.Equal("invite_invalid", (await expired.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task SecondDevice_CannotTakeAwayRunningHost_ButHostDeviceCan()
    {
        var pcA = await _server.UserAsync("Mira");
        var pcB = await RedeemAsync(await LinkCodeAsync(pcA));
        var (token, head) = await pcA.LeaseAsync();

        Assert.Equal(HttpStatusCode.Conflict, (await pcB.PostAsync("/api/lease", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await pcB.PostAsync("/api/lease/force-release", null)).StatusCode);
        // Erratenes Fencing-Token hilft dem zweiten Gerät nicht.
        Assert.Equal(HttpStatusCode.Conflict, (await pcB.WithLeaseToken(HttpMethod.Put, "/api/lease/heartbeat", token)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await pcB.WithLeaseToken(HttpMethod.Delete, "/api/lease", token)).StatusCode);
        var upload = await pcB.UploadAsync(SaveFactory.Build(), token, head);
        Assert.Equal(HttpStatusCode.Conflict, upload.StatusCode);
        Assert.Equal("stale_token", (await upload.JsonAsync()).GetProperty("conflictReason").GetString());

        Assert.Equal(HttpStatusCode.Created, (await pcA.UploadAsync(SaveFactory.Build(), token, head)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await pcA.PostAsync("/api/lease/force-release", null)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await pcB.PostAsync("/api/lease", null)).StatusCode);
    }

    [Fact]
    public async Task Presence_InGameOnOneDevice_IsNotOverwrittenByTheOther()
    {
        var pcA = await _server.UserAsync("Mira");
        var pcB = await RedeemAsync(await LinkCodeAsync(pcA));
        await pcA.PutAsJsonAsync("/api/presence", new { status = "im_spiel" });
        _server.Clock.Advance(TimeSpan.FromSeconds(5));
        await pcB.PutAsJsonAsync("/api/presence", new { status = "launcher" });

        var me = (await (await pcA.GetAsync("/api/crew")).JsonAsync()).EnumerateArray().Single();
        Assert.True(me.GetProperty("online").GetBoolean());
        Assert.Equal("im_spiel", me.GetProperty("status").GetString());

        _server.Clock.Advance(TimeSpan.FromSeconds(88));
        await pcB.PutAsJsonAsync("/api/presence", new { status = "launcher" });
        me = (await (await pcA.GetAsync("/api/crew")).JsonAsync()).EnumerateArray().Single();
        Assert.Equal("launcher", me.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Cli_InviteFor_CreatesLinkCode()
    {
        await _server.UserAsync("Mira");
        var (exit, output, _) = RunCli("invite", "--for", "Mira");
        Assert.Equal(0, exit);
        var second = await RedeemAsync(output.Trim());
        Assert.Equal("Mira", (await (await second.GetAsync("/api/me")).JsonAsync()).GetProperty("name").GetString());

        Assert.Equal(1, RunCli("invite", "--for", "Niemand").Exit);
        Assert.Contains("Mira (2 Zugänge)", RunCli("users").Output, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Cli_Link_MergesTwoRedeemedPlayers_KeepingHistory()
    {
        var main = await _server.UserAsync("Mira");
        var alt = await _server.UserAsync("MiraAlt");
        var (token, head) = await alt.LeaseAsync();
        Assert.Equal(HttpStatusCode.Created, (await alt.UploadAsync(SaveFactory.Build(), token, head)).StatusCode);

        var (exit, output, _) = RunCli("link", "Mira", "MiraAlt");
        Assert.Equal(0, exit);
        Assert.Contains("MiraAlt ist jetzt ein weiterer Zugang von Mira", output, StringComparison.Ordinal);

        // Altes Token von MiraAlt gilt jetzt als Mira; Version und laufende Host-Rolle gehören Mira.
        Assert.Equal("Mira", (await (await alt.GetAsync("/api/me")).JsonAsync()).GetProperty("name").GetString());
        var versions = await (await main.GetAsync("/api/versions")).JsonAsync();
        Assert.All(versions.EnumerateArray(), v => Assert.Equal("Mira", v.GetProperty("uploadedBy").GetString()));
        var world = await (await main.GetAsync("/api/world")).JsonAsync();
        Assert.Equal("Mira", world.GetProperty("host").GetProperty("name").GetString());
        Assert.Single((await (await main.GetAsync("/api/crew")).JsonAsync()).EnumerateArray());
        // Das hostende Gerät (MiraAlt-Token) behält die Host-Rolle.
        Assert.Equal(HttpStatusCode.OK, (await alt.WithLeaseToken(HttpMethod.Put, "/api/lease/heartbeat", token)).StatusCode);

        Assert.Equal(1, RunCli("link", "Mira", "Mira").Exit);
        Assert.Equal(1, RunCli("link", "Mira", "Niemand").Exit);
    }

    [Fact]
    public void Migration_OldDatabase_KeepsTokensAndPresence()
    {
        var dir = Path.Combine(Path.GetTempPath(), "sync-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var dbPath = Path.Combine(dir, "sync.db");
            using (var conn = new SqliteConnection($"Data Source={dbPath};Pooling=False"))
            {
                conn.Open();
                using var cmd = conn.CreateCommand();
                cmd.CommandText = """
                    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, token_hash TEXT NOT NULL UNIQUE, blocked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
                    CREATE TABLE invites(id INTEGER PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, used_by INTEGER REFERENCES users(id), used_at INTEGER);
                    CREATE TABLE leases(id INTEGER PRIMARY KEY CHECK(id = 1), lease_id TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), fencing_token INTEGER NOT NULL, base_version_id INTEGER, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
                    CREATE TABLE presence(user_id INTEGER PRIMARY KEY REFERENCES users(id), status TEXT NOT NULL, last_seen INTEGER NOT NULL);
                    """;
                cmd.ExecuteNonQuery();
                using var ins = conn.CreateCommand();
                ins.CommandText = "INSERT INTO users(id, name, token_hash, created_at) VALUES (1, 'Veloc', $h, 0); INSERT INTO presence VALUES (1, 'launcher', 5);";
                ins.Parameters.AddWithValue("$h", Crypto.Sha256Hex("altes-token"));
                ins.ExecuteNonQuery();
            }

            var db = new SyncDatabase(new SyncOptions { DataDir = dir });
            var auth = new AuthService(db, TimeProvider.System);
            var user = auth.Authenticate("altes-token");
            Assert.NotNull(user);
            Assert.Equal("Veloc", user.Name);
            Assert.NotEqual(0, user.DeviceId);
            _ = new SyncDatabase(new SyncOptions { DataDir = dir }); // zweiter Start: Migration ist wiederholbar
            Assert.Equal("Veloc", auth.Authenticate("altes-token")?.Name);
            SqliteConnection.ClearAllPools();
        }
        finally
        {
            try
            {
                Directory.Delete(dir, recursive: true);
            }
            catch (IOException)
            {
            }
        }
    }

    private (int Exit, string Output, string Error) RunCli(params string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var exit = Cli.Run(args[0], args[1..], _server.Services, stdout, stderr);
        return (exit, stdout.ToString(), stderr.ToString());
    }
}
