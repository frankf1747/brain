export const fakeExtraction = {
  entities: [
    { key: "e1", type: "person", name: "Frank Fu", aliases: [], untyped_hint: null, quote: "I" },
    { key: "e2", type: "organization", name: "Acme Corp", aliases: ["Acme"], untyped_hint: null, quote: "Acme Corp" },
  ],
  relations: [
    { from_key: "e1", to_key: "e2", type: "applied_to", confidence: 0.9, valid_from: "2026-09-01", valid_to: null, quote: "applied to Acme Corp" },
  ],
  facts_about_self: [
    { predicate: "Visa Status", object_text: "F-1 OPT", object_key: null, confidence: 0.95, valid_from: null, valid_to: null, quote: "I am on F-1 OPT" },
  ],
};
