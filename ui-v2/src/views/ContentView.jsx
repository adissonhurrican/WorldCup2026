import Screen from "../components/Screen";
import { PAGES } from "../content/pages";

// Static info page (About / How it works / Privacy / Terms). Reuses Screen so it inherits the
// app chrome (sticky bar, theme toggle, footer). Long-form text is capped to a comfortable
// reading width on desktop. Display only — no model/prediction/data. Project: ahcfrgxczbgdvrqmbisw

// Minimal inline markup: **bold** and [label](href). External (http) links open safely in a new tab.
function renderInline(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0, m, key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<strong key={key++} className="font-semibold text-ink">{m[1]}</strong>);
    } else {
      const href = m[3];
      const external = /^https?:/i.test(href);
      out.push(
        <a
          key={key++}
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="font-medium text-accent underline-offset-2 hover:underline"
        >
          {m[2]}
        </a>
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Article({ blocks }) {
  return (
    <div className="space-y-4">
      {blocks.map((b, i) => {
        if (b.type === "h") {
          return <h2 key={i} className="pt-4 text-[18px] font-bold tracking-tight text-ink">{b.text}</h2>;
        }
        if (b.type === "ul") {
          return (
            <ul key={i} className="list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-ink-2 marker:text-ink-3">
              {b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}
            </ul>
          );
        }
        return <p key={i} className="text-[15px] leading-relaxed text-ink-2">{renderInline(b.text)}</p>;
      })}
    </div>
  );
}

export default function ContentView({ pageKey, onBack, rightAction }) {
  const page = PAGES[pageKey];
  if (!page) return null;
  return (
    <Screen stickyTitle={page.title} rightAction={rightAction}>
      <article className="mx-auto max-w-[680px]">
        <button
          onClick={onBack}
          className="mb-6 inline-flex items-center gap-1.5 text-[14px] font-medium text-accent active:opacity-50"
        >
          <span aria-hidden="true">←</span> Back
        </button>

        <h1 className="text-[28px] font-bold tracking-tight text-ink lg:text-[32px]">{page.title}</h1>

        {(page.draft || page.updated) && (
          <div className="mt-2 flex flex-wrap items-center gap-2.5">
            {page.draft && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-bubble/15 px-2.5 py-0.5 text-[11px] font-semibold text-bubble">
                <span className="h-1.5 w-1.5 rounded-full bg-bubble" />
                Draft · pending legal review
              </span>
            )}
            {page.updated && <span className="text-[12px] text-ink-3">Last updated {page.updated}</span>}
          </div>
        )}

        <div className="mt-7">
          <Article blocks={page.blocks} />
        </div>
      </article>
    </Screen>
  );
}
