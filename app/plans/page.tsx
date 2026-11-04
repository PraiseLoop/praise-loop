import type { Metadata } from "next";
import Link from "next/link";
import { PLAN_LIMITS, type Plan } from "../../lib/services/entitlements";
import { PLAN_ORDER, PLAN_PRICING, planComparison, planNotes, publicPlanName } from "../../lib/plansDisplay";
import Icon from "../ui/Icon";
import PlanCta from "./PlanCta";
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
            posting through Buffer, while Business adds room for several businesses. Every plan keeps
            reviews and drafts private to your account, and nothing posts without your OK.
          </p>
        </section>

        <section aria-label="Compare the Free, Pro and Business plans" className={styles.grid}>
          {PLAN_ORDER.map(plan => (
            <article key={plan} className={styles.plan}>
              <div className={styles.planHead}>
                <h2 className={styles.planName}>{publicPlanName[plan]}</h2>
                <p className={styles.tagline}>{taglines[plan]}</p>
                {pricing ? <p className={styles.price}>{pricing[plan]}</p> : null}
              </div>
              <dl className={styles.features}>
                {rows.map(row => (
                  <div key={row.key} className={styles.feature}>
                    <dt>{row.label}</dt>
                    <dd>{row.values[plan]}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </section>

        {pricing ? null : (
          <p role="note" className={styles.pricingNote}>
            Prices are not published yet. During the pilot the plan and price are agreed directly with each
            business, and there is no checkout on this page.
          </p>
        )}

        <section aria-labelledby="notes-h" className={styles.notes}>
          <h2 id="notes-h">Good to know</h2>
          <ul>
            {notes.map(note => <li key={note}>{note}</li>)}
            <li>Each business has its own weekly limit. PraiseLoop support changes plans during the pilot.</li>
          </ul>
        </section>

        <section className={styles.cta}>
          <PlanCta label="Continue with Google" />
          <span className="pl-muted pl-small">Free to start. Nothing posts without your OK.</span>
        </section>
      </main>
    </div>
  );
}
