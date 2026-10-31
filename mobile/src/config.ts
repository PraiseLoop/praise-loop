import Constants from "expo-constants";

const extra = Constants.expoConfig?.extra as {
  apiBaseUrl?: unknown;
  googleWebClientId?: unknown;
  googleIosClientId?: unknown;
  microsoftClientId?: unknown;
  appVariant?: unknown;
} | undefined;

export const appConfig = {
  apiBaseUrl: typeof extra?.apiBaseUrl === "string" ? extra.apiBaseUrl : "",
  googleWebClientId: typeof extra?.googleWebClientId === "string" ? extra.googleWebClientId : "",
  googleIosClientId: typeof extra?.googleIosClientId === "string" ? extra.googleIosClientId : "",
  microsoftClientId: typeof extra?.microsoftClientId === "string" ? extra.microsoftClientId : "",
  variant: typeof extra?.appVariant === "string" ? extra.appVariant : "development",
  version: Constants.expoConfig?.version ?? "1.0.0"
};
