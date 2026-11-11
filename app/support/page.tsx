import type { Metadata } from "next";
import LegalPage from "../ui/LegalPage";

export const metadata: Metadata = {
  title: "Support · PraiseLoop",
  description: "How to reach PraiseLoop support and answers to common questions about approval, billing, account deletion, connections and email."
};

export default function SupportPage() {
  return (
    <LegalPage
      eyebrow="Help"
      title="Support"
      intro={
        <p>
          Need a hand? Email <a href="mailto:admin@praiseloop.ca">admin@praiseloop.ca</a>. We
          usually reply within 2 business days, Monday to Friday, Ontario time.
        </p>
      }
    >
      <h2>What to include</h2>
      <p>So we can help faster, tell us:</p>
      <ul>
        <li>the email address on your account;</li>
        <li>your business name;</li>
        <li>the page or feature you were using;</li>
        <li>what you expected and what happened;</li>
        <li>a screenshot or the exact error text, if you have one.</li>
      </ul>
      <p>
        Please do not send your password, a sign-in code or an access token. We never need those.
      </p>

      <h2>Common questions</h2>
      <p>
        “Your account page” below means your profile menu: tap your initials, then{" "}
        <strong>Plan and usage</strong>.
      </p>

      <h3>How does approval work?</h3>
      <p>
        Open <strong>This week</strong> in the app. Each draft has a caption and an image. You can
        edit the caption, approve the draft, or archive it if you do not want it. Approving does
        not post anything by itself. To publish, open an approved post and use{" "}
        <strong>Post</strong> on your phone (or <strong>Download image</strong> and{" "}
        <strong>Copy caption</strong> on a computer). On Pro and Business, you can also choose a
        time on the <strong>Schedule</strong> page and let automatic posting send it. Nothing is
        posted without your approval.
      </p>
      <p>
        If something was posted that you did not approve, email us immediately with your business
        name and a link to the post. That should not happen, and we will investigate.
      </p>

      <h3>How do I cancel my subscription?</h3>
      <p>
        Open your account page and choose <strong>Manage subscription</strong>. That opens
        Stripe’s secure billing portal, where you can cancel. Your plan stays active until the
        end of the period you have already paid for. We do not refund partial periods, except
        where the law requires it.
      </p>

      <h3>How do I delete my account?</h3>
      <p>
        Open your account page and find <strong>Delete account</strong>. Type{" "}
        <strong>DELETE</strong> and confirm. This permanently removes your account, businesses,
        reviews, drafts, images, sign-in methods and sessions. A live web subscription is
        cancelled first. An App Store or Google Play subscription must be cancelled in that store.
        There is no recovery period.
      </p>

      <h3>How do I disconnect Instagram, Facebook or Buffer?</h3>
      <p>
        Open <strong>Connections</strong> from the profile menu. In the{" "}
        <strong>Instagram and Facebook</strong> section, choose <strong>Disconnect</strong>. In
        the <strong>Buffer</strong> section, choose <strong>Disconnect</strong> as well. This
        removes PraiseLoop’s saved access and tokens. To remove PraiseLoop from the provider
        itself, revoke it in Facebook’s or Buffer’s settings.
      </p>

      <h3>How do I turn off the weekly email?</h3>
      <p>
        Open your account page and find the <strong>Emails</strong> section. Turn off{" "}
        <strong>Email me when my weekly posts are ready</strong>. Your drafts still appear under{" "}
        <strong>This week</strong>.
      </p>

      <h3>How do I sign out other devices?</h3>
      <p>
        Open your account page and find <strong>Other devices</strong>. Choose{" "}
        <strong>Sign out of all other devices</strong> and confirm with the code we email you.
        Every other web and phone session ends. The device you are using stays signed in.
      </p>

      <h3>How do I import my reviews?</h3>
      <p>
        Open <strong>Reviews</strong>. You can upload a CSV file or a Google Takeout export. If
        the Apify option is turned on for your account, you can also paste a Google Maps link for
        your own business and fetch reviews from there. Use reviews for your own business and
        make sure you have the right to use them.
      </p>

      <h3>How do I get an invite?</h3>
      <p>
        PraiseLoop is invite-only during the pilot. Email{" "}
        <a href="mailto:admin@praiseloop.ca">admin@praiseloop.ca</a> with your business name and
        the address you would like to sign in with. We will reply if there is room.
      </p>

      <h2>Still stuck?</h2>
      <p>
        Email <a href="mailto:admin@praiseloop.ca">admin@praiseloop.ca</a>. Include the details
        above and we will look into it. For how we handle your data, see the{" "}
        <a href="/privacy">privacy policy</a>. For the service agreement, see the{" "}
        <a href="/terms">terms of service</a>.
      </p>
    </LegalPage>
  );
}
