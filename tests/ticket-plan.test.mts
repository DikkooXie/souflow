import test from "node:test";
import assert from "node:assert/strict";
import { validateTicketPlan } from "../src/planning/validate-ticket-plan.mts";

const output = { id: "export", dependsOn: [], criteria: ["filtered"] };
const order = { id: "sort", dependsOn: ["export"], criteria: ["ordered"] };
const required = ["filtered", "ordered"];

test("accepts an unordered but complete delivery plan", () => {
  assert.deepEqual(validateTicketPlan(required, [order, output]), []);
});
test("detects a real cycle even when all references exist", () => {
  const errors = validateTicketPlan(required, [order, { ...output, dependsOn: ["sort"] }]);
  assert.ok(errors.some(error => error.startsWith("blocked-by-cycle:")));
});
test("reports invented references and omitted acceptance criteria together", () => {
  assert.deepEqual(validateTicketPlan(required, [{ ...output, dependsOn: ["ghost"], criteria: ["new"] }]),
    ["unknown-dependency:export:ghost", "unknown-criterion:export:new", "uncovered:filtered", "uncovered:ordered"]);
});
test("rejects ambiguous identities and vacuous plans", () => {
  assert.ok(validateTicketPlan(["filtered"], [output, output]).includes("invalid-ticket-ids"));
  assert.ok(validateTicketPlan([], []).includes("empty-plan"));
});
