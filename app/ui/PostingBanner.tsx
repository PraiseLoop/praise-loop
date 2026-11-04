"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "../apiFetch";
import { setupBanner, type PostingSetup } from "../../lib/posting/postingSetup";
import Icon from "./Icon";

// The "is posting set up?" banner (#205). It shows nothing until the server answers, so a
// connected owner never sees a flash of "not connected", and nothing when posting is live.
export default function PostingBanner({ businessId }: { businessId: number | string }) {
  const [setup, setSetup] = useState<PostingSetup | null>(null);
  useEffect(() => {
    setSetup(null);
    let current = true;
    void (async () => {
      try {
        const response = await apiFetch(`/api/businesses/${businessId}/posting-setup`);
        if (!response.ok || !current) return;
        const data = await response.json() as PostingSetup;
        if (current) setSetup(data);
      } catch { /* no banner is better than a wrong one */ }
    })();
    return () => { current = false; };
  }, [businessId]);

  const banner = setup ? setupBanner(setup) : null;
  if (!banner) return null;
  return (
    <div className="pl-banner" role="status" data-setup={setup?.state}>
      <Icon name="plug" size={22} />
      <p><strong>{banner.headline}</strong> {banner.detail}</p>
      {banner.link ? <Link href={banner.link.href} className="pl-btn pl-btn-dark">{banner.link.label}</Link> : null}
    </div>
  );
}
