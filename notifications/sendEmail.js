const { getTransporter } = require('../emailTransporter');

/**
 * Send a generic email.
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject line
 * @param {string} body - HTML body of the email (plain text fallback is stripped tags)
 */
const sendEmail = async ({ to, subject, body }) => {
  const transporter = getTransporter();
  const from = process.env.APP_EMAIL;

  const text = body.replace(/<[^>]+>/g, '').trim();

  await transporter.sendMail({
    from: `PointGod <${from}>`,
    to,
    subject,
    text,
    html: body,
  });
};

module.exports = { sendEmail };
