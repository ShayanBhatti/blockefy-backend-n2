const config = require("../config/orderConfig");
const {
  REQUIREMENT_TYPES,
} = require("../constants/order.constants");
const { requireNonEmpty, sanitizeText, isValidUrl } = require("../utils/sanitize");
const AppError = require("../utils/AppError");

/**
 * Requirement service.
 *
 * Validates buyer answers against the SELLER-DEFINED requirement questions
 * loaded from the gig (never from the request). Rejects unknown question ids,
 * wrong types, invalid options, malformed URLs and oversized text, and builds
 * the historical snapshot stored on the order.
 */

const MAX_TEXT_ANSWER_LENGTH = 5000;
const MAX_URL_LENGTH = 2048;
const MAX_FILES_PER_QUESTION = 5;

const MAX_ANSWER_CHARS = {
  [REQUIREMENT_TYPES.TEXT]: 1000,
  [REQUIREMENT_TYPES.TEXTAREA]: MAX_TEXT_ANSWER_LENGTH,
  [REQUIREMENT_TYPES.URL]: MAX_URL_LENGTH,
};

const validateFileMetadata = (file) => {
  const checks = [
    ["name", typeof file.name === "string" && file.name.length > 0 && file.name.length <= 255],
    ["url", typeof file.url === "string" && file.url.startsWith("https://") && file.url.length <= 2048],
    ["publicId", typeof file.publicId === "string" && /^blockefy\/order-files\/[a-z0-9\-_]+(\.[a-z0-9]+)?$/i.test(file.publicId)],
    ["mimeType", typeof file.mimeType === "string" && file.mimeType.length <= 255],
    ["extension", typeof file.extension === "string" && /^\.[a-z0-9]{1,10}$/i.test(file.extension)],
    ["size", Number.isInteger(file.size) && file.size >= 0 && file.size <= config.maxFileSizeBytes],
  ];
  const failed = checks.find(([, ok]) => !ok);
  if (failed) {
    throw new AppError(`Invalid file metadata: ${failed[0]}`, 400, "INVALID_FILE");
  }
  return {
    name: file.name.slice(0, 255),
    url: file.url,
    publicId: file.publicId,
    mimeType: file.mimeType,
    extension: file.extension.toLowerCase(),
    size: file.size,
  };
};

/**
 * Validate and sanitize a single answer against its requirement definition.
 * Returns the sanitized answer or throws AppError.
 */
const validateAnswer = (requirement, answer, files) => {
  const { type } = requirement;
  const required = requirement.required;

  const isEmpty = () => {
    if (answer === undefined || answer === null) return true;
    if (typeof answer === "string") return answer.trim().length === 0;
    if (Array.isArray(answer)) return answer.length === 0;
    return false;
  };

  switch (type) {
    case REQUIREMENT_TYPES.TEXT:
    case REQUIREMENT_TYPES.TEXTAREA: {
      if (isEmpty()) {
        if (required) throw new AppError(`Question "${requirement.question}" is required`, 400, "REQUIREMENTS_INCOMPLETE");
        return null;
      }
      return sanitizeText(answer, { max: MAX_ANSWER_CHARS[type], field: "Answer" });
    }
    case REQUIREMENT_TYPES.URL: {
      if (isEmpty()) {
        if (required) throw new AppError(`Question "${requirement.question}" is required`, 400, "REQUIREMENTS_INCOMPLETE");
        return null;
      }
      if (typeof answer !== "string" || !isValidUrl(answer)) {
        throw new AppError(`Question "${requirement.question}" requires a valid URL`, 400, "REQUIREMENTS_INCOMPLETE");
      }
      return answer.trim();
    }
    case REQUIREMENT_TYPES.SINGLE_SELECT: {
      if (isEmpty()) {
        if (required) throw new AppError(`Question "${requirement.question}" is required`, 400, "REQUIREMENTS_INCOMPLETE");
        return null;
      }
      if (!requirement.options.includes(answer)) {
        throw new AppError(`Invalid option for question "${requirement.question}"`, 400, "REQUIREMENTS_INCOMPLETE");
      }
      return answer;
    }
    case REQUIREMENT_TYPES.MULTI_SELECT: {
      if (isEmpty()) {
        if (required) throw new AppError(`Question "${requirement.question}" is required`, 400, "REQUIREMENTS_INCOMPLETE");
        return [];
      }
      if (!Array.isArray(answer)) {
        throw new AppError(`Question "${requirement.question}" requires an array of options`, 400, "REQUIREMENTS_INCOMPLETE");
      }
      for (const value of answer) {
        if (!requirement.options.includes(value)) {
          throw new AppError(`Invalid option "${value}" for question "${requirement.question}"`, 400, "REQUIREMENTS_INCOMPLETE");
        }
      }
      return [...new Set(answer)];
    }
    case REQUIREMENT_TYPES.FILE: {
      const fileList = Array.isArray(files) ? files : [];
      if (fileList.length === 0) {
        if (required) throw new AppError(`Question "${requirement.question}" requires a file upload`, 400, "REQUIREMENTS_INCOMPLETE");
        return null;
      }
      if (fileList.length > MAX_FILES_PER_QUESTION) {
        throw new AppError(`Question "${requirement.question}" accepts at most ${MAX_FILES_PER_QUESTION} files`, 400, "REQUIREMENTS_INCOMPLETE");
      }
      return fileList.map(validateFileMetadata);
    }
    default:
      throw new AppError(`Unsupported requirement type: ${type}`, 400, "VALIDATION_ERROR");
  }
};

