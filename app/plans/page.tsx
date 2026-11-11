import type { Metadata } from "next";
import Link from "next/link";
import { PLAN_LIMITS, type Plan } from "../../lib/services/entitlements";
import { PLAN_ORDER, PLAN_PRICING, planComparison, planNotes, publicPlanName } from "../../lib/plansDisplay";
import Icon from "../ui/Icon";
import PlanCta, { ProPlanCta } from "./PlanCta";
import styles from "./plans.module.css";

export const metadata: Metadata = {
  title: "Plans · PraiseLoop",
  description: "What the Free, Pro and Business PraiseLoop plans include: posts each week, quote-card designs, watermark, automatic posting, brand voice and businesses."
};

const taglines: Record<Plan, string> = {
  free: "For one business getting started.",
  pro: "For a business posting more often, without a watermark.",
  business: "For owners running several businesses."
};

// The comparison is worded from the same limits the server enforces, so a plan
// change cannot leave this page behind.
const rows = planComparison(PLAN_LIMITS);
const notes = planNotes(rows);
const pricing = PLAN_PRICING;

export default function PlansPage() {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Link href="/" className="pl-brand"><span className="pl-brand-mark"><Icon name="loop" strokeWidth={2.2} /></span>PraiseLoop</Link>
        <Link href="/" className="pl-small">Back to home</Link>
      </header>
      <main className={styles.main}>
        <section className={styles.intro}>
          <span className="pl-eyebrow">Plans</span>
          <h1 className={styles.headline}>Three plans. Your approval, always.</h1>
          <p className={styles.lede}>
            Start on Free. Pro makes more posts each week, removes the watermark and adds automatic
            posting to Instagram and Facebook, while Business adds room for several businesses. Every plan keeps
            reviews and drafts private to your account, and nothing posts without your OK.
          </p>
        </section>

        <section aria-label="Compare the Free, Pro and Business plans" className={styles.grid}>
          {PLAN_ORDER.map(plan => (
            <article key={plan} className={styles.plan}>
              <div className={styles.planHead}>
                <h2 className={styles.planName}>{publicPlanName[plan]}</h2>
                <p className={styles.tagline}>{taglines[plan]}</p>
                <p className={styles.price}>{pricing[plan]}</p>
              </div>
              <dl className={styles.features}>
                {rows.map(row => (
                  <div key={row.key} className={styles.feature}>
                    <dt>{row.label}</dt>
                    <dd>{row.values[plan]}</dd>
                  </div>
                ))}
              </dl>
              {plan === "pro" ? <div className={styles.planAction}><ProPlanCta /></div> : null}
            </article>
          ))}
        </section>

        <section aria-labelledby="notes-h" className={styles.notes}>
          <h2 id="notes-h">Good to know</h2>
          <ul>
            {notes.map(note => <li key={note}>{note}</li>)}
            <li>Each business has its own weekly limit. Upgrade to Pro from your account page; Business is arranged with us.</li>
          </ul>
        </section>

        <section className={styles.cta}>
          <PlanCta label="Continue with Google" />
          <span className="pl-muted pl-small">Free to start. Nothing posts without your OK.</span>
        </section>
      </main>
      <footer className={styles.footer}>
        <span className="pl-small pl-muted">PraiseLoop, Ontario, Canada</span>
        <nav className={styles.footerLinks} aria-label="Legal and help">
          <Link href="/privacy" className="pl-small">Privacy</Link>
          <Link href="/terms" className="pl-small">Terms</Link>
          <Link href="/support" className="pl-small">Support</Link>
          <Link href="/" className="pl-small">Home</Link>
        </nav>
      </footer>
    </div>
  );
}
