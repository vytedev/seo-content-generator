import { canonicalHash } from "./milestone-two.js";
import type { FactInventoryItem, ReviewResponse } from "./milestone-three.js";
import { ReviewResponseSchema } from "./milestone-three.js";
import type { StructuredDraft } from "./milestone-two.js";
import { deriveFactHardFlagReason } from "./hard-flags.js";

const FIGURE =
  /\b(?:£|\$|€)?\d+(?:[,.]\d+)*(?:\s?(?:%|cm|mm|m|kg|g|years?|days?|weeks?|months?|hours?))?\b/i;
const ATTRIBUTION_PASSIVE =
  /\b(?:(?:designed|created|made|crafted|founded|invented)(?:\s+in\s+\d{4})?\s+by\s+[^.!?\n]+|(?:the\s+)?designer\s+is\s+[^.!?\n]+)/i;
const ATTRIBUTION_NAME_LED =
  /\b(?!(?:The|We|Our|This|That|A|An)\b)[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){0,3}\s+(?:designed|created|made|crafted|founded|invented)\b[^.!?\n]*/u;

function isAttribution(value: string): boolean {
  return ATTRIBUTION_PASSIVE.test(value) || ATTRIBUTION_NAME_LED.test(value);
}

function classification(text: string): FactInventoryItem["classification"] {
  return isAttribution(text)
    ? "attribution_provenance"
    : FIGURE.test(text)
      ? "factual_figure"
      : "factual_claim";
}

/** Keeps complete assertions and their individual locations, including repeated prose. */
function sentences(text: string): Array<{ text: string; offset: number }> {
  const results: Array<{ text: string; offset: number }> = [];
  const expression = /[^.!?\n]+(?:[.!?]+|$)/g;
  for (const match of text.matchAll(expression)) {
    const value = match[0].replace(/^\s*(?:#+|[-*>])\s*/, "").trim();
    if (value) results.push({ text: value, offset: match.index ?? 0 });
  }
  return results;
}

/** Inventories assertions directly from immutable structured draft bytes. */
export function inventoryFacts(draft: StructuredDraft): FactInventoryItem[] {
  const candidates: Array<Omit<FactInventoryItem, "stable_key">> = [];
  const addFactualField = (field: string, text: string, index?: number) => {
    if (!FIGURE.test(text) && !isAttribution(text)) return;
    candidates.push({
      text: text.trim(),
      classification: classification(text),
      claim_type: isAttribution(text) ? "provenance" : "general",
      location: { field, ...(index === undefined ? {} : { line_start: index + 1 }) },
    });
  };

  for (const sentence of sentences(draft.markdown)) {
    if (!FIGURE.test(sentence.text) && !isAttribution(sentence.text)) continue;
    candidates.push({
      text: sentence.text,
      classification: classification(sentence.text),
      claim_type: isAttribution(sentence.text) ? "provenance" : "general",
      location: {
        field: "body_markdown",
        line_start: draft.markdown.slice(0, sentence.offset).split("\n").length,
      },
    });
  }

  for (const [index, claim] of draft.claims.entries()) {
    const kind = classification(claim.text);
    candidates.push({
      text: claim.text,
      classification: claim.type === "provenance" ? "attribution_provenance" : kind,
      claim_type:
        claim.type === "provenance" || kind === "attribution_provenance"
          ? "provenance"
          : claim.type,
      location: { field: "claims", line_start: index + 1 },
      ...(claim.product_identifier ? { product_identifier: claim.product_identifier } : {}),
    });
  }

  addFactualField("title", draft.title);
  addFactualField("meta_description", draft.meta_description);
  addFactualField("og_title", draft.og_title);
  addFactualField("og_description", draft.og_description);
  for (const [index, faq] of draft.faqs.entries()) {
    // FAQ answers are explicit article assertions and are inventoried whole.
    candidates.push({
      text: faq.answer.trim(),
      classification: classification(faq.answer),
      claim_type: isAttribution(faq.answer) ? "provenance" : "general",
      location: { field: "faqs", line_start: index + 1 },
    });
  }

  return candidates.map((item) => {
    const key = canonicalHash({
      text: item.text,
      classification: item.classification,
      claim_type: item.claim_type,
      location: item.location,
      product_identifier: item.product_identifier ?? null,
    });
    return { ...item, stable_key: `inventory-${key.slice(0, 20)}` };
  });
}

/** Rejects omissions and normalises safety-critical fact semantics independently of the model. */
export function enforceFactReview(
  raw: ReviewResponse,
  inventory: FactInventoryItem[],
): ReviewResponse {
  const response = ReviewResponseSchema.parse(raw);
  const inventoryKeys = response.claims.map((claim) => claim.inventory_key);
  if (new Set(inventoryKeys).size !== inventoryKeys.length)
    throw new Error("Fact review returned duplicate inventory items");
  const claimsByInventory = new Map(response.claims.map((claim) => [claim.inventory_key, claim]));
  const missing = inventory.filter((item) => !claimsByInventory.has(item.stable_key));
  if (missing.length)
    throw new Error(
      `Fact review omitted inventory items: ${missing.map((item) => item.stable_key).join(", ")}`,
    );
  const claims = response.claims.map((claim) => {
    const item = inventory.find((candidate) => candidate.stable_key === claim.inventory_key);
    if (!item)
      throw new Error(
        `Fact review returned an unknown inventory item: ${claim.inventory_key ?? "missing"}`,
      );
    return {
      ...claim,
      claim_text: item.text,
      location: item.location,
      type:
        item.classification === "attribution_provenance"
          ? ("provenance" as const)
          : item.claim_type,
      ...(deriveFactHardFlagReason(item)
        ? {
            hard_flag: true,
            hard_flag_reason: deriveFactHardFlagReason(item),
          }
        : {}),
    };
  });
  return ReviewResponseSchema.parse({ ...response, claims });
}
