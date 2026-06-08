import { useEffect } from "react";
import { IconClose } from "./icons";
import { PAGES, PAGE_ORDER } from "../content/pages";
import { SITE_NAME, COMPANY, COMPANY_URL, CONTACT_EMAIL, SECURITY_LABEL, SECURITY_URL } from "../config";

// Mobile-only secondary-nav drawer (lg:hidden). Re-skinned to match the desktop left rail in the ELEVEN
// language: ALWAYS-DARK night-glass background with GOLD text/links (same gold as the desktop nav), and the
// decorative gold dragon in the bottom-right corner. The bottom TabBar still owns the 3 primary tabs; this
// drawer holds the secondary links (About / How it works / Privacy / Terms) + footer info. Display only.
export default function MobileMenu({ open, current, onNavigate, onClose }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const ext = { target: "_blank", rel: "noopener noreferrer" };

  return (
    <div className={`absolute inset-0 z-[60] lg:hidden ${open ? "" : "pointer-events-none"}`} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0"}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className={`eleven-drawer absolute inset-y-0 left-0 flex w-[82%] max-w-[320px] flex-col shadow-2xl transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="relative z-10 flex flex-1 flex-col">
          <div className="flex items-start justify-between px-5 pb-3 pt-[max(18px,env(safe-area-inset-top))]">
            <div>
              <span className="rainbow-line block h-1 w-10 rounded-full" />
              <h2 className="eleven-drawer-title mt-2.5 text-[17px] font-bold tracking-tight">{SITE_NAME || COMPANY}</h2>
              <p className="eleven-drawer-sub mt-0.5 text-[12px]">World Cup 2026 predictions, updated live</p>
            </div>
            <button onClick={onClose} aria-label="Close menu" className="eleven-drawer-close -mr-1.5 grid h-9 w-9 place-items-center rounded-full active:opacity-50">
              <IconClose className="h-5 w-5" />
            </button>
          </div>

          <nav className="flex flex-col gap-0.5 px-3 py-2" aria-label="More">
            {PAGE_ORDER.map((k) => {
              const active = current === k;
              return (
                <button
                  key={k}
                  onClick={() => onNavigate(k)}
                  aria-current={active ? "page" : undefined}
                  className={`eleven-drawer-link${active ? " is-active" : ""} rounded-[10px] px-3 py-2.5 text-left text-[15px] font-medium`}
                >
                  {PAGES[k].navLabel}
                </button>
              );
            })}
          </nav>

          <div className="eleven-drawer-foot mt-auto space-y-2 border-t px-5 py-5 text-[12px]">
            <a href={COMPANY_URL} {...ext} className="block">{COMPANY}</a>
            <a href={`mailto:${CONTACT_EMAIL}`} className="block">{CONTACT_EMAIL}</a>
            <span className="block">
              Cybersecurity by <a href={SECURITY_URL} {...ext}>{SECURITY_LABEL}</a>
            </span>
            <span className="block pt-1">Simulation outputs, not betting odds.</span>
          </div>
        </div>

        {/* decorative gold dragon, small emblem in the bottom-right corner (~10% bigger than match-card flags) */}
        <img
          src={`${import.meta.env.BASE_URL}dragon.png`}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute bottom-3 right-3 z-0 w-[29px] select-none opacity-90"
        />
      </div>
    </div>
  );
}
