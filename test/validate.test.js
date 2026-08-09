const { test } = require("node:test");
const assert = require("node:assert/strict");

const { s, makeValidator } = require("../src/utils/validate");

test("required rejects missing values", () => {
  const rule = s.required(s.string());
  assert.equal(rule(undefined).valid, false);
  assert.equal(rule(null).valid, false);
  assert.equal(rule("").valid, false);
});

test("optional passes empty values", () => {
  const rule = s.optional(s.string());
  assert.equal(rule(undefined).valid, true);
  assert.equal(rule("").valid, true);
});

test("string trims and enforces max length", () => {
  assert.equal(s.string()("  hi  ").value, "hi");
  assert.equal(s.string({ max: 3 })("abcd").valid, false);
  assert.equal(s.string().max(3)("abcd").valid, false);
  assert.equal(s.string().max(3)("abc").valid, true);
});

test("integer enforces min/max", () => {
  assert.equal(s.integer({ min: 1 })(0).valid, false);
  assert.equal(s.integer({ min: 1 })(1).valid, true);
  assert.equal(s.integer({ max: 5 })(6).valid, false);
  assert.equal(s.integer()(1.5).valid, false);
});

test("enum rejects unknown values", () => {
  const rule = s.enum(["wallet", "card"]);
  assert.equal(rule("wallet").valid, true);
  assert.equal(rule("paypal").valid, false);
});

test("objectId validates format", () => {
  const rule = s.objectId();
  assert.equal(rule("507f1f77bcf86cd799439011").valid, true);
  assert.equal(rule("nope").valid, false);
});

test("url validates http(s) only", () => {
  assert.equal(s.url()("https://example.com/a.png").valid, true);
  assert.equal(s.url()("http://example.com").valid, true);
  assert.equal(s.url()("ftp://example.com").valid, false);
  assert.equal(s.url()("not a url").valid, false);
});

test("arrayOf enforces max and item rules", () => {
  const rule = s.arrayOf(s.objectId()).max(2);
  assert.equal(rule([]).valid, true);
  assert.equal(rule(["507f1f77bcf86cd799439011"]).valid, true);
  assert.equal(rule(["507f1f77bcf86cd799439011", "507f1f77bcf86cd799439011", "507f1f77bcf86cd799439011"]).valid, false);
  assert.equal(rule(["bad"]).valid, false);
});

test("object rejects unexpected fields", () => {
  const rule = s.object({ name: s.required(s.string()) });
  assert.equal(rule({ name: "x" }).valid, true);
  assert.equal(rule({ name: "x", extra: 1 }).valid, false);
});

test("makeValidator strips unknown fields and returns cleaned body", () => {
  const schema = { name: s.required(s.string()), age: s.optional(s.integer()) };
  const middleware = makeValidator(schema, { body: true, stripUnknown: true });
  const req = { body: { name: "  Ada  ", age: 36, hacker: true } };
  let nextCalled = false;
  middleware(req, {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.body.name, "Ada");
  assert.equal(req.body.age, 36);
  assert.equal("hacker" in req.body, false);
});

test("makeValidator returns 400 with details on failure", () => {
  const schema = { name: s.required(s.string()) };
  const middleware = makeValidator(schema, { body: true });
  const req = { body: {} };
  const res = {
    status(code) { this.code = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  middleware(req, res, () => {});
  assert.equal(res.code, 400);
  assert.equal(res.payload.success, false);
  assert.match(res.payload.details[0], /name/);
});
