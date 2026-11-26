using System.Globalization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.HttpOverrides;
using SatisfactorySync.Api;
using SatisfactorySync.Core;
using SatisfactorySync.Core.Data;

var command = args.Length > 0 && !args[0].StartsWith('-') && !args[0].Contains('=', StringComparison.Ordinal) ? args[0] : null;
var builder = WebApplication.CreateBuilder(command is null ? args : []);

var configFile = Environment.GetEnvironmentVariable("SYNC_CONFIG") ?? "/etc/satisfactory-sync/appsettings.json";
builder.Configuration.AddJsonFile(configFile, optional: true, reloadOnChange: false);
builder.Configuration.AddEnvironmentVariables();

if (!builder.Environment.IsDevelopment())
{
    builder.Logging.ClearProviders();
    builder.Logging.AddJsonConsole(o => o.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ ");
}

builder.Services.AddSingleton(sp => sp.GetRequiredService<IConfiguration>().GetSection(SyncOptions.Section).Get<SyncOptions>() ?? new SyncOptions());
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IDiskSpace, DriveDiskSpace>();
builder.Services.AddSingleton<SyncDatabase>();
builder.Services.AddSingleton<AuthService>();
builder.Services.AddSingleton<SyncService>();

builder.Services.AddAuthentication(TokenAuthHandler.SchemeName)
    .AddScheme<AuthenticationSchemeOptions, TokenAuthHandler>(TokenAuthHandler.SchemeName, null);
builder.Services.AddAuthorization();

builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    // nginx läuft auf demselben Rechner; nur Loopback-Proxys werden akzeptiert (Standard).
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
});

builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.OnRejected = (ctx, ct) => new ValueTask(ctx.HttpContext.Response.WriteAsJsonAsync(
        new ErrorBody("rate_limited", "Zu viele Anfragen. Bitte kurz warten.", null), ct));
    o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
    {
        var sync = ctx.RequestServices.GetRequiredService<SyncOptions>();
        return RateLimitPartition.GetTokenBucketLimiter(
            ctx.User.Identity?.Name ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "anon",
            _ => new TokenBucketRateLimiterOptions
            {
                TokenLimit = sync.RequestBurst,
                TokensPerPeriod = Math.Max(1, sync.RequestsPerMinute / 2),
                ReplenishmentPeriod = TimeSpan.FromSeconds(30),
                QueueLimit = 0,
            });
    });
    o.AddPolicy("redeem", ctx =>
    {
        var sync = ctx.RequestServices.GetRequiredService<SyncOptions>();
        return RateLimitPartition.GetFixedWindowLimiter(
            ctx.Connection.RemoteIpAddress?.ToString() ?? "anon",
            _ => new FixedWindowRateLimiterOptions { PermitLimit = sync.RedeemPerMinute, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 });
    });
});

// Auch in Development keine Ausnahmeseite bei unlesbaren Anfragen, sondern 400 im API-Fehlerformat.
builder.Services.Configure<RouteHandlerOptions>(o => o.ThrowOnBadRequest = false);
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase);

var app = builder.Build();

if (command is not null)
{
    return Cli.Run(command, args[1..], app.Services);
}

app.UseForwardedHeaders();

// Antworten ohne Inhalt (z. B. unlesbares JSON, unbekannte Route) bekommen dasselbe Fehlerformat wie der Rest der API.
app.UseStatusCodePages(ctx =>
{
    var status = ctx.HttpContext.Response.StatusCode;
    var (code, message) = status switch
    {
        StatusCodes.Status400BadRequest => ("bad_request", "Anfrage ist ungültig."),
        StatusCodes.Status404NotFound => ("not_found", "Gibt es nicht."),
        StatusCodes.Status405MethodNotAllowed => ("method_not_allowed", "Methode nicht erlaubt."),
        StatusCodes.Status413PayloadTooLarge => ("too_large", "Datei ist zu groß."),
        StatusCodes.Status415UnsupportedMediaType => ("unsupported_media_type", "Falscher Inhaltstyp."),
        _ => ("error", "Fehler auf dem Server."),
    };
    return ctx.HttpContext.Response.WriteAsJsonAsync(new ErrorBody(code, message, null), ctx.HttpContext.RequestAborted);
});
var pathBase = app.Configuration["Sync:PathBase"];
if (!string.IsNullOrEmpty(pathBase))
{
    app.UsePathBase(pathBase);
}

app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();

app.MapGet("/healthz", (SyncDatabase db) =>
{
    db.Read(c =>
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT 1";
        return cmd.ExecuteScalar();
    });
    return Results.Ok(new { status = "ok", time = DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture) });
});

Endpoints.Map(app);

app.Run();
return 0;

#pragma warning disable CA1515 // Program muss für WebApplicationFactory öffentlich sein.
public partial class Program;
#pragma warning restore CA1515
