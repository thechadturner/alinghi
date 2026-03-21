const { validationResult } = require('express-validator');

/**
 * Shared validation result handler for express-validator.
 * Sends 422 with first error message and a list of errors.
 */
function handleValidation(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    return next();
  }

  const first = errors.array({ onlyFirstError: true })[0];
  return res.status(422).json({
    success: false,
    message: first?.msg || 'Validation error',
    errors: errors.array().map(e => ({ param: e.param, msg: e.msg }))
  });
}

module.exports = { handleValidation };


