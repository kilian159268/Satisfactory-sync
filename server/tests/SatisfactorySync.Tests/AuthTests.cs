using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using SatisfactorySync.Api;
using SatisfactorySync.Core;

namespace SatisfactorySync.Tests;

/// <summary>Plan 5.6: Einladungscodes, Tokens, Sperren; Health-Endpoint; Kommandozeile.</summary>
public sealed class AuthTests : IDisposable
{
    private readonly SyncServer _server = new();

    public void Dispose() => _server.Dispose();

    private AuthService Auth => _server.Services.GetRequiredService<AuthService>();

    private HttpClient WithToken(string token)
    {
        var c = _server.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return c;
    }

    [Fact]
    public async Task Redeem_ReturnsToken_ThatWorks()
    {
        var code = Auth.CreateInvites(1)[0];
        var res = await _server.CreateClient().PostAsJsonAsync("/api/auth/redeem", new { code, name = "  Mira  " });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var j = await res.JsonAsync();
        Assert.Equal("Mira", j.GetProperty("name").GetString());
        var token = j.GetProperty("token").GetString()!;

        var me = await WithToken(token).GetAsync("/api/me");
        Assert.Equal(HttpStatusCode.OK, me.StatusCode);
        Assert.Equal("Mira", (await me.JsonAsync()).GetProperty("name").GetString());
    }

