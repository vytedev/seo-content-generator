const HANDOFF_FIELDS: Array<{ name: string; description: string }> = [
  { name: "primary_keyword", description: "The keyword this post must rank for." },
  { name: "related_keywords", description: "Supporting terms from your own research." },
  { name: "word_count_target", description: "The target length for the finished post." },
  { name: "locales_for_translation", description: "Recorded and passed to export, for dev." },
  { name: "plane_ticket", description: "The ticket this blog post is tracked against." },
  {
    name: "client_insights",
    description: "Optional — anything from real conversations a model would not know.",
  },
];

/**
 * Fills the space beside the handoff form with something useful rather than
 * empty canvas: what the pasted JSON needs to contain, and where it comes
 * from. Shown whenever there's nothing to resume, or the operator has
 * explicitly asked to start another post — the history table only pre-empts it
 * when landing on the page with in-progress work still open.
 */
export function HandoffReference() {
  return (
    <section
      aria-labelledby="handoff-reference-heading"
      className="rounded-group border border-rule bg-paper p-4"
    >
      <h2
        id="handoff-reference-heading"
        className="border-b border-rule pb-2 text-sm font-semibold"
      >
        What the handoff needs
      </h2>
      <dl className="divide-y divide-rule">
        {HANDOFF_FIELDS.map((field) => (
          <div key={field.name} className="py-3">
            <dt className="font-mono text-xs text-ink">{field.name}</dt>
            <dd className="mt-0.5 text-xs text-muted">{field.description}</dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-rule pt-4 text-xs text-muted">
        This comes from your keyword-research chat in Claude — copy the JSON it produces straight
        across.
      </p>
    </section>
  );
}
