const nodemailer = require("nodemailer");

let transporter;

const getTransporter = () => {
  if (transporter) return transporter;

  const { APP_EMAIL, APP_PASSWORD } = process.env;
  if (!APP_EMAIL || !APP_PASSWORD) {
    throw new Error("APP_EMAIL and APP_PASSWORD must be set in the environment");
  }

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: APP_EMAIL,
      pass: APP_PASSWORD,
    },
  });

  return transporter;
};

const sendVerificationCodeEmail = async ({ to, verificationCode }) => {
  const mailTransporter = getTransporter();
  const from = process.env.APP_EMAIL;

  const text = [
    "Here is your verification code for PointGod. This code expires in 15 minutes.",
    "",
    verificationCode,
    "",
    "If you did not request this code, please update your password.",
  ].join("\n");

  const html = `
    <p>Here is your verification code for PointGod. This code expires in 15 minutes.</p>
    <p style="font-size: 24px; font-weight: bold; letter-spacing: 4px;">${verificationCode}</p>
    <p>If you did not request this code, please update your password.</p>
  `;

  await mailTransporter.sendMail({
    from: `PointGod <${from}>`,
    to,
    subject: "Your PointGod verification code",
    text,
    html,
  });
};

module.exports = { getTransporter, sendVerificationCodeEmail };
