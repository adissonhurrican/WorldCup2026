import { useState, useEffect } from "react";
import TabBar from "./components/TabBar";
import SideNav from "./components/SideNav";
import MobileMenu from "./components/MobileMenu";
import ThemeToggle from "./components/ThemeToggle";
import TeamSheet from "./components/TeamSheet";
import MatchSheet from "./components/MatchSheet";
import MyTeamView from "./views/MyTeamView";
import MatchesView from "./views/MatchesView";
import PredictionView from "./views/PredictionView";
import GroupsView from "./views/GroupsView";
import ContentView from "./views/ContentView";
import { IconMenu } from "./components/icons";
import { loadAll, loadLiveScores, loadLineups, loadEvents } from "./lib/appData";
import { teamByCode } from "./lib/select";

const LIVE_POLL_MS = 30000;

const DEFAULT_TEAM_CODE = "BIH";

function initDark() {
  try {
    const s = localStorage.getItem("wc-theme");
    if (s) return s === "dark";
  } catch (e) { /* ignore */ }
  try {
    return matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (e) {
    return false;
  }
}

export default function App() {
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [live, setLive] = useState({}); // display-only in-play scores, polled separately
  const [lineups, setLineups] = useState({}); // display-only confirmed XIs, polled separately
  const [events, setEvents] = useState({}); // display-only goals/cards timeline, polled separately

  const [view, setView] = useState("team");
  const [secondary, setSecondary] = useState(null); // null = main app; else an info page key (about/how/privacy/terms)
  const [menuOpen, setMenuOpen] = useState(false); // mobile secondary-nav drawer
  const [teamCode, setTeamCode] = useState(DEFAULT_TEAM_CODE);
  const [myTeamTab, setMyTeamTab] = useState("Overview");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [matchFx, setMatchFx] = useState(null);
  const [dark, setDark] = useState(initDark);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("wc-theme", dark ? "dark" : "light");
    } catch (e) { /* ignore */ }
  }, [dark]);

  useEffect(() => {
    let alive = true;
    loadAll()
      .then((d) => {
        if (!alive) return;
        setData(d);
        // make sure the default team exists in the real contract
        if (!teamByCode(d, DEFAULT_TEAM_CODE) && d.teams && d.teams[0]) setTeamCode(d.teams[0].code);
      })
      .catch((e) => alive && setLoadErr(e));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live in-play scores + confirmed lineups + goal/card events: poll the static side-job files (written server-side).
  // Display-only — the client never calls API-Football and never holds the key. Same cadence so the
  // XI, in-play score, and event timeline tick over together near kickoff.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      loadLiveScores().then((r) => { if (alive) setLive(r.map || {}); }).catch(() => {});
      loadLineups().then((r) => { if (alive) setLineups(r.map || {}); }).catch(() => {});
      loadEvents().then((r) => { if (alive) setEvents(r.map || {}); }).catch(() => {});
    };
    tick();
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const themeToggle = <ThemeToggle dark={dark} onToggle={() => setDark((d) => !d)} />;

  // Primary nav (3 tabs) always returns to the main app; info pages are highlighted only when active.
  const navView = secondary ? null : view;
  const goMain = (id) => { setView(id); setSecondary(null); };
  const openPage = (k) => { setSecondary(k); setMenuOpen(false); };

  const selectTeam = (code) => {
    setTeamCode(code);
    setView("team");
    setSecondary(null);
  };

  return (
    <div className="relative mx-auto flex h-[100dvh] w-full max-w-[28rem] flex-col overflow-hidden bg-bg md:max-w-[44rem] lg:max-w-none lg:flex-row">
      {!data && !loadErr && <Splash />}
      {loadErr && <LoadError err={loadErr} />}

      {data && (
        <>
          <SideNav view={navView} onChange={goMain} secondary={secondary} onSecondary={setSecondary} />

          {/* mobile-only secondary-nav trigger (desktop uses the sidebar) */}
          <button
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            className="absolute left-2.5 top-2 z-40 grid h-9 w-9 place-items-center rounded-full text-ink active:opacity-50 lg:hidden"
          >
            <IconMenu className="h-[22px] w-[22px]" />
          </button>

          <div className="relative z-10 min-h-0 flex-1 lg:min-w-0">
            <div className={`h-full ${view === "team" && !secondary ? "" : "hidden"}`}>
              <MyTeamView
                data={data}
                code={teamCode}
                tab={myTeamTab}
                onTab={setMyTeamTab}
                live={live}
                lineups={lineups}
                events={events}
                onOpenMatch={setMatchFx}
                onOpenSwitcher={() => setSheetOpen(true)}
                rightAction={themeToggle}
              />
            </div>
            <div className={`h-full ${view === "matches" && !secondary ? "" : "hidden"}`}>
              <MatchesView data={data} live={live} lineups={lineups} events={events} onOpenMatch={setMatchFx} rightAction={themeToggle} />
            </div>
            <div className={`h-full ${view === "prediction" && !secondary ? "" : "hidden"}`}>
              <PredictionView data={data} rightAction={themeToggle} />
            </div>
            <div className={`h-full ${view === "groups" && !secondary ? "" : "hidden"}`}>
              <GroupsView data={data} onSelectTeam={selectTeam} rightAction={themeToggle} />
            </div>
            <div className={`h-full ${secondary ? "" : "hidden"}`}>
              {secondary && <ContentView key={secondary} pageKey={secondary} onBack={() => setSecondary(null)} rightAction={themeToggle} />}
            </div>
          </div>

          <TabBar view={navView} onChange={goMain} />

          <MobileMenu open={menuOpen} current={secondary} onNavigate={openPage} onClose={() => setMenuOpen(false)} />

          <TeamSheet
            data={data}
            open={sheetOpen}
            current={teamCode}
            onPick={(t) => {
              setTeamCode(t.code);
              setSheetOpen(false);
            }}
            onClose={() => setSheetOpen(false)}
          />

          <MatchSheet data={data} fx={matchFx} live={live} lineups={lineups} events={events} onClose={() => setMatchFx(null)} />
        </>
      )}
    </div>
  );
}

function Splash() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-ink-2">
      <div className="rainbow-line h-1 w-24 animate-pulse rounded-full" />
      <p className="text-[14px]">Loading…</p>
    </div>
  );
}

function LoadError({ err }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="text-[16px] font-semibold">Couldn’t load the data</p>
      <p className="text-[13px] text-ink-2">
        Serve over HTTP (e.g. <code>npm run dev</code>) so <code>app-data.json</code> can load.
      </p>
      <p className="mt-1 text-[12px] text-ink-3">{String(err && err.message)}</p>
    </div>
  );
}
