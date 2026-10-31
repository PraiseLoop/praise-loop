# PraiseLoop mobile

The owner's iOS/Android app: a thin Expo client over the existing PraiseLoop API.
The web app, worker and database stay where they are; this package is independent
of the root `package.json` and is never part of the web Docker build.

## Requirements

- Node 22 and npm 10 (the root `.nvmrc` works)
- Expo Go for quick checks, or a development build for native modules
- A running PraiseLoop server (`docker compose up` from the repo root)
- Google sign-in needs a development or store build and the iOS/Android OAuth
  clients from #78; Expo Go does not contain the native Google module, so it
  offers demo and email-code sign-in instead.
- Apple sign-in needs iOS 13+, a development or store build, an App ID with the
  **Sign in with Apple** capability, and `APPLE_CLIENT_ID=ca.visda.praiseloop`
  (plus any future Services ID) on the server. Expo Go and Android hide it.
- Microsoft sign-in needs a development or store build, the Entra ID app
  registration from `docs/auth.md`, `MICROSOFT_CLIENT_ID` on the server and
  `EXPO_PUBLIC_MICROSOFT_CLIENT_ID` in the app. It uses `expo-auth-session` with
  PKCE and no client secret, and the button is hidden without the client id.

## Run it

With the dev stack (`docker compose -f docker-compose.yml -f docker-compose.dev.yml up`
from the repo root) the `mobile` service already runs the Expo server and prints the QR
code; see [development](../docs/development.md#phone-app-in-the-dev-stack). To run it by
hand instead:

```bash
cd mobile
npm ci
npm start
```

Then scan the QR code with Expo Go, or press `a`/`i` for an emulator. On a physical
phone, `localhost` points at the phone, not your computer: set
`EXPO_PUBLIC_API_BASE_URL` to your machine's LAN address before starting, e.g.

```bash
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3000 npm start
```

`APP_VARIANT=development|preview|production` selects the app name and the default
API URL (development falls back to `http://localhost:3000`). Preview and production
builds must set `EXPO_PUBLIC_API_BASE_URL`; there is no hard-coded secret, and the
app only talks to our API.

Native Google sign-in reads these public values through `app.config.ts`:

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Web OAuth client ID, the same value as the server's `GOOGLE_CLIENT_ID`. Empty hides **Continue with Google**. |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | iOS OAuth client ID from #78. |
| `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` | Reversed iOS client ID (`com.googleusercontent.apps.…`). Only needed for `expo prebuild`; the config plugin is added only when it is set. |

Microsoft sign-in reads one public value:

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_MICROSOFT_CLIENT_ID` | Entra ID application (client) id, the same value as the server's `MICROSOFT_CLIENT_ID`. Empty hides **Continue with Microsoft**. |

The phone uses the public-client redirect URI `praiseloop://auth/microsoft`;
register it under **Mobile and desktop applications** in the Entra app. No
secret is shipped or used on the phone.

The server accepts ID tokens for `GOOGLE_IOS_CLIENT_ID` and
`GOOGLE_ANDROID_CLIENT_ID` (`docs/auth.md`). Android's native sign-in requests
the token for the web client ID, so include that ID in the server's
`GOOGLE_ANDROID_CLIENT_ID` as documented there.

The app has six screens: a launch gate driven by `GET /api/mobile/config`, sign-in,
an "update required" screen, the weekly queue (`#86`), a draft detail with the
share-sheet flow (`#87`) and the profile screen (`#151`), reached from the initials
avatar in the queue header. The profile shows the owner's name and email (the name
is editable, the email is not), the linked sign-in methods (link Google, or
unlink one after a confirmation while another remains), the plan and this week's
usage, the notification toggle, the app version and API server, and **Sign out**.
Sign-in offers **Continue with Google** (#85/#81), **Continue with Apple** (#92) on
iOS 13+ with the native module, and **Continue with Microsoft** (#158) when
`EXPO_PUBLIC_MICROSOFT_CLIENT_ID` is set, all in a development or store build; the same
screen always offers an email-code option, and a development server with
`MOBILE_DEV_AUTH=1` also offers a demo owner, which is the fastest way to walk the
whole flow with synthetic data. Expo Go hides Google and Apple because their
native modules are absent, so demo and email-code sign-in are the paths there;
Microsoft needs a development or store build for its registered redirect URI.
Apple sends the owner's name only on the first authorization; the app forwards it
with the identity token so the server can fill a missing name without replacing
an edited one. Microsoft uses the browser-based PKCE flow, sends only the ID
token to the server, and never links to an existing owner by email.

```bash
# repo root
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
docker compose exec web npm run dev:seed

# mobile/
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3000 npm start
```

Then tap **Sign in as demo owner**. The seed creates two businesses and five
rendered drafts; see [development](../docs/development.md#demo-flow-with-synthetic-data).
The token lives in the platform keychain (`expo-secure-store`); the share sheet
receives a cached PNG and the caption is copied to the clipboard for pasting into
Instagram. `shared` is owner-reported, never inferred. Queue thumbnails and the
draft image use the same authenticated download into the app cache, because the
core React Native `Image` does not reliably send custom headers in Expo Go.

## Push notifications

The weekly "posts are ready" reminder is an Expo push notification. After the
first successful sign-in the queue shows a short explanation with **Turn on
notifications** and **Not now**; only **Turn on** asks the OS. The choice is
stored in the same keychain storage as the session (`expo-secure-store`), so
**Not now** is not shown again. The profile screen has the same setting as a
switch: off unregisters the device, on requests permission if needed and
registers it. If the OS has denied permission, the screen explains how to turn
it on in system settings. Signing out unregisters the token best-effort before
the session is revoked. On every signed-in launch with notifications on, the
app refreshes its token with `POST /api/mobile/push-tokens`.

Tapping a notification opens `praiseloop://queue?businessId=<id>`. The app
validates the id as a positive integer, signs in first when there is no session,
then opens that business's queue; an id the owner does not own falls back to the
first business. The token endpoint and payload shape come from #88.

Push needs all of the following, and the app says plainly when one is missing:

- a **development or store build** on a physical iOS or Android phone. Expo Go
  and simulators cannot obtain an Expo push token.
- an **EAS project id**, read from `Constants.expoConfig?.extra?.eas?.projectId`
  or `Constants.easConfig?.projectId`. Set `EXPO_PUBLIC_EAS_PROJECT_ID` to place
  it in `extra.eas.projectId`, or let an EAS update manifest supply
  `easConfig.projectId`. Without it the push setting is disabled with a "not
  configured for this build" note. The id is public, not a secret.
- **owner provider credentials**, not committed to this repo:
  - iOS: an APNs authentication key (`.p8`, key id and team id) uploaded to the
    Expo project, or EAS-managed credentials.
  - Android: a Firebase/FCM project with `google-services.json` and FCM
    credentials attached to the Expo project.

`expo-notifications` and `expo-device` are required lazily, so Expo Go and Jest
still start and the push UI stays hidden where a token cannot exist. No physical
device test has been run for this work: the tests mock the native module and the
API, and the real notification delivery, OS permission sheet and deep link on
hardware are still owner checks.

## Checks

```bash
npm run lint
npm run typecheck
npm test
```

CI runs the same commands in the `mobile` job. Tests cover the API client's error
mapping (401/409/429/network/timeout), the version gate, native Google, Apple and
Microsoft sign-in availability/cancellation (and Microsoft's PKCE exchange), all
three token exchanges (success, invalid
response, 401), the no-business screen's onboarding link and visibility, the keychain
session store, draft/version API shapes, queue list states and generation
progress, the draft image cache (bearer header, shared downloads, retry, eviction
and the 401 path), the profile helpers and API wrapper (name rule, initials,
400/401), the sign-in method helpers and API wrapper (provider names, added
dates, the unlink rule, link/unlink success, 400/409 and 401), and every
share-flow branch (unavailable share sheet, download/copy/share failures,
cancelled share, version conflict, expired session). Push coverage adds permission mapping and denial,
register/unregister payloads and calls against a mocked API, Expo Go/simulator
availability, deep-link parsing and routing with and without a session, the stored
choice and the settings toggle.

## Builds

Local builds and EAS Build both work. Expo Router is the router; Jest with the
`jest-expo` preset runs the tests. No native `ios/` or `android/` folders are
committed. Google sign-in is compiled in at prebuild through the config plugin,
so set `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` and rebuild after changing OAuth
clients; changing it does not affect `expo start` or Expo Go. Apple sign-in is
compiled in through the `expo-apple-authentication` plugin and `usesAppleSignIn`,
so it also needs a rebuild after the App ID gains the capability. Microsoft
sign-in uses `expo-auth-session` with `expo-crypto` and `expo-web-browser`; they
are installed through `npx expo install` for SDK 58 and the `expo-web-browser`
config plugin is registered, so a development build also needs a rebuild after
the dependency change. The bundle ID /
package name is `ca.visda.praiseloop` as a placeholder:
the owner must confirm it before store setup (#91), because it cannot change after
release. No device or simulator check of Apple or Microsoft sign-in was run; it
waits on the owner's Apple Developer and Entra setup.
