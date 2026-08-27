import { describe, expect, it } from "vitest";
import { isCanonicalProductRoute } from "../src/shared/product-route.js";
import { classifyInternalLinkHierarchy } from "../src/shared/link-conversion-review.js";

const url = (path: string) => `https://www.mobelaris.com${path}`;

describe("shared canonical Mobelaris product-route policy", () => {
  it.each([
    "/product/eames-chair",
    "/product/eames-chair/",
    "/products/eames-chair",
    "/products/eames-chair/",
    "/en/style-charles-eames-dining-chair",
  ])("recognises %s", (path) => {
    expect(isCanonicalProductRoute(url(path))).toBe(true);
    expect(classifyInternalLinkHierarchy(url(path))).toBe("product");
  });

  it.each([
    "/en",
    "/products",
    "/products/",
    "/products/chair/details",
    "/products//chair",
    "//products/chair",
    "/en//style-chair",
    "/en/style-chair/details",
    "/collections/chairs",
    "/designers/eames",
    "/categories/chairs",
    "/category/chairs",
    "/editorial/chair-guide",
    "/blog/chair-guide",
    "/en/about",
    "/products/chair?colour=red",
    "/en/style-chair#details",
    "/products/%E0%A4%A",
    "/products/chair%2Fdetails",
    "/en/style-chair%5Cdetails",
  ])("rejects non-product or unsafe route %s", (path) => {
    expect(isCanonicalProductRoute(url(path))).toBe(false);
    expect(classifyInternalLinkHierarchy(url(path))).not.toBe("product");
  });
});
