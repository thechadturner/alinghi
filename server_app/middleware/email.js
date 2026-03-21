const nodemailer = require('nodemailer');
const config = require('./config');
const { log, error: logError, debug } = require('../../shared/utils/console');

/**
 * Email service for sending emails via Hostinger SMTP
 * Uses EMAIL_FROM and EMAIL_PASSWORD from environment variables
 */

// Create reusable transporter
let transporter = null;

/**
 * Initialize email transporter
 * @returns {Object} Nodemailer transporter instance
 */
function getTransporter() {
  if (transporter) {
    return transporter;
  }

  const emailAddress = config.EMAIL_FROM;
  const emailPassword = config.EMAIL_PASSWORD;
  const smtpHost = config.EMAIL_SMTP_HOST || 'smtp.hostinger.com';
  const smtpPort = parseInt(config.EMAIL_SMTP_PORT || '465', 10);
  
  // Hostinger: Port 465 uses SSL, Port 587 uses TLS/STARTTLS
  // secure: true for SSL (port 465), false for STARTTLS (port 587)
  const smtpSecure = smtpPort === 465;

  if (!emailAddress || !emailPassword) {
    logError('[Email] EMAIL_ADDRESS or EMAIL_PASSWORD not configured');
    return null;
  }

  try {
    // Configure transporter based on Hostinger SMTP settings
    const transporterConfig = {
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure, // true for SSL (465), false for STARTTLS (587)
      auth: {
        user: emailAddress,
        pass: emailPassword,
      }
    };

    // For port 587 (TLS/STARTTLS), add TLS configuration
    if (smtpPort === 587) {
      transporterConfig.requireTLS = true;
      transporterConfig.tls = {
        // Do not fail on invalid certs (some servers use self-signed certs)
        rejectUnauthorized: false,
        ciphers: 'SSLv3'
      };
    } else if (smtpPort === 465) {
      // For port 465 (SSL), ensure secure connection
      transporterConfig.tls = {
        rejectUnauthorized: false
      };
    }

    transporter = nodemailer.createTransport(transporterConfig);

    debug(`[Email] Transporter initialized: ${smtpHost}:${smtpPort} (secure: ${smtpSecure})`);
    return transporter;
  } catch (err) {
    logError('[Email] Failed to create transporter:', err);
    return null;
  }
}

/**
 * Verify email transporter connection
 * @returns {Promise<boolean>} True if connection is valid
 */
async function verifyConnection() {
  const transport = getTransporter();
  if (!transport) {
    return false;
  }

  try {
    await transport.verify();
    debug('[Email] SMTP connection verified');
    return true;
  } catch (err) {
    logError('[Email] SMTP connection verification failed:', err);
    return false;
  }
}

/**
 * Send an email
 * @param {Object} options - Email options
 * @param {string|string[]} options.to - Recipient email address(es)
 * @param {string} options.subject - Email subject
 * @param {string} options.text - Plain text body
 * @param {string} options.html - HTML body (optional)
 * @param {string|string[]} options.cc - CC recipients (optional)
 * @param {string|string[]} options.bcc - BCC recipients (optional)
 * @param {string} options.replyTo - Reply-to address (optional)
 * @param {Array} options.attachments - Email attachments (optional)
 * @returns {Promise<Object>} Send result with success status and message
 */
async function sendEmail(options) {
  const transport = getTransporter();
  if (!transport) {
    return {
      success: false,
      error: 'Email service not configured. Please set EMAIL_FROM and EMAIL_PASSWORD environment variables.'
    };
  }

  const defaultFrom = config.EMAIL_FROM || 'support@racesight.cloud';

  // Validate required fields
  if (!options.to) {
    return {
      success: false,
      error: 'Recipient email address (to) is required'
    };
  }

  if (!options.subject) {
    return {
      success: false,
      error: 'Email subject is required'
    };
  }

  if (!options.text && !options.html) {
    return {
      success: false,
      error: 'Email body (text or html) is required'
    };
  }

  try {
    const mailOptions = {
      from: options.from || defaultFrom,
      to: Array.isArray(options.to) ? options.to.join(', ') : options.to,
      subject: options.subject,
      text: options.text,
      html: options.html || options.text, // Use text as fallback for HTML
      ...(options.cc && { cc: Array.isArray(options.cc) ? options.cc.join(', ') : options.cc }),
      ...(options.bcc && { bcc: Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc }),
      ...(options.replyTo && { replyTo: options.replyTo }),
      ...(options.attachments && { attachments: options.attachments })
    };

    debug(`[Email] Sending email to: ${mailOptions.to}, subject: ${mailOptions.subject}`);
    
    const info = await transport.sendMail(mailOptions);
    
    log(`[Email] Email sent successfully. MessageId: ${info.messageId}`);
    
    return {
      success: true,
      messageId: info.messageId,
      response: info.response,
      message: 'Email sent successfully'
    };
  } catch (err) {
    logError('[Email] Failed to send email:', err);
    return {
      success: false,
      error: err.message || 'Failed to send email'
    };
  }
}

/**
 * Send a simple text email
 * @param {string|string[]} to - Recipient email address(es)
 * @param {string} subject - Email subject
 * @param {string} text - Email body text
 * @returns {Promise<Object>} Send result
 */
async function sendSimpleEmail(to, subject, text) {
  return sendEmail({ to, subject, text });
}

/**
 * Send an HTML email
 * @param {string|string[]} to - Recipient email address(es)
 * @param {string} subject - Email subject
 * @param {string} html - Email body HTML
 * @param {string} text - Plain text fallback (optional)
 * @returns {Promise<Object>} Send result
 */
async function sendHtmlEmail(to, subject, html, text = null) {
  return sendEmail({ to, subject, html, text });
}

module.exports = {
  getTransporter,
  verifyConnection,
  sendEmail,
  sendSimpleEmail,
  sendHtmlEmail
};
