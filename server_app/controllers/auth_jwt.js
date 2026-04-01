const { validationResult } = require('express-validator');
const { authManager } = require('../../shared/auth');
const { sendResponse } = require('../middleware/helpers');
const { log, error, debug } = require('../../shared');
const { logMessage: sharedLogMessage } = require('../../shared/utils/logging');

/**
 * New Authentication Controller using shared auth module
 * This will eventually replace the existing auth.js controller
 */

// Get current user
exports.getUser = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'getUser' };
  
  try {
    // Check if user is super user
    const db = require('../middleware/db');
    const superUserId = db.GetSuperUser();
    const isSuperUser = req.user?.user_id && superUserId && req.user.user_id.toString() === superUserId.toString();
    
    // Add is_super_user to user object
    const userData = {
      ...req.user,
      is_super_user: isSuperUser
    };
    
    return sendResponse(res, info, 200, true, 'User data retrieved successfully', userData, false);
  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// User Login
exports.Login = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'Login' };

  // Log login attempt
  log(`[Login] Login attempt from ${req.ip || req.connection.remoteAddress} for email: ${req.body?.email || 'unknown'}`);

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(err => err.msg || `${err.path}: ${err.msg}`);
    log(`[Login] Validation failed: ${errorMessages.join(', ')}`);
    return sendResponse(res, info, 400, false, errorMessages.join(', '), null);
  }

  const { email, password } = req.body;
  const clientIp = req.ip || req.connection.remoteAddress;

  try {
    // Authenticate user using shared auth module
    log(`[Login] Attempting authentication for: ${email}`);
    const authResult = await authManager.authenticateUser(email, password, clientIp);
    
    if (!authResult) {
      log(`[Login] Authentication failed for: ${email}`);
      
      // Check failed login attempts and log after 3 attempts
      const db = require('../../shared/database/connection');
      const { user: userManager } = require('../../shared/auth');
      try {
        const user = await userManager.getUserByEmail(email);
        const userId = user ? user.user_id : null;
        
        // Count failed login attempts in the last hour
        const countSql = `SELECT COUNT(*) as count FROM admin.failed_logins 
          WHERE (user_id = $1 OR ($1 IS NULL AND ip_address = $2))
          AND attempted_at > NOW() - INTERVAL '1 hour'`;
        const countResult = await db.getRows(countSql, [userId, clientIp]);
        const failedAttempts = countResult && countResult[0] ? parseInt(countResult[0].count) : 0;
        
        // Log to database with type 'auth' after 3 failed attempts (use shared logger for correct client_ip)
        if (failedAttempts >= 3) {
          await sharedLogMessage(
            clientIp,
            userId ? String(userId) : '0',
            'server_app/controllers/auth_jwt.js',
            'warning',
            `Failed login attempt #${failedAttempts} for email: ${email}`,
            {
              email: email,
              user_id: userId,
              ip_address: clientIp,
              failed_attempts: failedAttempts,
              user_agent: req.get('User-Agent') || 'Unknown'
            }
          );
        }
      } catch (logError) {
        // Don't fail the login request if logging fails
        error('Failed to log auth attempt:', logError);
      }
      
      return res.status(401).end();
    }
    
    log(`[Login] Authentication successful for: ${email} (user_id: ${authResult.user?.user_id || 'unknown'})`);

    // Set cookie with access token
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
      domain: process.env.NODE_ENV === "production" ? undefined : undefined // Allow cookies to work with any domain in development
    };

    res.cookie("auth_token", authResult.accessToken, cookieOptions);

    // Return user data and tokens
    return sendResponse(res, info, 200, true, 'Login successful', {
      user: authResult.user,
      accessToken: authResult.accessToken,
      refreshToken: authResult.refreshToken,
      expiresIn: authResult.expiresIn
    }, false);

  } catch (error) {
    const code = error && error.code;
    const isDbUnavailable =
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === '57P03';
    const status = isDbUnavailable ? 503 : 500;
    const message = isDbUnavailable
      ? 'Database unavailable — check DB_HOST, Postgres on the host, and pg_hba.conf.'
      : error.message;
    return sendResponse(res, info, status, false, message, null, true);
  }
};

