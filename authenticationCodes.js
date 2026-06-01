const { sendVerificationCodeEmail } = require("./emailTransporter");

const COLLECTION = "authentication_codes";
const CODE_TTL_MS = 15 * 60 * 1000;

const generateVerificationCode = () =>
  String(Math.floor(100000 + Math.random() * 900000));

const deleteExistingCodesForUser = async (db, user_id) => {
  await db.collection(COLLECTION).deleteMany({ user_id });
};

const createAndEmailVerificationCode = async (db, user) => {
  const verification_code = generateVerificationCode();
  const expiration_date = new Date(Date.now() + CODE_TTL_MS);

  await deleteExistingCodesForUser(db, user.user_id);

  const now = new Date();
  await db.collection(COLLECTION).insertOne({
    user_id: user.user_id,
    verification_code,
    expiration_date,
    created_at: now,
    updated_at: now,
  });

  await sendVerificationCodeEmail({
    to: user.email,
    verificationCode: verification_code,
  });
};

const verifyCodeForUser = async (db, { user_id, verification_code }) => {
  const record = await db.collection(COLLECTION).findOne({ user_id });

  if (!record) {
    const error = new Error("No verification code found. Please sign in again.");
    error.code = "CODE_NOT_FOUND";
    throw error;
  }

  if (new Date() > new Date(record.expiration_date)) {
    await deleteExistingCodesForUser(db, user_id);
    const error = new Error("Verification code has expired. Please sign in again.");
    error.code = "CODE_EXPIRED";
    throw error;
  }

  if (String(record.verification_code) !== String(verification_code).trim()) {
    const error = new Error("Verification code is incorrect.");
    error.code = "CODE_INVALID";
    throw error;
  }

  await deleteExistingCodesForUser(db, user_id);
  return true;
};

const stripPassword = (user) => {
  if (!user) return user;
  const { password: _, ...rest } = user;
  return rest;
};

module.exports = {
  createAndEmailVerificationCode,
  verifyCodeForUser,
  stripPassword,
};
