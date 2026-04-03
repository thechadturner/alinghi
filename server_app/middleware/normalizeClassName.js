const { normalizeClassSchemaName } = require('./helpers');

/**
 * After gp50 → ac40 schema rename, clients may still send class_name=gp50 (cached UI / local storage).
 * Normalize query and JSON body before controllers build schema-qualified SQL.
 */
function normalizeLegacyClassName(req, res, next) {
  if (req.query && Object.prototype.hasOwnProperty.call(req.query, 'class_name')) {
    req.query.class_name = normalizeClassSchemaName(req.query.class_name);
  }
  if (req.body && typeof req.body === 'object' && Object.prototype.hasOwnProperty.call(req.body, 'class_name')) {
    req.body.class_name = normalizeClassSchemaName(req.body.class_name);
  }
  next();
}

module.exports = { normalizeLegacyClassName };
