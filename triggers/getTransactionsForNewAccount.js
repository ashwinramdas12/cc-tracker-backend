exports = async function (changeEvent) {
    if (changeEvent.operationType !== 'insert') return;

    const account = changeEvent.fullDocument;
    const serviceName = "main";
    const database = "cc_tracker_main";
    const db = context.services.get(serviceName).db(database);
    const accountsCollection = db.collection("accounts");
    const cardsCollection = db.collection("cards");
    const plaidItemsCollection = db.collection("plaid_items");
    const transactionsCollection = db.collection("transactions");

    try {
        const accountId = account.account_id;
        const userId = account.user_id;

        const plaidItem = await plaidItemsCollection.findOne({ user_id: userId, plaid_item_id: account.plaid_item_id });
        if (!plaidItem?.access_token) {
            console.log("No plaid item / access token found for user:", userId);
            return;
        }

        // Use the stored cursor if one exists (first call will have none)
        const stableCursor = plaidItem.transactions_cursor || null;
        let cursor = stableCursor;
        const allAdded = [];

        // Paginate through transactions/sync until has_more is false.
        // If Plaid mutates data mid-pagination, restart from the stable cursor.
        let hasMore = true;
        while (hasMore) {
            const requestBody = {
                client_id: context.values.get("PLAID_CLIENT_ID"),
                secret: context.values.get("PLAID_SECRET"),
                access_token: plaidItem.access_token,
                count: 500,
                options: { include_original_description: true },
            };
            if (cursor) {
                requestBody.cursor = cursor;
            }

            const plaidResponse = await context.http.post({
                url: "https://production.plaid.com/transactions/sync",
                headers: { "Content-Type": ["application/json"] },
                body: JSON.stringify(requestBody),
            });

            const body = JSON.parse(plaidResponse.body.text());

            if (body.error_code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
                // Plaid mutated data mid-pagination — restart from the stable cursor
                cursor = stableCursor;
                allAdded.length = 0;
                continue;
            }

            if (body.error_code) {
                throw new Error(`Plaid sync error: ${body.error_code} — ${body.error_message}`);
            }

            allAdded.push(...(body.added || []));
            cursor = body.next_cursor;
            hasMore = body.has_more;
        }

        // Save the final cursor back so future syncs pick up where we left off
        await plaidItemsCollection.updateOne(
            { plaid_item_id: plaidItem.plaid_item_id },
            { $set: { transactions_cursor: cursor || "" } }
        );

        // Filter to only transactions belonging to this specific account
        const transactions = allAdded.filter(tx => tx.account_id === accountId);

        if (!transactions.length) {
            console.log("No transactions returned from Plaid for account:", accountId);
            await accountsCollection.updateOne(
                { account_id: accountId },
                { $set: { loading_transactions: false } }
            );
            return;
        }

        // Persist transactions
        for (const tx of transactions) {
            delete tx.unofficial_currency_code;
            delete tx.counterparties;
            delete tx.payment_meta;
            delete tx.location;
            delete tx.pending_transaction_id;
            delete tx.personal_finance_category_icon_url;
            await transactionsCollection.updateOne(
                { user_id: userId, transaction_id: tx.transaction_id },
                {
                    $set: { ...tx, user_id: userId, plaid_item_id: plaidItem.plaid_item_id, update_from_plaid: true, initial_sync_from_trigger: true },
                    $setOnInsert: { createdAt: new Date() },
                },
                { upsert: true }
            );
        }

        // Determine opened_date and next_annual_fee_date
        let openedDate = null;
        let nextAnnualFeeDate = null;

        if (account.card_id) {
            const card = await cardsCollection.findOne({ card_id: account.card_id });

            if (card?.annual_fee && card.annual_fee > 0) {
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
            }
        }

        const updatePayload = { loading_transactions: false };
        if (openedDate) updatePayload.opened_date = openedDate;
        if (nextAnnualFeeDate) updatePayload.next_annual_fee_date = nextAnnualFeeDate;

        await accountsCollection.updateOne(
            { account_id: accountId },
            { $set: updatePayload }
        );

    } catch (err) {
        console.log("error in getTransactionsForNewAccount:", err.message);
    }
};
