# Internal Linking Guidelines and Hierarchy Rules

> **Status: Task-derived draft — pending editorial approval.**

## Purpose

Discover links before drafting so useful links shape the article rather than being retrofitted afterward. Links should help the reader and support the blog-to-commercial conversion path.

## Discovery sources

- Published Ghost blog posts: URL, title and primary topic.
- Google Search Console pages with impressions for terms related to the supplied primary keyword, used to surface commercial URLs not stored in Ghost.

## Ranking hierarchy

Apply this priority order when relevance and context are otherwise suitable:

1. Collection
2. Designer hub
3. Sub-collection
4. Product
5. Broad category
6. Homepage

The hierarchy does not justify an irrelevant link.

## Candidate validation

- Rank candidates by topical relevance and conversion value.
- Verify every candidate returns HTTP 200 before it enters the run shortlist.
- Keep the source and verification time for every candidate.
- Cache discovery results for no longer than one day.
- If no suitable link exists, record a warning or finding; never invent a URL.

## Draft placement

- Use only targets from the run's verified shortlist.
- Place relevant commercial links in the body, not only in the conclusion.
- Use anchor text that describes the destination and fits the surrounding sentence.
- Do not add a link merely to satisfy a count; it must support the reader or conversion goal.

## Review

Code checks:

- The target exists in the shortlist.
- The target returns HTTP 200.
- The target follows the configured hierarchy rules.

Model judgement checks:

- Anchor-text quality.
- Contextual fit.
- Whether commercial links support the conversion goal rather than acting as decoration.

## Pending editorial input

The task does not specify and this draft does not invent:

- Minimum or maximum link counts.
- Repeated-link policy.
- Exact-match anchor restrictions.
- Approved/excluded URL lists beyond the discovery and hierarchy rules.
