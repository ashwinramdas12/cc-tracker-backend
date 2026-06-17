const webpush = require('web-push');

let configured = false;

const ensureConfigured = () => {
  if (configured) return;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_EMAIL) {
    throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_EMAIL must be set in .env');
  }
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
};

/**
 * Send a web push notification to a stored push subscription.
 * @param {object} subscription - The PushSubscription JSON stored on the user doc
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 * @param {object} [data] - Optional extra data forwarded to the service worker's notificationclick handler
 */
const sendPushNotification = async ({ subscription, title, body, data = {} }) => {
  if (!subscription?.endpoint) return;
  ensureConfigured();
  const payload = JSON.stringify({ title, body, data });
  try {
    await webpush.sendNotification(subscription, payload);
  } catch (err) {
    // 410 Gone means the subscription is no longer valid (user revoked permission)
    if (err.statusCode === 410) {
      console.warn('Push subscription expired (410). It should be removed from the user doc.');
    } else {
      throw err;
    }
  }
};

module.exports = { sendPushNotification };
