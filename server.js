require("dotenv").config();

const express = require("express");
const cors = require("cors");
const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
} = require("plaid");

const bcrypt = require("bcryptjs");
const { accountsDetailed } = require("./accountsDetailed");
const { connectToMongo } = require("./connectToMongo");
const fuzzySearchCreditCards = require("./fuzzySearchCreditCards");
const { searchCards } = require("./searchCards");
const { searchRewards } = require("./searchRewards");
const { searchSpendCategories } = require("./searchSpendCategories");
const { searchTransferPartners } = require("./searchTransferPartners");
const { searchIssuers } = require("./searchIssuers");
const {
  createAndEmailVerificationCode,
  verifyCodeForUser,
  stripPassword,
} = require("./authenticationCodes");
const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  "https://point-god-frontend-c9db2c986805.herokuapp.com",
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  })
);
app.use(express.json());

/* -------------------------------------------------------------------------- */
/*  Mongo                                                                     */
/* -------------------------------------------------------------------------- */

const mongoOperation = async ({
  operation,
  collection,
  payload,
  filter,
  projection,
  options,
  aggregation,
}) => {
  const mongo = await connectToMongo();
  const db = mongo.db(process.env.DATABASE_NAME);
  let result;

  if (operation === "insertOne") {
    const now = new Date();
    result = await db.collection(collection).insertOne({
      ...payload,
      created_at: now,
      updated_at: now
    });
  }
  if (operation === "findOne") {
    result = await db.collection(collection).findOne(filter, projection, options);
  }
  if (operation === "countDocuments") {
    result = await db.collection(collection).countDocuments(filter, options);
  }
  if (operation === "updateOne") {
    if (payload.last_login) {
      payload.last_login = new Date(payload.last_login);
    }
    const updatePayload = { $set: { ...payload, updated_at: new Date() } };
    result = await db.collection(collection).updateOne(filter, updatePayload, options);
  }
  if (operation === "updateMany") {
    const updatePayload = { $set: { ...payload, updated_at: new Date() } };
    result = await db.collection(collection).updateMany(filter, updatePayload, options);
  }
  if (operation === "find") {
    if (options && options.sort) {
      result = await db
        .collection(collection)
        .find(filter, projection, options)
        .sort(options.sort)
        .toArray();
    } else {
      result = await db.collection(collection).find(filter, projection).toArray();
    }
  }
  if (operation === "deleteOne") {
    result = await db.collection(collection).deleteOne(filter);
  }
  if (operation === "deleteMany") {
    result = await db.collection(collection).deleteMany(filter);
  }
  if (operation === "aggregate") {
    result = await db.collection(collection).aggregate(aggregation).toArray();
  }
  return result;
};

// Function to generate random locationId
function randomStringGenerator(length) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/*  Plaid                                                                     */
/* -------------------------------------------------------------------------- */

const plaidEnv = process.env.PLAID_ENV || "sandbox";
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
      "Plaid-Version": "2020-09-14",
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

const plaidProducts = (process.env.PLAID_PRODUCTS || "transactions")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => Products[p.charAt(0).toUpperCase() + p.slice(1)] || p);

const plaidCountryCodes = (process.env.PLAID_COUNTRY_CODES || "US")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean)
  .map((c) => CountryCode[c] || c);

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toIsoDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

/** Start of UTC day as ISO string for comparing stored authorized_datetime values. */
const toStartOfDayIso = (yyyyMmDd) => `${yyyyMmDd}T00:00:00.000Z`;

/** Exclusive UTC end bound (start of day after yyyyMmDd) for authorized_datetime string range. */
const toExclusiveEndIso = (yyyyMmDd) => {
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
};

const transactionsSyncCount = 500;

