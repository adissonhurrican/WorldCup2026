import { useState } from "react";
import SiteFooter from "./SiteFooter";

// A scrollable screen with the iOS large-title pattern:
//  - a translucent sticky bar whose compact title fades in once you scroll past the big header
//  - a large in-content header at the top of the scroll
//  - a persistent right action (theme toggle)
// Each view owns its own Screen (and thus its own scroll position → state-preserving across tabs).
export default function Screen({ stickyTitle, rightAction, header, children }) {
  const [scrolled, setScrolled] = useState(false);
  const onScroll = (e) => {
    const s = e.currentTarget.scrollTop > 40;
    setScrolled((prev) => (prev === s ? prev : s));
  };

  return (
    <div className="relative h-full">
      {/* Sticky bar. iOS large-title pattern: transparent at the very top (the big in-content
          title shows through), then a frosted-GLASS OBJECT once scrolled — the glass look is
          built from layered fills (.glass-nav, rim + gradient + inner glow + depth) so it reads
          as glass over a solid area too; backdrop-blur is only an enhancement, not a dependency. */}
      <div
        className={`absolute inset-x-0 top-0 z-20 flex h-[52px] items-center px-4 transition-[background,box-shadow] duration-200 ${
          scrolled ? "glass-nav glass-nav--top backdrop-blur-2xl backdrop-saturate-150" : "bg-transparent"
        }`}
      >
        <div
          className={`min-w-0 flex-1 truncate text-center text-[16px] font-semibold transition-opacity duration-200 ${
            scrolled ? "opacity-100" : "opacity-0"
          }`}
        >
          {stickyTitle}
        </div>
        {rightAction && <div className="absolute right-2.5">{rightAction}</div>}
      </div>

      {/* scroll area — content caps + centers on desktop so it doesn't sprawl on wide/ultrawide.
          A min-h-full flex column keeps the footer pinned to the bottom on short views instead of
          floating mid-screen, while still scrolling naturally when content is tall. */}
      <div className="h-full overflow-y-auto overscroll-contain" onScroll={onScroll}>
        {/* pb clears the overlaid bottom tab bar on mobile so the footer isn't hidden under it */}
        <div className="flex min-h-full flex-col pb-[calc(3.75rem+env(safe-area-inset-bottom))] lg:pb-0">
          <div className="flex-1 px-4 pb-12 pt-[58px] md:px-6 lg:mx-auto lg:w-full lg:max-w-[1200px] lg:px-8 lg:pb-14 lg:pt-[64px]">
            {header}
            {children}
          </div>
          <SiteFooter />
        </div>
      </div>
    </div>
  );
}
