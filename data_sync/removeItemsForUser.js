require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { connectToMongo, closeMongo } = require('../connectToMongo');

const USER_ID = 'Cp2xlHyEtdp8MKfs';
const KEEP_ITEM_ID = 'MMMXeRRYddUByb4eZxZ6hn5k8O5z4AIdRg3Py';

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

    // Fetch all plaid_items for this user from our DB to get access tokens
    const items = await db.collection('plaid_items').find({ user_id: USER_ID }).toArray();

    console.log(`\nFound ${items.length} item(s) for user ${USER_ID}:\n`);
    for (const item of items) {
        console.log(`  plaid_item_id : ${item.plaid_item_id}`);
        console.log(`  access_token  : ${item.access_token}`);
        console.log(`  institution   : ${item.institution_name ?? 'unknown'}`);
        console.log(`  keep          : ${item.plaid_item_id === KEEP_ITEM_ID}`);
        console.log('');
    }

    // const toRemove = items.filter((item) => item.plaid_item_id !== KEEP_ITEM_ID);

    // if (toRemove.length === 0) {
    //     console.log('Nothing to remove.');
    //     await closeMongo();
    //     return;
    // }

    // console.log(`Removing ${toRemove.length} item(s)...\n`);

    // for (const item of toRemove) {
    //     try {
    //         await plaidClient.itemRemove({ access_token: item.access_token });
    //         console.log(`  ✓ Removed from Plaid: ${item.plaid_item_id}`);

    //         await db.collection('plaid_items').deleteOne({ plaid_item_id: item.plaid_item_id });
    //         console.log(`  ✓ Deleted from plaid_items collection`);

    //         const { deletedCount } = await db.collection('accounts').deleteMany({ plaid_item_id: item.plaid_item_id });
    //         console.log(`  ✓ Deleted ${deletedCount} associated account(s)\n`);
    //     } catch (err) {
    //         console.error(`  ✗ Failed to remove ${item.plaid_item_id}:`, err?.response?.data ?? err.message);
    //     }
    // }

    await closeMongo();
    console.log('Done.');
})();
