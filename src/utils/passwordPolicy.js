/**
 * Password strength policy (F5).
 *
 * Extracted from the auth controller so it can be unit-tested independently of
 * the request lifecycle.
 */
const MIN_PASSWORD_LENGTH = 8;

const hasLetter = (p) => /[a-zA-Z]/.test(p);
const hasNumber = (p) => /\d/.test(p);

/**
 * Returns an error message if the password is too weak, else null.
 * @param {string} password
 * @returns {string|null}
 */
const validatePasswordStrength = (password) => {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long`;
  }
  if (!hasLetter(password)) {
    return "Password must contain at least one letter";
  }
  if (!hasNumber(password)) {
    return "Password must contain at least one number";
  }
  return null;
};

module.exports = { validatePasswordStrength, MIN_PASSWORD_LENGTH };