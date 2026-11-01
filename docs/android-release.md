# Android releases through GitHub and Obtainium

A tag like `mobile-v1.0.1` builds a standalone Android APK in EAS (Expo's build service) and
attaches it to a GitHub Release. [Obtainium](https://obtainium.imranr.dev/) on a phone watches
that repository's releases, installs the newest APK and offers updates. The repository is public,
so Obtainium needs no token. The workflow is `.github/workflows/mobile-release.yml`; the build
profiles are `mobile/eas.json`. Nothing runs until you push a `mobile-v*` tag (or start the
workflow by hand).

The APK is a **preview build**: the JavaScript is bundled inside, so it needs no development
server, and native Google, Apple and Microsoft sign-in work in it (they do not in Expo Go).

## One-time setup (owner steps)

1. **Expo account and project.** Create an account at expo.dev and a project named `praiseloop`
   there (or run `npx eas-cli init` from `mobile/`). The app config is a TypeScript file, so
   `eas init` cannot write the project id into it; copy the id from the project page instead.
   The app reads it from `EXPO_PUBLIC_EAS_PROJECT_ID` (this also lets push notifications find it).
   **Every `eas-cli` command below needs that variable in your shell**, because the config has no
   saved id for the tool to find: run `export EXPO_PUBLIC_EAS_PROJECT_ID=<project id>` in the
   terminal you use for steps 3 to 5.
2. **Token and project id for GitHub.** On expo.dev create an access token (Account settings,
   Access tokens) and add it to the repository as the **secret** `EXPO_TOKEN`. Add the project id
   as the **variable** `EAS_PROJECT_ID` (Settings, Secrets and variables, Actions, Variables). It is
   not a secret, and the workflow stops with a clear message if it is missing.
3. **Build settings.** The build runs in Expo's cloud, which cannot see GitHub or your `.env`, so
   give it the public app settings as EAS environment variables (they are not secrets):
   ```sh
   cd mobile
   npx eas-cli env:create --environment preview --name EXPO_PUBLIC_API_BASE_URL --value https://<your server>
   npx eas-cli env:create --environment preview --name EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID --value <web client id>
   ```
   Add `EXPO_PUBLIC_MICROSOFT_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and
   `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` the same way when you use them.
4. **The server address is baked in.** A standalone APK talks to the address it was built with.
   Until the pilot hosting (#90) is up, use an address your phone can reach (your Tailscale
   or LAN address); builds made then only work for you. Rebuild when the real domain exists.
5. **First build and the signing key.** Run
   `npx eas-cli build --platform android --profile preview` (with the variable exported as in step 1)
   once by hand and let EAS generate the Android keystore. **Android installs an update over an
   existing app only if it is signed with the same key**, so never replace the key; lose it and
   everyone has to uninstall and reinstall. Download a backup with `npx eas-cli credentials`
   (Android, then download the keystore) and keep it somewhere safe and private.
6. **Google sign-in on Android.** In Google Cloud Console (Google Auth Platform, Clients) create a
   second client of type **Android** with package name `ca.visda.praiseloop` and the SHA-1
   fingerprint of that keystore (`npx eas-cli credentials` shows it). Without it native sign-in fails with
   "developer error". It needs no environment variable: the token audience is still the web client,
   so the web client id must also be in the server's `GOOGLE_ANDROID_CLIENT_ID` (see
   [auth.md](auth.md)).

## Releasing

```sh
git tag mobile-v1.0.1
git push origin mobile-v1.0.1
```

The workflow checks types and tests, builds the APK in EAS, downloads it and creates a release
named for the tag with the APK attached. Each build gets a higher Android version code
automatically (`autoIncrement`, tracked by EAS), which Android requires for updates. Change
`version` in `mobile/app.config.ts` when you want a new visible version number.

To try the workflow without publishing, run it from the Actions tab (Android release, Run
workflow): it builds and keeps the APK as a downloadable workflow artifact instead of a release.

## Installing with Obtainium

1. Install Obtainium (from its GitHub releases or F-Droid) and allow it to install apps.
2. Add app, paste `https://github.com/iamstevedavis/praise-loop`.
3. Because the repository also has other tags, open the app's settings in Obtainium and set a
   filter on the release title or APK name so it follows only `PraiseLoop Android` / `praiseloop-mobile-v*.apk`
   (Obtainium's "Filter APKs by regular expression": `praiseloop-mobile-v.*\.apk`).
4. Install. New releases show up as updates.

## Putting it on Google Play later

Google Play signs the app it distributes. To keep a build from Play and a build from GitHub
compatible, **give Play your existing key instead of letting it make a new one** (Play App
Signing lets you upload your own app signing key when you create the app). Use the `production`
profile (an app bundle) for the Play upload. If the keys ever differ, a phone must uninstall one
version before installing the other.

## What this does not do

- It does not run on pushes or pull requests, and it is separate from the CI workflow.
- It builds Android only. iOS needs an Apple developer account (#91) and goes through TestFlight.
- Nothing here has been run yet: the workflow, the EAS project and the first build are untested
  until you complete the steps above.
