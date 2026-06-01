# cc_tracker backend



Express API for the credit card points tracker.



## Setup



```bash

cd backend

npm install

cp .env.example .env

# then fill in CC_TRACKER_API_KEY, PLAID_CLIENT_ID, PLAID_SECRET

npm run dev

```



The server listens on `PORT` (default `4000`).



## Auth



Every route under `/api/*` requires two headers:



| header        | value                                  |

| ------------- | -------------------------------------- |

| `x-client-id` | `CC_TRACKER` (or `CC_TRACKER_CLIENT_ID`) |

| `x-api-key`   | matches `CC_TRACKER_API_KEY` in `.env` |



`GET /health` is the only unauthenticated route.



## Collections



Field names use **snake_case** to align with Plaid payloads.



- `users` — `{ _id, email, name, created_at, updated_at }` where `_id` is the client-generated string `user_id`.

- `plaid_items` — one row per Plaid Item (institution connection). Holds the

  `access_token` shared by every account under the connection, plus

  `transactions_cursor` (per-Item cursor for `/transactions/sync`).

  `{ _id, user_id, plaid_item_id, access_token, transactions_cursor, institution_id, institution_name, ... }`

- `accounts` — one row per card / Plaid account.

  `{ _id, user_id, item_id, plaid_item_id, plaid_account_id, plaid_persistent_account_id, name, official_name, mask, type, subtype, institution_id, institution_name, balances, ... }`

- `transactions` — one row per Plaid transaction, stamped with `user_id` (string)

  and `plaid_item_id` (string). Plaid fields (`transaction_id`, `account_id`, `date`,

  `amount`, etc.) are stored as returned by `/transactions/sync`. Documents include

  `created_at` on insert and `updated_at` when applied from the `modified` array.



  Recommended index: unique compound `{ user_id: 1, transaction_id: 1 }`.



`access_token` lives on `plaid_items` rather than on every account because

Plaid issues one token per Item; all accounts under that Item share it.



## Endpoints



### Public



- `GET /health` → `{ ok: true, env }`



### Users



- `POST /api/users` `{ user_id, email, name? }` → creates user (`_id` = `user_id`) or returns existing if that id already exists. Returns `409` if `email` is taken by another user.

- `GET /api/users/:user_id`



### Plaid



- `POST /api/plaid/link-token` `{ user_id }` → `{ link_token, expiration }`

  Frontend uses this to open Plaid Link.

- `POST /api/plaid/exchange-public-token`

  `{ user_id, public_token, institution? }`

  Exchanges the Link `public_token` for an `access_token`, then fetches and

  persists every account (card) under that Item.



### Transactions



- `POST /api/transactions_sync` `{ user_id }`  

  For each linked Plaid Item for that user, calls `/transactions/sync`, pages

  until `has_more` is false, applies `removed` / `modified` / `added` to the

  `transactions` collection, and saves the new cursor on `plaid_items`.



- `GET /api/transactions?user_id=...&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&account_id=...`

  - `user_id` (required)

  - `start_date` / `end_date` optional, default to the last 30 days.

  - `account_id` (Plaid `account_id` for that card) optional — when present,

    restricts the response to that card.

  - Reads from the local `transactions` collection (run `transactions_sync`

    first so data is current).



### Accounts



- `GET /api/accounts?user_id=...` — convenience list of every saved card.

