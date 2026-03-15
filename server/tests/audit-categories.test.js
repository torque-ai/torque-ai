"use strict";


const {
  AUDIT_CATEGORIES,
  getAllCategories,
  getCategory,
  getSubcategories,
  filterCategories,
  getCoreCategories,
} = require("../audit/categories");

describe("audit categories", () => {
  it("has 15 defined categories", () => {
    expect(Object.keys(AUDIT_CATEGORIES).length).toBe(15);
  });

  it("ensures every category has label, subcategories, and meaningful prompt guidance", () => {
    for (const category of Object.values(AUDIT_CATEGORIES)) {
      expect(typeof category.label).toBe("string");
      expect(category.label.length).toBeGreaterThan(0);
      expect(typeof category.subcategories).toBe("object");
      expect(Array.isArray(category.subcategories)).toBe(false);
      expect(Object.keys(category.subcategories).length).toBeGreaterThan(0);
      expect(typeof category.prompt_guidance).toBe("string");
      expect(category.prompt_guidance.length).toBeGreaterThan(10);
    }
  });

  it("returns all categories and includes key entries", () => {
    const categories = getAllCategories();
    expect(categories.length).toBe(15);
    expect(categories).toContain("security");
    expect(categories).toContain("performance");
    expect(categories).toContain("i18n");
  });

  it("returns security category with expected metadata", () => {
    const category = getCategory("security");
    expect(category).not.toBeNull();
    expect(category.label).toBe("Security");
    expect(category.subcategories).toHaveProperty("injection.sql");
  });

  it("returns null for unknown category names", () => {
    expect(getCategory("nonexistent")).toBeNull();
  });

  it("returns expected subcategories for security", () => {
    expect(getSubcategories("security")).toEqual(
      expect.arrayContaining(["injection.sql", "injection.command", "auth"]),
    );
  });

  it("filters by full category names", () => {
    const filtered = filterCategories(["security", "concurrency"]);
    expect(Object.keys(filtered).length).toBe(2);
    expect(Object.keys(filtered)).toEqual(expect.arrayContaining(["security", "concurrency"]));
  });

  it("filters by dotted subcategory keys", () => {
    const filtered = filterCategories(["security.injection.sql", "security.auth"]);
    expect(Object.keys(filtered)).toHaveLength(1);
    expect(Object.keys(filtered)[0]).toBe("security");
    expect(Object.keys(filtered.security.subcategories)).toHaveLength(2);
    expect(filtered.security.subcategories).toHaveProperty("injection.sql");
    expect(filtered.security.subcategories).toHaveProperty("auth");
  });

  it("returns core categories without accessibility and i18n", () => {
    const coreCategories = getCoreCategories();
    expect(coreCategories).toContain("security");
    expect(coreCategories).toContain("error-handling");
    expect(coreCategories).toContain("code-quality");
    expect(coreCategories).toContain("architecture");
    expect(coreCategories).toContain("performance");
    expect(coreCategories).toContain("concurrency");
    expect(coreCategories).not.toContain("accessibility");
    expect(coreCategories).not.toContain("i18n");
  });
});
