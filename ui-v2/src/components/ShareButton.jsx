import { useState, useRef, useEffect } from "react";
import { IconShare, IconCheck } from "./icons";
import { SITE_NAME, SITE_URL, TAGLINE } from "../config";

// One-tap share. On devices with the Web Share API (mobile + modern desktop browsers) this opens
// the native share sheet (iMessage, WhatsApp, X, …). Where it's unavailable (e.g. desktop Firefox)
// we fall back to copying the URL to the clipboard and flash a brief "Link copied!" confirmation.
// A cancelled share sheet is normal user behaviour, NOT an error — it is swallowed silently.
// v1 shares the app itself (URL + tagline); per-team/per-match sharing is a later enhancement.
export default function ShareButton() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const flash = () => {
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };

  const copyFallback = async () => {
    try {
      await navigator.clipboard.writeText(SITE_URL);
      flash();
    } catch (e) {
      // Older browsers without the async clipboard API — last-ditch execCommand path.
      try {
        const ta = document.createElement("textarea");
        ta.value = SITE_URL;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        flash();
      } catch (e2) {
        /* nothing we can do — fail silently rather than throw at the user */
      }
    }
  };

  const onShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: SITE_NAME, text: TAGLINE, url: SITE_URL });
      } catch (e) {
        // AbortError = the user dismissed the sheet → not a failure, do nothing.
        if (e && e.name === "AbortError") return;
        // Any other failure (e.g. NotAllowedError): degrade to the copy path.
        await copyFallback();
      }
      return;
    }
    await copyFallback();
  };

  return (
    <div className="relative">
      <button
        onClick={onShare}
        aria-label={`Share ${SITE_NAME}`}
        className="grid h-9 w-9 place-items-center rounded-full text-ink active:opacity-50"
      >
        {copied ? <IconCheck className="h-[22px] w-[22px] text-accent" /> : <IconShare className="h-[22px] w-[22px]" />}
      </button>
      {copied && (
        <span
          role="status"
          className="animate-panel pointer-events-none absolute right-0 top-[calc(100%+5px)] z-50 whitespace-nowrap rounded-full bg-ink px-2.5 py-1 text-[11px] font-semibold text-bg shadow-lg"
        >
          Link copied!
        </span>
      )}
    </div>
  );
}
