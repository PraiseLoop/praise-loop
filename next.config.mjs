// The legal and support pages are served by the praiseloop.ca website (#292).
// Keep in step with lib/legalLinks.ts. Temporary (307) redirects, so moving the
// pages back into the app later is not undone by cached permanent redirects.
const legalSite = "https://praiseloop.ca";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return ["privacy", "terms", "support"].map(page => ({
      source: `/${page}`,
      destination: `${legalSite}/${page}/`,
      permanent: false
    }));
  }
};

export default nextConfig;
