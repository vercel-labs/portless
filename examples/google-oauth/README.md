# Google OAuth with portless

Google OAuth rejects `.localhost` subdomains as redirect URIs. This example shows how to use portless with a custom TLD to get a domain that Google accepts.

## Why `.localhost` fails

Google's OAuth credentials page validates redirect URIs against a bundled copy of the [Public Suffix List](https://publicsuffix.org/). `.localhost` is not in their copy, so subdomains like `myapp.localhost:3000` are rejected with:

- "must end with a public top-level domain (such as .com or .org)"
- "must use a domain that is a valid top private domain"

Plain `localhost` works because Google hardcodes it in a whitelist, but subdomains do not.

## The fix: use any valid TLD

Any TLD in the Public Suffix List works. portless lets you set a custom TLD with `--tld`:

```bash
sudo portless proxy start --https -p 443 --tld dev
portless oauth-test next dev
# -> https://oauth-test.dev
```

`.dev` is a real gTLD (owned by Google). It requires HTTPS because it's HSTS-preloaded, which portless handles automatically.

## Recommended: use a domain you own

Using a bare TLD like `.dev` means your local domain (`oauth-test.dev`) could collide with a real domain someone else owns. For safer local development, use a subdomain of a domain you control:

```bash
sudo portless proxy start --https -p 443 --tld dev
portless oauth-test.local.ctate next dev
# -> https://oauth-test.local.ctate.dev
```

Since you own `ctate.dev`, nothing under `local.ctate.dev` will conflict with real internet traffic. This works for teams too -- set a wildcard DNS record (`*.local.yourcompany.dev -> 127.0.0.1`) so every developer gets local resolution without `/etc/hosts`.

## Setup

### 1. Install portless

```bash
npm install -g portless
```

### 2. Start the proxy

```bash
sudo portless proxy start --https -p 443 --tld dev
```

Port 443 is the standard HTTPS port, so URLs don't need a port number.

### 3. Create a Google OAuth client

1. Go to [Google Cloud Console > Credentials](https://console.cloud.google.com/apis/credentials)
2. Click "Create Credentials" > "OAuth client ID"
3. Choose "Web application"
4. Add your domain to "Authorized JavaScript origins" (e.g. `https://oauth-test.dev`)
5. Add the callback URL to "Authorized redirect URIs" (e.g. `https://oauth-test.dev/api/auth/callback/google`)
6. Copy the Client ID and Client Secret

### 4. Configure the example

```bash
cd examples/google-oauth
cp .env.example .env
```

Edit `.env` with your credentials:

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
NEXTAUTH_SECRET=generate-with-openssl-rand-base64-32
NEXTAUTH_URL=https://oauth-test.dev
```

Generate a secret:

```bash
openssl rand -base64 32
```

### 5. Install and run

```bash
pnpm install
pnpm dev
```

This runs `portless oauth-test next dev`, which serves the app at `https://oauth-test.dev`.

### 6. Test

Open https://oauth-test.dev in your browser and click "Continue with Google".

## Alternative: plain localhost for the callback

If you only need Google OAuth and don't want to change TLDs, you can add `http://localhost:3000/api/auth/callback/google` as an additional redirect URI. Google allows plain `localhost` with any port. Configure NextAuth to use it:

```
NEXTAUTH_URL=http://localhost:3000
```

The downside is you lose the portless benefits (named URLs, no port conflicts) for the OAuth callback flow.