const persistPlaidTransactionAdds = async (db, txs, user_id, plaid_item_id, { initialSync = false, cutoffDate = null } = {}) => {
  const collection = db.collection("transactions");
  let count = 0;
  for (const tx of txs) {
    if (cutoffDate) {
      const txDate = new Date(tx.authorized_datetime || tx.date);
      if (txDate < cutoffDate) continue;
    }
    delete tx.unofficial_currency_code
    delete tx.counterparties
    delete tx.payment_meta
    delete tx.location
    delete tx.pending_transaction_id
    delete tx.personal_finance_category_icon_url
    await collection.updateOne(
      { user_id, transaction_id: tx.transaction_id },
      {
        $set: { ...tx, user_id, plaid_item_id, update_from_plaid: true, ...(initialSync ? { initial_sync: true } : {}) },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    count++;
  }
  return count;
};

const persistPlaidTransactionModified = async (db, txs, user_id, plaid_item_id) => {
  const collection = db.collection("transactions");
  let count = 0;
  for (const tx of txs) {
    const updateResult = await collection.updateOne(
      { user_id, transaction_id: tx.transaction_id },
      {
        $set: { ...tx, user_id, plaid_item_id, updatedAt: new Date(), update_from_plaid: true, type:"modified" },
      }
    );
    if (updateResult.matchedCount === 0) {
      await collection.updateOne(
        { user_id, transaction_id: tx.transaction_id },
        {
          $set: { ...tx, user_id, plaid_item_id, update_from_plaid: true },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true }
      );
    }
    count++;
  }
  return count;
};

const persistPlaidTransactionRemoved = async (db, removed, user_id) => {
  const collection = db.collection("transactions");
  if (!removed.length) return 0;
  const removedIds = removed.map((r) => r.transaction_id);
  const deleteResult = await collection.deleteMany({
    user_id,
    transaction_id: { $in: removedIds },
  });
  return deleteResult.deletedCount;
};

const syncTransactionsForItem = async (webhook_code, item, user_id, { initialSync = false, maxMonths = null } = {}) => {
  const mongo = await connectToMongo();
  const db = mongo.db(process.env.DATABASE_NAME);

  const cutoffDate = maxMonths
    ? new Date(Date.now() - maxMonths * 30 * 24 * 60 * 60 * 1000)
    : null;

  const stats = { added: 0, modified: 0, removed: 0 };

  // stableCursor is the cursor we started this sync session with.
  // If Plaid returns TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION we revert to it.
  const stableCursor =
    item.transactions_cursor && String(item.transactions_cursor).length > 0
      ? item.transactions_cursor
      : undefined;
  let cursor = stableCursor;

  while (true) {
    let data;
    try {
      const options = {
        include_original_description: true,
      };
      if (maxMonths) {
        options.days_requested = maxMonths * 30;
      }
      const plaidResponse = await plaidClient.transactionsSync({
        access_token: item.access_token,
        cursor,
        count: transactionsSyncCount,
        options: options,
      });
      
      data = plaidResponse.data;
    } catch (err) {
      const errCode = err?.response?.data?.error_code;
      if (errCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
        // Plaid mutated data mid-pagination — restart from the stable cursor
        cursor = stableCursor;
        stats.added = 0;
        stats.modified = 0;
        stats.removed = 0;
        continue;
      }
      throw err;
    }

    stats.removed += await persistPlaidTransactionRemoved(db, data.removed || [], user_id);
    stats.modified += await persistPlaidTransactionModified(
      db,
      data.modified || [],
      user_id,
      item.plaid_item_id
    );
    stats.added += await persistPlaidTransactionAdds(
      db,
      data.added || [],
      user_id,
      item.plaid_item_id,
      { initialSync, cutoffDate }
    );

    const oneAccount = await mongoOperation({
      operation: "findOne",
      collection: "accounts",
      filter: { plaid_item_id: item.plaid_item_id },
    });
    if(oneAccount.loading_transactions && webhook_code === "SYNC_UPDATES_AVAILABLE"){
      // Determine opened_date and next_annual_fee_date
      const accounts = await mongoOperation({
        operation: "find",
        collection: "accounts",
        filter: { plaid_item_id: item.plaid_item_id },
      });
      let openedDate = null;
      let nextAnnualFeeDate = null;
      const transactionsByAccountId = [...data.added, ...data.modified].reduce((acc, tx) => {
        (acc[tx.account_id] ??= []).push(tx);
        return acc;
      }, {});

      for (const accountId in transactionsByAccountId) {
        const account = accounts.find(account => account.account_id === accountId);
        const transactions = transactionsByAccountId[accountId];
        const card = await mongoOperation({
          operation: "findOne",
          collection: "cards",
          filter: { card_id: account?.card_id },
        });

        if (card && card.annual_fee && card.annual_fee > 0) {
            const annualFeeDescription = card.annual_fee_statement_description;
            const annualFeeTx = transactions.filter(tx => {
                const name = (tx.name || tx.original_description || '').toLowerCase();
                return name.includes(annualFeeDescription) && tx.amount > 0;
            })
            .sort((a, b) => new Date(a.authorized_datetime) - new Date(b.authorized_datetime))[0];

            if (annualFeeTx) {
                const feeDate = new Date(annualFeeTx.authorized_datetime || annualFeeTx.date);
                feeDate.setFullYear(feeDate.getFullYear() - 1);
                openedDate = feeDate;
                const next = new Date(feeDate);
                next.setFullYear(next.getFullYear() + 1);
                nextAnnualFeeDate = next;
            }
        }

        // Fall back to oldest transaction date if no annual fee transaction found
        if (!openedDate) {
            const sorted = [...transactions].sort((a, b) => {
                const da = new Date(a.authorized_datetime || a.date);
                const db = new Date(b.authorized_datetime || b.date);
                return da - db;
            });
            const oldestDate = new Date(sorted[0].authorized_datetime || sorted[0].date);
            const twelveMonthsAgo = new Date();
            twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

            if (oldestDate > twelveMonthsAgo) {
                openedDate = oldestDate;
                if (card && card.annual_fee && card.annual_fee > 0) {
                    const next = new Date(oldestDate);
                    next.setFullYear(next.getFullYear() + 1);
                    nextAnnualFeeDate = next;
                }
            }
        }
        const updatePayload = {};
        if (openedDate) updatePayload.opened_date = openedDate;
        if (nextAnnualFeeDate) updatePayload.next_annual_fee_date = nextAnnualFeeDate;
        if (Object.keys(updatePayload).length > 0) {
          await mongoOperation({
            operation: "updateOne",
            collection: "accounts",
            filter: { account_id: accountId },
            payload: updatePayload,
          });
        }
      }
    }
    console.log("added: ", stats.added);
    console.log("modified: ", stats.modified);
    console.log("removed: ", stats.removed);
    cursor = data.next_cursor;

    if(webhook_code === "SYNC_UPDATES_AVAILABLE"){
      await mongoOperation({
        operation: "updateMany",
        collection: "accounts",
        filter: { plaid_item_id: item.plaid_item_id },
        payload: { loading_transactions: false },
      });
    }

    if (!data.has_more) {
      await mongoOperation({
        operation: "updateOne",
        collection: "plaid_items",
        filter: { plaid_item_id: item.plaid_item_id },
        payload: { transactions_cursor: cursor || "" },
      });
      break;
    }
  }

  return stats;
};

/* -------------------------------------------------------------------------- */
/*  Auth                                                                      */
/* -------------------------------------------------------------------------- */

const expectedClientId = process.env.CC_TRACKER_CLIENT_ID || "CC_TRACKER";

const authMiddleware = (req, res, next) => {
  const clientId = req.header("x-client-id");
  const apiKey = req.header("x-api-key");

  if (!process.env.CC_TRACKER_API_KEY) {
    return res.status(500).json({ error: "Server missing CC_TRACKER_API_KEY" });
  }
  if (clientId !== expectedClientId || apiKey !== process.env.CC_TRACKER_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
};

/* -------------------------------------------------------------------------- */
/*  Public routes                                                             */
/* -------------------------------------------------------------------------- */

app.get("/health", (req, res) => {
  res.json({ ok: true, env: plaidEnv });
});

/* -------------------------------------------------------------------------- */
/*  Protected routes                                                          */
/* -------------------------------------------------------------------------- */

const api = express.Router();
api.use(authMiddleware);

/* ---------- Users ---------- */

// POST /users  { user_id, email, name? }  — user_id is your generated string, stored as _id
api.post(
  "/create-user",
  wrap(async (req, res) => {
    const { email, password, first_name, last_name } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required", code: "MISSING_EMAIL" });
    if (!password) return res.status(400).json({ error: "password is required", code: "MISSING_PASSWORD" });
    if (!first_name) return res.status(400).json({ error: "first_name is required", code: "MISSING_FIRST_NAME" });
    if (!last_name) return res.status(400).json({ error: "last_name is required", code: "MISSING_LAST_NAME" });

    const existingEmail = await mongoOperation({
      operation: "findOne",
      collection: "users",
      filter: { email },
    });
    if (existingEmail) {
      return res.status(409).json({ error: "email already in use", code: "EMAIL_ALREADY_IN_USE" });
    }

    const user_id = randomStringGenerator(16);

    await mongoOperation({
      operation: "insertOne",
      collection: "users",
      payload: { 
        user_id, 
        email, 
        password, 
        first_name, 
        last_name,
        last_login: new Date(),
      },
    });

    const user = await mongoOperation({
      operation: "findOne",
      collection: "users",
      filter: { user_id },
    });
    return res.status(201).json(stripPassword(user));
  })
);

/* ---------- Authentication (MFA) ---------- */

api.post(
  "/auth/login-mfa",
  wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const user = await mongoOperation({
      operation: "findOne",
      collection: "users",
      filter: { email: email.toLowerCase() },
    });

    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: "Invalid password" });
    }

    const mongo = await connectToMongo();
    const db = mongo.db(process.env.DATABASE_NAME);
    await createAndEmailVerificationCode(db, user);

    return res.json(stripPassword(user));
  })
);

