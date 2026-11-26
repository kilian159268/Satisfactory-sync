using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using SatisfactorySync.Core;
using YamlDotNet.RepresentationModel;

namespace SatisfactorySync.Tests;

/// <summary>Hält contracts/openapi.yaml und die implementierte API deckungsgleich.</summary>
public sealed partial class ContractTests : IDisposable
{
    private static readonly string YamlPath = FindContract();
    private static readonly string YamlText = File.ReadAllText(YamlPath);
    private static readonly YamlMappingNode Root = Load();

    private readonly SyncServer _server = new();

    public void Dispose() => _server.Dispose();

    private static string FindContract()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "contracts", "openapi.yaml");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new FileNotFoundException("contracts/openapi.yaml nicht gefunden.");
    }

    private static YamlMappingNode Load()
    {
        var stream = new YamlStream();
        using var reader = new StringReader(File.ReadAllText(FindContract()));
        stream.Load(reader);
        return (YamlMappingNode)stream.Documents[0].RootNode;
    }

    private static YamlMappingNode Map(YamlNode node, string key) => (YamlMappingNode)((YamlMappingNode)node)[key];

    [GeneratedRegex(@"\{(\w+):[^}]+\}")]
    private static partial Regex RouteConstraint();

    [Fact]
    public void IsOpenApi31()
    {
        Assert.Equal("3.1.0", ((YamlScalarNode)Root["openapi"]).Value);
    }

    [Fact]
    public void EveryMappedRoute_IsInContract_AndViceVersa()
    {
        _ = _server.CreateClient(); // Server starten, damit alle Endpunkte registriert sind.
        var implemented = _server.Services.GetRequiredService<EndpointDataSource>().Endpoints
            .OfType<RouteEndpoint>()
            .SelectMany(e => (e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? []).Select(m =>
                $"{m.ToUpperInvariant()} {RouteConstraint().Replace("/" + e.RoutePattern.RawText!.TrimStart('/'), "{$1}")}"))
            .ToHashSet();

        var documented = Map(Root, "paths").Children
            .SelectMany(p => ((YamlMappingNode)p.Value).Children.Keys.Select(m => $"{((YamlScalarNode)m).Value!.ToUpperInvariant()} {((YamlScalarNode)p.Key).Value}"))
            .ToHashSet();

        Assert.NotEmpty(implemented);
        Assert.Empty(implemented.Except(documented));
        Assert.Empty(documented.Except(implemented));
    }

    [Fact]
    public void AllRefs_Resolve()
    {
        var refs = Regex.Matches(YamlText, @"\$ref: '#/([^']+)'").Select(m => m.Groups[1].Value).Distinct().ToList();
        Assert.NotEmpty(refs);
        foreach (var r in refs)
        {
            YamlNode node = Root;
            foreach (var part in r.Split('/'))
            {
                var map = Assert.IsType<YamlMappingNode>(node);
                Assert.True(map.Children.ContainsKey(part), $"$ref #/{r} zeigt ins Leere.");
                node = map[part];
            }
        }
    }

    [Fact]
    public void EveryErrorCode_IsDocumented()
    {
        var codes = typeof(Errors).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.FieldType == typeof(SyncError))
            .Select(f => ((SyncError)f.GetValue(null)!).Code)
            .Concat(["lease_held", "invalid_save", "wrong_session", "invalid_name", "invalid_status", "invalid_json",
                "invalid_sha256", "invalid_base_version", "invalid_idempotency_key", "invalid_lease_token",
                "unauthorized", "rate_limited", "bad_request",
                "no_lease", "stale_token", "lease_expired", "base_mismatch", "playtime_regressed"]);
        foreach (var code in codes)
        {
            Assert.Contains(code, YamlText, StringComparison.Ordinal);
        }
    }

    public static TheoryData<string, Type> Schemas => new()
    {
        { "Version", typeof(VersionInfo) },
        { "UploadResult", typeof(UploadResult) },
        { "Host", typeof(HostInfo) },
        { "WorldStatus", typeof(WorldStatus) },
        { "LeaseGrant", typeof(LeaseGrant) },
        { "CrewMember", typeof(CrewMember) },
        { "AuditEntry", typeof(AuditEntry) },
    };

    [Theory]
    [MemberData(nameof(Schemas))]
    public void SchemaProperties_MatchRecords(string schema, Type type)
    {
        var s = Map(Map(Map(Root, "components"), "schemas"), schema);
        var documented = ((YamlMappingNode)s["properties"]).Children.Keys.Select(k => ((YamlScalarNode)k).Value!).ToHashSet();
        var required = ((YamlSequenceNode)s["required"]).Children.Select(k => ((YamlScalarNode)k).Value!).ToHashSet();
        var actual = type.GetProperties().Select(p => JsonNamingPolicy.CamelCase.ConvertName(p.Name)).ToHashSet();

        Assert.Equal(actual.Order(), documented.Order());
        Assert.Equal(actual.Order(), required.Order());
    }
}
