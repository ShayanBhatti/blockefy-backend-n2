/**
 * Consistent API response helpers.
 *
 * Success:  { success: true,  message, data }
 * Error:    { success: false, message, code }
 */
const ok = (res, data = null, message = "OK", status = 200) => {
  return res.status(status).json({ success: true, message, data });
};

const created = (res, data = null, message = "Created") => {
  return ok(res, data, message, 201);
};

const fail = (res, status, message, code = "ERROR", details = undefined) => {
  const body = { success: false, message, code };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
};

module.exports = { ok, created, fail };
