using System.Net;

namespace SatisfactorySync.Tests;

public sealed class LeaseTests : IDisposable
{
    private readonly SyncServer _server = new();

    public void Dispose() => _server.Dispose();

    [Fact]
    public async Task FiftyParallelLeaseRequests_ExactlyOneWins()
    {
        var clients = new List<HttpClient>();
        for (var i = 0; i < 50; i++)
        {
            clients.Add(await _server.UserAsync($"Spieler{i}"));
        }

        using var start = new ManualResetEventSlim(false);
        var tasks = clients.Select(c => Task.Run(async () =>
        {
            start.Wait();
            return await c.PostAsync("/api/lease", null);
        })).ToList();
        start.Set();
        var results = await Task.WhenAll(tasks);

        Assert.Equal(1, results.Count(r => r.StatusCode == HttpStatusCode.OK));
        Assert.Equal(49, results.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        foreach (var r in results.Where(r => r.StatusCode == HttpStatusCode.Conflict))
        {
            Assert.Equal("lease_held", (await r.JsonAsync()).GetProperty("error").GetString());
        }
    }

    [Fact]
    public async Task FiftyParallelLeaseRequests_SameUser_ExactlyOneWins()
    {
        var c = await _server.UserAsync("Mira");
        var results = await Task.WhenAll(Enumerable.Range(0, 50).Select(_ => Task.Run(() => c.PostAsync("/api/lease", null))));
        Assert.Equal(1, results.Count(r => r.StatusCode == HttpStatusCode.OK));
    }

    [Fact]
    public async Task FencingToken_StrictlyIncreases()
    {
        var a = await _server.UserAsync("Mira");
        var (t1, _) = await a.LeaseAsync();
        Assert.Equal(HttpStatusCode.NoContent, (await a.WithLeaseToken(HttpMethod.Delete, "/api/lease", t1)).StatusCode);
        var (t2, _) = await a.LeaseAsync();
        Assert.True(t2 > t1);
    }

    [Fact]
    public async Task Heartbeat_ExtendsLease_SoNobodyElseCanTakeIt()
    {
        var a = await _server.UserAsync("Mira");
        var b = await _server.UserAsync("Ole");
        var (t, _) = await a.LeaseAsync();
        for (var i = 0; i < 10; i++)
        {
            _server.Clock.Advance(TimeSpan.FromSeconds(20));
            Assert.Equal(HttpStatusCode.OK, (await a.WithLeaseToken(HttpMethod.Put, "/api/lease/heartbeat", t)).StatusCode);
        }

        Assert.Equal(HttpStatusCode.Conflict, (await b.PostAsync("/api/lease", null)).StatusCode);
    }

    [Fact]
    public async Task ExpiredLease_CanBeTakenOver_AndOldHostLosesIt()
    {
        var a = await _server.UserAsync("Mira");
        var b = await _server.UserAsync("Ole");
        var (ta, _) = await a.LeaseAsync();
        _server.Clock.Advance(TimeSpan.FromMinutes(2) + TimeSpan.FromSeconds(1));

        var (tb, _) = await b.LeaseAsync();
        Assert.True(tb > ta);

        var hb = await a.WithLeaseToken(HttpMethod.Put, "/api/lease/heartbeat", ta);
        Assert.Equal(HttpStatusCode.Conflict, hb.StatusCode);
        Assert.Equal("lease_lost", (await hb.JsonAsync()).GetProperty("error").GetString());
        Assert.Equal(HttpStatusCode.Conflict, (await a.WithLeaseToken(HttpMethod.Delete, "/api/lease", ta)).StatusCode);
    }

    [Fact]
    public async Task ExpiredLease_NobodyTookIt_HeartbeatRevives()
    {
        var a = await _server.UserAsync("Mira");
        var (t, _) = await a.LeaseAsync();
        _server.Clock.Advance(TimeSpan.FromMinutes(3));
        Assert.Equal(HttpStatusCode.OK, (await a.WithLeaseToken(HttpMethod.Put, "/api/lease/heartbeat", t)).StatusCode);

        var world = await (await a.GetAsync("/api/world")).JsonAsync();
        Assert.False(world.GetProperty("host").GetProperty("expired").GetBoolean());
    }

    [Fact]
    public async Task Release_FreesLease_ForNextHost()
    {
        var a = await _server.UserAsync("Mira");
        var b = await _server.UserAsync("Ole");
        var (t, _) = await a.LeaseAsync();
        Assert.Equal(HttpStatusCode.NoContent, (await a.WithLeaseToken(HttpMethod.Delete, "/api/lease", t)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await b.PostAsync("/api/lease", null)).StatusCode);
    }

    [Fact]
    public async Task ForceRelease_OnlyWhenExpiredOrByHost()
    {
        var a = await _server.UserAsync("Mira");
        var b = await _server.UserAsync("Ole");
        await a.LeaseAsync();

        Assert.Equal(HttpStatusCode.Conflict, (await b.PostAsync("/api/lease/force-release", null)).StatusCode);
        _server.Clock.Advance(TimeSpan.FromMinutes(5));
        Assert.Equal(HttpStatusCode.OK, (await b.PostAsync("/api/lease/force-release", null)).StatusCode);

        var audit = await (await b.GetAsync("/api/audit")).JsonAsync();
        Assert.Contains(audit.EnumerateArray(), e => e.GetProperty("action").GetString() == "lease_force_released" && e.GetProperty("user").GetString() == "Ole");
    }

    [Fact]
    public async Task ForceRelease_ByHostItself_Works()
    {
        var a = await _server.UserAsync("Mira");
        await a.LeaseAsync();
        Assert.Equal(HttpStatusCode.OK, (await a.PostAsync("/api/lease/force-release", null)).StatusCode);
        var world = await (await a.GetAsync("/api/world")).JsonAsync();
        Assert.Equal(System.Text.Json.JsonValueKind.Null, world.GetProperty("host").ValueKind);
    }

    [Fact]
    public async Task World_ShowsHost()
    {
        var a = await _server.UserAsync("Mira");
        await a.LeaseAsync();
        var world = await (await a.GetAsync("/api/world")).JsonAsync();
        Assert.Equal("Mira", world.GetProperty("host").GetProperty("name").GetString());
    }

    [Fact]
    public async Task LeaseHeld_ResponseNamesTheHost()
    {
        var a = await _server.UserAsync("Mira");
        var b = await _server.UserAsync("Ole");
        await a.LeaseAsync();
        var res = await b.PostAsync("/api/lease", null);
        var j = await res.JsonAsync();
        Assert.Equal("Mira", j.GetProperty("details").GetProperty("name").GetString());
    }
}
