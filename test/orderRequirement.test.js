const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateRequirements,
  validateProjectDescription,
  validateAttachments,
} = require("../src/services/orderRequirement.service");

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const { REQUIREMENT_TYPES } = require("../src/constants/order.constants");

const req = (id, type, { required = true, options = [], question = `Q${id}` } = {}) => ({
  _id: new ObjectId(),
  question,
  type,
  required,
  options,
});

const TEXT = REQUIREMENT_TYPES.TEXT;
const TEXTAREA = REQUIREMENT_TYPES.TEXTAREA;
const URL = REQUIREMENT_TYPES.URL;
const SINGLE_SELECT = REQUIREMENT_TYPES.SINGLE_SELECT;
const MULTI_SELECT = REQUIREMENT_TYPES.MULTI_SELECT;
const FILE = REQUIREMENT_TYPES.FILE;

test("empty answers fail when required questions exist", () => {
  assert.throws(
    () => validateRequirements([req(1, TEXT)], []),
    (e) => e.code === "REQUIREMENTS_INCOMPLETE"
  );
});

test("text answers are sanitized and stored in snapshot", () => {
  const r = req(1, TEXT);
  const { snapshot } = validateRequirements([r], [{ questionId: String(r._id), answer: "  Hello <b>world</b>  " }]);
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].question, r.question);
});

test("unknown question ids are rejected", () => {
  const r = req(1, TEXT);
  assert.throws(
    () => validateRequirements([r], [{ questionId: String(new ObjectId()), answer: "x" }]),
    (e) => e.code === "REQUIREMENTS_INCOMPLETE"
  );
});

test("duplicate answers for one question rejected", () => {
  const r = req(1, TEXT);
  assert.throws(
    () =>
      validateRequirements([r], [
        { questionId: String(r._id), answer: "a" },
        { questionId: String(r._id), answer: "b" },
      ]),
    (e) => e.message.includes("Duplicate")
  );
});

test("single select must be a valid option", () => {
  const r = req(1, SINGLE_SELECT, { options: ["red", "blue"] });
  const { snapshot } = validateRequirements([r], [{ questionId: String(r._id), answer: "red" }]);
  assert.equal(snapshot[0].answer, "red");
  assert.throws(
    () => validateRequirements([r], [{ questionId: String(r._id), answer: "green" }]),
    (e) => e.code === "REQUIREMENTS_INCOMPLETE"
  );
});

test("multi select dedupes and validates options", () => {
  const r = req(1, MULTI_SELECT, { options: ["a", "b", "c"] });
  const { snapshot } = validateRequirements([r], [{ questionId: String(r._id), answer: ["a", "b", "a"] }]);
  assert.deepEqual(snapshot[0].answer, ["a", "b"]);
  assert.throws(
    () => validateRequirements([r], [{ questionId: String(r._id), answer: ["a", "zzz"] }]),
    (e) => e.code === "REQUIREMENTS_INCOMPLETE"
  );
});

test("url answers must be valid http(s) urls", () => {
  const r = req(1, URL);
  const { snapshot } = validateRequirements([r], [{ questionId: String(r._id), answer: "https://example.com" }]);
  assert.equal(snapshot[0].answer, "https://example.com");
  assert.throws(
    () => validateRequirements([r], [{ questionId: String(r._id), answer: "ftp://nope" }]),
    (e) => e.code === "REQUIREMENTS_INCOMPLETE"
  );
});

test("file answers require valid metadata", () => {
  const r = req(1, FILE);
  const goodFile = {
    name: "brief.pdf",
    url: "https://res.cloudinary.com/x/raw/upload/blockefy/order-files/abc.pdf",
    publicId: "blockefy/order-files/abc.pdf",
    mimeType: "application/pdf",
    extension: ".pdf",
    size: 1024,
  };
  const { snapshot } = validateRequirements([r], [{ questionId: String(r._id), files: [goodFile] }]);
  assert.equal(snapshot[0].files.length, 1);
  const badFile = { ...goodFile, url: "ftp://x" };
  assert.throws(
    () => validateRequirements([r], [{ questionId: String(r._id), files: [badFile] }]),
    (e) => e.code === "INVALID_FILE"
  );
});

test("optional question answered is kept, unanswered optional skipped", () => {
  const reqOptional = req(1, TEXT, { required: false });
  const reqRequired = req(2, TEXT, { required: true });
  const reqUnanswered = req(3, TEXT, { required: false });
  const { snapshot } = validateRequirements(
    [reqOptional, reqRequired, reqUnanswered],
    [{ questionId: String(reqOptional._id), answer: "yes" }, { questionId: String(reqRequired._id), answer: "sure" }]
  );
  assert.equal(snapshot.length, 2);
});

test("project description must be non-empty and length-capped", () => {
  const desc = validateProjectDescription("  Build a website  ");
  assert.equal(desc, "Build a website");
  assert.throws(() => validateProjectDescription(""), (e) => e.code === "VALIDATION_ERROR");
  assert.throws(() => validateProjectDescription("x".repeat(6000)), (e) => e.code === "VALIDATION_ERROR");
});

test("attachments validates metadata list", () => {
  assert.deepEqual(validateAttachments(undefined), []);
  assert.deepEqual(validateAttachments([]), []);
  const goodFile = {
    name: "a.png",
    url: "https://res.cloudinary.com/x/raw/upload/blockefy/order-files/a.png",
    publicId: "blockefy/order-files/a.png",
    mimeType: "image/png",
    extension: ".png",
    size: 10,
  };
  assert.equal(validateAttachments([goodFile]).length, 1);
});
