require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { connectToMongo, closeMongo } = require('../connectToMongo');

const PLAID_ITEM_ID = 'MMMXeRRYddUByb4eZxZ6hn5k8O5z4AIdRg3Py';

const plaidClient = new PlaidApi(
    new Configuration({
        basePath: PlaidEnvironments[process.env.PLAID_ENV || 'production'],
        baseOptions: {
            headers: {
                'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
                'PLAID-SECRET': process.env.PLAID_SECRET,
                'Plaid-Version': '2020-09-14',
            },
        },
    })
);

(async () => {
    const mongo = await connectToMongo();
    const db = mongo.db(process.env.DATABASE_NAME);

    const item = await db.collection('plaid_items').findOne({ plaid_item_id: PLAID_ITEM_ID });

    if (!item) {
        console.error(`No plaid_items doc found for plaid_item_id: ${PLAID_ITEM_ID}`);
        await closeMongo();
        return;
    }

    try {
        const response = await plaidClient.itemGet({ access_token: item.access_token });
        console.log(JSON.stringify(response.data, null, 2));
    } catch (err) {
        console.error('Error calling /item/get:', err?.response?.data ?? err.message);
    }

    await closeMongo();
})();
