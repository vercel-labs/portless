---
name: oauth
description: Configure OAuth providers (Google, Apple, Microsoft, Facebook, GitHub, etc.) to work with portless local dev URLs. Use when setting up OAuth redirect URIs, fixing "redirect_uri_mismatch" or "invalid redirect" errors, configuring sign-in providers for local development, or when a provider rejects .localhost subdomains. Triggers include "OAuth not working with portless", "redirect URI mismatch", "Google/Apple/Microsoft sign-in fails locally", "configure OAuth for local dev", or any task involving OAuth callback URLs with portless domains.
---

# OAuth with Portless

OAuth providers validate redirect URIs against domain rules. `.localhost` subdomains fail on most providers because they are not in the Public Suffix List or are explicitly blocked. Portless fixes this with `--tld` to serve apps on real, valid domains.

## The Problem

When portless uses the default `.localhost` TLD, OAuth providers reject redirect URIs like `http://myapp.localhost:1355/callback`:

| Provider  | `localhost` | `.localhost` subdomains | Reason                         |
| --------- | ----------- | ----------------------- | ------------------------------ |
| Google    | Allowed     | Rejected                | Not in their bundled PSL       |
| Apple     | Rejected    | Rejected                | No localhost at all            |
| Microsoft | Allowed     | Allowed                 | Permissive localhost handling  |
| Facebook  | Allowed     | Varies                  | Must register each URI exactly |
| GitHub    | Allowed     | Allowed                 | Permissive                     |

Google and Apple are the strictest. Microsoft and GitHub are more lenient with localhost.

## The Fix

Use a valid TLD so the redirect URI passes provider validation:

```bash
sudo portless proxy start --https -p 443 --tld dev
portless myapp next dev
# -> https://myapp.dev
```

Any TLD in the Public Suffix List works: `.dev`, `.app`, `.com`, `.io`, etc.

### Use a domain you own

Bare TLDs like `.dev` mean `myapp.dev` could collide with a real domain. Use a subdomain of a domain you control:

```bash
sudo portless proxy start --https -p 443 --tld dev
portless myapp.local.yourcompany next dev
# -> https://myapp.local.yourcompany.dev
```

This ensures no outbound traffic reaches something you don't own. For teams, set a wildcard DNS record (`*.local.yourcompany.dev -> 127.0.0.1`) so every developer gets resolution without `/etc/hosts`.

## Provider Setup

### Google

1. Go to [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. Create or edit an OAuth 2.0 Client ID (Web application)
3. Add the portless domain to **Authorized JavaScript origins**: `https://myapp.dev`
4. Add the callback to **Authorized redirect URIs**: `https://myapp.dev/api/auth/callback/google`

Google validates domains against the Public Suffix List. The domain must end with a recognized TLD. `.localhost` subdomains fail this check; `.dev`, `.app`, `.com`, etc. all pass.

HTTPS is required for `.dev` and `.app` (HSTS-preloaded). Portless handles this automatically with `--https`.

### Apple

Apple Sign In does not allow `localhost` or IP addresses at all.

1. Go to [Apple Developer > Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources)
2. Register a Services ID
3. Configure Sign In with Apple, adding the portless domain as a **Return URL**: `https://myapp.dev/api/auth/callback/apple`

The domain must be a real, publicly-resolvable domain name. Since portless maps the domain to 127.0.0.1 locally, the browser resolves it but Apple's server-side validation may require the domain to resolve publicly too. If Apple rejects the domain, add a public DNS A record pointing to 127.0.0.1 for your dev subdomain.

### Microsoft (Entra / Azure AD)

1. Go to [Azure Portal > App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps)
2. Create or edit an app registration
3. Under **Authentication**, add a **Web** redirect URI: `https://myapp.dev/api/auth/callback/azure-ad`

Microsoft allows `http://localhost` with any port for development. It also accepts `.localhost` subdomains in most cases. Using a custom TLD with portless is still recommended for consistency across providers.

### Facebook (Meta)

1. Go to [Meta for Developers > App Dashboard](https://developers.facebook.com/apps/)
2. Under **Facebook Login > Settings**, add the portless URL to **Valid OAuth Redirect URIs**: `https://myapp.dev/api/auth/callback/facebook`

Facebook requires each redirect URI to be registered exactly (no wildcards). Strict Mode (enabled by default) enforces exact matching.

### GitHub

1. Go to [GitHub Developer Settings > OAuth Apps](https://github.com/settings/developers)
2. Set **Authorization callback URL**: `https://myapp.dev/api/auth/callback/github`

GitHub is permissive with localhost and subdomains. A custom TLD is not strictly required but keeps the setup consistent.

## Auth Library Configuration

### NextAuth / Auth.js

Set `NEXTAUTH_URL` to match the portless domain:

```env
NEXTAUTH_URL=https://myapp.dev
```

NextAuth uses this to construct callback URLs. Without it, callbacks may use `localhost` and cause a mismatch.

### Passport.js

Set the `callbackURL` in each strategy to use the portless domain:

```js
new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.BASE_URL + "/auth/google/callback",
});
```

Set `BASE_URL=https://myapp.dev` in your environment.

### Generic / Manual

Read the `PORTLESS_URL` environment variable that portless injects into the child process:

```js
const baseUrl = process.env.PORTLESS_URL || "http://localhost:3000";
const callbackUrl = `${baseUrl}/auth/callback`;
```

## Troubleshooting

### "redirect_uri_mismatch" or "invalid redirect URI"

The redirect URI sent during the OAuth flow doesn't match what's registered with the provider. Check:

1. The provider's registered redirect URI matches the portless domain exactly (protocol, host, path)
2. `NEXTAUTH_URL` or equivalent is set to the portless URL (not `localhost`)
3. The proxy is running with the correct TLD (`portless list` to verify)

### Provider requires HTTPS

`.dev` and `.app` TLDs are HSTS-preloaded -- browsers force HTTPS. Start the proxy with `--https`:

```bash
sudo portless proxy start --https -p 443 --tld dev
```

Port 443 avoids needing a port number in URLs. Run `sudo portless trust` to add the local CA to your system trust store and eliminate browser warnings.

### Apple rejects the domain

Apple may require the domain to resolve publicly. Add a DNS A record for your dev subdomain pointing to `127.0.0.1`:

```
myapp.local.yourcompany.dev  A  127.0.0.1
```

Or use a wildcard: `*.local.yourcompany.dev  A  127.0.0.1`.

### Callback goes to wrong URL after sign-in

The auth library is constructing the callback URL from `localhost` instead of the portless domain. Set the appropriate environment variable:

- **NextAuth**: `NEXTAUTH_URL=https://myapp.dev`
- **Auth.js v5**: `AUTH_URL=https://myapp.dev`
- **Manual**: `PORTLESS_URL` is injected automatically; use it as the base URL

## Example

See [`examples/google-oauth`](../../examples/google-oauth) for a complete working example with Next.js + NextAuth + Google OAuth using `--tld dev`.
