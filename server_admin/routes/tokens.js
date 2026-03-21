const express = require('express');
const { body, param } = require('express-validator');
const { authenticate, requireSuperUser } = require('../middleware/auth_jwt');
const { validatePAT, requirePatScopes, sha256 } = require('../middleware/pat');
const { handleValidation } = require('../../shared/middleware/validation');
const db = require('../../server_app/middleware/db');

const router = express.Router();

// Create a new PAT (admin or superuser)
router.post(
  '/',
  authenticate,
  requireSuperUser,
  [
    body('name').isString().bail().trim().isLength({ min: 1, max: 100 }),
    body('scopes').isArray().withMessage('scopes must be an array'),
    body('expires_in_days').isInt({ min: 1, max: 365 }).withMessage('expires_in_days 1-365'),
    body('ip_allowlist').optional({ nullable: true }).isArray().withMessage('ip_allowlist must be an array'),
    body('project_ids').optional({ nullable: true }).isArray().withMessage('project_ids must be an array of ints')
  ],
  handleValidation,
  async (req, res) => {
    try {
      const userId = req.user?.user_id;
      const { name, scopes, expires_in_days, ip_allowlist, project_ids } = req.body;

      // Generate raw token and hash
      const rawToken = require('crypto').randomBytes(32).toString('hex');
      const tokenHash = sha256(rawToken);

      // Revoke all existing active tokens for this user before creating a new one
      await db.ExecuteCommand(
        `UPDATE admin.personal_api_tokens 
         SET revoked_at = now() 
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
      );

      const sql = `
        INSERT INTO admin.personal_api_tokens
          (user_id, name, token_hash, scopes, ip_allowlist, project_ids, expires_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval, $8)`;
      const ok = await db.ExecuteCommand(sql, [
        userId,
        name,
        tokenHash,
        scopes,
        ip_allowlist || null,
        project_ids || null,
        String(expires_in_days),
        userId
      ]);

      if (!ok) return res.status(500).json({ success: false, message: 'Failed to create token' });

      // Return raw token ONCE
      return res.json({ success: true, data: { token: rawToken, name, scopes, expires_in_days } });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Error creating token' });
    }
  }
);

// List current user's PATs (metadata only)
router.get('/', authenticate, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    const sql = `
      SELECT 
        t.token_id,
        t.name,
        t.scopes,
        t.ip_allowlist,
        t.project_ids,
        t.created_at,
        t.last_used_at,
        t.expires_at,
        t.revoked_at,
        u.email
      FROM admin.personal_api_tokens t
      JOIN admin.users u ON u.user_id = t.user_id
      WHERE t.user_id = $1
      ORDER BY t.created_at DESC`;
    const rows = await db.GetRows(sql, [userId]);
    return res.json({ success: true, data: rows || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error listing tokens' });
  }
});

// Revoke a PAT by id
router.delete(
  '/:id',
  authenticate,
  requireSuperUser,
  [param('id').isUUID()],
  handleValidation,
  async (req, res) => {
    try {
      const tokenId = req.params.id;
      const ok = await db.ExecuteCommand(
        'UPDATE admin.personal_api_tokens SET revoked_at = now() WHERE token_id = $1 AND revoked_at IS NULL',
        [tokenId]
      );
      if (!ok) return res.status(404).json({ success: false, message: 'Token not found or already revoked' });
      return res.json({ success: true, message: 'Token revoked' });
    } catch (err) {
      return res.status(500).json({ success: false, message: 'Error revoking token' });
    }
  }
);

module.exports = router;


