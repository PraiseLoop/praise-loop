import type { Metadata } from "next";
import LegalPage from "../ui/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service · PraiseLoop",
  description: "The agreement for using PraiseLoop: plans and prices, cancellation and refunds, acceptable use, approval before posting, and liability."
};

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms of Service"
      intro={
        <p>
          These terms are an agreement between you and PraiseLoop, run by an individual sole
          proprietor based in Ontario, Canada. They cover your use of praiseloop.ca, the web app
          and the phone app. By creating an account or using PraiseLoop, you agree to these terms.
          If you do not agree, do not use the service.
        </p>
      }
    >
      <h2>Who can use PraiseLoop</h2>
      <p>
        PraiseLoop is for businesses and the people who run them. You must be at least 18 years
        old and able to enter into a contract. You confirm that you are authorised to act for the
        business you add. PraiseLoop is not a consumer service and is not for children.
      </p>

      <h2>Your account</h2>
      <p>
        Keep your sign-in details safe and give us accurate information. You are responsible for
        activity under your account. Tell us at{" "}
        <a href="mailto:admin@praiseloop.ca">admin@praiseloop.ca</a> if you think someone else has
        access to it.
      </p>

      <h2>Reviews and content you provide</h2>
      <p>
        You must have the right to use every review, photo, logo and other piece of content you
        import or upload, including your customers’ words and names. You are responsible for what
        you provide, approve and post. Do not import content you do not have permission to use.
      </p>

      <h2>How posting works</h2>
      <p>
        Each week PraiseLoop selects review quotes, writes captions and renders images for your
        approval. <strong>Nothing is posted without your approval.</strong> You can edit,
        approve, archive, download or share a draft. Automatic posting on Pro and Business only
        sends posts you have approved and scheduled to a connection you set up. You remain
        responsible for reviewing everything before it goes out and for following the rules of
        the platforms you post to.
      </p>

      <h2>Plans, prices and billing</h2>
      <p>
        PraiseLoop offers Free, Pro and Business plans. Free is free. Pro is{" "}
        <strong>CA$29.99 a month, plus applicable tax</strong>. Business pricing is not published
        yet and is arranged with us. Prices are in Canadian dollars. Payment is handled by
        Stripe. A paid plan renews monthly until you cancel.
      </p>
      <p>
        We may change prices with 30 days’ notice by email to the address on your account. A new
        price applies from your next renewal after the notice.
      </p>

      <h2>Cancellation and refunds</h2>
      <p>
        You can cancel any time from your account page. <strong>Manage subscription</strong>{" "}
        opens Stripe’s secure portal, where you can cancel. Your plan stays active until the end
        of the period you have already paid for, then your account moves to Free and Free limits
        apply.
      </p>
      <p>
        We do not refund partial periods, except where the law requires it. Deleting your account
        cancels a live web subscription for you. An App Store or Google Play subscription is
        managed by that store and must be cancelled there.
      </p>

      <h2>Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>import or post fake, misleading or incentivised reviews;</li>
        <li>use content you do not have the right to use, or post content that is unlawful, hateful, harassing, deceptive or infringes someone else’s rights;</li>
        <li>scrape, crawl, overload or otherwise abuse the service, or try to bypass its limits or security;</li>
        <li>access another owner’s data, or attempt to do so;</li>
        <li>resell or provide the service to others without our written permission;</li>
        <li>break the terms of Instagram, Facebook, Buffer, Google or any other connected platform.</li>
      </ul>
      <p>
        We may suspend or end your access if you break these rules, if your use creates a risk or
        legal exposure, or if you do not pay. Where it is reasonable, we will tell you why and
        give you a chance to fix the problem.
      </p>

      <h2>Third-party platforms</h2>
      <p>
        Connecting Instagram, Facebook, Buffer, Google or another service is optional. Your use
        of those services is governed by their own terms and privacy policies, not ours. We do
        not control them and are not responsible for their actions, outages or changes. If a
        platform restricts your account or changes its rules, posting may fail.
      </p>

      <h2>The pilot and availability</h2>
      <p>
        PraiseLoop is in a paid pilot. The service is provided <strong>“as is” and “as
        available”</strong>. We do not promise uptime, that every post will be generated on time,
        or that a third-party platform will accept a post. We may change, pause or discontinue
        features, and we aim to give reasonable notice of significant changes.
      </p>

      <h2>Your content and our content</h2>
      <p>
        You keep ownership of the reviews, logos and other content you provide. You give us
        permission to use it only to run the service for you: to generate captions and images,
        show them to you, and publish the posts you approve. We own PraiseLoop, its software and
        its design. We grant you a limited, non-exclusive right to use the service under these
        terms.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, PraiseLoop is not liable for indirect, incidental,
        special, consequential or punitive damages, or for lost profits, revenue, data or
        goodwill. Our total liability for all claims relating to the service in any 12-month
        period is limited to the fees you paid us for PraiseLoop in the 12 months before the
        event giving rise to the claim. Nothing in these terms limits liability that cannot be
        limited by law.
      </p>

      <h2>Suspension and termination</h2>
      <p>
        You can stop using PraiseLoop and delete your account at any time. We may suspend or end
        your access under the acceptable use section above, or end the service with reasonable
        notice. When your access ends, your right to use the service ends. Sections that by their
        nature should survive, including payment, liability and governing law, continue to apply.
      </p>

      <h2>Changes to these terms</h2>
      <p>
        We may update these terms. If a change is material, we will post the new version here and
        email you at least 30 days before it takes effect, unless the law requires a change
        sooner. Continuing to use PraiseLoop after the change means you accept the new terms. If
        you do not agree, you can cancel before the change takes effect.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of Ontario and the federal laws of Canada that apply
        in Ontario, without regard to conflict-of-law rules. The courts of Ontario have
        jurisdiction over any dispute, unless the law requires otherwise.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: <a href="mailto:admin@praiseloop.ca">admin@praiseloop.ca</a>.
        For help using the app, see the <a href="/support">support page</a>.
      </p>
    </LegalPage>
  );
}
