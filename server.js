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
const {
  createAndEmailVerificationCode,
  verifyCodeForUser,
  stripPassword,
} = require("./authenticationCodes");
const app = express();
app.use(cors());
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

const toIsoDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

const transactionsSyncCount = 500;

const persistPlaidTransactionAdds = async (db, txs, user_id, plaid_item_id) => {
  const collection = db.collection("transactions");
  let count = 0;
  for (const tx of txs) {
    await collection.updateOne(
      { user_id, transaction_id: tx.transaction_id },
      {
        $set: { ...tx, user_id, plaid_item_id },
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
        $set: { ...tx, user_id, plaid_item_id, updatedAt: new Date() },
      }
    );
    if (updateResult.matchedCount === 0) {
      await collection.updateOne(
        { user_id, transaction_id: tx.transaction_id },
        {
          $set: { ...tx, user_id, plaid_item_id },
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

const syncTransactionsForItem = async (item, user_id) => {
  const mongo = await connectToMongo();
  const db = mongo.db(process.env.DATABASE_NAME);

  const stats = { added: 0, modified: 0, removed: 0 };
  let cursor =
    item.transactions_cursor && String(item.transactions_cursor).length > 0
      ? item.transactions_cursor
      : undefined;

  while (true) {
    const plaidResponse = await plaidClient.transactionsSync({
      access_token: item.access_token,
      cursor,
      count: transactionsSyncCount,
      options: {
        include_original_description: true,

      },
    });

    const data = plaidResponse.data;

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
      item.plaid_item_id
    );

    cursor = data.next_cursor;

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
      client_name: process.env.PLAID_CLIENT_NAME || "CC Tracker",
      products: plaidProducts,
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
    const accessToken = exchange.data.access_token;
    const plaidItemId = exchange.data.item_id;

    const accountsResponse = await plaidClient.accountsGet({ access_token: accessToken });
    const plaidAccounts = accountsResponse.data.accounts || [];
    const plaidItem = accountsResponse.data.item || {};

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
        const name = acct.official_name || acct.name;
        const card = fuzzySearchCreditCards(name, creditCards, institutionInfo?.name);
        await mongoOperation({
          operation: "updateOne",
          collection: "accounts",
          filter: { account_id: acct.account_id },
          payload: {
            user_id,
            account_id: acct.account_id,
            plaid_persistent_account_id: acct.persistent_account_id || null,
            card_id: card?.card_id || null,
            name: name,
            mask: acct.mask || null,
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

api.post(
  "/plaid/webhook/fQqMLcssXf",
  wrap(async (req, res) => {
    const { webhook_type, webhook_code, item_id } = req.body || {};
    if (!webhook_type || !webhook_code || !item_id) {
      return res.status(400).json({ error: "webhook_type, webhook_code, and item_id are required" });
    }

    if(webhook_code==="SYNC_UPDATES_AVAILABLE"){
      const item = await mongoOperation({
        operation: "findOne",
        collection: "plaid_items",
        filter: { plaid_item_id: item_id },
      });
      if (!item) return res.status(404).json({ error: "item not found" });

      const totals = { added: 0, modified: 0, removed: 0 };

      
      const itemStats = await syncTransactionsForItem(item, user_id);
      totals.added += itemStats.added;
      totals.modified += itemStats.modified;
      totals.removed += itemStats.removed;
      console.log("total transactions synced: ", totals);
    }

    return res.json({
      user_id,
      itemsSynced: items.length,
      totals,
      byItem,
    });
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

    filter.date = { $gte: startStr, $lte: endStr };

    const transactions = await mongoOperation({
      operation: "find",
      collection: "transactions",
      filter,
      options: { sort: { date: -1, transaction_id: -1 } },
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

api.post(
  "/mongoOperation",
  wrap(async (req, res) => {
    const { operation, collection, filter, projection, options, payload, aggregation } =
      req.body || {};
    const result = await mongoOperation({ operation, collection, filter, projection, options, payload, aggregation });
    return res.json(result);
  })
);

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
