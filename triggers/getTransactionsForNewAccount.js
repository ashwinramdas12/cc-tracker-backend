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

        // Get the plaid item for this account to retrieve the access token
        const plaidItem = await plaidItemsCollection.findOne({ user_id: userId });
        if (!plaidItem?.access_token) {
            console.log("No plaid item / access token found for user:", userId);
            return;
        }

        // Fetch 15 months of transactions from Plaid
        const endDate = new Date();
        const startDate = new Date();
        startDate.setMonth(startDate.getMonth() - 2);
        const formatDate = (d) => d.toISOString().split('T')[0];

        const plaidResponse = await context.http.post({
            url: "https://production.plaid.com/transactions/get",
            headers: { "Content-Type": ["application/json"] },
            body: JSON.stringify({
                client_id: context.values.get("PLAID_CLIENT_ID"),
                secret: context.values.get("PLAID_SECRET"),
                access_token: plaidItem.access_token,
                start_date: formatDate(startDate),
                end_date: formatDate(endDate),
                options: {
                    account_ids: [accountId],
                    count: 500,
                    include_original_description: true,
                }
            })
        });
        console.log("plaidResponse: ", plaidResponse);
        console.log("plaidResponse.body: ", plaidResponse.body);
        console.log("plaidResponse.body.text(): ", plaidResponse.body.text());
        const body = JSON.parse(plaidResponse.body.text());
        const transactions = body.transactions || [];

        if (!transactions.length) {
            console.log("No transactions returned from Plaid for account:", accountId);
            return;
        }

        // Persist all transactions (mirrors persistPlaidTransactionAdds logic)
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
                    $set: { ...tx, user_id: userId, plaid_item_id: plaidItem.plaid_item_id, update_from_plaid: true, initial_sync: true },
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
                // Look for the annual fee transaction — typically a negative-amount charge
                // with "annual fee" in the name/description
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

        // If no annual fee transaction found, fall back to oldest transaction date
        // (only if the oldest transaction is less than 12 months old)
        if (!openedDate) {
            const sorted = [...transactions].sort((a, b) => {
                const da = new Date(a.authorized_datetime || a.date);
                const db = new Date(b.authorized_datetime || b.date);
                return da - db;
            });
            const oldestTx = sorted[0];
            const oldestDate = new Date(oldestTx.authorized_datetime || oldestTx.date);
            const twelveMonthsAgo = new Date();
            twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

            if (oldestDate > twelveMonthsAgo) {
                openedDate = oldestDate;
            }
        }

        if (openedDate) {
            const updatePayload = { opened_date: openedDate };
            if (nextAnnualFeeDate) updatePayload.next_annual_fee_date = nextAnnualFeeDate;
            updatePayload.loading_transactions = false;
            await accountsCollection.updateOne(
                { account_id: accountId },
                { $set: updatePayload }
            );
        } else {
            await accountsCollection.updateOne(
                { account_id: accountId },
                { $set: { loading_transactions: false } }
            );
        }

    } catch (err) {
        console.log("error in getTransactionsForNewAccount:", err.message);
    }
};