// User Registration
exports.Register = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'Register' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(err => {
      const field = err.path || err.param;
      const message = err.msg || 'Invalid value';
      return `${field}: ${message}`;
    });
    debug('Registration validation errors:', errorMessages);
    debug('Request body:', req.body);
    return sendResponse(res, info, 400, false, `Validation failed: ${errorMessages.join(', ')}`, null);
  }

  const { first_name, last_name, email, password } = req.body;

  // Additional validation for required fields
  if (!first_name || !last_name || !email || !password) {
    const missingFields = [];
    if (!first_name) missingFields.push('first_name');
    if (!last_name) missingFields.push('last_name');
    if (!email) missingFields.push('email');
    if (!password) missingFields.push('password');
    
    debug('Missing required fields:', missingFields);
    return sendResponse(res, info, 400, false, `Missing required fields: ${missingFields.join(', ')}`, null);
  }

  try {
    debug('Register attempt:', { first_name, last_name, email });
    
    // Validate password strength with detailed feedback
    const { user: userManager } = require('../../shared/auth');
    
    // Check password requirements and provide specific feedback
    const passwordErrors = [];
    
    if (password.length < 8) {
      passwordErrors.push('at least 8 characters');
    }
    if (!/[A-Z]/.test(password)) {
      passwordErrors.push('one uppercase letter');
    }
    if (!/[a-z]/.test(password)) {
      passwordErrors.push('one lowercase letter');
    }
    if (!/[0-9]/.test(password)) {
      passwordErrors.push('one number');
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};'':"\\|,.<>\/?]/.test(password)) {
      passwordErrors.push('one special character (!@#$%^&*()_+-=[]{};:"|,.<>?)');
    }
    
    // More lenient validation - require at least 4 out of 5 criteria (allow 1 missing)
    if (passwordErrors.length > 1) {
      // Only show the first 2 missing criteria to avoid overwhelming the user
      const shownErrors = passwordErrors.slice(0, 2);
      const errorMessage = `Password must contain ${shownErrors.join(', ')}. Please update your password and try again.`;
      debug('Password validation failed:', passwordErrors);
      return sendResponse(res, info, 400, false, errorMessage, null);
    }
    
    // If we get here, the password is acceptable (only 1 or 0 criteria missing)
    // Check if user already exists in main users table
    const existingUser = await userManager.getUserByEmail(email);
    
    if (existingUser) {
      return sendResponse(res, info, 409, false, 'An account with this email already exists. Please log in instead.', { redirectTo: '/login' });
    }

    const db = require('../../shared/database/connection');
    
    // Check for email rule matching if pid is provided in query string
    let matchedProjectId = null;
    const pid = req.query.pid ? parseInt(req.query.pid, 10) : null;
    
    if (pid && !isNaN(pid)) {
      try {
        // Validate that project exists
        const projectCheckSql = `SELECT project_id FROM admin.projects WHERE project_id = $1`;
        const projectCheck = await db.getRows(projectCheckSql, [pid]);
        
        if (projectCheck && projectCheck.length > 0) {
          // Query user_rules for allowed_email rules for this project
          const rulesSql = `SELECT json FROM admin.user_rules WHERE project_id = $1 AND type = 'allowed_email'`;
          const rules = await db.getRows(rulesSql, [pid]);
          
          if (rules && rules.length > 0) {
            // Check if email matches any rule
            const emailLower = email.toLowerCase();
            
            for (const rule of rules) {
              try {
                const ruleData = typeof rule.json === 'string' ? JSON.parse(rule.json) : rule.json;
                const ruleEmail = ruleData?.email;
                
                if (ruleEmail) {
                  const ruleEmailLower = ruleEmail.toLowerCase();
                  
                  // Pattern matching: if rule starts with "@", check if email ends with that domain
                  if (ruleEmailLower.startsWith('@')) {
                    if (emailLower.endsWith(ruleEmailLower)) {
                      matchedProjectId = pid;
                      debug(`Email ${email} matched rule pattern ${ruleEmail} for project ${pid}`);
                      break;
                    }
                  } else {
                    // Exact match
                    if (emailLower === ruleEmailLower) {
                      matchedProjectId = pid;
                      debug(`Email ${email} matched exact rule ${ruleEmail} for project ${pid}`);
                      break;
                    }
                  }
                }
              } catch (ruleError) {
                error(`Error parsing rule JSON for project ${pid}:`, ruleError);
                // Continue checking other rules
              }
            }
            
            if (matchedProjectId) {
              log(`Email rule matched for ${email} -> project ${matchedProjectId}`);
            }
          } else {
            debug(`No email rules found for project ${pid}`);
          }
        } else {
          debug(`Invalid project_id ${pid} provided in registration`);
        }
      } catch (ruleCheckError) {
        error('Error checking email rules during registration:', ruleCheckError);
        // Don't block registration if rule check fails, just log it
      }
    }

    // Check if email is in users_pending table (invitation-only registration)
    // If we have a matched project from rules, we can skip this check
    const checkPendingSql = `SELECT * FROM admin.users_pending WHERE email = $1`;
    const pendingUser = await db.getRows(checkPendingSql, [email]);
    
    // If no rule match and no pending user, block registration
    if (!matchedProjectId && (!pendingUser || pendingUser.length === 0)) {
      return sendResponse(res, info, 403, false, 'Your email address could not be found. Registration is currently invitation-only. Please contact support if you believe you should have access.', null);
    }

    // Check if user already exists in unverified users table
    const checkUnverifiedSql = `SELECT * FROM admin.users_unverified WHERE email = $1`;
    const existingUnverified = await db.getRows(checkUnverifiedSql, [email]);
    
    if (existingUnverified && existingUnverified.length > 0) {
      // Update existing unverified user with new verification code
      const verification_code = Math.floor(1000 + Math.random() * 9000).toString();
      
      const password_hash = await userManager.hashPassword(password);
      const clientIp = req.ip || req.connection.remoteAddress;
      const userAgent = req.get('User-Agent') || 'Unknown';
      
      // Try to update with matched_project_id, fallback if column doesn't exist
      // Since executeCommand catches errors internally, we need to try with column first,
      // and if it fails, try without it (column may not exist if migration hasn't run)
      let updateSql;
      let updateParams;
      let updateResult = false;
      
      // Only try with matched_project_id if we have a value
      if (matchedProjectId) {
        updateSql = `UPDATE admin.users_unverified SET 
          first_name = $1, 
          last_name = $2, 
          password_hash = $3, 
          verification_code = $4, 
          created_at = NOW(),
          expires_at = NOW() + INTERVAL '24 hours',
          attempts = 0,
          ip_address = $6,
          user_agent = $7,
          matched_project_id = $8
          WHERE email = $5`;
        
        updateParams = [first_name, last_name, password_hash, verification_code, email, clientIp, userAgent, matchedProjectId];
        updateResult = await db.executeCommand(updateSql, updateParams);
      }
      
      // If update with matched_project_id failed (or we don't have a matched project), try without it
      if (!updateResult) {
        if (matchedProjectId) {
          debug('matched_project_id column may not exist or update failed, trying without it');
        }
        
        updateSql = `UPDATE admin.users_unverified SET 
          first_name = $1, 
          last_name = $2, 
          password_hash = $3, 
          verification_code = $4, 
          created_at = NOW(),
          expires_at = NOW() + INTERVAL '24 hours',
          attempts = 0,
          ip_address = $6,
          user_agent = $7
          WHERE email = $5`;
        
        updateParams = [first_name, last_name, password_hash, verification_code, email, clientIp, userAgent];
        updateResult = await db.executeCommand(updateSql, updateParams);
        
        if (!updateResult) {
          error('Failed to update users_unverified table');
          return sendResponse(res, info, 500, false, 'Failed to update user account. Please try again.', null, true);
        }
        
        // Store matched_project_id in a separate way if column doesn't exist
        if (matchedProjectId) {
          debug(`Note: matched_project_id ${matchedProjectId} could not be stored in users_unverified (column may not exist). Will check rules again during verification.`);
        }
      }
      
      // Send verification code via email
      const emailService = require('../middleware/email');
      const emailResult = await emailService.sendHtmlEmail(
        email,
        'RACESIGHT - Email Verification Code',
        `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #333;">Welcome to RACESIGHT!</h2>
            <p>Hello ${first_name},</p>
            <p>Thank you for registering with RACESIGHT. To complete your registration, please verify your email address using the code below.</p>
            <p style="font-size: 24px; font-weight: bold; color: #0066cc; text-align: center; padding: 20px; background-color: #f0f0f0; border-radius: 5px; margin: 20px 0;">
              Your verification code is: <strong>${verification_code}</strong>
            </p>
            <p>This code will expire in 24 hours.</p>
            <p>If you did not create an account with RACESIGHT, please ignore this email.</p>
            <p style="margin-top: 30px; color: #666; font-size: 12px;">
              Best regards,<br>
              The RACESIGHT Team
            </p>
          </div>
        `,
        `Welcome to RACESIGHT!\n\nHello ${first_name},\n\nThank you for registering. Your verification code is: ${verification_code}\n\nThis code will expire in 24 hours.\n\nIf you did not create an account, please ignore this email.`
      );

      // Log registration verification code with type 'auth' (use shared logger for correct client_ip)
      try {
        await sharedLogMessage(
          clientIp,
          '0',
          'server_app/controllers/auth_jwt.js',
          'auth',
          `Registration verification code sent to ${email}`,
          {
            email: email,
            first_name: first_name,
            last_name: last_name,
            verification_code: verification_code,
            ip_address: clientIp,
            user_agent: userAgent,
            email_sent: emailResult.success
          }
        );
      } catch (logError) {
        error('Failed to log registration verification:', logError);
      }

      if (!emailResult.success) {
        error(`Failed to send verification email to ${email}:`, emailResult.error);
        log(`Updated unverified user: Verification code for ${email}: ${verification_code} (email sending failed)`);
      } else {
        log(`Verification code sent via email to ${email}`);
      }
      
      // Don't include verification_code in response for security
      return sendResponse(res, info, 201, true, `Verification code sent to ${email}`, {
        email: email
      });
    }

    // Create new unverified user
    const verification_code = Math.floor(1000 + Math.random() * 9000).toString();
    const password_hash = await userManager.hashPassword(password);
    const clientIp = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent') || 'Unknown';
    
    // Try to insert with matched_project_id, fallback if column doesn't exist
    // Since executeCommand catches errors internally, we need to try with column first,
    // and if it fails, try without it (column may not exist if migration hasn't run)
    let insertSql;
    let insertParams;
    let insertResult = false;
    
    // Only try with matched_project_id if we have a value
    if (matchedProjectId) {
      insertSql = `INSERT INTO admin.users_unverified 
        (first_name, last_name, email, password_hash, verification_code, ip_address, user_agent, permission, matched_project_id) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'administrator', $8)`;
      
      insertParams = [first_name, last_name, email, password_hash, verification_code, clientIp, userAgent, matchedProjectId];
      insertResult = await db.executeCommand(insertSql, insertParams);
    }
    
    // If insert with matched_project_id failed (or we don't have a matched project), try without it
    if (!insertResult) {
      if (matchedProjectId) {
        debug('matched_project_id column may not exist or insert failed, trying without it');
      }
      
      insertSql = `INSERT INTO admin.users_unverified 
        (first_name, last_name, email, password_hash, verification_code, ip_address, user_agent, permission) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'administrator')`;
      
      insertParams = [first_name, last_name, email, password_hash, verification_code, clientIp, userAgent];
      insertResult = await db.executeCommand(insertSql, insertParams);
      
      if (!insertResult) {
        error('Failed to insert into users_unverified table');
        return sendResponse(res, info, 500, false, 'Failed to create user account. Please try again.', null, true);
      }
      
      // Store matched_project_id in a separate way if column doesn't exist
      if (matchedProjectId) {
        debug(`Note: matched_project_id ${matchedProjectId} could not be stored in users_unverified (column may not exist). Will check rules again during verification.`);
      }
    }
    
    // Send verification code via email
    const emailService = require('../middleware/email');
    const emailResult = await emailService.sendHtmlEmail(
      email,
      'RACESIGHT - Email Verification Code',
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">Welcome to RACESIGHT!</h2>
          <p>Hello ${first_name},</p>
          <p>Thank you for registering with RACESIGHT. To complete your registration, please verify your email address using the code below.</p>
          <p style="font-size: 24px; font-weight: bold; color: #0066cc; text-align: center; padding: 20px; background-color: #f0f0f0; border-radius: 5px; margin: 20px 0;">
            Your verification code is: <strong>${verification_code}</strong>
          </p>
          <p>This code will expire in 24 hours.</p>
          <p>If you did not create an account with RACESIGHT, please ignore this email.</p>
          <p style="margin-top: 30px; color: #666; font-size: 12px;">
            Best regards,<br>
            The RACESIGHT Team
          </p>
        </div>
      `,
      `Welcome to RACESIGHT!\n\nHello ${first_name},\n\nThank you for registering. Your verification code is: ${verification_code}\n\nThis code will expire in 24 hours.\n\nIf you did not create an account, please ignore this email.`
    );

    // Log registration verification code with type 'auth' (use shared logger for correct client_ip)
    try {
      await sharedLogMessage(
        clientIp,
        '0',
        'server_app/controllers/auth_jwt.js',
        'auth',
        `Registration verification code sent to ${email}`,
        {
          email: email,
          first_name: first_name,
          last_name: last_name,
          verification_code: verification_code,
          ip_address: clientIp,
          user_agent: userAgent,
          email_sent: emailResult.success
        }
      );
    } catch (logError) {
      error('Failed to log registration verification:', logError);
    }

    if (!emailResult.success) {
      error(`Failed to send verification email to ${email}:`, emailResult.error);
      log(`New unverified user created: Verification code for ${email}: ${verification_code} (email sending failed)`);
    } else {
      log(`Verification code sent via email to ${email}`);
    }

    // Don't include verification_code in response for security
    return sendResponse(res, info, 201, true, `Verification code sent to ${email}`, {
      email: email
    });

  } catch (error) {
    error('Registration error:', error);
    error('Error details:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    
    if (error.code === "23505" || error.message.includes('duplicate key value violates unique constraint "users_email_key"')) {
      return sendResponse(res, info, 409, false, 'An account with this email already exists. Please log in instead.', { redirectTo: '/login' });
    } else {
      return sendResponse(res, info, 500, false, error.message, null, true);
    }
  }
};

// Email Verification
exports.Verify = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'Verify' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(err => err.msg || `${err.path}: ${err.msg}`);
    return sendResponse(res, info, 400, false, errorMessages.join(', '), null);
  }

  const { email, code } = req.body;

  try {
    // Check if user exists in unverified users table
    const db = require('../../shared/database/connection');
    const checkUnverifiedSql = `SELECT * FROM admin.users_unverified WHERE email = $1 AND expires_at > NOW()`;
    const unverifiedUser = await db.getRows(checkUnverifiedSql, [email]);
    
    if (!unverifiedUser || unverifiedUser.length === 0) {
      return sendResponse(res, info, 400, false, 'Verification code has expired or user not found', null);
    }

    const userData = unverifiedUser[0];
    
    // Check if verification code matches
    if (userData.verification_code !== code) {
      // Increment attempts counter
      const updateAttemptsSql = `UPDATE admin.users_unverified SET attempts = attempts + 1 WHERE email = $1`;
      await db.executeCommand(updateAttemptsSql, [email]);
      
      return sendResponse(res, info, 400, false, 'Invalid verification code', null);
    }
    
    // Check if too many attempts (optional security measure)
    if (userData.attempts >= 5) {
      return sendResponse(res, info, 429, false, 'Too many verification attempts. Please request a new code.', null);
    }
    
    // Check if user already exists in main users table
    const { user: userManager } = require('../../shared/auth');
    const existingUser = await userManager.getUserByEmail(email);
    
    if (existingUser) {
      // User already exists - they may have already verified or registered
      return sendResponse(res, info, 409, false, 'An account with this email already exists. Please log in instead.', { redirectTo: '/login' });
    }
    
    // Create user in main users table using your existing schema
    // Generate unique username - start with initials and append number if needed
    let baseUserName = userData.first_name[0] + userData.last_name[0];
    let user_name = baseUserName;
    let newUser = null;
    let attempts = 0;
    const maxAttempts = 100; // Prevent infinite loop
    
    while (!newUser && attempts < maxAttempts) {
      // Check if username already exists
      const checkUsernameSql = `SELECT user_id FROM admin.users WHERE user_name = $1`;
      const existingUsername = await db.getRows(checkUsernameSql, [user_name]);
      
      if (existingUsername && existingUsername.length > 0) {
        // Username already exists, try with a number suffix
        attempts++;
        user_name = baseUserName + attempts;
        debug(`Username ${baseUserName} already exists, trying ${user_name}`);
        continue;
      }
      
      // Username is available, try to insert
      const insertUserSql = `INSERT INTO admin.users 
        (user_name, first_name, last_name, email, password_hash, is_active, is_verified, created_at, updated_at) 
        VALUES ($1, $2, $3, $4, $5, true, true, NOW(), NOW()) 
        RETURNING user_id, user_name, first_name, last_name, email, is_active, is_verified, created_at, updated_at`;
      
      newUser = await db.getRows(insertUserSql, [
        user_name, 
        userData.first_name, 
        userData.last_name, 
        userData.email, 
        userData.password_hash
      ]);
      
      if (newUser && newUser.length > 0) {
        break; // Successfully created user
      }
      
      // If getRows returned null, it might be a database error
      // Check if it's a duplicate username error by checking the error logs
      // For now, try next username
      attempts++;
      if (attempts < maxAttempts) {
        user_name = baseUserName + attempts;
      }
    }
    
    if (!newUser || newUser.length === 0) {
      error('Failed to create user in main users table - could not generate unique username after', attempts, 'attempts');
      return sendResponse(res, info, 500, false, 'Failed to create user account. Please contact support.', null, true);
    }

    // Check for matched_project_id from email rules (stored during registration)
    let matchedProjectId = null;
    try {
      // Try to get matched_project_id from users_unverified
      if (userData.matched_project_id) {
        matchedProjectId = userData.matched_project_id;
        debug(`Found matched_project_id ${matchedProjectId} from users_unverified for ${email}`);
      }
    } catch (err) {
      // Column might not exist, will check rules again below
      debug('matched_project_id column may not exist in users_unverified');
    }
    
    // If no matched_project_id found, try to check email rules again as fallback
    if (!matchedProjectId) {
      try {
        // Query user_rules for allowed_email rules that match this email
        const rulesSql = `SELECT project_id, json FROM admin.user_rules WHERE type = 'allowed_email'`;
        const allRules = await db.getRows(rulesSql, []);
        
        if (allRules && allRules.length > 0) {
          const emailLower = userData.email.toLowerCase();
          
          for (const rule of allRules) {
            try {
              const ruleData = typeof rule.json === 'string' ? JSON.parse(rule.json) : rule.json;
              const ruleEmail = ruleData?.email;
              
              if (ruleEmail) {
                const ruleEmailLower = ruleEmail.toLowerCase();
                
                // Pattern matching: if rule starts with "@", check if email ends with that domain
                if (ruleEmailLower.startsWith('@')) {
                  if (emailLower.endsWith(ruleEmailLower)) {
                    matchedProjectId = rule.project_id;
                    debug(`Email ${email} matched rule pattern ${ruleEmail} for project ${rule.project_id} during verification`);
                    break;
                  }
                } else {
                  // Exact match
                  if (emailLower === ruleEmailLower) {
                    matchedProjectId = rule.project_id;
                    debug(`Email ${email} matched exact rule ${ruleEmail} for project ${rule.project_id} during verification`);
                    break;
                  }
                }
              }
            } catch (ruleError) {
              error(`Error parsing rule JSON for project ${rule.project_id}:`, ruleError);
              // Continue checking other rules
            }
          }
        }
      } catch (ruleCheckError) {
        error('Error checking email rules during verification:', ruleCheckError);
        // Don't block verification if rule check fails
      }
    }
    
    // Check if user is in the user_pending table to determine subscription type
    const checkPendingSql = `SELECT * FROM admin.users_pending WHERE email = $1`;
    const pendingUser = await db.getRows(checkPendingSql, [userData.email]);
    
    // If user has matched_project_id from email rules OR is in users_pending, create "member" subscription; otherwise "free"
    const subscriptionType = (matchedProjectId || (pendingUser && pendingUser.length > 0)) ? 'member' : 'free';
    
    // Create subscription for the new user (same columns as users.updateSubscription — partial INSERTs can fail on some DBs)
    const subscriptionSql = `
      INSERT INTO admin.user_subscriptions (user_id, subscription_type, status, start_date, end_date, auto_renew)
      VALUES ($1, $2, 'active', CURRENT_DATE, (CURRENT_DATE + INTERVAL '1 year')::date, false)
      RETURNING id`;
    const subscriptionRows = await db.getRows(subscriptionSql, [newUser[0].user_id, subscriptionType]);

    if (!subscriptionRows || subscriptionRows.length === 0) {
      error(
        'Failed to create subscription for new user; rolling back user row. user_id=',
        newUser[0].user_id,
        'subscription_type=',
        subscriptionType
      );
      const rollbackSql = `DELETE FROM admin.users WHERE user_id = $1`;
      await db.executeCommand(rollbackSql, [newUser[0].user_id]);
      return sendResponse(
        res,
        info,
        500,
        false,
        'Could not complete account setup. Please try verifying your email again, or contact support if this persists.',
        null,
        true
      );
    }

    log(`Created default '${subscriptionType}' subscription for new user: ${newUser[0].user_id}`);
    
    // If matched_project_id exists, add user to project with "reader" permission
    if (matchedProjectId) {
      try {
        // Validate project exists
        const projectCheckSql = `SELECT project_id FROM admin.projects WHERE project_id = $1`;
        const projectCheck = await db.getRows(projectCheckSql, [matchedProjectId]);
        
        if (projectCheck && projectCheck.length > 0) {
          // Check if permission already exists
          const checkPermissionSql = `SELECT permission FROM admin.user_projects WHERE user_id = $1 AND project_id = $2`;
          const existingPermission = await db.getRows(checkPermissionSql, [newUser[0].user_id, matchedProjectId]);
          
          let permissionResult = false;
          if (existingPermission && existingPermission.length > 0) {
            // Update existing permission
            const updatePermissionSql = `UPDATE admin.user_projects SET permission = $3 WHERE user_id = $1 AND project_id = $2`;
            permissionResult = await db.executeCommand(updatePermissionSql, [newUser[0].user_id, matchedProjectId, 'reader']);
          } else {
            // Insert new permission
            const insertPermissionSql = `INSERT INTO admin.user_projects (user_id, project_id, permission) VALUES ($1, $2, $3)`;
            permissionResult = await db.executeCommand(insertPermissionSql, [newUser[0].user_id, matchedProjectId, 'reader']);
          }
          
          if (permissionResult) {
            log(`Added user ${newUser[0].user_id} to project ${matchedProjectId} with 'reader' permission via email rule`);
          } else {
            error(`Failed to add user ${newUser[0].user_id} to project ${matchedProjectId} with 'reader' permission`);
            // Don't fail verification if permission insertion fails, just log it
          }
        } else {
          error(`Matched project_id ${matchedProjectId} does not exist`);
        }
      } catch (projectError) {
        error(`Error adding user to project ${matchedProjectId}:`, projectError);
        // Don't fail verification if project permission fails, just log it
      }
    }

    // Delete from unverified users table
    const deleteUnverifiedSql = `DELETE FROM admin.users_unverified WHERE email = $1`;
    await db.executeCommand(deleteUnverifiedSql, [email]);
    
    // If user was in users_pending table, transfer their project permissions and remove them
    if (pendingUser && pendingUser.length > 0) {
      // Transfer project permissions from users_pending to user_projects
      for (const pending of pendingUser) {
        // Check if permission already exists
        const checkSql = `SELECT permission FROM admin.user_projects WHERE user_id = $1 AND project_id = $2`;
        const existingPermission = await db.getRows(checkSql, [newUser[0].user_id, pending.project_id]);
        
        let insertResult;
        if (existingPermission && existingPermission.length > 0) {
          // Update existing permission
          const updateSql = `UPDATE admin.user_projects SET permission = $3 WHERE user_id = $1 AND project_id = $2`;
          insertResult = await db.executeCommand(updateSql, [
            newUser[0].user_id, 
            pending.project_id, 
            pending.permission
          ]);
        } else {
          // Insert new permission
          const insertSql = `INSERT INTO admin.user_projects (user_id, project_id, permission) VALUES ($1, $2, $3)`;
          insertResult = await db.executeCommand(insertSql, [
            newUser[0].user_id, 
            pending.project_id, 
            pending.permission
          ]);
        }
        
        if (insertResult) {
          log(`Transferred project permission for user ${email}: project_id=${pending.project_id}, permission=${pending.permission}`);
        } else {
          error(`Failed to transfer project permission for user ${email}: project_id=${pending.project_id}, permission=${pending.permission}`);
        }
      }
      
      // Now remove user from users_pending table
      const deletePendingSql = `DELETE FROM admin.users_pending WHERE email = $1`;
      const deleteResult = await db.executeCommand(deletePendingSql, [email]);
      
      if (deleteResult) {
        log(`Removed user from users_pending table: ${email}`);
      } else {
        error(`Failed to remove user from users_pending table: ${email}`);
      }
    }
    
    // Generate tokens for the new user
    const { jwt } = require('../../shared/auth');
    
    // Get user permissions (fetch from database after transfer)
    const permissions = await userManager.getAllUserPermissions(newUser[0].user_id);
    
    // Return the highest permission level as a single string
    const permissionLevels = ['reader', 'contributor', 'publisher', 'administrator', 'superuser'];
    let highestPermission = 'reader'; // default
    
    permissions.forEach(p => {
      const currentIndex = permissionLevels.indexOf(p.permission);
      const highestIndex = permissionLevels.indexOf(highestPermission);
      if (currentIndex > highestIndex) {
        highestPermission = p.permission;
      }
    });
    
    const permissionsMap = highestPermission;
    
    const tokens = await jwt.generateTokenPair(newUser[0], permissionsMap);
    
    if (!tokens) {
      error('Failed to generate authentication tokens');
      return sendResponse(res, info, 500, false, 'Failed to generate authentication tokens', null, true);
    }

    // Set cookie with access token
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
      domain: process.env.NODE_ENV === "production" ? undefined : undefined // Allow cookies to work with any domain in development
    };

    res.cookie("auth_token", tokens.accessToken, cookieOptions);

    return sendResponse(res, info, 200, true, 'Verification successful!', {
      user: newUser[0],
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn
    }, false);

  } catch (error) {
    error('Verification error:', error.message);
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Refresh Token
exports.RefreshToken = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'RefreshToken' };

  const { refreshToken } = req.body;

  if (!refreshToken) {
    return sendResponse(res, info, 400, false, 'Refresh token required', null);
  }

  try {
    // Refresh access token using shared auth module
    const refreshResult = await authManager.refreshToken(refreshToken);
    
    if (!refreshResult) {
      return sendResponse(res, info, 401, false, 'Invalid refresh token', null);
    }

    // Set new access token cookie
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
      domain: process.env.NODE_ENV === "production" ? undefined : undefined // Allow cookies to work with any domain in development
    };

    res.cookie("auth_token", refreshResult.accessToken, cookieOptions);

    return sendResponse(res, info, 200, true, 'Token refreshed successfully', refreshResult, false);

  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Logout
exports.Logout = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'Logout' };

  try {
    const accessToken = req.cookies?.auth_token || req.headers.authorization?.replace('Bearer ', '');
    const { refreshToken } = req.body;

    if (accessToken) {
      // Logout using shared auth module
      await authManager.logoutUser(accessToken, refreshToken);
    }

    // Clear cookie
    res.clearCookie("auth_token");

    return sendResponse(res, info, 200, true, 'Logout successful', null, false);

  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Password Reset Request
exports.ForgotPassword = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'ForgotPassword' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(err => err.msg || `${err.path}: ${err.msg}`);
    return sendResponse(res, info, 400, false, errorMessages.join(', '), null);
  }

  const { email } = req.body;

  try {
    // Check if user exists in main users table (verified users only)
    const { user: userManager } = require('../../shared/auth');
    const user = await userManager.getUserByEmail(email);
    
    if (!user) {
      return sendResponse(res, info, 404, false, 'User not found', null);
    }

    // Check if user is verified (should always be true for existing users)
    if (!user.is_verified) {
      return sendResponse(res, info, 400, false, 'Account not verified. Please complete registration first.', null);
    }

    // Generate reset code
    const resetCode = Math.floor(1000 + Math.random() * 9000).toString();
    const clientIp = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent') || 'Unknown';
    
    // Update user with reset code and expiration using new password_reset_code field
    const db = require('../../shared/database/connection');
    const sql = `UPDATE admin.users SET 
      password_reset_code = $1, 
      password_reset_expires_at = NOW() + INTERVAL '24 hours',
      password_reset_attempts = 0,
      updated_at = NOW()
      WHERE email = $2`;
    await db.executeCommand(sql, [resetCode, email]);

    // Send reset code via email
    const emailService = require('../middleware/email');
    const emailResult = await emailService.sendHtmlEmail(
      email,
      'RACESIGHT - Password Reset Code',
      `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">Password Reset Request</h2>
          <p>Hello,</p>
          <p>You have requested to reset your password for your RACESIGHT account.</p>
          <p style="font-size: 24px; font-weight: bold; color: #0066cc; text-align: center; padding: 20px; background-color: #f0f0f0; border-radius: 5px; margin: 20px 0;">
            Your verification code is: <strong>${resetCode}</strong>
          </p>
          <p>This code will expire in 24 hours.</p>
          <p>If you did not request this password reset, please ignore this email or contact support if you have concerns.</p>
          <p style="margin-top: 30px; color: #666; font-size: 12px;">
            Best regards,<br>
            The RACESIGHT Team
          </p>
        </div>
      `,
      `Password Reset Request\n\nYour verification code is: ${resetCode}\n\nThis code will expire in 24 hours.\n\nIf you did not request this password reset, please ignore this email.`
    );

    // Log password reset code with type 'auth' (use shared logger for correct client_ip)
    try {
      await sharedLogMessage(
        clientIp,
        user?.user_id ? String(user.user_id) : '0',
        'server_app/controllers/auth_jwt.js',
        'auth',
        `Password reset code sent to ${email}`,
        {
          email: email,
          user_id: user.user_id,
          reset_code: resetCode,
          ip_address: clientIp,
          user_agent: userAgent,
          email_sent: emailResult.success
        }
      );
    } catch (logError) {
      error('Failed to log password reset:', logError);
    }

    if (!emailResult.success) {
      error(`Failed to send password reset email to ${email}:`, emailResult.error);
      // Still log the code for debugging, but don't expose it in the response
      log(`Password reset code for ${email}: ${resetCode} (email sending failed)`);
    } else {
      log(`Password reset code sent via email to ${email}`);
    }

    log(`Reset requested from IP: ${clientIp}, User-Agent: ${userAgent}`);

    // Don't include reset_code in response for security
    return sendResponse(res, info, 200, true, `Password reset code sent to ${email}`, null, false);

  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};

// Password Reset
exports.ResetPassword = async (req, res) => {
  const info = { "auth_token": req.cookies?.auth_token, "location": 'server_app/auth_jwt', "function": 'ResetPassword' };

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(err => err.msg || `${err.path}: ${err.msg}`);
    return sendResponse(res, info, 400, false, errorMessages.join(', '), null);
  }

  const { email, code, newPassword } = req.body;

  try {
    // Import userManager for password hashing
    const { user: userManager } = require('../../shared/auth');
    
    // Validate new password strength - match registration validation (4 out of 5 criteria)
    const passwordErrors = [];
    
    if (newPassword.length < 8) {
      passwordErrors.push('at least 8 characters');
    }
    if (!/[A-Z]/.test(newPassword)) {
      passwordErrors.push('one uppercase letter');
    }
    if (!/[a-z]/.test(newPassword)) {
      passwordErrors.push('one lowercase letter');
    }
    if (!/[0-9]/.test(newPassword)) {
      passwordErrors.push('one number');
    }
    if (!/[!@#$%^&*()_+\-=\[\]{};'':"\\|,.<>\/?]/.test(newPassword)) {
      passwordErrors.push('one special character (!@#$%^&*()_+-=[]{};:"|,.<>?)');
    }
    
    // More lenient validation - require at least 4 out of 5 criteria (allow 1 missing)
    if (passwordErrors.length > 1) {
      // Only show the first 2 missing criteria to avoid overwhelming the user
      const shownErrors = passwordErrors.slice(0, 2);
      const errorMessage = `Password must contain ${shownErrors.join(', ')}. Please update your password and try again.`;
      debug('Password validation failed:', passwordErrors);
      return sendResponse(res, info, 400, false, errorMessage, null);
    }

    // Verify reset code with expiration check using new password_reset_code field
    const db = require('../../shared/database/connection');
    const sql = `SELECT user_id, password_reset_attempts FROM admin.users 
      WHERE email = $1 AND password_reset_code = $2 AND password_reset_expires_at > NOW()`;
    const result = await db.getRows(sql, [email, code]);
    
    if (!result || result.length === 0) {
      return sendResponse(res, info, 400, false, 'Invalid or expired reset code', null);
    }

    const userId = result[0].user_id;
    const attempts = result[0].password_reset_attempts || 0;

    // Check if too many attempts
    if (attempts >= 5) {
      return sendResponse(res, info, 429, false, 'Too many reset attempts. Please request a new code.', null);
    }

    // Hash new password
    const passwordHash = await userManager.hashPassword(newPassword);

    // Update password and clear reset code
    const updateSql = `UPDATE admin.users SET 
      password_hash = $1, 
      password_reset_code = NULL,
      password_reset_expires_at = NULL,
      password_reset_attempts = 0,
      updated_at = NOW()
      WHERE user_id = $2`;
    await db.executeCommand(updateSql, [passwordHash, userId]);

    // Get updated user data
    const userSql = `SELECT user_id, user_name, first_name, last_name, email, is_verified, is_active FROM admin.users WHERE user_id = $1`;
    const userResult = await db.getRows(userSql, [userId]);
    
    if (!userResult || userResult.length === 0) {
      return sendResponse(res, info, 500, false, 'Failed to retrieve user data', null, true);
    }

    const userData = userResult[0];

    // Generate tokens for automatic login
    const { jwt } = require('../../shared/auth');
    
    // Get user permissions
    const permissions = await userManager.getAllUserPermissions(userId);
    
    // Return the highest permission level as a single string
    const permissionLevels = ['reader', 'contributor', 'publisher', 'administrator', 'superuser'];
    let highestPermission = 'reader'; // default
    
    permissions.forEach(p => {
      const currentIndex = permissionLevels.indexOf(p.permission);
      const highestIndex = permissionLevels.indexOf(highestPermission);
      if (currentIndex > highestIndex) {
        highestPermission = p.permission;
      }
    });
    
    const permissionsMap = highestPermission;
    const tokens = await jwt.generateTokenPair(userData, permissionsMap);

    if (!tokens) {
      error('Failed to generate authentication tokens');
      return sendResponse(res, info, 500, false, 'Failed to generate authentication tokens', null, true);
    }

    // Set cookie with access token
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 1 day
      domain: process.env.NODE_ENV === "production" ? undefined : undefined
    };

    res.cookie("auth_token", tokens.accessToken, cookieOptions);

    // Check if user is super user
    const dbMiddleware = require('../middleware/db');
    const superUserId = dbMiddleware.GetSuperUser();
    const isSuperUser = userData.user_id && superUserId && userData.user_id.toString() === superUserId.toString();

    return sendResponse(res, info, 200, true, 'Password reset successfully', {
      user: {
        user_id: userData.user_id,
        user_name: userData.user_name,
        first_name: userData.first_name,
        last_name: userData.last_name,
        email: userData.email,
        is_verified: userData.is_verified,
        is_super_user: isSuperUser
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn
    }, false);

  } catch (error) {
    return sendResponse(res, info, 500, false, error.message, null, true);
  }
};