api.post(
  "/auth/send-verification-code",
  wrap(async (req, res) => {
    const { user_id } = req.body || {};
    if (!user_id) {
      return res.status(400).json({ error: "user_id is required" });
    }

    const user = await mongoOperation({
      operation: "findOne",
      collection: "users",
      filter: { user_id },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const mongo = await connectToMongo();
    const db = mongo.db(process.env.DATABASE_NAME);
    await createAndEmailVerificationCode(db, user);

    return res.json({ success: true });
  })
);

api.post(
  "/auth/verify-code",
  wrap(async (req, res) => {
    const { user_id, verification_code } = req.body || {};
    if (!user_id || !verification_code) {
      return res.status(400).json({ error: "user_id and verification_code are required" });
    }

    const user = await mongoOperation({
      operation: "findOne",
      collection: "users",
      filter: { user_id },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const mongo = await connectToMongo();
    const db = mongo.db(process.env.DATABASE_NAME);
    await verifyCodeForUser(db, { user_id, verification_code });

    const last_login = new Date();
    await mongoOperation({
      operation: "updateOne",
      collection: "users",
      filter: { user_id },
      payload: { last_login },
    });

    return res.json(stripPassword({ ...user, last_login }));
  })
);

api.post(
  "/auth/update-password",
  wrap(async (req, res) => {
    const { user_id, password, verification_code } = req.body || {};
    if (!user_id || !password || !verification_code) {
      return res.status(400).json({
        error: "user_id, password, and verification_code are required",
      });
    }

    const user = await mongoOperation({
      operation: "findOne",
      collection: "users",
      filter: { user_id },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const mongo = await connectToMongo();
    const db = mongo.db(process.env.DATABASE_NAME);
    await verifyCodeForUser(db, { user_id, verification_code });

    await mongoOperation({
      operation: "updateOne",
      collection: "users",
      filter: { user_id },
      payload: { password },
    });

    return res.json({ success: true });
  })
);

/* ---------- Plaid: create link token ---------- */

// POST /plaid/link-token  { user_id }
api.post(
  "/plaid/link-token",
  wrap(async (req, res) => {
    const { user_id } = req.body || {};
    if (!user_id || typeof user_id !== "string") {
      return res.status(400).json({ error: "user_id is required" });
    }

    const user = await mongoOperation({
      operation: "findOne",
      collection: "users",
      filter: { user_id },
    });
    if (!user) return res.status(404).json({ error: "user not found" });

    const linkResponse = await plaidClient.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: process.env.PLAID_CLIENT_NAME || "PointGod",
      products: plaidProducts,
      transactions: {
        days_requested: 730
      },
      country_codes: plaidCountryCodes,
      webhook: process.env.ENDPOINT_BASE + '/api/plaid/webhook/fQqMLcssXf',
      language: "en",
      ...(process.env.PLAID_REDIRECT_URI ? { redirect_uri: process.env.PLAID_REDIRECT_URI } : {}),
    });

    return res.json({
      link_token: linkResponse.data.link_token,
      expiration: linkResponse.data.expiration,
    });
  })
);

/* ---------- Plaid: exchange public token + persist accounts ---------- */

// POST /plaid/exchange-public-token
//   { user_id, public_token, institution? : { institution_id, name } }
api.post(
  "/plaid/exchange-public-token",
  wrap(async (req, res) => {
    const { user_id, public_token: publicToken, institution } = req.body || {};
    if (!user_id || typeof user_id !== "string") {
      return res.status(400).json({ error: "user_id is required" });
    }
    if (!publicToken) return res.status(400).json({ error: "public_token is required" });

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    console.log("exchange: ", exchange.data);
    const accessToken = exchange.data.access_token;
    const plaidItemId = exchange.data.item_id;
    
    const accountsResponse = await plaidClient.accountsGet({ access_token: accessToken });
    const plaidAccounts = accountsResponse.data.accounts || [];
    console.log("plaidAccounts: ", plaidAccounts);
    const plaidItem = accountsResponse.data.item || {};
    console.log("plaidItem: ", plaidItem);

    let institutionInfo = institution || null;
    if (!institutionInfo && plaidItem.institution_id) {
      try {
        const institutionResponse = await plaidClient.institutionsGetById({
          institution_id: plaidItem.institution_id,
          country_codes: plaidCountryCodes,
        });
        institutionInfo = {
          institution_id: institutionResponse.data.institution.institution_id,
          name: institutionResponse.data.institution.name,
        };
      } catch (_err) {
        institutionInfo = { institution_id: plaidItem.institution_id, name: null };
      }
    }

    await mongoOperation({
      operation: "updateOne",
      collection: "plaid_items",
      filter: { plaid_item_id: plaidItemId },
      payload: {
        user_id,
        plaid_item_id: plaidItemId,
        access_token: accessToken,
        institution_id: institutionInfo ? institutionInfo.institution_id : null,
        institution_name: institutionInfo ? institutionInfo.name : null,
        available_products: plaidItem.available_products || [],
        billed_products: plaidItem.billed_products || [],
      },
      options: { upsert: true },
    });

    const itemDoc = await mongoOperation({
      operation: "findOne",
      collection: "plaid_items",
      filter: { plaid_item_id: plaidItemId },
    });

    const creditCards = await mongoOperation({
      operation: "find",
      collection: "cards",
      filter: {},
    });

    const savedAccounts = [];
    for (const acct of plaidAccounts) {
      if (acct.subtype === "credit card") {
        console.log("acct: ", acct);
        const name = acct.official_name || acct.name;
        const card = fuzzySearchCreditCards(name, creditCards, institutionInfo?.name);
        await mongoOperation({
          operation: "updateOne",
          collection: "accounts",
          filter: { account_id: acct.account_id },
          payload: {
            user_id,
            account_id: acct.account_id,
            plaid_item_id: plaidItemId,
            card_id: card?.card_id || null,
            name: name,
            mask: acct.mask || null,
            loading_transactions: true,
          },
          options: { upsert: true },
        });
      }

      const accountDoc = await mongoOperation({
        operation: "findOne",
        collection: "accounts",
        filter: { account_id: acct.account_id },
      });
      savedAccounts.push(accountDoc);
    }

    return res.status(201).json({
      item: itemDoc,
      accounts: savedAccounts,
    });
  })
);

/* ---------- Transactions ---------- */

// Registered on app (not api) so Plaid can reach it without auth headers
app.post(
  "/api/plaid/webhook/fQqMLcssXf",
  wrap(async (req, res) => {
    console.log("plaid webhook req.body: ", req.body);
    const { webhook_type, webhook_code, item_id } = req.body || {};
    if (!webhook_type || !webhook_code || !item_id) {
      return res.status(400).json({ error: "webhook_type, webhook_code, and item_id are required" });
    }

    const SYNC_CODES = ["SYNC_UPDATES_AVAILABLE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"];

    if (SYNC_CODES.includes(webhook_code)) {
      await delay(10_000);
      console.log("webhook_code: ", webhook_code);
      console.log("item_id: ", item_id);
      const item = await mongoOperation({
        operation: "findOne",
        collection: "plaid_items",
        filter: { plaid_item_id: item_id },
      });
      if (!item) return res.status(404).json({ error: "item not found" });
      
      const itemUserId = item.user_id;
      const isInitialSync = webhook_code === "INITIAL_UPDATE" || webhook_code === "HISTORICAL_UPDATE";
      const maxMonths = webhook_code === "HISTORICAL_UPDATE" ? 15 : null;

      const stats = await syncTransactionsForItem(webhook_code, item, itemUserId, { initialSync: isInitialSync, maxMonths });
      console.log(`${webhook_code} sync complete for item ${item_id}:`, stats);

      return res.json({ webhook_code, item_id, user_id: itemUserId, stats });
    }

    return res.json({ webhook_code, handled: false });
  })
);

// account_id = Plaid account_id for that card (optional). user_id is the user_id of the user
api.get(
  "/transactions",
  wrap(async (req, res) => {
    const { user_id, start_date, end_date, account_id } = req.query;
    if (!user_id || typeof user_id !== "string") {
      return res.status(400).json({ error: "user_id is required" });
    }

    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startStr = toIsoDate(start_date) || toIsoDate(thirtyDaysAgo);
    const endStr = toIsoDate(end_date) || toIsoDate(today);
    if (!startStr || !endStr) {
      return res.status(400).json({ error: "invalid startDate / endDate" });
    }

    const filter = { user_id };

    if (account_id) {
      filter.account_id = account_id;
    }

    filter.authorized_datetime = {
      $gte: toStartOfDayIso(startStr),
      $lt: toExclusiveEndIso(endStr),
    };

    const transactions = await mongoOperation({
      operation: "find",
      collection: "transactions",
      filter,
      options: { sort: { authorized_datetime: -1, transaction_id: -1 } },
    });

    const transactionsByAccount = Object.values(
      transactions.reduce((accumulator, tx) => {
        const key = tx.account_id;
        if (!accumulator[key]) {
          accumulator[key] = {
            accountId: key,
            transactions: [],
            totalSpend: 0,
            totalRewards: 0,
          };
        }
        accumulator[key].transactions.push(tx);
        accumulator[key].totalSpend += typeof tx.amount === "number" ? tx.amount : 0;
        accumulator[key].totalRewards +=
          typeof tx.reward_amount === "number" ? tx.reward_amount : 0;
        return accumulator;
      }, {})
    );

    return res.json({
      startDate: startStr,
      endDate: endStr,
      total: transactions.length,
      transactions,
      transactionsByAccount,
    });
  })
);

/* ---------- Accounts ---------- */

// GET /accounts?user_id=
api.get(
  "/accounts",
  wrap(async (req, res) => {
    const { user_id } = req.query;
    if (!user_id || typeof user_id !== "string") {
      return res.status(400).json({ error: "user_id is required" });
    }
    const accounts = await mongoOperation({
      operation: "find",
      collection: "accounts",
      filter: { user_id },
    });
    return res.json({ accounts });
  })
);

api.get("/accounts_detailed", wrap(async (req, res) => {
  const { user_id, month_year, year } = req.query;
  //if month_year is not provided, it uses the current month and year
  if (!user_id || typeof user_id !== "string") {
    return res.status(400).json({ error: "user_id is required" });
  }
  const accounts = await accountsDetailed({ user_id, month_year, year });
  return res.json({ accounts });
}));

api.get("/cards/search", wrap(async (req, res) => {
  const { q, limit: limitParam } = req.query;
  const query = typeof q === "string" ? q.trim() : "";
  const limit = Math.min(Math.max(parseInt(limitParam, 10) || 5, 1), 20);

  if (!query) {
    return res.json({ cards: [] });
  }

  const allCards = await mongoOperation({
    operation: "find",
    collection: "cards",
    filter: {},
    projection: { card_id: 1, name: 1, image: 1, issuer_id: 1, plaid_search_terms: 1 },
  });

  const cards = searchCards(query, allCards, limit).map(({ _id, ...card }) => card);
  return res.json({ cards });
}));

api.get("/cards/admin", wrap(async (req, res) => {
  const { q, page: pageParam, pageSize: pageSizeParam } = req.query;
  const query = typeof q === "string" ? q.trim() : "";
  const page = Math.max(parseInt(pageParam, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(pageSizeParam, 10) || 10, 1), 50);

  const allCards = await mongoOperation({
    operation: "find",
    collection: "cards",
    filter: {},
  });

  let matched = allCards;
  if (query) {
    matched = searchCards(query, allCards, allCards.length);
  } else {
    matched = [...allCards].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }

  const total = matched.length;
  const skip = (page - 1) * pageSize;
  const cards = matched.slice(skip, skip + pageSize).map(({ _id, ...card }) => card);

  return res.json({ cards, total, page, pageSize });
}));

api.get("/rewards/admin", wrap(async (req, res) => {
  const { q, card_id: cardIdParam, page: pageParam, pageSize: pageSizeParam } = req.query;
  const query = typeof q === "string" ? q.trim() : "";
  const cardId = typeof cardIdParam === "string" ? cardIdParam.trim() : "";
  const page = Math.max(parseInt(pageParam, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(pageSizeParam, 10) || 10, 1), 50);

  const allRewards = await mongoOperation({
    operation: "find",
    collection: "rewards",
    filter: {},
  });

  let matched = allRewards;
  if (cardId) {
    matched = matched.filter((reward) => reward.card_id === cardId);
  }
  if (query) {
    matched = searchRewards(query, matched, matched.length);
  } else {
    matched = [...matched].sort((a, b) =>
      (a.reward_id || "").localeCompare(b.reward_id || "")
    );
  }

  const total = matched.length;
  const skip = (page - 1) * pageSize;
  const rewards = matched.slice(skip, skip + pageSize).map(({ _id, ...reward }) => reward);

  return res.json({ rewards, total, page, pageSize });
}));

api.get("/spend-categories/admin", wrap(async (req, res) => {
  const { q, page: pageParam, pageSize: pageSizeParam } = req.query;
  const query = typeof q === "string" ? q.trim() : "";
  const page = Math.max(parseInt(pageParam, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(pageSizeParam, 10) || 10, 1), 50);

  const allCategories = await mongoOperation({
    operation: "find",
    collection: "spend_categories",
    filter: {},
  });

  let matched = allCategories;
  if (query) {
    matched = searchSpendCategories(query, allCategories, allCategories.length);
  } else {
    matched = [...allCategories].sort((a, b) =>
      (a.category || "").localeCompare(b.category || "")
    );
  }

  const total = matched.length;
  const skip = (page - 1) * pageSize;
  const categories = matched
    .slice(skip, skip + pageSize)
    .map(({ _id, ...category }) => ({ ...category, _id: _id?.toString?.() ?? _id }));

  return res.json({ categories, total, page, pageSize });
}));

api.get("/transfer-partners/admin", wrap(async (req, res) => {
  const { q, page: pageParam, pageSize: pageSizeParam } = req.query;
  const query = typeof q === "string" ? q.trim() : "";
  const page = Math.max(parseInt(pageParam, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(pageSizeParam, 10) || 10, 1), 50);

  const allPartners = await mongoOperation({
    operation: "find",
    collection: "transfer_partners",
    filter: {},
  });

  let matched = allPartners;
  if (query) {
    matched = searchTransferPartners(query, allPartners, allPartners.length);
  } else {
    matched = [...allPartners].sort((a, b) =>
      (a.program || "").localeCompare(b.program || "")
    );
  }

  const total = matched.length;
  const skip = (page - 1) * pageSize;
  const transferPartners = matched
    .slice(skip, skip + pageSize)
    .map(({ _id, ...partner }) => partner);

  return res.json({ transferPartners, total, page, pageSize });
}));

api.get("/issuers/admin", wrap(async (req, res) => {
  const { q, page: pageParam, pageSize: pageSizeParam } = req.query;
  const query = typeof q === "string" ? q.trim() : "";
  const page = Math.max(parseInt(pageParam, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(pageSizeParam, 10) || 10, 1), 50);

  const allIssuers = await mongoOperation({
    operation: "find",
    collection: "issuers",
    filter: {},
  });

  let matched = allIssuers;
  if (query) {
    matched = searchIssuers(query, allIssuers, allIssuers.length);
  } else {
    matched = [...allIssuers].sort((a, b) =>
      (a.issuer_id || "").localeCompare(b.issuer_id || "")
    );
  }

  const total = matched.length;
  const skip = (page - 1) * pageSize;
  const issuers = matched.slice(skip, skip + pageSize).map(({ _id, ...issuer }) => issuer);

  return res.json({ issuers, total, page, pageSize });
}));

api.post(
  "/mongoOperation",
  wrap(async (req, res) => {
    const { operation, collection, filter, projection, options, payload, aggregation } =
      req.body || {};
    const result = await mongoOperation({ operation, collection, filter, projection, options, payload, aggregation });
    return res.json(result);
  })
);

// POST /cards/best
// Returns the top 5 cards ranked by estimated annual cash earn for a given category + spend
api.post("/cards/best", wrap(async (req, res) => {
  const { category, category_spend, existing_cards } = req.body;
  if (!category || typeof category !== "string") {
    return res.status(400).json({ error: "category is required" });
  }
  
  const mongo = await connectToMongo();
  const db = mongo.db(process.env.DATABASE_NAME);

  const [allCards, allRewards, allIssuers] = await Promise.all([
    db.collection("cards").find({ active: true, card_id: { $nin: existing_cards.length > 0 ? existing_cards : [] } }).toArray(),
    db.collection("rewards").find({ category:{$regex: category} }).toArray(),
    db.collection("issuers").find({}).toArray(),
  ]);

  const issuerByIssuerId = Object.fromEntries(allIssuers.map((i) => [i.issuer_id, i]));
  const cardById = Object.fromEntries(allCards.map((c) => [c.card_id, c]));

  const rewardsByCardId = allRewards.reduce((acc, r) => {
    if (!acc[r.card_id]) acc[r.card_id] = [];
    acc[r.card_id].push(r);
    return acc;
  }, {});

  // Annualise a credit reward's spend cap value
  const annualisedCreditValue = (reward) => {
    if (reward.spend_cap_annual != null) return reward.spend_cap_annual;
    if (reward.spend_cap_biannual != null) return reward.spend_cap_biannual * 2;
    if (reward.spend_cap_quarterly != null) return reward.spend_cap_quarterly * 4;
    if (reward.spend_cap_monthly != null) return reward.spend_cap_monthly * 12;
    return 0;
  };

  const scored = Object.entries(rewardsByCardId).map(([cardId, rewards]) => {
    const card = cardById[cardId];
    if (!card) return null;

    const issuer = issuerByIssuerId[card.issuer_id] ?? {};
    const pointValueCents = issuer.point_value_cents ?? 1;

    // Best rate-based reward (base or merchant type)
    const baseReward = rewards
      .filter((r) => r.type === "base" || r.type === "merchant")
      .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0] ?? null;

    // Stack credit rewards greedily (highest value first) until spend is exhausted or all used
    const creditRewards = rewards
      .filter((r) => r.type === "credit" || r.type === "merchantCredit")
      .sort((a, b) => annualisedCreditValue(b) - annualisedCreditValue(a));

    let remainingSpend = category_spend;
    let cashFromCredits = 0;
    const stackedCreditRewards = [];
    for (const cr of creditRewards) {
      if (remainingSpend <= 0) break;
      const creditVal = annualisedCreditValue(cr);
      const applied = Math.min(creditVal, remainingSpend);
      cashFromCredits += applied;
      remainingSpend -= applied;
      stackedCreditRewards.push(cr);
    }

    const cashFromPoints = baseReward
      ? (category_spend * (baseReward.rate ?? 0) * pointValueCents) / 100
      : 0;
    const estimatedCashEarn = cashFromPoints + cashFromCredits;

    return { cardId, card, estimatedCashEarn, baseReward, creditRewards: stackedCreditRewards };
  }).filter(Boolean);

  // Cards with both a base reward + credit rewards rank highest, then sort by estimated cash
  scored.sort((a, b) => {
    const aHasBoth = a.baseReward && a.creditRewards.length > 0 ? 1 : 0;
    const bHasBoth = b.baseReward && b.creditRewards.length > 0 ? 1 : 0;
    if (bHasBoth !== aHasBoth) return bHasBoth - aHasBoth;
    return b.estimatedCashEarn - a.estimatedCashEarn;
  });

  const result = {};
  scored.slice(0, 5).forEach(({ cardId, card, estimatedCashEarn }, idx) => {
    const { _id, ...cardWithoutId } = card;
    result[cardId] = {
      card_rank: idx + 1,
      estimated_cash_earn: `$${estimatedCashEarn.toFixed(2)}`,
      card: cardWithoutId,
    };
  });

  return res.json(result);
}));

/* ---------- Plaid Item removal ---------- */

api.delete(
  '/plaid/item',
  wrap(async (req, res) => {
    const { user_id, plaid_item_id } = req.body || {};
    if (!user_id || !plaid_item_id) {
      return res.status(400).json({ error: 'user_id and plaid_item_id are required' });
    }

    const item = await mongoOperation({
      operation: 'findOne',
      collection: 'plaid_items',
      filter: { user_id, plaid_item_id },
    });
    if (!item) return res.status(404).json({ error: 'Plaid item not found' });

    await plaidClient.itemRemove({ access_token: item.access_token });

    await mongoOperation({
      operation: 'deleteOne',
      collection: 'plaid_items',
      filter: { plaid_item_id },
    });

    await mongoOperation({
      operation: 'deleteMany',
      collection: 'accounts',
      filter: { plaid_item_id },
    });

    return res.json({ success: true, plaid_item_id });
  })
);

/* -------------------------------------------------------------------------- */
/*  Push notifications                                                        */
/* -------------------------------------------------------------------------- */

api.get('/push/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(500).json({ error: 'VAPID_PUBLIC_KEY not configured' });
  res.json({ publicKey: key });
});

/* -------------------------------------------------------------------------- */
/*  Mount + error handler                                                     */
/* -------------------------------------------------------------------------- */

app.use("/api", api);

app.use((err, req, res, _next) => {
  const plaidErr = err && err.response && err.response.data;
  if (plaidErr) {
    console.error("Plaid error:", plaidErr);
    return res.status(err.response.status || 500).json({ error: plaidErr });
  }
  console.error(err);
  return res.status(500).json({ error: err.message || "Internal Server Error" });
});

/* -------------------------------------------------------------------------- */
/*  Boot                                                                      */
/* -------------------------------------------------------------------------- */

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`cc_tracker backend listening on :${port} (plaid=${plaidEnv})`);
});

module.exports = { app, mongoOperation, connectToMongo };
