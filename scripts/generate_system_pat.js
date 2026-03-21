// scripts/generate_system_pat.js
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * SHA256 hash function (matches the one in pat.js middleware)
 */
function sha256(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Generate a PAT token for the system user with 2 years expiration
 */
async function generateSystemPAT() {
  try {
    // Dynamically import CommonJS modules
    const dbModule = await import('../server_app/middleware/db.js');
    const db = dbModule.default || dbModule;
    
    // Get the system user ID (SUPER_USER from environment)
    const systemUserId = db.GetSuperUser();
    
    if (!systemUserId) {
      console.error('ERROR: SUPER_USER is not set in environment variables');
      console.error('Please set SUPER_USER in your .env or .env.local file');
      process.exit(1);
    }

    console.log(`System User ID: ${systemUserId.substring(0, 8)}...${systemUserId.substring(systemUserId.length - 8)}`);

    // Verify the system user exists in the database
    const userCheckSql = `SELECT user_id, email, user_name FROM admin.users WHERE user_id = $1`;
    const userRows = await db.GetRows(userCheckSql, [systemUserId]);
    
    if (!userRows || userRows.length === 0) {
      console.error(`ERROR: System user with ID ${systemUserId} not found in database`);
      console.error('Please verify that SUPER_USER matches a valid user_id in admin.users');
      process.exit(1);
    }

    const systemUser = userRows[0];
    console.log(`Found system user: ${systemUser.email || systemUser.user_name || 'Unknown'}`);

    // Generate raw token (64 hex characters = 32 bytes)
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);

    // Token name with timestamp
    const tokenName = `system-pat-${new Date().toISOString().slice(0, 10)}`;

    // 2 years = 730 days
    const expiresInDays = 730;

    // Revoke any existing active tokens for the system user
    console.log('Revoking existing active tokens for system user...');
    await db.ExecuteCommand(
      `UPDATE admin.personal_api_tokens 
       SET revoked_at = now() 
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [systemUserId]
    );

    // Insert new token with 2 years expiration
    const insertSql = `
      INSERT INTO admin.personal_api_tokens
        (user_id, name, token_hash, scopes, ip_allowlist, project_ids, expires_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' days')::interval, $8)
      RETURNING token_id, expires_at, created_at`;

    const insertParams = [
      systemUserId,
      tokenName,
      tokenHash,
      ['read', 'write', 'admin'], // Full scopes for system user
      null, // No IP restrictions
      null, // No project restrictions
      String(expiresInDays),
      systemUserId
    ];

    const result = await db.GetRows(insertSql, insertParams);
    
    if (!result || result.length === 0) {
      console.error('ERROR: Failed to insert token into database');
      process.exit(1);
    }

    const tokenRecord = result[0];
    const expiresAt = new Date(tokenRecord.expires_at);
    
    console.log('\n✅ PAT Token generated successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('⚠️  IMPORTANT: Save this token now - it will not be shown again!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`\nToken Name: ${tokenName}`);
    console.log(`Token ID: ${tokenRecord.token_id}`);
    console.log(`Expires: ${expiresAt.toISOString()} (${expiresInDays} days from now)`);
    console.log(`Scopes: read, write, admin`);
    console.log(`\n🔑 PAT Token:`);
    console.log(rawToken);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\nUsage: Include this token in API requests as:');
    console.log('  Authorization: Bearer <token>');
    console.log('\n');

  } catch (error) {
    console.error('ERROR generating system PAT token:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the script
generateSystemPAT()
  .then(() => {
    console.log('Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });