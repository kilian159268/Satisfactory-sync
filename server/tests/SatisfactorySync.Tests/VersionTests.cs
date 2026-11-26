using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace SatisfactorySync.Tests;

/// <summary>Download, Wiederherstellen, Karte, Aufbewahrung.</summary>
public sealed class VersionTests : IDisposable
{
    private readonly SyncServer _server = new();

    public void Dispose() => _server.Dispose();

    private static async Task<JsonElement> UploadOkAsync(HttpClient c, byte[] data, long token, long baseId)
    {
        var res = await c.UploadAsync(data, token, baseId);
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        return (await res.JsonAsync()).GetProperty("version");
    }

    private static HashSet<long> StoredIds(string dir) =>
        Directory.GetFiles(dir).Select(f => long.Parse(Path.GetFileNameWithoutExtension(f), System.Globalization.CultureInfo.InvariantCulture)).ToHashSet();

    // ---------------------------------------------------------------- Download

    [Fact]
    public async Task Download_BytesIdentical_EtagIsSha256()
    {
        var c = await _server.UserAsync("Mira");
        var (token, head) = await c.LeaseAsync();
        var data = SaveFactory.Build(payload: 100_000);
        var id = (await UploadOkAsync(c, data, token, head)).GetProperty("id").GetInt64();

        var res = await c.GetAsync($"/api/versions/{id}/file");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(data, await res.Content.ReadAsByteArrayAsync());
        Assert.Equal($"\"{SaveFactory.Sha(data)}\"", res.Headers.ETag?.Tag);
        Assert.Equal(SaveFactory.Sha(data), res.Headers.GetValues("Content-SHA256").Single());
        Assert.Equal("application/octet-stream", res.Content.Headers.ContentType?.MediaType);
        Assert.Contains("bytes", res.Headers.AcceptRanges);
    }

    [Fact]
    public async Task Download_RangeRequest_Returns206WithPart()
    {
        var c = await _server.UserAsync("Mira");
        var (token, head) = await c.LeaseAsync();
        var data = SaveFactory.Build(payload: 50_000);
        var id = (await UploadOkAsync(c, data, token, head)).GetProperty("id").GetInt64();

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/versions/{id}/file");
        req.Headers.Range = new RangeHeaderValue(1000, 1999);
        var res = await c.SendAsync(req);

        Assert.Equal(HttpStatusCode.PartialContent, res.StatusCode);
        Assert.Equal(data[1000..2000], await res.Content.ReadAsByteArrayAsync());
        Assert.Equal(data.Length, res.Content.Headers.ContentRange?.Length);
    }

