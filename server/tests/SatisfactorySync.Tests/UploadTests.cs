using System.Net;
using System.Text.Json;

namespace SatisfactorySync.Tests;

/// <summary>Plan 5.3 und Kapitel 8: Upload, Fencing, Compare-and-swap, Idempotenz.</summary>
public sealed class UploadTests : IDisposable
{
    private readonly SyncServer _server = new();

    public void Dispose() => _server.Dispose();

    private int FileCount() => Directory.GetFiles(Path.Combine(_server.DataDir, "versions")).Length;

    private int TempCount() => Directory.GetFiles(Path.Combine(_server.DataDir, "tmp")).Length;

    /// <summary>Host werden und eine erste Version hochladen.</summary>
    private async Task<(HttpClient Client, long Token, long HeadId)> HostWithFirstVersionAsync(string name = "Mira", int playSeconds = 3600)
    {
        var c = await _server.UserAsync(name);
        var (token, head) = await c.LeaseAsync();
        var res = await c.UploadAsync(SaveFactory.Build(playSeconds: playSeconds), token, head);
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        return (c, token, (await res.JsonAsync()).GetProperty("version").GetProperty("id").GetInt64());
    }

    [Fact]
    public async Task FirstUpload_BecomesHead_WithBaseVersionZero()
    {
        var c = await _server.UserAsync("Mira");
        var (token, head) = await c.LeaseAsync();
        Assert.Equal(0, head);

        var data = SaveFactory.Build(session: "Fabrik", playSeconds: 1234);
        var res = await c.UploadAsync(data, token, 0);

        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var j = await res.JsonAsync();
        Assert.True(j.GetProperty("accepted").GetBoolean());
        Assert.Equal(JsonValueKind.Null, j.GetProperty("conflictReason").ValueKind);
        var v = j.GetProperty("version");
        Assert.Equal(1, v.GetProperty("number").GetInt64());
        Assert.Equal("1", v.GetProperty("label").GetString());
        Assert.Equal("normal", v.GetProperty("type").GetString());
        Assert.Equal(1234, v.GetProperty("playSeconds").GetInt32());
        Assert.Equal("Fabrik", v.GetProperty("sessionName").GetString());
        Assert.Equal("Mira", v.GetProperty("uploadedBy").GetString());
        Assert.Equal(SaveFactory.Sha(data), v.GetProperty("sha256").GetString());
        Assert.Equal(data.Length, v.GetProperty("size").GetInt64());
        Assert.Equal(0, v.GetProperty("baseVersionId").GetInt64());

        var world = await ClientExtensions.WorldAsync(c);
        Assert.Equal(v.GetProperty("id").GetInt64(), ClientExtensions.HeadId(world));
        Assert.Equal("Fabrik", world.GetProperty("sessionName").GetString());
        Assert.Equal(0, TempCount());
    }

    [Fact]
    public async Task SecondUpload_OnCurrentHead_BecomesNextNumber()
    {
        var (c, token, head) = await HostWithFirstVersionAsync();
        var res = await c.UploadAsync(SaveFactory.Build(playSeconds: 4000), token, head);
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var v = (await res.JsonAsync()).GetProperty("version");
        Assert.Equal(2, v.GetProperty("number").GetInt64());
        Assert.Equal(head, v.GetProperty("baseVersionId").GetInt64());
        Assert.Equal(v.GetProperty("id").GetInt64(), ClientExtensions.HeadId(await ClientExtensions.WorldAsync(c)));
    }

