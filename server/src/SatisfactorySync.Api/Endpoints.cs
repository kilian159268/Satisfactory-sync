using System.Globalization;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Net.Http.Headers;
using SatisfactorySync.Core;

namespace SatisfactorySync.Api;

internal sealed record RedeemRequest(string? Code, string? Name);

internal sealed record RedeemResponse(string Token, string Name);

internal sealed record PresenceRequest(string? Status);

/// <summary>HTTP-Abbildung der API aus Plan 5.2 (Vertrag: contracts/openapi.yaml).</summary>
internal static class Endpoints
{
    public const string LeaseTokenHeader = "Lease-Token";
    public const string BaseVersionHeader = "Base-Version";
    public const string Sha256Header = "Content-SHA256";
    public const string IdempotencyHeader = "Idempotency-Key";

    public static void Map(WebApplication app)
    {
        app.MapPost("/api/auth/redeem", (RedeemRequest body, AuthService auth) =>
        {
            var r = auth.Redeem(body.Code, body.Name);
            return r.Ok ? Results.Ok(new RedeemResponse(r.Value!, body.Name!.Trim())) : Problem(r.Error!);
        }).RequireRateLimiting("redeem");

        var api = app.MapGroup("/api").RequireAuthorization();

        api.MapGet("/me", (HttpContext ctx) => Results.Ok(new { name = CurrentUser(ctx).Name }));

        api.MapGet("/world", (SyncService s) => Results.Ok(s.GetWorld()));

        api.MapPost("/lease", (HttpContext ctx, SyncService s) => From(s.AcquireLease(CurrentUser(ctx)), Results.Ok));

        api.MapPut("/lease/heartbeat", (HttpContext ctx, SyncService s) =>
            LeaseToken(ctx) is { } t ? From(s.Heartbeat(CurrentUser(ctx), t), e => Results.Ok(new { expiresAt = e })) : MissingLeaseToken());

        api.MapDelete("/lease", (HttpContext ctx, SyncService s) =>
            LeaseToken(ctx) is { } t ? From(s.ReleaseLease(CurrentUser(ctx), t), _ => Results.NoContent()) : MissingLeaseToken());

        api.MapPost("/lease/force-release", (HttpContext ctx, SyncService s) =>
            From(s.ForceRelease(CurrentUser(ctx)), released => Results.Ok(new { released })));

        api.MapGet("/versions", (SyncService s) => Results.Ok(s.ListVersions()));

        api.MapPost("/versions", UploadAsync);

        api.MapGet("/versions/{id:long}/file", (long id, HttpContext ctx, SyncService s) =>
        {
            var r = s.OpenFile(id);
            if (!r.Ok)
            {
                return Problem(r.Error!);
            }

            var (info, path) = r.Value;
            ctx.Response.Headers[Sha256Header] = info.Sha256;
            return Results.File(
                path,
                "application/octet-stream",
                fileDownloadName: $"version-{info.Label}.sav",
                lastModified: info.UploadedAt,
                entityTag: new EntityTagHeaderValue($"\"{info.Sha256}\""),
                enableRangeProcessing: true);
        });

        api.MapPost("/versions/{id:long}/restore", (long id, HttpContext ctx, SyncService s) =>
            From(s.Restore(CurrentUser(ctx), id), v => Results.Created($"/api/versions/{v.Id}", v)));

        api.MapPut("/versions/{id:long}/map", async (long id, HttpContext ctx, SyncService s, SyncOptions o) =>
        {
            if (ctx.Request.ContentLength > o.MaxMapBytes)
            {
                return Problem(Errors.TooLarge);
            }

            using var reader = new StreamReader(ctx.Request.Body);
            var buffer = new char[o.MaxMapBytes + 1];
            var read = await reader.ReadBlockAsync(buffer, ctx.RequestAborted).ConfigureAwait(false);
            return read > o.MaxMapBytes
                ? Problem(Errors.TooLarge)
                : From(s.PutMap(CurrentUser(ctx), id, new string(buffer, 0, read)), _ => Results.NoContent());
        });

        api.MapGet("/versions/{id:long}/map", (long id, SyncService s) =>
            From(s.GetMap(id), json => Results.Text(json, "application/json")));

        api.MapPut("/presence", (PresenceRequest body, HttpContext ctx, SyncService s) =>
        {
            if (!PresenceStatus.IsValid(body.Status))
            {
                return Problem(Errors.Invalid("invalid_status", "Status muss „launcher“ oder „im_spiel“ sein."));
            }

            s.SetPresence(CurrentUser(ctx), body.Status!);
            return Results.NoContent();
        });

        api.MapGet("/crew", (SyncService s) => Results.Ok(s.GetCrew()));

        api.MapGet("/audit", (SyncService s) => Results.Ok(s.GetAudit()));
    }