    [Fact]
    public async Task Download_ResumeFromOffset_Works()
    {
        var c = await _server.UserAsync("Mira");
        var (token, head) = await c.LeaseAsync();
        var data = SaveFactory.Build(payload: 20_000);
        var id = (await UploadOkAsync(c, data, token, head)).GetProperty("id").GetInt64();

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/versions/{id}/file");
        req.Headers.Range = new RangeHeaderValue(5000, null);
        var res = await c.SendAsync(req);
        Assert.Equal(HttpStatusCode.PartialContent, res.StatusCode);
        Assert.Equal(data[5000..], await res.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task Download_IfNoneMatch_Returns304()
    {
        var c = await _server.UserAsync("Mira");
        var (token, head) = await c.LeaseAsync();
        var data = SaveFactory.Build();
        var id = (await UploadOkAsync(c, data, token, head)).GetProperty("id").GetInt64();

        using var req = new HttpRequestMessage(HttpMethod.Get, $"/api/versions/{id}/file");
        req.Headers.IfNoneMatch.Add(new EntityTagHeaderValue($"\"{SaveFactory.Sha(data)}\""));
        Assert.Equal(HttpStatusCode.NotModified, (await c.SendAsync(req)).StatusCode);
    }

    [Fact]
    public async Task Download_UnknownVersion_Returns404()
    {
        var c = await _server.UserAsync("Mira");
        var res = await c.GetAsync("/api/versions/999/file");
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("version_not_found", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    // ---------------------------------------------------------------- Restore

    [Fact]
    public async Task Restore_WhileHostActive_Returns409()
    {
        var a = await _server.UserAsync("Mira");
        var (token, head) = await a.LeaseAsync();
        var v1 = (await UploadOkAsync(a, SaveFactory.Build(), token, head)).GetProperty("id").GetInt64();

        var b = await _server.UserAsync("Ole");
        var res = await b.PostAsync($"/api/versions/{v1}/restore", null);

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("host_active", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Restore_CreatesNewNumberAndHead_OldChainKept_OldBaseBecomesConflict()
    {
        var a = await _server.UserAsync("Mira");
        var (token, head) = await a.LeaseAsync();
        var d1 = SaveFactory.Build(playSeconds: 1000);
        var v1 = (await UploadOkAsync(a, d1, token, head)).GetProperty("id").GetInt64();
        var v2 = (await UploadOkAsync(a, SaveFactory.Build(playSeconds: 2000), token, v1)).GetProperty("id").GetInt64();
        Assert.Equal(HttpStatusCode.NoContent, (await a.WithLeaseToken(HttpMethod.Delete, "/api/lease", token)).StatusCode);

        var b = await _server.UserAsync("Ole");
        var res = await b.PostAsync($"/api/versions/{v1}/restore", null);

        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var restored = await res.JsonAsync();
        var v3 = restored.GetProperty("id").GetInt64();
        Assert.Equal(3, restored.GetProperty("number").GetInt64());
        Assert.Equal("import", restored.GetProperty("type").GetString());
        Assert.Equal(v1, restored.GetProperty("restoredFrom").GetInt64());
        Assert.Equal(v2, restored.GetProperty("baseVersionId").GetInt64());
        Assert.Equal("Ole", restored.GetProperty("uploadedBy").GetString());
        Assert.Equal(1000, restored.GetProperty("playSeconds").GetInt32());
        Assert.Equal(v3, ClientExtensions.HeadId(await b.WorldAsync()));

        // Alte Kette bleibt.
        Assert.Equal(3, await b.VersionCountAsync());
        Assert.Equal(HttpStatusCode.OK, (await b.GetAsync($"/api/versions/{v2}/file")).StatusCode);
        Assert.Equal(d1, await (await b.GetAsync($"/api/versions/{v3}/file")).Content.ReadAsByteArrayAsync());

        // Neuer Host mit altem Stand v2 als Basis → Konfliktkopie, Head bleibt der zurückgeholte.
        var (t2, h2) = await a.LeaseAsync();
        Assert.Equal(v3, h2);
        var up = await a.UploadAsync(SaveFactory.Build(playSeconds: 3000), t2, v2);
        Assert.Equal(HttpStatusCode.Conflict, up.StatusCode);
        Assert.Equal("base_mismatch", (await up.JsonAsync()).GetProperty("conflictReason").GetString());
        Assert.Equal(v3, ClientExtensions.HeadId(await a.WorldAsync()));

        var audit = (await (await b.GetAsync("/api/audit")).JsonAsync()).EnumerateArray().ToList();
        Assert.Contains(audit, e => e.GetProperty("action").GetString() == "version_restored" && e.GetProperty("user").GetString() == "Ole");
    }

    [Fact]
    public async Task Restore_AfterLeaseExpired_Works_AndOldHostCannotReviveLease()
    {
        var a = await _server.UserAsync("Mira");
        var (token, head) = await a.LeaseAsync();
        var v1 = (await UploadOkAsync(a, SaveFactory.Build(), token, head)).GetProperty("id").GetInt64();
        _server.Clock.Advance(_server.Options.LeaseDuration + TimeSpan.FromSeconds(1));

        Assert.Equal(HttpStatusCode.Created, (await a.PostAsync($"/api/versions/{v1}/restore", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await a.WithLeaseToken(HttpMethod.Put, "/api/lease/heartbeat", token)).StatusCode);
    }

    [Fact]
    public async Task Restore_ConflictCopy_Works()
    {
        var a = await _server.UserAsync("Mira");
        var conflict = await a.UploadAsync(SaveFactory.Build(), null, 0);
        var kid = (await conflict.JsonAsync()).GetProperty("version").GetProperty("id").GetInt64();
        var res = await a.PostAsync($"/api/versions/{kid}/restore", null);
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        Assert.Equal(1, (await res.JsonAsync()).GetProperty("number").GetInt64());

        // Der Sessionname ist danach festgelegt: ein anderer Spielstand wird abgelehnt.
        Assert.Equal("Fabrik", (await a.WorldAsync()).GetProperty("sessionName").GetString());
        Assert.Equal(HttpStatusCode.UnprocessableEntity, (await a.UploadAsync(SaveFactory.Build(session: "Andere"), null, 0)).StatusCode);
    }

    [Fact]
    public async Task Restore_UnknownVersion_Returns404()
    {
        var a = await _server.UserAsync("Mira");
        Assert.Equal(HttpStatusCode.NotFound, (await a.PostAsync("/api/versions/77/restore", null)).StatusCode);
    }

    [Fact]
    public async Task Restore_DiskFull_Returns507()
    {
        var a = await _server.UserAsync("Mira");
        var kid = (await (await a.UploadAsync(SaveFactory.Build(), null, 0)).JsonAsync()).GetProperty("version").GetProperty("id").GetInt64();
        _server.Disk.Available = 0;
        Assert.Equal(HttpStatusCode.InsufficientStorage, (await a.PostAsync($"/api/versions/{kid}/restore", null)).StatusCode);
    }

    // ---------------------------------------------------------------- Karte

    [Fact]
    public async Task Map_PutThenGet_ReturnsSameJson_AndHasMapIsSet()
    {
        var a = await _server.UserAsync("Mira");
        var (token, head) = await a.LeaseAsync();
        var id = (await UploadOkAsync(a, SaveFactory.Build(), token, head)).GetProperty("id").GetInt64();
        var json = """{"version":1,"clusters":[{"id":1,"x":10.5,"y":-3,"count":4,"topTypes":["Konstruktor"]}],"stations":[],"players":[],"bounds":{"minX":0,"minY":0,"maxX":1,"maxY":1}}""";

        Assert.Equal(HttpStatusCode.NotFound, (await a.GetAsync($"/api/versions/{id}/map")).StatusCode);
        var put = await a.PutAsync($"/api/versions/{id}/map", new StringContent(json, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);

        var get = await a.GetAsync($"/api/versions/{id}/map");
        Assert.Equal(HttpStatusCode.OK, get.StatusCode);
        Assert.Equal("application/json", get.Content.Headers.ContentType?.MediaType);
        Assert.Equal(json, await get.Content.ReadAsStringAsync());

        var versions = await (await a.GetAsync("/api/versions")).JsonAsync();
        Assert.True(versions[0].GetProperty("hasMap").GetBoolean());
    }

    [Fact]
    public async Task Map_OtherUser_Rejected403()
    {
        var a = await _server.UserAsync("Mira");
        var (token, head) = await a.LeaseAsync();
        var id = (await UploadOkAsync(a, SaveFactory.Build(), token, head)).GetProperty("id").GetInt64();
        var b = await _server.UserAsync("Ole");

        var res = await b.PutAsync($"/api/versions/{id}/map", new StringContent("{}", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal("not_uploader", (await res.JsonAsync()).GetProperty("error").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await a.GetAsync($"/api/versions/{id}/map")).StatusCode);
    }

    [Fact]
    public async Task Map_InvalidJson_Rejected400()
    {
        var a = await _server.UserAsync("Mira");
        var (token, head) = await a.LeaseAsync();
        var id = (await UploadOkAsync(a, SaveFactory.Build(), token, head)).GetProperty("id").GetInt64();

        var res = await a.PutAsync($"/api/versions/{id}/map", new StringContent("{kaputt", Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("invalid_json", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Map_UnknownVersion_Returns404()
    {
        var a = await _server.UserAsync("Mira");
        var res = await a.PutAsync("/api/versions/5/map", new StringContent("{}", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
        Assert.Equal("version_not_found", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Map_TooLarge_Returns413()
    {
        using var server = new SyncServer(o => o.MaxMapBytes = 100);
        var a = await server.UserAsync("Mira");
        var (token, head) = await a.LeaseAsync();
        var id = (await UploadOkAsync(a, SaveFactory.Build(), token, head)).GetProperty("id").GetInt64();
        var big = "[" + string.Join(',', Enumerable.Repeat("1", 200)) + "]";
        var res = await a.PutAsync($"/api/versions/{id}/map", new StringContent(big, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, res.StatusCode);
    }

    // ---------------------------------------------------------------- Aufbewahrung

    [Fact]
    public async Task Retention_After25Uploads_OldFilesRemoved_HeadAndLatest20Kept()
    {
        var a = await _server.UserAsync("Mira");
        var (token, head) = await a.LeaseAsync();
        var ids = new List<long>();
        for (var i = 0; i < 25; i++)
        {
            var v = await UploadOkAsync(a, SaveFactory.Build(playSeconds: 1000 + i, payload: 64), token, head);
            head = v.GetProperty("id").GetInt64();
            ids.Add(head);
            _server.Clock.Advance(TimeSpan.FromMinutes(1));
            await a.WithLeaseToken(HttpMethod.Put, "/api/lease/heartbeat", token);
        }

        var dir = Path.Combine(_server.DataDir, "versions");
        var files = StoredIds(dir);

        Assert.Equal(20, files.Count);
        Assert.Contains(head, files);
        Assert.All(ids.TakeLast(20), id => Assert.Contains(id, files));
        Assert.All(ids.Take(5), id => Assert.DoesNotContain(id, files));

        Assert.Equal(20, await a.VersionCountAsync());
        Assert.Equal(HttpStatusCode.NotFound, (await a.GetAsync($"/api/versions/{ids[0]}/file")).StatusCode);
        Assert.Equal(head, ClientExtensions.HeadId(await a.WorldAsync()));
    }

    [Fact]
    public async Task Retention_KeepsOnePerDay_And30DayOldConflictsGo()
    {
        var a = await _server.UserAsync("Mira");
        var conflictId = (await (await a.UploadAsync(SaveFactory.Build(playSeconds: 1), null, 0)).JsonAsync()).GetProperty("version").GetProperty("id").GetInt64();
        var (token, head) = await a.LeaseAsync();
        var firstDay = (await UploadOkAsync(a, SaveFactory.Build(playSeconds: 10), token, head)).GetProperty("id").GetInt64();
        head = firstDay;
        _server.Clock.Advance(TimeSpan.FromDays(1));

        for (var i = 0; i < 21; i++)
        {
            // Heartbeat hält die Lease über die vorgespulte Zeit.
            await a.WithLeaseToken(HttpMethod.Put, "/api/lease/heartbeat", token);
            head = (await UploadOkAsync(a, SaveFactory.Build(playSeconds: 100 + i, payload: 64), token, head)).GetProperty("id").GetInt64();
        }

        var files = StoredIds(Path.Combine(_server.DataDir, "versions"));
        Assert.Contains(firstDay, files);       // einzige Version ihres Tages
        Assert.Contains(conflictId, files);     // Konfliktkopie jünger als 30 Tage

        _server.Clock.Advance(TimeSpan.FromDays(31));
        await a.WithLeaseToken(HttpMethod.Put, "/api/lease/heartbeat", token);
        head = (await UploadOkAsync(a, SaveFactory.Build(playSeconds: 500, payload: 64), token, head)).GetProperty("id").GetInt64();

        files = StoredIds(Path.Combine(_server.DataDir, "versions"));
        Assert.DoesNotContain(conflictId, files);
        Assert.DoesNotContain(firstDay, files);
        Assert.Contains(head, files);
    }
}
