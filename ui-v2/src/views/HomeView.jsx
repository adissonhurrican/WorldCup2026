import Screen from "../components/Screen";
import { Card } from "../components/ui";
import { REPORT } from "../content/model-report";

// Post-tournament HOME — the first thing a visitor sees now that the World Cup is over.
// Plain-language summary first (who won, how well the predictions did), then the two engines
// (the math + the AI), then the door into the full model report. Same design language as the
// rest of the app: Card surfaces, the knockout gold strip, ink/ink-2/ink-3 type, rainbow accent.
// Display only — every number comes from the frozen REPORT content module. Project: ahcfrgxczbgdvrqmbisw

export default function HomeView({ rightAction, onOpenReport, onGoTo }) {
  const r = REPORT;
  return (
    <Screen
      stickyTitle="World Cup 2026"
      rightAction={rightAction}
      header={<h1 className="py-1 text-[34px] font-bold tracking-tight">World Cup 2026</h1>}
    >
      <div className="space-y-4 lg:mx-auto lg:max-w-[960px]">
        {/* the champion — the tournament's final word, in the knockout-gold treatment */}
        <Card className="relative overflow-hidden p-0">
          <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: "linear-gradient(90deg, rgba(214,157,46,0.9), rgba(126,82,10,0.55))" }} />
          <div className="px-5 pb-6 pt-7 text-center">
            <div className="text-[11px] font-bold uppercase tracking-wide text-ink-3">{r.final.when}</div>
            <div className="mt-2 text-[30px] font-bold leading-tight tracking-tight">{r.final.headline}</div>
            <div className="mt-1 text-[16px] font-semibold tabular-nums text-ink-2">{r.final.scoreline}</div>
            <div className="rainbow-line mx-auto mt-4 h-[3px] w-28 rounded-full" />
            <p className="mx-auto mt-3 max-w-[26rem] text-[13px] leading-relaxed text-ink-2">{r.final.extras}</p>
          </div>
        </Card>

        {/* the easy version — four numbers a visitor should leave with */}
        <div>
          <h2 className="px-1 text-[17px] font-bold tracking-tight">How did the predictions do?</h2>
          <p className="mt-1 px-1 text-[13px] text-ink-2">
            Every number below is scored against predictions we published <span className="font-semibold text-ink">before</span> the games they cover.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {r.headlineTiles.map((t) => (
              <Card key={t.label} className="p-5">
                <div className="flex items-baseline gap-2.5">
                  <span className="text-[34px] font-bold tabular-nums tracking-tight text-ink">{t.value}</span>
                  <span className="text-[14px] font-semibold text-ink">{t.label}</span>
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{t.detail}</p>
              </Card>
            ))}
          </div>
        </div>

        {/* the two engines — the math and the AI, side by side */}
        <div>
          <h2 className="px-1 text-[17px] font-bold tracking-tight">Two engines, one scoreboard</h2>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Card className="border-l-[3px] border-l-accent/60 p-5">
              <div className="text-[11px] font-bold uppercase tracking-wide text-ink-3">{r.engines.math.title}</div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{r.engines.math.body}</p>
            </Card>
            <Card className="border-l-[3px] border-l-bubble/60 p-5">
              <div className="text-[11px] font-bold uppercase tracking-wide text-bubble">✦ {r.engines.ai.title}</div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{r.engines.ai.body}</p>
            </Card>
          </div>
        </div>

        {/* the door to the details + reliving the tournament */}
        <Card className="p-5">
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[15px] font-bold">The full model report</div>
              <p className="mt-0.5 text-[13px] text-ink-2">Every table: the simulation, group-stage calibration, knockout record, the AI's calls, and how we compare to Opta, Goldman Sachs and the rest.</p>
            </div>
            <button
              onClick={onOpenReport}
              className="shrink-0 rounded-full bg-accent px-5 py-2.5 text-[14px] font-bold text-white transition active:scale-[0.98]"
            >
              Read the report
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-separator/50 pt-3.5 text-[13px]">
            <button onClick={() => onGoTo("bracket")} className="rounded-full bg-fill/10 px-3.5 py-1.5 font-semibold text-ink-2 active:opacity-60">Relive the bracket</button>
            <button onClick={() => onGoTo("matches")} className="rounded-full bg-fill/10 px-3.5 py-1.5 font-semibold text-ink-2 active:opacity-60">All 104 matches</button>
            <button onClick={() => onGoTo("team")} className="rounded-full bg-fill/10 px-3.5 py-1.5 font-semibold text-ink-2 active:opacity-60">Your team's run</button>
          </div>
        </Card>

        <p className="px-1 text-center text-[11px] text-ink-3">Simulation outputs, not betting odds.</p>
      </div>
    </Screen>
  );
}
