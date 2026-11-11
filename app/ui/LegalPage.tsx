import Link from "next/link";
import Icon from "./Icon";
import styles from "./legal.module.css";

// The three public legal pages (#262) share one chrome so the footer links, the
// reading width and the phone-width rules cannot drift apart. They are server
// components and never fetch owner data; /privacy, /terms and /support are in
// AppShell's bare routes, so a signed-out visitor sees them without a sign-in wall.
export const LEGAL_LAST_UPDATED = "2026-11-10";

export default function LegalPage({
  eyebrow,
  title,
  intro,
  children
}: {
  eyebrow: string;
  title: string;
  intro: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Link href="/" className="pl-brand"><span className="pl-brand-mark"><Icon name="loop" strokeWidth={2.2} /></span>PraiseLoop</Link>
        <nav className={styles.nav} aria-label="Site">
          <Link href="/plans" className="pl-small">Plans</Link>
          <Link href="/support" className="pl-small">Support</Link>
        </nav>
      </header>
      <main className={styles.main}>
        <article className={styles.article}>
          <header className={styles.intro}>
            <span className="pl-eyebrow">{eyebrow}</span>
            <h1 className={styles.headline}>{title}</h1>
            <p className={`${styles.updated} pl-small pl-muted`}>Last updated: {LEGAL_LAST_UPDATED}</p>
            {intro}
          </header>
          {children}
        </article>
      </main>
      <footer className={styles.footer}>
        <span className="pl-small pl-muted">PraiseLoop, Ontario, Canada</span>
        <nav className={styles.footerLinks} aria-label="Legal and help">
          <Link href="/privacy" className="pl-small">Privacy</Link>
          <Link href="/terms" className="pl-small">Terms</Link>
          <Link href="/support" className="pl-small">Support</Link>
          <Link href="/plans" className="pl-small">Plans</Link>
        </nav>
      </footer>
    </div>
  );
}