/**
 * Pure validation of answers against requirement definitions.
 *
 * @param {Array} requirements - active gig requirements [{_id, question, type, required, options}]
 * @param {Array} answers - submitted answers [{questionId, answer, files}]
 * @returns {Object} { snapshot } - sanitized buyerRequirements snapshot
 */
const validateRequirements = (requirements, answers) => {
  if (!Array.isArray(answers) || answers.length === 0) {
    const missing = (requirements || []).filter((r) => r.required);
    if (missing.length > 0) {
      throw new AppError("Required questions must be answered", 400, "REQUIREMENTS_INCOMPLETE");
    }
    return { snapshot: [] };
  }

  if (answers.length > config.maxRequirementsAnswers) {
    throw new AppError("Too many requirement answers", 400, "VALIDATION_ERROR");
  }

  const activeRequirements = (requirements || []).filter((r) => r.isActive !== false);
  const byId = new Map();
  for (const r of activeRequirements) {
    const id = String(r._id);
    if (!byId.has(id)) byId.set(id, r);
  }

  const seen = new Set();
  const snapshot = [];

  for (const answerEntry of answers) {
    if (!answerEntry || typeof answerEntry !== "object") {
      throw new AppError("Malformed requirement answer", 400, "VALIDATION_ERROR");
    }
    const questionId = answerEntry.questionId;
    if (questionId === undefined || questionId === null) {
      throw new AppError("Requirement answer missing questionId", 400, "REQUIREMENTS_INCOMPLETE");
    }
    const id = String(questionId);
    if (seen.has(id)) {
      throw new AppError("Duplicate answer for the same question", 400, "VALIDATION_ERROR");
    }
    seen.add(id);

    const requirement = byId.get(id);
    if (!requirement) {
      // Reject answers for questions that don't belong to the selected gig.
      throw new AppError(`Requirement "${id}" does not belong to this gig`, 400, "REQUIREMENTS_INCOMPLETE");
    }

    const sanitizedAnswer = validateAnswer(requirement, answerEntry.answer, answerEntry.files);

    snapshot.push({
      questionId: requirement._id,
      question: requirement.question,
      type: requirement.type,
      required: requirement.required,
      options: requirement.options || [],
      answer: sanitizedAnswer,
      files: Array.isArray(sanitizedAnswer) && requirement.type === REQUIREMENT_TYPES.FILE ? sanitizedAnswer : [],
    });
  }

  // Enforce that every required question was answered.
  for (const r of activeRequirements) {
    if (r.required && !seen.has(String(r._id))) {
      throw new AppError(`Question "${r.question}" is required`, 400, "REQUIREMENTS_INCOMPLETE");
    }
  }

  return { snapshot };
};

/**
 * Validate the buyer's project description (always required).
 * Returns the sanitized description.
 */
const validateProjectDescription = (description) => {
  try {
    return requireNonEmpty(description, { max: config.projectDescriptionMaxLength, field: "Project description" });
  } catch (e) {
    throw new AppError(e.message, 400, "VALIDATION_ERROR");
  }
};

/**
 * Validate optional attachment metadata submitted by the buyer.
 */
const validateAttachments = (attachments) => {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  if (attachments.length > config.maxAttachments) {
    throw new AppError(`At most ${config.maxAttachments} attachments are allowed`, 400, "VALIDATION_ERROR");
  }
  return attachments.map(validateFileMetadata);
};

module.exports = {
  validateRequirements,
  validateProjectDescription,
  validateAttachments,
  validateFileMetadata,
};
