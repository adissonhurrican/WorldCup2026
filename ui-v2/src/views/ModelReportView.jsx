import Screen from "../components/Screen";
import { Card } from "../components/ui";
import { REPORT } from "../content/model-report";

// The FULL post-tournament model report — every table behind the Home summary: the pre-tournament
// simulation, group-stage calibration, the knockout record, the AI co-predictor's calls, benchmarks
// (simpler models on the same games + the public field), and the pipeline's data record. Reached from
// Home ("Read the report") and the side nav. Same design language as the app; display only; all numbers
// come from the frozen REPORT content module. Project: ahcfrgxczbgdvrqmbisw

function SectionHead({ eyebrow, title, sub }) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-ink-3">{eyebrow}</div>
      <h2 className="mt-0.5 text-[19px] font-bold tracking-tight">{title}</h2>
      {sub && <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-ink-2">{sub}</p>}
    </div>
  );
}

function Table({ head, children }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-[12px] border border-separator/50">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={`whitespace-nowrap border-b border-separator/50 px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wide text-ink-3 ${h.right ? "text-right" : ""}`}>{h.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
const Td = ({ children, right = false, strong = false }) => (
  <td className={`border-b border-separator/30 px-3 py-2 align-top ${right ? "text-right tabular-nums" : ""} ${strong ? "font-semibold text-ink" : "text-ink-2"}`}>{children}</td>
);
const Chip = ({ tone = "gold", children }) => {
  const cls = tone === "hit" ? "bg-qualified/10 text-qualified" : tone === "miss" ? "bg-live/10 text-live" : "bg-bubble/10 text-bubble";
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10.5px] font-bold ${cls}`}>{children}</span>;
};
function FactRow({ items }) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((f) => (
        <Card key={f.l} className="p-3.5">
          <div className="text-[20px] font-bold tabular-nums tracking-tight">{f.v}</div>
          <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{f.l}</div>
        </Card>
      ))}
    </div>
  );
}

export default function ModelReportView({ onBack, rightAction }) {
  const r = REPORT;
  return (
    <Screen stickyTitle="Model report" rightAction={rightAction}>
      <div className="mx-auto max-w-[880px]">
        <button onClick={onBack} className="mb-6 inline-flex items-center gap-1.5 text-[14px] font-medium text-accent active:opacity-50">
          <span aria-hidden="true">←</span> Back
        </button>

        <h1 className="text-[28px] font-bold tracking-tight text-ink lg:text-[32px]">The model report</h1>
        <p className="mt-2 max-w-[62ch] text-[14px] leading-relaxed text-ink-2">
          How the math and the AI actually did across all 104 matches of World Cup 2026 — scored only against
          predictions locked <span className="font-semibold text-ink">before</span> the games they cover.
        </p>

        <div className="mt-8 space-y-10">
          <section>
            <SectionHead eyebrow="The 20,000-run simulation · frozen 4 June" title="It named the final four — and the Final itself"
              sub="The sim's four most likely semi-finalists were exactly the four who made it, and its two most likely champions met in the Final, finishing in that order." />
            <Table head={[{ label: "Sim rank" }, { label: "Team" }, { label: "Champion odds", right: true }, { label: "Reach SF", right: true }, { label: "Actual finish" }]}>
              {r.sim.top.map((t) => (
                <tr key={t.rank}>
                  <Td right>{t.rank}</Td>
                  <Td strong>{t.team}</Td>
                  <Td right>{t.champ}</Td>
                  <Td right>{t.sf}</Td>
                  <Td>{t.medal ? <Chip>{t.finish}</Chip> : t.finish}</Td>
                </tr>
              ))}
            </Table>
            <FactRow items={r.sim.groupFacts.map((f, i) => ({ ...f, key: i }))} />
          </section>

          <section>
            <SectionHead eyebrow="Group stage · 72 matches · win / draw / win" title="61% against a 33% baseline — and slightly underconfident"
              sub="The probabilistic scores beat uniform guessing on both measures. The calibration table is the honest part: mid-priced favourites won far more often than the model believed." />
            <FactRow items={r.groups.stats} />
            <Table head={[{ label: "Favourite priced at" }, { label: "Games", right: true }, { label: "Favourite won", right: true }, { label: "Read" }]}>
              {r.groups.calibration.map((c) => (
                <tr key={c.priced}>
                  <Td right>{c.priced}</Td>
                  <Td right>{c.games}</Td>
                  <Td right strong>{c.won}</Td>
                  <Td>{c.read}</Td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 max-w-[62ch] text-[12.5px] text-ink-3">{r.groups.lesson}</p>
          </section>

          <section>
            <SectionHead eyebrow="Knockouts · 32 ties · post-group K=60 engine" title="A flawless finish: perfect quarters, semis — and the Final on a 51% call"
              sub={`The knockout engine took 26 of 32 ties, sharpening every round, with a winner-probability Brier of ${r.knockout.brier}. Its single narrowest call of the bracket was the Final itself: Spain 51–49. Spain won 1–0.`} />
            <div className="mt-3 flex flex-wrap gap-2">
              {r.knockout.perRound.map((x) => (
                <span key={x.round} className="rounded-full bg-fill/10 px-3 py-1.5 text-[12.5px] font-semibold text-ink-2">
                  {x.round} <span className="tabular-nums text-ink">{x.rec}</span>
                </span>
              ))}
            </div>
            <Table head={[{ label: "Upset" }, { label: "Round" }, { label: "Favourite", right: true }, { label: "Result" }, { label: "Kind" }]}>
              {r.knockout.upsets.map((u) => (
                <tr key={u.tie}>
                  <Td strong>{u.tie}</Td>
                  <Td>{u.round}</Td>
                  <Td right>{u.fav}</Td>
                  <Td><span className="tabular-nums">{u.result}</span></Td>
                  <Td><Chip tone={u.kind === "shootout" ? "miss" : "gold"}>{u.kind}</Chip></Td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 max-w-[62ch] text-[12.5px] text-ink-3">{r.knockout.upsetNote}</p>
          </section>

          <section>
            <SectionHead eyebrow="The AI co-predictor · 16 ties, R16 → Final" title="Math 13, AI 12 — but the AI's solo call was the shot of the tournament"
              sub="From the round of 16 the AI published its own pick beside the model's number — grounded in the sourced national stories, form and head-to-heads, and free to disagree." />
            <FactRow items={r.ai.record} />
            <Table head={[{ label: "Divergence" }, { label: "The math said", right: true }, { label: "The AI said" }, { label: "Result" }, { label: "Verdict" }]}>
              {r.ai.divergences.map((d) => (
                <tr key={d.tie}>
                  <Td strong>{d.tie}</Td>
                  <Td right>{d.model}</Td>
                  <Td>{d.ai}</Td>
                  <Td><span className="tabular-nums">{d.result}</span></Td>
                  <Td><Chip tone={d.aiWon ? "hit" : "gold"}>{d.verdict}</Chip></Td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 max-w-[62ch] text-[12.5px] text-ink-3">{r.ai.note}</p>
          </section>

          <section>
            <SectionHead eyebrow="Benchmarks · same matches, same cutoffs" title="Against simpler models — and everyone else's"
              sub="First the controlled comparison: what simpler pickers would have done on the exact same games. Raw accuracy barely separates ranking systems in a tournament this favourite-friendly — the difference is in what each system can even express." />
            <Table head={[{ label: "Model" }, { label: "Groups (72)", right: true }, { label: "Knockouts (32)", right: true }, { label: "KO Brier", right: true }, { label: "Probabilities & sim" }]}>
              {r.benchmarks.internal.map((b) => (
                <tr key={b.model}>
                  <Td strong={!!b.ours}>{b.model}</Td>
                  <Td right>{b.groups}</Td>
                  <Td right>{b.ko}</Td>
                  <Td right>{b.brier}</Td>
                  <Td>{b.ours ? <Chip>{b.extra}</Chip> : b.extra}</Td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 max-w-[62ch] text-[12.5px] text-ink-3">{r.benchmarks.internalNote}</p>
            <Table head={[{ label: "Forecaster" }, { label: "Spain (champion)", right: true }, { label: "Their top 4" }, { label: "How it aged" }]}>
              {r.benchmarks.publicField.map((b) => (
                <tr key={b.who}>
                  <Td strong={!!b.ours}>{b.who}</Td>
                  <Td right>{b.spain}</Td>
                  <Td>{b.top4}</Td>
                  <Td>{/4\/4/.test(b.aged) ? <Chip tone="hit">{b.aged}</Chip> : /wrong/.test(b.aged) ? <Chip tone="miss">{b.aged}</Chip> : b.aged}</Td>
                </tr>
              ))}
            </Table>
            <p className="mt-2 max-w-[62ch] text-[12.5px] text-ink-3">{r.benchmarks.publicNote}</p>
          </section>

          <section>
            <SectionHead eyebrow="Data & operations · 11 June → 19 July" title="The pipeline finished as clean as it started" />
            <FactRow items={r.ops} />
          </section>

          <p className="border-t border-separator/50 pt-4 text-[12px] leading-relaxed text-ink-3">
            <span className="font-semibold text-ink-2">Method.</span> {r.method}
          </p>
        </div>
      </div>
    </Screen>
  );
}
