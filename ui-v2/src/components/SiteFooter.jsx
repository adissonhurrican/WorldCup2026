import { SITE_NAME, COMPANY, COMPANY_URL, CONTACT_EMAIL, SECURITY_LABEL, SECURITY_URL } from "../config";

// Quiet, presentational site footer — rendered once inside Screen, so it appears at the
// bottom of every view's scroll. Full-bleed top hairline + muted surface; inner content
// is capped to the same max-width as the page content and centered on desktop. Mobile-first.
// Display only: no model/prediction/data. External links open safely (noopener noreferrer).
export default function SiteFooter() {
  const year = new Date().getFullYear();
  const link = "text-ink-2 underline-offset-2 transition-colors hover:text-ink hover:underline";
  return (
    <footer className="mt-6 border-t border-separator/60 bg-fill/[0.02] px-4 py-8 md:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="text-[13px] font-semibold text-ink-2">{SITE_NAME || COMPANY}</div>
          <p className="text-[11px] text-ink-3">Predictions by a statistical model, explained by AI.</p>
        </div>

        <nav className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-3" aria-label="Footer">
          <a href={COMPANY_URL} target="_blank" rel="noopener noreferrer" className={link}>{COMPANY}</a>
          <a href={`mailto:${CONTACT_EMAIL}`} className={link}>{CONTACT_EMAIL}</a>
          <span>
            Cybersecurity by{" "}
            <a href={SECURITY_URL} target="_blank" rel="noopener noreferrer" className={link}>{SECURITY_LABEL}</a>
          </span>
        </nav>
      </div>

      <p className="mx-auto mt-5 max-w-[1200px] text-[11px] text-ink-3">
        © {year} {COMPANY}. All rights reserved.
      </p>
    </footer>
  );
}
