// Visual lineup — both starting XIs positioned on the pitch photo by their API-Football grids.
// Home fills the BOTTOM half (attacking up); away is mirrored onto the TOP half (attacking down) —
// the classic both-XIs-on-one-pitch look. Display-only, like every lineup surface; rendered inside
// LineupPitchSheet (the "View on pitch" popup). A missing side simply leaves its half empty (the
// sheet shows the "XI not posted" note).
import { useState } from "react";
import { Flag } from "./ui";
import pitchImg from "../assets/pitch.webp"; // 800w q50 (median-denoised) — 175KB vs the 1.4MB source photo
import { sidePositions, toFullPitch } from "../lib/pitch";

// Photo circle + shirt number + surname. Photo is the DERIVED API-Football URL from the lineup's
// player_id (same id space as squads.json); 404/missing -> initials, mirroring PlayerAvatar.
function PlayerToken({ p }) {
  const [broken, setBroken] = useState(false);
  const photo = p.player_id != null ? `https://media.api-sports.io/football/players/${p.player_id}.png` : null;
  const initials = (p.name || "").split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const surname = (p.name || "").trim().split(/\s+/).slice(-1)[0] || "";
  return (
    <div
      className="absolute flex w-[52px] -translate-x-1/2 -translate-y-1/2 flex-col items-center"
      // z: tokens nearer their own goal paint on top, so a keeper's name chip is never covered
      // by the line in front (labels hang BELOW photos, toward the centre of the pitch).
      style={{ left: `${p.x}%`, top: `${p.y}%`, zIndex: Math.round(Math.abs(p.y - 50)) }}
    >
      <span className="relative">
        {photo && !broken ? (
          <img
            src={photo}
            alt={p.name}
            onError={() => setBroken(true)}
            className="h-9 w-9 rounded-full bg-white/85 object-cover shadow-[0_2px_5px_rgba(0,0,0,0.45)] ring-[1.5px] ring-white/90"
          />
        ) : (
          <span className="grid h-9 w-9 place-items-center rounded-full bg-white/85 text-[12px] font-bold text-neutral-700 shadow-[0_2px_5px_rgba(0,0,0,0.45)] ring-[1.5px] ring-white/90">
            {initials || "?"}
          </span>
        )}
        {p.number != null && (
          <span className="absolute -bottom-0.5 -right-1 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-neutral-900/90 px-0.5 text-[8.5px] font-bold tabular-nums text-white ring-1 ring-white/80">
            {p.number}
          </span>
        )}
      </span>
      <span className="mt-0.5 max-w-full truncate rounded bg-black/45 px-1 text-[8.5px] font-semibold leading-snug text-white">
        {surname}
      </span>
    </div>
  );
}

// Per-half identity chip: flag + team name + formation · coach. Away sits top-left, home bottom-left.
function HalfChip({ team, code, side, top }) {
  if (!side) return null;
  const label = team?.name || code;
  return (
    <div className={`absolute left-1.5 ${top ? "top-1.5" : "bottom-1.5"} z-50 flex items-center gap-1.5 rounded-full bg-black/60 py-0.5 pl-1 pr-2 text-[10px] font-semibold text-white backdrop-blur-sm`}>
      <Flag team={team || { code }} size={16} />
      <span className="max-w-[96px] truncate">{label}</span>
      {side.formation && <span className="tabular-nums text-white/90">{side.formation}</span>}
      {side.coach && <span className="max-w-[90px] truncate font-normal text-white/75">· {side.coach}</span>}
    </div>
  );
}

// `homeLineup`/`awayLineup` are the function/export side shape ({ formation, coach, startXI, ... });
// `homeTeam`/`awayTeam` (optional) are app-data team objects ({ code, name, flag }) for the chips.
export default function LineupPitch({ homeCode, awayCode, homeTeam, awayTeam, homeLineup, awayLineup }) {
  const home = sidePositions(homeLineup?.startXI).map((p) => toFullPitch(p, "home"));
  const away = sidePositions(awayLineup?.startXI).map((p) => toFullPitch(p, "away"));
  return (
    <div className="relative w-full overflow-hidden rounded-[14px]">
      <img src={pitchImg} alt="" aria-hidden="true" className="block w-full select-none" />
      <HalfChip team={awayTeam} code={awayCode} side={awayLineup} top />
      <HalfChip team={homeTeam} code={homeCode} side={homeLineup} top={false} />
      {away.map((p, i) => (
        <PlayerToken key={`a-${p.player_id ?? p.name}-${i}`} p={p} />
      ))}
      {home.map((p, i) => (
        <PlayerToken key={`h-${p.player_id ?? p.name}-${i}`} p={p} />
      ))}
    </div>
  );
}
