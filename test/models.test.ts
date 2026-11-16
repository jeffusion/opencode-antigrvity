import { describe, expect, test } from "bun:test";
import { acpModelCatalog, catalogFromSession, fallbackAcpModelCatalog, resolveAcpModelSelection } from "../src/models.js";
import { buildProviderModels } from "../src/index.js";
import { parseModelsDev, researchedMetadataFor } from "../src/model-metadata.js";

const fixtureCatalog = () => acpModelCatalog("fake", "test", [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
]);

describe("ACP model catalog", () => {
  test("maps effort variants to exact Antigravity model ids", () => {
    const catalog = fixtureCatalog();
    const selected = resolveAcpModelSelection("gemini-3.8-flash", "low", catalog);
    expect(selected.acpModel).toBe("gemini-3.8-flash-low");
    expect(resolveAcpModelSelection("gemini-3.8-flash-high", "low", catalog).acpModel).toBe("gemini-3.8-flash-low");
  });

  test("exposes one named family instead of duplicate effort-suffixed rows", () => {
    const catalog = fixtureCatalog();
    const ids = catalog.models.map((model) => model.id);
    expect(ids).toContain("gemini-3.8-flash");
    expect(ids).not.toContain("gemini-3.8-flash-high");
    expect(catalog.models.find((model) => model.id === "gemini-3.8-flash")?.name).toBe("Gemini 3.8 Flash");
  });

  test("uses researched model limits only when a canonical match exists", () => {
    const catalog = fixtureCatalog();
    const models = buildProviderModels(catalog);
    const flash = models.find((model) => model.id === "gemini-3.8-flash")!;
    expect(flash.limit).toEqual({ context: 1_048_576, output: 65_536 });
    expect(flash.variants.map((variant) => variant.id)).toEqual(["high", "medium", "low"]);
    expect(flash.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] });
    expect(flash.status).toBe("active");
    expect(researchedMetadataFor({ id: "gpt-oss-120b-medium", name: "GPT-OSS", acpModel: "gpt-oss-120b-medium", family: "gpt-oss-120b", effort: "medium" })?.output).toBe(32_768);
  });

});

test("config-only pickers keep opaque wire IDs when no legacy snapshot exists", () => {
  const catalog = catalogFromSession({
    configOptions: [{ id: "choose", category: "model", currentValue: "gemini-pro-agent", options: [
      { group: "Gemini", options: [{ value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" }, { value: "new-opaque-id", name: "New Model" }] },
    ] }],
  }, "fake")!;
  expect(catalog.models.map((m) => m.id)).toEqual(["gemini-pro-agent", "new-opaque-id"]);
  expect(resolveAcpModelSelection(undefined, undefined, catalog).acpModel).toBe("gemini-pro-agent");
  expect(() => resolveAcpModelSelection("gemini-3.1-pro-high", undefined, catalog)).toThrow(/Unknown/);
  expect(() => resolveAcpModelSelection("gemini-pro-agent", "high", catalog)).toThrow(/did not advertise/);
  expect(buildProviderModels(catalog)[1].name).toContain("limits estimated");
});

test("the complete legacy models snapshot wins over grouped config pickers", () => {
  const catalog = catalogFromSession({
    configOptions: [{ id: "model", category: "model", currentValue: "gemini-3.8-flash", options: [
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { value: "ui-only-family", name: "UI Family" },
    ] }],
    models: {
      availableModels: [
        { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
        { modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
        { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
        { modelId: "opaque-wire-id", name: "Opaque" },
      ],
      currentModelId: "gemini-3.8-flash-low",
    },
  }, "fake")!;
  expect(catalog.exactModels.map((m) => m.id)).toEqual([
    "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "opaque-wire-id",
  ]);
  expect(catalog.models.map((m) => m.id)).toEqual(["gemini-3.8-flash", "opaque-wire-id"]);
  expect(catalog.currentModel).toBe("gemini-3.8-flash-low");
  expect(resolveAcpModelSelection("gemini-3.8-flash", "medium", catalog).acpModel).toBe("gemini-3.8-flash-medium");
});

test("an advertised empty legacy snapshot clears without falling back to config pickers", () => {
  const catalog = catalogFromSession({
    models: { availableModels: [], currentModelId: "anything" },
    configOptions: [{ id: "model", category: "model", currentValue: "ui-only", options: [{ value: "ui-only", name: "UI" }] }],
  }, "fake")!;
  expect(catalog.exactModels).toEqual([]);
  expect(catalog.models).toEqual([]);
});

test("missing, empty, legacy, and colliding catalogs do not invent model availability", () => {
  expect(fallbackAcpModelCatalog().models).toEqual([]);
  expect(catalogFromSession({ configOptions: [] }, "fake")).toBeUndefined();
  expect(catalogFromSession({ configOptions: [{ id: "model", options: [] }] }, "fake")?.models).toEqual([]);
  const legacy = catalogFromSession({ models: { availableModels: [{ modelId: "legacy-exact", name: "Legacy" }], currentModelId: "legacy-exact" } }, "fake")!;
  expect(legacy.currentModel).toBe("legacy-exact");
  const colliding = acpModelCatalog("fake", null, [["foo", "Foo"], ["foo-high", "Foo (High)"], ["foo-low", "Foo (Low)"], ["foo", "Duplicate"]]);
  expect(colliding.models.map((m) => m.id)).toEqual(["foo", "foo-high", "foo-low"]);
});

test("models.dev enrichment accepts limits, excludes prices, and does not alter availability", () => {
  const parsed = parseModelsDev({ google: { models: {
    "future-flash": { limit: { context: 100000, output: 10000 }, modalities: { input: ["text", "image"] }, cost: { input: 100 } },
    "invalid": { limit: { context: -1, output: 0 } },
  } } });
  expect(Object.keys(parsed)).toEqual(["future-flash"]);
  expect(parsed["future-flash"].context).toBe(100000);
  expect(parsed["future-flash"]).not.toHaveProperty("cost");
  expect(fallbackAcpModelCatalog().models).toEqual([]);
});
