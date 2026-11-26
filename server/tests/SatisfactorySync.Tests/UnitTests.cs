using System.Text;
using Microsoft.Extensions.DependencyInjection;
using SatisfactorySync.Core;
using SatisfactorySync.Core.Saves;

namespace SatisfactorySync.Tests;

public sealed class SaveHeaderParserTests
{
    private static SaveHeader Parse(byte[] data)
    {
        using var ms = new MemoryStream(data);
        return SaveHeaderParser.Parse(ms);
    }

    [Fact]
    public void HeaderVersion13_HasNoSaveName()
    {
        var h = Parse(SaveFactory.Build(session: "Fabrik", playSeconds: 7200, headerVersion: 13, build: 416835));
        Assert.Equal(13, h.HeaderVersion);
        Assert.Equal(46, h.SaveVersion);
        Assert.Equal(416835, h.BuildVersion);
        Assert.Null(h.SaveName);
        Assert.Equal("Persistent_Level", h.MapName);
        Assert.Equal("Fabrik", h.SessionName);
        Assert.Equal(7200, h.PlayDurationSeconds);
        Assert.Equal(638_680_000_000_000_000L, h.SaveDateTicks);
    }

    [Fact]
    public void HeaderVersion14_ReadsSaveName()
    {
        var h = Parse(SaveFactory.Build(session: "Fabrik", playSeconds: 60, headerVersion: 14));
        Assert.Equal(14, h.HeaderVersion);
        Assert.Equal("Fabrik_autosave_0", h.SaveName);
        Assert.Equal("Fabrik", h.SessionName);
        Assert.Equal(60, h.PlayDurationSeconds);
    }

    [Fact]
    public void Utf16SessionName_IsDecoded()
    {
        var h = Parse(SaveFactory.Build(session: "Fabrik Ünd 工場", utf16Session: true));
        Assert.Equal("Fabrik Ünd 工場", h.SessionName);
    }

    [Fact]
    public void Latin1SessionName_IsDecoded()
    {
        Assert.Equal("Größe", Parse(SaveFactory.Build(session: "Größe")).SessionName);
    }

    [Fact]
    public void OnlyHeaderIsRead_StreamPositionStaysNearStart()
    {
        using var ms = new MemoryStream(SaveFactory.Build(payload: 1_000_000));
        SaveHeaderParser.Parse(ms);
        Assert.True(ms.Position < 1000);
    }

    [Fact]
    public void TruncatedFile_AtEveryPosition_Throws()
    {
        var full = SaveFactory.Build(payload: 0);
        // Header endet vor dem SessionVisibility-Byte (letztes Byte der Datei).
        for (var len = 0; len < full.Length - 1; len++)
        {
            var cut = full[..len];
            Assert.Throws<SaveHeaderException>(() => Parse(cut));
        }
    }

    [Theory]
    [InlineData("Das ist kein Spielstand, sondern einfach nur Text.")]
    [InlineData("\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0")]
    public void Nonsense_Throws(string text) =>
        Assert.Throws<SaveHeaderException>(() => Parse(Encoding.UTF8.GetBytes(text)));

    [Fact]
    public void RandomBytes_Throw()
    {
        var rng = new Random(1234);
        for (var i = 0; i < 200; i++)
        {
            var data = new byte[rng.Next(0, 4096)];
            rng.NextBytes(data);
            // Zufall trifft praktisch nie ein plausibles Header-Format; ein Treffer wäre aber kein Absturz.
            try
            {
                Parse(data);
            }
            catch (SaveHeaderException)
            {
            }
        }
    }

    [Fact]
    public void HugeStringLength_Throws()
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write(13);
        w.Write(46);
        w.Write(1);
        w.Write(int.MaxValue);
        w.Write(new byte[64]);
        Assert.Throws<SaveHeaderException>(() => Parse(ms.ToArray()));

        ms.SetLength(0);
        w.Write(13);
        w.Write(46);
        w.Write(1);
        w.Write(int.MinValue);
        Assert.Throws<SaveHeaderException>(() => Parse(ms.ToArray()));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(65)]
    public void UnknownHeaderVersion_Throws(int version) =>
        Assert.Throws<SaveHeaderException>(() => Parse(SaveFactory.Build(headerVersion: version)));

    [Fact]
    public void NegativePlaytime_Throws() =>
        Assert.Throws<SaveHeaderException>(() => Parse(SaveFactory.Build(playSeconds: -5)));

    [Fact]
    public void EmptySessionName_Throws() =>
        Assert.Throws<SaveHeaderException>(() => Parse(SaveFactory.Build(session: "")));
}

