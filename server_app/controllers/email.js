const emailService = require('../middleware/email');
const { sendResponse } = require('../middleware/helpers');
const { log, error: logError, debug } = require('../../shared/utils/console');
const db = require('../middleware/db');

/**
 * Send an email
 * @route POST /api/email/send
 */
exports.sendEmail = async (req, res) => {
  const info = {
    "auth_token": req.cookies?.auth_token,
    "location": 'server_app/email',
    "function": 'sendEmail'
  };

  try {
    const { to, subject, text, html, cc, bcc, replyTo, attachments } = req.body;

    // Validate required fields
    if (!to) {
      return sendResponse(res, info, 400, false, 'Recipient email address (to) is required', null);
    }

    if (!subject) {
      return sendResponse(res, info, 400, false, 'Email subject is required', null);
    }

    if (!text && !html) {
      return sendResponse(res, info, 400, false, 'Email body (text or html) is required', null);
    }

    const result = await emailService.sendEmail({
      to,
      subject,
      text,
      html,
      cc,
      bcc,
      replyTo,
      attachments
    });

    if (result.success) {
      return sendResponse(res, info, 200, true, result.message, {
        messageId: result.messageId,
        response: result.response
      });
    } else {
      return sendResponse(res, info, 500, false, result.error || 'Failed to send email', null);
    }
  } catch (error) {
    logError('[Email Controller] Error in sendEmail:', error);
    return sendResponse(res, info, 500, false, error.message || 'Internal server error', null, true);
  }
};

/**
 * Verify email service connection
 * @route GET /api/email/verify
 */
exports.verifyEmailService = async (req, res) => {
  const info = {
    "auth_token": req.cookies?.auth_token,
    "location": 'server_app/email',
    "function": 'verifyEmailService'
  };

  try {
    const isConnected = await emailService.verifyConnection();
    
    if (isConnected) {
      return sendResponse(res, info, 200, true, 'Email service is configured and connected', {
        connected: true
      });
    } else {
      return sendResponse(res, info, 503, false, 'Email service is not configured or connection failed', {
        connected: false
      });
    }
  } catch (error) {
    logError('[Email Controller] Error in verifyEmailService:', error);
    return sendResponse(res, info, 500, false, error.message || 'Internal server error', null, true);
  }
};

/**
 * Send process completion notification email
 * @route POST /api/email/process-completion
 * This endpoint is called by the Python server when a process completes and SSE connection is not active
 */
exports.sendProcessCompletionEmail = async (req, res) => {
  const info = {
    "auth_token": req.headers?.authorization || req.cookies?.auth_token,
    "location": 'server_app/email',
    "function": 'sendProcessCompletionEmail'
  };

  try {
    const { user_id, process_id, script_name, class_name, status, message, return_code, error_lines } = req.body;

    // Validate required fields
    if (!user_id) {
      return sendResponse(res, info, 400, false, 'user_id is required', null);
    }

    if (!script_name) {
      return sendResponse(res, info, 400, false, 'script_name is required', null);
    }

    // Get user email from database
    const sql = "SELECT email, first_name, last_name FROM admin.users WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1";
    const userRows = await db.GetRows(sql, [user_id]);

    if (!userRows || userRows.length === 0) {
      logError(`[Email Controller] User not found: ${user_id}`);
      return sendResponse(res, info, 404, false, 'User not found', null);
    }

    const userEmail = userRows[0].email;
    const userName = userRows[0].first_name || 'User';

    if (!userEmail) {
      logError(`[Email Controller] User ${user_id} has no email address`);
      return sendResponse(res, info, 400, false, 'User has no email address', null);
    }

    // Determine status and message
    const isSuccess = status === 'complete' || status === 'success' || (return_code !== undefined && return_code === 0);
    const statusText = isSuccess ? 'completed successfully' : 'failed';
    const subject = `Script Execution ${statusText}: ${script_name}`;
    
    // Build email content
    const scriptDisplayName = script_name.endsWith('.py') ? script_name : `${script_name}.py`;
    const classNameText = class_name ? ` (${class_name})` : '';
    const errorText = error_lines && error_lines.length > 0 
      ? `\n\nErrors:\n${error_lines.slice(0, 5).join('\n')}${error_lines.length > 5 ? `\n... and ${error_lines.length - 5} more errors` : ''}`
      : '';

    const textContent = `Hello ${userName},

Your script execution has ${statusText}.

Script: ${scriptDisplayName}${classNameText}
Process ID: ${process_id}
Status: ${status || (isSuccess ? 'Success' : 'Failed')}
${return_code !== undefined ? `Return Code: ${return_code}` : ''}${errorText}

${isSuccess 
  ? 'The script completed successfully. You can now view the results in the application.'
  : 'The script execution encountered errors. Please check the application for more details.'
}

Thank you,
RACESIGHT Team`;

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <p>Hello ${userName},</p>
        <p>Your script execution has <strong>${statusText}</strong>.</p>
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Script:</strong> ${scriptDisplayName}${classNameText}</p>
          <p><strong>Process ID:</strong> ${process_id}</p>
          <p><strong>Status:</strong> ${status || (isSuccess ? 'Success' : 'Failed')}</p>
          ${return_code !== undefined ? `<p><strong>Return Code:</strong> ${return_code}</p>` : ''}
          ${errorText ? `<div style="margin-top: 10px; padding: 10px; background-color: #fee; border-left: 3px solid #f00;"><strong>Errors:</strong><pre style="white-space: pre-wrap; font-size: 12px;">${error_lines.slice(0, 5).join('\n')}${error_lines.length > 5 ? `\n... and ${error_lines.length - 5} more errors` : ''}</pre></div>` : ''}
        </div>
        <p>${isSuccess 
          ? 'The script completed successfully. You can now view the results in the application.'
          : 'The script execution encountered errors. Please check the application for more details.'
        }</p>
        <p>Thank you,<br>RACESIGHT Team</p>
      </div>
    `;

    // Send email
    const result = await emailService.sendEmail({
      to: userEmail,
      subject: subject,
      text: textContent,
      html: htmlContent
    });

    if (result.success) {
      log(`[Email Controller] Process completion email sent to ${userEmail} for process ${process_id}`);
      return sendResponse(res, info, 200, true, 'Process completion email sent successfully', {
        messageId: result.messageId,
        email: userEmail
      });
    } else {
      logError(`[Email Controller] Failed to send process completion email: ${result.error}`);
      return sendResponse(res, info, 500, false, result.error || 'Failed to send email', null);
    }
  } catch (error) {
    logError('[Email Controller] Error in sendProcessCompletionEmail:', error);
    return sendResponse(res, info, 500, false, error.message || 'Internal server error', null, true);
  }
};
