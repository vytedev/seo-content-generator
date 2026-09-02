import { describe, expect, it } from "vitest";
import {
  classifyInvalidSuccess,
  classifyStructuredContent,
  isJson,
} from "../src/server/providers/structured-output-diagnostics.js";

describe("structured-output diagnostics", () => {
  it.each([
    [false, undefined, undefined, false, "invalid_envelope"],
    [true, "length", '{"partial":', false, "truncation"],
    [true, "stop", "  ", false, "empty_content"],
    [true, "stop", "not json", false, "invalid_json"],
    [true, "stop", '{"wrong":true}', true, "schema_validation_failure"],
  ] as const)(
    "classifies invalid successes without exposing content",
    (envelope, finish, content, json, expected) => {
      expect(classifyInvalidSuccess(envelope, finish, content, json)).toBe(expected);
    },
  );

  it.each(["[]", "null", '"text"', '{"unexpected":true}'])(
    "recognises valid JSON independently of the required object schema: %s",
    (content) => {
      expect(isJson(content)).toBe(true);
      expect(classifyStructuredContent(content, isJson(content))).toBe("schema_validation_failure");
    },
  );

  it("does not recognise malformed JSON", () => {
    expect(isJson('{"partial":')).toBe(false);
  });
});
