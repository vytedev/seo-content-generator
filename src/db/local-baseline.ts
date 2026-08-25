export const LOCAL_BASELINE_STATUS = "pending_editorial_approval" as const;

export const PROVISIONAL_KEYWORD_CONCENTRATION_RULE =
  "Use keywords naturally, flag unnatural or concentrated repetition, and calibrate numeric thresholds later against the two selected calibration posts." as const;

export interface ProvisionalCalibrationPost {
  readonly slot: 1 | 2;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly httpStatus: 200;
  readonly selectionReason: string;
  readonly status: "provisional_local";
}

export const PROVISIONAL_CALIBRATION_POSTS = [
  {
    slot: 1,
    url: "https://www.mobelaris.com/en/mobelarisblog/barcelona-chair-replica-vs-original-key-differences",
    canonicalUrl:
      "https://www.mobelaris.com/en/mobelarisblog/barcelona-chair-replica-vs-original-key-differences",
    title: "Barcelona Chair Replica vs Original: 2026 Guide",
    httpStatus: 200,
    selectionReason:
      "Exercises direct-answer and TL;DR structure, specific headings, comparisons, commercial internal links, FAQs, and dense product, price, dimension, lifespan and provenance-sensitive claims.",
    status: "provisional_local",
  },
  {
    slot: 2,
    url: "https://www.mobelaris.com/en/mobelarisblog/eileen-gray-e1027-table-replica-what-to-know",
    canonicalUrl:
      "https://www.mobelaris.com/en/mobelarisblog/eileen-gray-e1027-table-replica-what-to-know",
    title: "Eileen Gray E1027 Table Replica: Buyer's Guide 2026",
    httpStatus: 200,
    selectionReason:
      "Exercises answer-first buyer guidance, H2/H3 structure, technical dimensions and materials, comparison tables, internal links, extensive FAQs, and provenance/designer-attribution claims.",
    status: "provisional_local",
  },
] as const satisfies readonly ProvisionalCalibrationPost[];