    private static async Task<IResult> UploadAsync(HttpContext ctx, SyncService s, SyncOptions o)
    {
        var user = CurrentUser(ctx);
        var h = ctx.Request.Headers;
        if (!long.TryParse(h[BaseVersionHeader], NumberStyles.None, CultureInfo.InvariantCulture, out var baseVersion))
        {
            return Problem(Errors.Invalid("invalid_base_version", "Base-Version fehlt."));
        }

        long? leaseToken = null;
        if (!string.IsNullOrEmpty(h[LeaseTokenHeader]))
        {
            if (LeaseToken(ctx) is not { } t)
            {
                return MissingLeaseToken();
            }

            leaseToken = t;
        }

        if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
        {
            limit.MaxRequestBodySize = o.MaxUploadBytes;
        }

        var request = new UploadRequest(leaseToken, baseVersion, h[Sha256Header].ToString(), h[IdempotencyHeader].ToString());
        Result<UploadResult> r;
        try
        {
            r = await s.UploadAsync(user, request, ctx.Request.Body, ctx.Request.ContentLength, ctx.RequestAborted).ConfigureAwait(false);
        }
        catch (BadHttpRequestException ex) when (ex.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            return Problem(Errors.TooLarge);
        }

        if (!r.Ok)
        {
            return Problem(r.Error!);
        }

        var result = r.Value!;
        return result.Accepted
            ? Results.Created($"/api/versions/{result.Version.Id}", result)
            : Results.Json(result, statusCode: StatusCodes.Status409Conflict);
    }

    private static User CurrentUser(HttpContext ctx) =>
        ctx.Items[TokenAuthHandler.UserItem] as User ?? throw new InvalidOperationException("Kein angemeldeter Benutzer.");

    private static long? LeaseToken(HttpContext ctx) =>
        long.TryParse(ctx.Request.Headers[LeaseTokenHeader], NumberStyles.None, CultureInfo.InvariantCulture, out var t) ? t : null;

    private static IResult MissingLeaseToken() =>
        Problem(Errors.Invalid("invalid_lease_token", "Lease-Token fehlt oder ist ungültig."));

    private static IResult From<T>(Result<T> r, Func<T, IResult> ok) => r.Ok ? ok(r.Value!) : Problem(r.Error!);

    public static IResult Problem(SyncError e) => Results.Json(
        new ErrorBody(e.Code, e.Message, e.Details),
        statusCode: e.Kind switch
        {
            ErrorKind.Invalid => StatusCodes.Status400BadRequest,
            ErrorKind.Unauthorized => StatusCodes.Status401Unauthorized,
            ErrorKind.Forbidden => StatusCodes.Status403Forbidden,
            ErrorKind.NotFound => StatusCodes.Status404NotFound,
            ErrorKind.Conflict => StatusCodes.Status409Conflict,
            ErrorKind.Unprocessable => StatusCodes.Status422UnprocessableEntity,
            ErrorKind.TooLarge => StatusCodes.Status413PayloadTooLarge,
            ErrorKind.InsufficientStorage => StatusCodes.Status507InsufficientStorage,
            _ => StatusCodes.Status500InternalServerError,
        });
}