    [Fact]
    public async Task Redeem_CodeOnlyOnce_SecondTime401()
    {
        var code = Auth.CreateInvites(1)[0];
        var anon = _server.CreateClient();
        Assert.Equal(HttpStatusCode.OK, (await anon.PostAsJsonAsync("/api/auth/redeem", new { code, name = "Mira" })).StatusCode);

        var again = await anon.PostAsJsonAsync("/api/auth/redeem", new { code, name = "Ole" });

        Assert.Equal(HttpStatusCode.Unauthorized, again.StatusCode);
        Assert.Equal("invite_invalid", (await again.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Redeem_CodeIsNormalized()
    {
        var code = Auth.CreateInvites(1)[0];
        var sloppy = " " + code.Replace("-", "", StringComparison.Ordinal).ToLowerInvariant() + " ";
        var res = await _server.CreateClient().PostAsJsonAsync("/api/auth/redeem", new { code = sloppy, name = "Mira" });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Theory]
    [InlineData("AAAA-BBBB-CCCC")]
    [InlineData("")]
    [InlineData(null)]
    public async Task Redeem_UnknownCode_401(string? code)
    {
        var res = await _server.CreateClient().PostAsJsonAsync("/api/auth/redeem", new { code, name = "Mira" });
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("invite_invalid", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Theory]
    [InlineData("Mira")]
    [InlineData("mira")]
    public async Task Redeem_NameTaken_409_CodeStaysValid(string second)
    {
        await _server.UserAsync("Mira");
        var code = Auth.CreateInvites(1)[0];
        var anon = _server.CreateClient();

        var res = await anon.PostAsJsonAsync("/api/auth/redeem", new { code, name = second });

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("name_taken", (await res.JsonAsync()).GetProperty("error").GetString());
        Assert.Equal(HttpStatusCode.OK, (await anon.PostAsJsonAsync("/api/auth/redeem", new { code, name = "Ole" })).StatusCode);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("EinSehrSehrLangerNameMitMehrAls24")]
    [InlineData("Tab\tName")]
    public async Task Redeem_InvalidName_400(string name)
    {
        var code = Auth.CreateInvites(1)[0];
        var res = await _server.CreateClient().PostAsJsonAsync("/api/auth/redeem", new { code, name });
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("invalid_name", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Redeem_IsRateLimited()
    {
        using var server = new SyncServer(o => o.RedeemPerMinute = 3);
        var anon = server.CreateClient();
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 5; i++)
        {
            statuses.Add((await anon.PostAsJsonAsync("/api/auth/redeem", new { code = "AAAA-BBBB-CCCC", name = "Mira" })).StatusCode);
        }

        Assert.Equal(3, statuses.Count(s => s == HttpStatusCode.Unauthorized));
        Assert.Equal(2, statuses.Count(s => s == HttpStatusCode.TooManyRequests));
    }

    [Fact]
    public async Task Requests_AreRateLimitedPerUser()
    {
        using var server = new SyncServer(o =>
        {
            o.RequestBurst = 5;
            o.RequestsPerMinute = 2;
        });
        var c = await server.UserAsync("Mira");
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 8; i++)
        {
            statuses.Add((await c.GetAsync("/api/world")).StatusCode);
        }

        Assert.Contains(HttpStatusCode.TooManyRequests, statuses);
        var limited = await c.GetAsync("/api/world");
        Assert.Equal("rate_limited", (await limited.JsonAsync()).GetProperty("error").GetString());
    }

    [Theory]
    [InlineData("/api/me")]
    [InlineData("/api/world")]
    [InlineData("/api/versions")]
    [InlineData("/api/crew")]
    [InlineData("/api/audit")]
    public async Task WithoutToken_401(string url)
    {
        var res = await _server.CreateClient().GetAsync(url);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("unauthorized", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task InvalidToken_401()
    {
        Assert.Equal(HttpStatusCode.Unauthorized, (await WithToken("falsch").GetAsync("/api/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await WithToken(new string('x', 500)).GetAsync("/api/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await WithToken(string.Empty).PostAsync("/api/lease", null)).StatusCode);
    }

    [Fact]
    public async Task WrongScheme_401()
    {
        var c = _server.CreateClient();
        c.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", "bWlyYTpwdw==");
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/me")).StatusCode);
    }

    [Fact]
    public async Task BlockedUser_401_UnblockRestores()
    {
        var c = await _server.UserAsync("Mira");
        Assert.True(Auth.SetBlocked("Mira", true));
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/me")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsync("/api/lease", null)).StatusCode);

        Assert.True(Auth.SetBlocked("Mira", false));
        Assert.Equal(HttpStatusCode.OK, (await c.GetAsync("/api/me")).StatusCode);
        Assert.False(Auth.SetBlocked("Niemand", true));
    }

    [Fact]
    public async Task Healthz_WithoutAuth_200()
    {
        var res = await _server.CreateClient().GetAsync("/healthz");
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var j = await res.JsonAsync();
        Assert.Equal("ok", j.GetProperty("status").GetString());
        Assert.True(DateTimeOffset.TryParse(j.GetProperty("time").GetString(), System.Globalization.CultureInfo.InvariantCulture, out _));
    }

    [Fact]
    public void TokensAndCodes_AreStoredOnlyAsHash()
    {
        var code = Auth.CreateInvites(1)[0];
        Assert.True(Auth.Redeem(code, "Mira").Ok);
        var db = ReadShared(Path.Combine(_server.DataDir, "sync.db"));
        var wal = Path.Combine(_server.DataDir, "sync.db-wal");
        var all = File.Exists(wal) ? [.. db, .. ReadShared(wal)] : db;
        var text = System.Text.Encoding.Latin1.GetString(all);
        Assert.DoesNotContain(code, text, StringComparison.Ordinal);
    }

    private static byte[] ReadShared(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var ms = new MemoryStream();
        fs.CopyTo(ms);
        return ms.ToArray();
    }

    // ---------------------------------------------------------------- Kommandozeile

    private (int Exit, string Out, string Err) RunCli(params string[] args)
    {
        using var stdout = new StringWriter();
        using var stderr = new StringWriter();
        var exit = Cli.Run(args[0], args[1..], _server.Services, stdout, stderr);
        return (exit, stdout.ToString(), stderr.ToString());
    }

    [Fact]
    public async Task Cli_InviteCount_PrintsRedeemableCodes()
    {
        var (exit, output, _) = RunCli("invite", "--count", "3");
        Assert.Equal(0, exit);
        var codes = output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        Assert.Equal(3, codes.Length);
        Assert.All(codes, c => Assert.Matches("^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$", c));
        var res = await _server.CreateClient().PostAsJsonAsync("/api/auth/redeem", new { code = codes[1], name = "Mira" });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Theory]
    [InlineData("abc")]
    [InlineData("0")]
    [InlineData("51")]
    public void Cli_InviteBadCount_Fails(string count)
    {
        var (exit, output, err) = RunCli("invite", "--count", count);
        Assert.Equal(2, exit);
        Assert.Empty(output);
        Assert.NotEmpty(err);
    }

    [Fact]
    public async Task Cli_UsersAndBlock()
    {
        await _server.UserAsync("Mira");
        await _server.UserAsync("Ole");

        Assert.Equal(0, RunCli("block", "Ole").Exit);
        var (exit, output, _) = RunCli("users");
        Assert.Equal(0, exit);
        Assert.Contains("Mira", output, StringComparison.Ordinal);
        Assert.Contains("Ole (gesperrt)", output, StringComparison.Ordinal);

        Assert.Equal(1, RunCli("block", "Niemand").Exit);
        Assert.Equal(0, RunCli("unblock", "Ole").Exit);
        Assert.DoesNotContain("gesperrt", RunCli("users").Out, StringComparison.Ordinal);
    }

    [Fact]
    public void Cli_UnknownCommand_PrintsHelp()
    {
        var (exit, _, err) = RunCli("unsinn");
        Assert.Equal(2, exit);
        Assert.Contains("invite", err, StringComparison.Ordinal);
    }
}
