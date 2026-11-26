using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace SatisfactorySync.Tests;

/// <summary>Plan 6.5: Anwesenheit und Gruppe.</summary>
public sealed class CrewTests : IDisposable
{
    private readonly SyncServer _server = new();

    public void Dispose() => _server.Dispose();

    private static async Task<JsonElement> MemberAsync(HttpClient c, string name) =>
        (await (await c.GetAsync("/api/crew")).JsonAsync()).EnumerateArray().Single(m => m.GetProperty("name").GetString() == name);

    [Fact]
    public async Task NewUser_WithoutPresence_IsOffline()
    {
        var c = await _server.UserAsync("Mira");
        var m = await MemberAsync(c, "Mira");
        Assert.False(m.GetProperty("online").GetBoolean());
        Assert.Equal(JsonValueKind.Null, m.GetProperty("status").ValueKind);
        Assert.Equal(JsonValueKind.Null, m.GetProperty("lastSeen").ValueKind);
        Assert.False(m.GetProperty("isHost").GetBoolean());
    }

    [Theory]
    [InlineData("launcher")]
    [InlineData("im_spiel")]
    public async Task Presence_MakesOnline_WithStatus(string status)
    {
        var a = await _server.UserAsync("Mira");
        var b = await _server.UserAsync("Ole");
        Assert.Equal(HttpStatusCode.NoContent, (await a.PutAsJsonAsync("/api/presence", new { status })).StatusCode);

        var m = await MemberAsync(b, "Mira");
        Assert.True(m.GetProperty("online").GetBoolean());
        Assert.Equal(status, m.GetProperty("status").GetString());
        Assert.Equal(_server.Clock.GetUtcNow(), m.GetProperty("lastSeen").GetDateTimeOffset());
    }

    [Fact]
    public async Task Presence_After90Seconds_Offline()
    {
        var a = await _server.UserAsync("Mira");
        await a.PutAsJsonAsync("/api/presence", new { status = "im_spiel" });

        _server.Clock.Advance(TimeSpan.FromSeconds(90));
        Assert.True((await MemberAsync(a, "Mira")).GetProperty("online").GetBoolean());

        _server.Clock.Advance(TimeSpan.FromSeconds(1));
        var m = await MemberAsync(a, "Mira");
        Assert.False(m.GetProperty("online").GetBoolean());
        Assert.Equal(JsonValueKind.Null, m.GetProperty("status").ValueKind);
        Assert.NotEqual(JsonValueKind.Null, m.GetProperty("lastSeen").ValueKind);

        // Neues Lebenszeichen → wieder online.
        await a.PutAsJsonAsync("/api/presence", new { status = "launcher" });
        Assert.True((await MemberAsync(a, "Mira")).GetProperty("online").GetBoolean());
    }

    [Fact]
    public async Task Crew_IsHost_FollowsLease()
    {
        var a = await _server.UserAsync("Mira");
        var b = await _server.UserAsync("Ole");
        await a.LeaseAsync();

        Assert.True((await MemberAsync(b, "Mira")).GetProperty("isHost").GetBoolean());
        Assert.False((await MemberAsync(b, "Ole")).GetProperty("isHost").GetBoolean());

        _server.Clock.Advance(_server.Options.LeaseDuration + TimeSpan.FromSeconds(1));
        Assert.False((await MemberAsync(b, "Mira")).GetProperty("isHost").GetBoolean());
    }

    [Theory]
    [InlineData("afk")]
    [InlineData("")]
    [InlineData(null)]
    public async Task Presence_InvalidStatus_400(string? status)
    {
        var a = await _server.UserAsync("Mira");
        var res = await a.PutAsJsonAsync("/api/presence", new { status });
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("invalid_status", (await res.JsonAsync()).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Crew_ListsAllUsersSorted_WithoutBlocked()
    {
        var c = await _server.UserAsync("Ole");
        await _server.UserAsync("Mira");
        await _server.UserAsync("Zoe");
        Assert.True(Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions
            .GetRequiredService<SatisfactorySync.Core.AuthService>(_server.Services).SetBlocked("Zoe", true));

        var names = (await (await c.GetAsync("/api/crew")).JsonAsync()).EnumerateArray().Select(m => m.GetProperty("name").GetString()).ToList();
        Assert.Equal(["Mira", "Ole"], names);
    }
}
