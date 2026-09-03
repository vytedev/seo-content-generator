import { describe, expect, it } from "vitest";
import { isCanonicalProductRoute } from "../src/shared/product-route.js";
import {
  INTERNAL_LINK_HIERARCHY_RANK,
  classifyInternalLinkHierarchy,
} from "../src/shared/internal-link-hierarchy.js";

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

  it.each([
    ["/", "homepage"],
    ["/collections/chairs", "collection"],
    ["/collections/chairs/dining", "sub_collection"],
    ["/designers/eames", "designer_hub"],
    ["/products/eames-chair", "product"],
    ["/de/style-eames-chair", "product"],
    ["/de", "broad_category"],
    ["/de/editorial/chair-guide", "broad_category"],
  ] as const)("classifies %s as %s for Steps 1.2, 1.7 and 1.8", (path, expected) => {
    const classified = classifyInternalLinkHierarchy(url(path));
    expect(classified).toBe(expected);
    expect(INTERNAL_LINK_HIERARCHY_RANK[classified!]).toBeGreaterThan(0);
  });

  it.each([
    "not a URL",
    "https://www.mobelaris.com/products/%E0%A4%A",
    "https://www.mobelaris.com/products/chair%2Fdetails",
    "ftp://www.mobelaris.com/products/chair",
  ])("fails closed for malformed hierarchy input %s", (value) => {
    expect(classifyInternalLinkHierarchy(value)).toBeNull();
  });
});
