import { REPEATED_ADJECTIVE_POLICY } from "./rule-data.js";
import {
  PROVISIONAL_BANNED_PHRASES_V1,
  PROVISIONAL_US_TO_UK_WORD_MAP_V1,
  PROVISIONAL_VAGUE_HEADINGS_V1,
} from "./policy-data.js";

export const RULE_INVENTORY_V1 = [
  {
    id: "on_page.meta_title.length",
    applicability: "always",
    parameters: { unit: "utf_16_code_units", minimum: 55, maximum: 60, severity: "blocker" },
  },
  {
    id: "on_page.meta_description.length",
    applicability: "always",
    parameters: { unit: "utf_16_code_units", minimum: 150, maximum: 155, severity: "blocker" },
  },
  {
    id: "on_page.populated",
    applicability: "always",
    parameters: {
      fields: [
        "meta_title",
        "meta_description",
        "og_title",
        "og_description",
        "slug",
        "images[].alt",
        "images[].filename",
        "faqs[].question",
        "faqs[].answer",
      ],
      arrays_require_item: ["images"],
      severity: "blocker",
    },
  },
  {
    id: "structure.heading_levels",
    applicability: "when_any_heading_exists",
    parameters: {
      no_initial_skip: true,
      no_level_skip_between_adjacent_headings: true,
      severity: "blocker",
    },
  },
  {
    id: "structure.single_h1",
    applicability: "always",
    parameters: { count: 1, severity: "blocker" },
  },
  {
    id: "keyword.primary.h1",
    applicability: "always",
    parameters: { exact_phrase_case_insensitive: true, severity: "blocker" },
  },
  {
    id: "structure.direct_answer",
    applicability: "always",
    parameters: {
      location: "immediate_paragraph_after_first_h1",
      minimum_words: 40,
      maximum_words: 70,
      severity: "blocker",
    },
  },
  {
    id: "structure.conclusion",
    applicability: "always",
    parameters: {
      heading_level: 2,
      exact_heading_case_insensitive: "Conclusion",
      first_block_must_be_paragraph: true,
      severity: "blocker",
    },
  },
  {
    id: "structure.key_takeaways",
    applicability: "always",
    parameters: {
      exact_heading_case_insensitive: "Key Takeaways",
      minimum_items: 3,
      maximum_items: 5,
      unordered: true,
      severity: "blocker",
    },
  },
  {
    id: "structure.faq_count",
    applicability: "always",
    parameters: { source: "on_page.faqs", minimum: 3, maximum: 6, severity: "blocker" },
  },
  {
    id: "structure.faq_answer_length",
    applicability: "for_each_on_page_faq",
    parameters: { minimum_words: 40, maximum_words: 80, severity: "blocker" },
  },
  {
    id: "structure.callouts",
    applicability: "always",
    parameters: { minimum: 1, maximum: 3, markdown_blockquotes: true, severity: "blocker" },
  },
  {
    id: "style.readability_grade_8",
    applicability: "always",
    parameters: {
      algorithm: "flesch_kincaid_approximation_v1",
      maximum_grade: 8,
      severity: "blocker",
    },
  },
  {
    id: "style.british_english_provisional",
    applicability: "always",
    parameters: {
      map: PROVISIONAL_US_TO_UK_WORD_MAP_V1,
      matching: "whole_word_case_insensitive",
      severity: "warning",
      provisional: true,
    },
  },
  {
    id: "style.vague_heading_provisional",
    applicability: "when_any_heading_exists",
    parameters: {
      headings: PROVISIONAL_VAGUE_HEADINGS_V1,
      matching: "normalised_exact",
      severity: "warning",
      provisional: true,
    },
  },
  {
    id: "style.banned_phrase_provisional",
    applicability: "always",
    parameters: {
      phrases: PROVISIONAL_BANNED_PHRASES_V1,
      matching: "whole_word_case_insensitive",
      severity: "warning",
      provisional: true,
    },
  },
  {
    id: "style.repeated_adjective",
    applicability: "when_paragraph_or_list_prose_exists",
    parameters: REPEATED_ADJECTIVE_POLICY,
  },
  {
    id: "keyword.primary.meta_title",
    applicability: "always",
    parameters: { exact_phrase_case_insensitive: true, severity: "blocker" },
  },
  {
    id: "keyword.primary.first_100_words",
    applicability: "always",
    parameters: {
      exact_phrase_case_insensitive: true,
      maximum_position_words: 100,
      headings_excluded: true,
      severity: "blocker",
    },
  },
  {
    id: "keyword.primary.h2",
    applicability: "always",
    parameters: { exact_phrase_case_insensitive: true, minimum: 1, severity: "blocker" },
  },
  {
    id: "keyword.related.meaningful_section",
    applicability: "for_each_related_keyword",
    parameters: {
      exact_phrase_case_insensitive: true,
      kinds: ["paragraph", "list_item", "blockquote"],
      headed_section_required: true,
      severity: "blocker",
    },
  },
  {
    id: "keyword.concentration_provisional",
    applicability: "for_primary_and_each_related_keyword",
    parameters: {
      repeated_within_same_non_heading_block: true,
      severity: "warning",
      provisional: true,
    },
  },
  {
    id: "links.verified_internal_presence",
    applicability: "always",
    parameters: {
      status: 200,
      source: "frozen_verified_shortlist",
      block_kind: "paragraph",
      excluded_sections: ["conclusion", "key takeaways", "faq", "faqs"],
      minimum: 1,
      severity: "blocker",
    },
  },
] as const;