public sealed class RetentionTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 26, 18, 0, 0, TimeSpan.Zero);

    private static RetentionCandidate Normal(long id, DateTimeOffset at) => new(id, id, VersionType.Normal, at);

    [Fact]
    public void Empty_NothingToPrune() =>
        Assert.Empty(Retention.SelectPrunable([], null, Now, 20, 30));

    [Fact]
    public void KeepsLatestN_SameDay()
    {
        var versions = Enumerable.Range(1, 25).Select(i => Normal(i, Now.AddMinutes(-100 + i))).ToList();
        var prune = Retention.SelectPrunable(versions, 25, Now, 20, 30);
        Assert.Equal([1L, 2, 3, 4, 5], prune.Order());
    }

    [Fact]
    public void HeadIsAlwaysKept_EvenIfOld()
    {
        var versions = Enumerable.Range(1, 30).Select(i => Normal(i, Now.AddDays(-100))).ToList();
        var prune = Retention.SelectPrunable(versions, 1, Now, 5, 30);
        Assert.DoesNotContain(1L, prune);
        Assert.Equal(24, prune.Count);
    }

    [Fact]
    public void KeepsNewestPerDay_WithinWindow()
    {
        var versions = new List<RetentionCandidate>
        {
            Normal(1, Now.AddDays(-3).AddHours(-2)),
            Normal(2, Now.AddDays(-3).AddHours(-1)), // neuester von Tag -3
            Normal(3, Now.AddDays(-2)),
            Normal(4, Now.AddDays(-40)),             // außerhalb des Fensters
            Normal(5, Now),
            Normal(6, Now.AddMinutes(1)),
        };
        var prune = Retention.SelectPrunable(versions, 6, Now, 2, 30);
        Assert.Equal([1L, 4], prune.Order());
    }

    [Fact]
    public void ConflictCopies_KeptForWindow_ThenPruned_NeverCountAsLatest()
    {
        var versions = new List<RetentionCandidate>
        {
            Normal(1, Now),
            new(2, null, VersionType.Conflict, Now.AddDays(-29)),
            new(3, null, VersionType.Conflict, Now.AddDays(-31)),
            Normal(4, Now),
        };
        var prune = Retention.SelectPrunable(versions, 4, Now, 1, 30);
        // 1: gleicher Tag wie der neuere Head, nicht unter den letzten 1 → weg. 3: Konfliktkopie älter als 30 Tage → weg.
        Assert.Equal([1L, 3], prune.Order());
    }

    [Fact]
    public void ImportsCountAsMainLine()
    {
        var versions = new List<RetentionCandidate>
        {
            Normal(1, Now.AddDays(-50)),
            new(2, 2, VersionType.Import, Now.AddDays(-50)),
            Normal(3, Now),
        };
        var prune = Retention.SelectPrunable(versions, 3, Now, 2, 30);
        Assert.Equal([1L], prune.Order());
    }
}

/// <summary>Plan 8 „Upload bricht ab“: nichts Halbes bleibt liegen, Retry mit gleichem Key klappt.</summary>
public sealed class AbortedUploadTests : IDisposable
{
    private readonly SyncServer _server = new();

    public void Dispose() => _server.Dispose();

    private sealed class BreakingStream(byte[] data, int breakAfter) : Stream
    {
        private int _pos;

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => data.Length;

        public override long Position { get => _pos; set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_pos >= breakAfter)
            {
                throw new IOException("Verbindung abgebrochen.");
            }

            var n = Math.Min(Math.Min(count, breakAfter - _pos), 1000);
            Array.Copy(data, _pos, buffer, offset, n);
            _pos += n;
            return n;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    [Fact]
    public async Task AbortMidway_NoVersion_NoTempFile_RetryWithSameKeyWorks()
    {
        await _server.UserAsync("Mira");
        var auth = _server.Services.GetRequiredService<AuthService>();
        var sync = _server.Services.GetRequiredService<SyncService>();
        var user = auth.ListUsers().Single();
        var lease = sync.AcquireLease(user).Value!;
        var data = SaveFactory.Build(payload: 50_000);
        var request = new UploadRequest(lease.FencingToken, 0, SaveFactory.Sha(data), "key-1");

        using (var broken = new BreakingStream(data, 20_000))
        {
            await Assert.ThrowsAsync<IOException>(() => sync.UploadAsync(user, request, broken, data.Length, CancellationToken.None));
        }

        Assert.Empty(sync.ListVersions());
        Assert.Empty(Directory.GetFiles(Path.Combine(_server.DataDir, "tmp")));
        Assert.Null(sync.GetWorld().Head);

        using var ok = new MemoryStream(data);
        var r = await sync.UploadAsync(user, request, ok, data.Length, CancellationToken.None);
        Assert.True(r.Ok);
        Assert.True(r.Value!.Accepted);
        Assert.Single(sync.ListVersions());
    }

    [Fact]
    public async Task Cancelled_NoTempFileLeft()
    {
        await _server.UserAsync("Mira");
        var sync = _server.Services.GetRequiredService<SyncService>();
        var user = _server.Services.GetRequiredService<AuthService>().ListUsers().Single();
        var data = SaveFactory.Build();
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();
        using var ms = new MemoryStream(data);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            sync.UploadAsync(user, new UploadRequest(null, 0, SaveFactory.Sha(data), "k"), ms, data.Length, cts.Token));
        Assert.Empty(Directory.GetFiles(Path.Combine(_server.DataDir, "tmp")));
    }
}
