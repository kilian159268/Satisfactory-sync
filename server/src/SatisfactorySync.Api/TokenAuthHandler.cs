using System.Globalization;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using SatisfactorySync.Core;

namespace SatisfactorySync.Api;

/// <summary>Persönliches Token als <c>Authorization: Bearer …</c>. Der Server kennt nur den Hash.</summary>
internal sealed class TokenAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    AuthService auth) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Token";
    public const string UserItem = "sync-user";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var header = Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.Ordinal))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        var user = auth.Authenticate(header["Bearer ".Length..].Trim());
        if (user is null)
        {
            return Task.FromResult(AuthenticateResult.Fail("Ungültiges Token."));
        }

        Context.Items[UserItem] = user;
        var identity = new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, user.Id.ToString(CultureInfo.InvariantCulture)), new Claim(ClaimTypes.Name, user.Name)],
            SchemeName);
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName)));
    }

    protected override async Task HandleChallengeAsync(AuthenticationProperties properties)
    {
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        await Response.WriteAsJsonAsync(new ErrorBody("unauthorized", "Nicht angemeldet oder Zugang gesperrt.", null)).ConfigureAwait(false);
    }
}

internal sealed record ErrorBody(string Error, string Message, object? Details);
