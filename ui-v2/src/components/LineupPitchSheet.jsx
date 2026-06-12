// "View on pitch" popup — both starting XIs on the pitch photo. Reuses the PlayerDetailCard portal
// pattern verbatim (createPortal to body, fixed inset-0 z-[60], backdrop/Esc/Done dismiss, body
// scroll lock, bottom-sheet on mobile / centered card on desktop). Display-only; renders entirely
// from the lineups map already polled by the app — no new fetches. Additive: the text lineup list
// in the match sheet is untouched; this is just another way to look at the same XIs.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import LineupPitch from "./LineupPitch";

export default function LineupPitchSheet({ fx, lineup, homeTeam, awayTeam, onClose }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(true);
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const lu = lineup || {};
  const missing = [
    !lu.home_lineup && fx?.home,
    !lu.away_lineup && fx?.away,
  ].filter(Boolean);

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Starting XIs on the pitch">
      <div onClick={onClose} className={`absolute inset-0 bg-black/40 transition-opacity duration-200 lg:bg-black/60 lg:backdrop-blur-sm ${shown ? "opacity-100" : "opacity-0"}`} />
      <div className={`absolute inset-x-0 bottom-0 flex max-h-[92%] flex-col overflow-hidden rounded-t-[20px] bg-surface shadow-2xl transition-opacity duration-200 lg:inset-x-auto lg:bottom-auto lg:left-1/2 lg:top-1/2 lg:max-h-[92vh] lg:w-[430px] lg:max-w-[92vw] lg:-translate-x-1/2 lg:-translate-y-1/2 lg:rounded-[22px] ${shown ? "opacity-100" : "opacity-0"}`}>
        <div className="flex justify-center pt-2.5 lg:hidden"><span className="h-1.5 w-9 rounded-full bg-fill/30" /></div>
        <div className="flex items-center justify-between px-4 pb-1 pt-1">
          <span className="text-[14px] font-semibold">{fx?.home} v {fx?.away} — Starting XIs</span>
          <button onClick={onClose} className="text-[15px] font-medium text-accent active:opacity-50">Done</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-[max(16px,env(safe-area-inset-bottom))] pt-1">
          <LineupPitch homeCode={fx?.home} awayCode={fx?.away} homeTeam={homeTeam} awayTeam={awayTeam} homeLineup={lu.home_lineup} awayLineup={lu.away_lineup} />
          {missing.length > 0 && (
            <p className="mt-2 text-center text-[11px] text-ink-3">{missing.join(" and ")} XI not posted yet.</p>
          )}
          <p className="mt-2 text-center text-[11px] text-ink-3">
            Confirmed XIs from the official team sheet — display only; they don’t change the prediction.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