    [Fact]
    public async Task StaleToken_Returns409_StoresConflictCopy_HeadUnchanged()
    {
        var (a, ta, head) = await HostWithFirstVersionAsync();
        Assert.Equal(HttpStatusCode.NoContent, (await a.WithLeaseToken(HttpMethod.Delete, "/api/lease", ta)).StatusCode);
        var b = await _server.UserAsync("Ole");
        await b.LeaseAsync();

        var res = await a.UploadAsync(SaveFactory.Build(playSeconds: 9999), ta, head);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var j = await res.JsonAsync();
        Assert.False(j.GetProperty("accepted").GetBoolean());
        Assert.Equal("stale_token", j.GetProperty("conflictReason").GetString());
        Assert.False(string.IsNullOrEmpty(j.GetProperty("message").GetString()));
        var v = j.GetProperty("version");
        Assert.Equal("konflikt", v.GetProperty("type").GetString());
        Assert.Equal(JsonValueKind.Null, v.GetProperty("number").ValueKind);
        Assert.StartsWith("K-", v.GetProperty("label").GetString(), StringComparison.Ordinal);

        Assert.Equal(head, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(a)));
        Assert.Equal(2, await ClientExtensions.VersionCountAsync(a));
        // Die Konfliktkopie ist abrufbar.
        var file = await a.GetAsync($"/api/versions/{v.GetProperty("id").GetInt64()}/file");
        Assert.Equal(HttpStatusCode.OK, file.StatusCode);
    }

    [Fact]
    public async Task WrongBase_Returns409_BaseMismatch_ConflictCopy()
    {
        var (c, token, head) = await HostWithFirstVersionAsync();
        var res = await c.UploadAsync(SaveFactory.Build(playSeconds: 5000), token, head + 42);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        var j = await res.JsonAsync();
        Assert.Equal("base_mismatch", j.GetProperty("conflictReason").GetString());
        Assert.Equal("konflikt", j.GetProperty("version").GetProperty("type").GetString());
        Assert.Equal(head, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(c)));
    }

    [Fact]
    public async Task OlderBase_AfterSomeoneElseUploaded_IsBaseMismatch()
    {
        var (c, token, v1) = await HostWithFirstVersionAsync();
        var v2 = (await (await c.UploadAsync(SaveFactory.Build(playSeconds: 4000), token, v1)).JsonAsync()).GetProperty("version").GetProperty("id").GetInt64();

        var res = await c.UploadAsync(SaveFactory.Build(playSeconds: 5000), token, v1);
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("base_mismatch", (await res.JsonAsync()).GetProperty("conflictReason").GetString());
        Assert.Equal(v2, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(c)));
    }

    [Fact]
    public async Task SameIdempotencyKey_Sequential_OneVersion_SameResponse()
    {
        var c = await _server.UserAsync("Mira");
        var (token, head) = await c.LeaseAsync();
        var data = SaveFactory.Build();

        var first = await c.UploadAsync(data, token, head, key: "abc-1");
        var second = await c.UploadAsync(data, token, head, key: "abc-1");

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        Assert.Equal((await first.JsonAsync()).ToString(), (await second.JsonAsync()).ToString());
        Assert.Equal(1, await ClientExtensions.VersionCountAsync(c));
        Assert.Equal(1, FileCount());
        Assert.Equal(0, TempCount());
    }

    [Fact]
    public async Task SameIdempotencyKey_ConflictResponse_IsRepeatedAs409()
    {
        var c = await _server.UserAsync("Mira");
        var data = SaveFactory.Build();
        var first = await c.UploadAsync(data, null, 0, key: "retry");
        var second = await c.UploadAsync(data, null, 0, key: "retry");
        Assert.Equal(HttpStatusCode.Conflict, first.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.Equal((await first.JsonAsync()).ToString(), (await second.JsonAsync()).ToString());
        Assert.Equal(1, await ClientExtensions.VersionCountAsync(c));
    }

    [Fact]
    public async Task SameIdempotencyKey_Parallel_OneVersion_SameResponse()
    {
        var c = await _server.UserAsync("Mira");
        var (token, head) = await c.LeaseAsync();
        var data = SaveFactory.Build(payload: 256 * 1024);

        using var start = new ManualResetEventSlim(false);
        var tasks = Enumerable.Range(0, 10).Select(_ => Task.Run(async () =>
        {
            start.Wait();
            return await c.UploadAsync(data, token, head, key: "parallel-key");
        })).ToList();
        start.Set();
        var results = await Task.WhenAll(tasks);

        Assert.All(results, r => Assert.Equal(HttpStatusCode.Created, r.StatusCode));
        var bodies = await Task.WhenAll(results.Select(async r => (await r.JsonAsync()).ToString()));
        Assert.Single(bodies.Distinct());
        Assert.Equal(1, await ClientExtensions.VersionCountAsync(c));
        Assert.Equal(1, FileCount());
        Assert.Equal(0, TempCount());
    }

    [Fact]
    public async Task IdempotencyKey_IsPerUser()
    {
        var a = await _server.UserAsync("Mira");
        var b = await _server.UserAsync("Ole");
        Assert.Equal(HttpStatusCode.Conflict, (await a.UploadAsync(SaveFactory.Build(), null, 0, key: "same")).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await b.UploadAsync(SaveFactory.Build(), null, 0, key: "same")).StatusCode);
        Assert.Equal(2, await ClientExtensions.VersionCountAsync(a));
    }

    [Fact]
    public async Task WrongHash_Returns400_NothingStored()
    {
        var c = await _server.UserAsync("Mira");
        var (token, head) = await c.LeaseAsync();
        var data = SaveFactory.Build();

        var res = await c.UploadAsync(data, token, head, sha: new string('0', 64));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("hash_mismatch", (await res.JsonAsync()).GetProperty("error").GetString());
        Assert.Equal(0, await ClientExtensions.VersionCountAsync(c));
        Assert.Equal(0, FileCount());
        Assert.Equal(0, TempCount());
        Assert.Equal(0, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(c)));

        // Retry mit gleichem Key und richtigem Hash klappt (Fehler werden nicht als Antwort gespeichert).
        var key = Guid.NewGuid().ToString();
        Assert.Equal(HttpStatusCode.BadRequest, (await c.UploadAsync(data, token, head, key: key, sha: new string('a', 64))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await c.UploadAsync(data, token, head, key: key)).StatusCode);
    }

    [Theory]
    [InlineData("kein-hash")]
    [InlineData("")]
    public async Task MalformedHashHeader_Returns400(string sha)
    {
        var c = await _server.UserAsync("Mira");
        var res = await c.UploadAsync(SaveFactory.Build(), null, 0, sha: sha);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("invalid_sha256", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task MissingBaseVersion_Returns400()
    {
        var c = await _server.UserAsync("Mira");
        var data = SaveFactory.Build();
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/versions") { Content = new ByteArrayContent(data) };
        req.Headers.Add("Content-SHA256", SaveFactory.Sha(data));
        req.Headers.Add("Idempotency-Key", "k");
        var res = await c.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("invalid_base_version", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task MissingIdempotencyKey_Returns400()
    {
        var c = await _server.UserAsync("Mira");
        var data = SaveFactory.Build();
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/versions") { Content = new ByteArrayContent(data) };
        req.Headers.Add("Base-Version", "0");
        req.Headers.Add("Content-SHA256", SaveFactory.Sha(data));
        var res = await c.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("invalid_idempotency_key", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task MalformedLeaseToken_Returns400()
    {
        var c = await _server.UserAsync("Mira");
        var data = SaveFactory.Build();
        using var req = new HttpRequestMessage(HttpMethod.Post, "/api/versions") { Content = new ByteArrayContent(data) };
        req.Headers.Add("Lease-Token", "abc");
        req.Headers.Add("Base-Version", "0");
        req.Headers.Add("Content-SHA256", SaveFactory.Sha(data));
        req.Headers.Add("Idempotency-Key", "k");
        var res = await c.SendAsync(req);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("invalid_lease_token", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task InvalidHeader_Returns422_NothingStored()
    {
        var c = await _server.UserAsync("Mira");
        var (token, head) = await c.LeaseAsync();
        var junk = "Das ist kein Spielstand, sondern Text."u8.ToArray();

        var res = await c.UploadAsync(junk, token, head);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
        Assert.Equal("invalid_save", (await res.JsonAsync()).GetProperty("error").GetString());
        Assert.Equal(0, await ClientExtensions.VersionCountAsync(c));
        Assert.Equal(0, FileCount());
        Assert.Equal(0, TempCount());
    }

    [Fact]
    public async Task WrongSession_Returns422_HeadUnchanged()
    {
        var (c, token, head) = await HostWithFirstVersionAsync();
        var res = await c.UploadAsync(SaveFactory.Build(session: "Andere Welt", playSeconds: 99999), token, head);

        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
        var j = await res.JsonAsync();
        Assert.Equal("wrong_session", j.GetProperty("error").GetString());
        Assert.Equal("Fabrik", j.GetProperty("details").GetProperty("expected").GetString());
        Assert.Equal("Andere Welt", j.GetProperty("details").GetProperty("actual").GetString());
        Assert.Equal(head, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(c)));
        Assert.Equal(1, await ClientExtensions.VersionCountAsync(c));
        Assert.Equal(1, FileCount());
        Assert.Equal(0, TempCount());
    }

    [Fact]
    public async Task LessPlaytime_IsConflictCopy()
    {
        var (c, token, head) = await HostWithFirstVersionAsync(playSeconds: 3600);
        var res = await c.UploadAsync(SaveFactory.Build(playSeconds: 3599), token, head);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("playtime_regressed", (await res.JsonAsync()).GetProperty("conflictReason").GetString());
        Assert.Equal(head, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(c)));
    }

    [Fact]
    public async Task EqualPlaytime_IsAccepted()
    {
        var (c, token, head) = await HostWithFirstVersionAsync(playSeconds: 3600);
        Assert.Equal(HttpStatusCode.Created, (await c.UploadAsync(SaveFactory.Build(playSeconds: 3600), token, head)).StatusCode);
    }

    [Fact]
    public async Task WithoutLeaseToken_IsConflictCopy()
    {
        var (_, _, head) = await HostWithFirstVersionAsync();
        var b = await _server.UserAsync("Ole");

        var res = await b.UploadAsync(SaveFactory.Build(playSeconds: 99999), null, head);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("no_lease", (await res.JsonAsync()).GetProperty("conflictReason").GetString());
        Assert.Equal(head, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(b)));
    }

    [Fact]
    public async Task OtherUsersToken_IsStale()
    {
        var (_, token, head) = await HostWithFirstVersionAsync();
        var b = await _server.UserAsync("Ole");
        var res = await b.UploadAsync(SaveFactory.Build(playSeconds: 99999), token, head);
        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("stale_token", (await res.JsonAsync()).GetProperty("conflictReason").GetString());
    }

    [Fact]
    public async Task DiskFull_Returns507_NothingStored()
    {
        var (c, token, head) = await HostWithFirstVersionAsync();
        _server.Disk.Available = _server.Options.MinFreeBytes - 1;

        var res = await c.UploadAsync(SaveFactory.Build(playSeconds: 5000), token, head);

        Assert.Equal(HttpStatusCode.InsufficientStorage, res.StatusCode);
        Assert.Equal("disk_full", (await res.JsonAsync()).GetProperty("error").GetString());
        Assert.Equal(head, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(c)));
        Assert.Equal(1, FileCount());
        Assert.Equal(0, TempCount());
    }

    [Fact]
    public async Task DiskAlmostFull_UploadWouldCrossLimit_Returns507()
    {
        var c = await _server.UserAsync("Mira");
        var (token, head) = await c.LeaseAsync();
        var data = SaveFactory.Build();
        _server.Disk.Available = _server.Options.MinFreeBytes + (data.Length / 2);
        Assert.Equal(HttpStatusCode.InsufficientStorage, (await c.UploadAsync(data, token, head)).StatusCode);
    }

    [Fact]
    public async Task TooLarge_Returns413()
    {
        using var server = new SyncServer(o => o.MaxUploadBytes = 1024);
        var c = await server.UserAsync("Mira");
        var res = await c.UploadAsync(SaveFactory.Build(payload: 4096), null, 0);
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, res.StatusCode);
        Assert.Equal("too_large", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task ExpiredLease_OtherHost_OldHostUploadBecomesConflictCopy()
    {
        // Plan 8: Host-PC geht aus / Internet weg → Lease läuft ab → anderer Host → später Upload des alten Hosts.
        var (a, ta, v1) = await HostWithFirstVersionAsync();
        _server.Clock.Advance(_server.Options.LeaseDuration + TimeSpan.FromSeconds(1));

        var b = await _server.UserAsync("Ole");
        var (tb, hb) = await b.LeaseAsync();
        Assert.Equal(v1, hb);
        var v2 = (await (await b.UploadAsync(SaveFactory.Build(playSeconds: 4000), tb, hb)).JsonAsync()).GetProperty("version").GetProperty("id").GetInt64();

        var res = await a.UploadAsync(SaveFactory.Build(playSeconds: 99999), ta, v1);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("stale_token", (await res.JsonAsync()).GetProperty("conflictReason").GetString());
        Assert.Equal(v2, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(a)));
    }

    [Fact]
    public async Task ExpiredLease_NobodyElse_UploadIsLeaseExpiredConflict()
    {
        var (c, token, head) = await HostWithFirstVersionAsync();
        _server.Clock.Advance(_server.Options.LeaseDuration + TimeSpan.FromSeconds(1));

        var res = await c.UploadAsync(SaveFactory.Build(playSeconds: 5000), token, head);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("lease_expired", (await res.JsonAsync()).GetProperty("conflictReason").GetString());
        Assert.Equal(head, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(c)));
    }

    [Fact]
    public async Task ConflictCopy_NeverBecomesHead_ButAppearsInHistory()
    {
        var (c, _, head) = await HostWithFirstVersionAsync();
        await c.UploadAsync(SaveFactory.Build(playSeconds: 99999), null, head);
        var versions = (await (await c.GetAsync("/api/versions")).JsonAsync()).EnumerateArray().ToList();
        Assert.Equal(2, versions.Count);
        Assert.Equal("konflikt", versions[0].GetProperty("type").GetString()); // neueste zuerst
        Assert.Equal(head, ClientExtensions.HeadId(await ClientExtensions.WorldAsync(c)));
    }

    [Fact]
    public async Task Upload_WritesAuditEntries()
    {
        var (c, _, head) = await HostWithFirstVersionAsync();
        await c.UploadAsync(SaveFactory.Build(), null, head);
        var actions = (await (await c.GetAsync("/api/audit")).JsonAsync()).EnumerateArray().Select(e => e.GetProperty("action").GetString()).ToList();
        Assert.Contains("version_uploaded", actions);
        Assert.Contains("conflict_copy", actions);
        Assert.Contains("lease_acquired", actions);
    }
}
