import type { ConfigContext, ExpoConfig } from "expo/config";

// APP_VARIANT=development|preview|production. EAS supplies EXPO_PUBLIC_API_BASE_URL
// per environment; development falls back to the local Next server. The app never
// ships provider secrets — it only talks to our API.
const variants = ["development", "preview", "production"] as const;
type Variant = (typeof variants)[number];

const variant: Variant = variants.includes(process.env.APP_VARIANT as Variant)
  ? (process.env.APP_VARIANT as Variant)
  : "development";

const apiBaseUrl =
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  (variant === "development" ? "http://localhost:3000" : "");

// Native Google Sign-In. The web client ID is the OAuth client the server already
// trusts; the iOS client ID and URL scheme come from issue #78. Empty values keep
// the Google button hidden instead of failing at runtime.
const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? "";
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? "";
const googleIosUrlScheme = process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME ?? "";

// Microsoft Entra ID app registration (public client). It is not a secret; an
// empty value keeps the Microsoft button hidden instead of failing at runtime.
const microsoftClientId = process.env.EXPO_PUBLIC_MICROSOFT_CLIENT_ID ?? "";

// Public EAS project id used to fetch Expo push tokens (#89). It is not a secret;
// leaving it empty keeps push unavailable instead of failing at launch.
const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? "";

// The plugin needs the URL scheme at prebuild, so only add it when it is set;
// otherwise `expo start` and `expo config` still work without Google setup.
const googlePlugins: NonNullable<ExpoConfig["plugins"]> = googleIosUrlScheme
  ? [["@react-native-google-signin/google-signin", { iosUrlScheme: googleIosUrlScheme }]]
  : [];

// Saving an approved post asks for photo-library access only when the owner taps
// Save to Photos, and only for adding photos. The plugin supplies the iOS usage
// strings and the Android media permission at prebuild.
const mediaLibraryPlugin: NonNullable<ExpoConfig["plugins"]>[number] = ["expo-media-library", {
  photosPermission: "PraiseLoop saves the posts you approve to your photo library when you ask it to.",
  savePhotosPermission: "PraiseLoop saves the posts you approve to your photo library when you tap Save to Photos.",
  granularPermissions: ["photo"]
}];

// Bundle ID / package name must be confirmed by the owner before store setup (#91).
const bundleIdentifier = "ca.visda.praiseloop";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant === "production" ? "PraiseLoop" : `PraiseLoop (${variant})`,
  slug: "praiseloop",
  version: "1.0.0",
  orientation: "portrait",
  scheme: "praiseloop",
  userInterfaceStyle: "automatic",
  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier,
    supportsTablet: false,
    usesAppleSignIn: true
  },
  android: {
    package: bundleIdentifier,
    adaptiveIcon: {
      foregroundImage: "./assets/icon.png",
      backgroundColor: "#123456"
    }
  },
  plugins: [
    "expo-router",
    mediaLibraryPlugin,
    "expo-notifications",
    "expo-apple-authentication",
    "expo-web-browser",
    ...googlePlugins
  ],
  experiments: {
    typedRoutes: true
  },
  extra: {
    apiBaseUrl,
    googleWebClientId,
    googleIosClientId,
    microsoftClientId,
    appVariant: variant,
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {})
  }
});
