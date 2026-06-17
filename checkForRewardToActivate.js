require('dotenv').config();
const { connectToMongo, closeMongo } = require('./connectToMongo');

async function checkForRewardToActivate(transaction) {
    const mongo = await connectToMongo()
    const db = mongo.db(process.env.DATABASE_NAME)
    const accountsCollection = db.collection('accounts')
    const usersCollection = db.collection('users')
    const cardsCollection = db.collection('cards')
    const rewardsCollection = db.collection('rewards')
    try{
        const accountId = transaction.account_id;
        const rewardId = transaction.reward_id;
        const card = await cardsCollection.findOne({ account_id: accountId });
        const cardId = card.card_id;
        const currentReward = await rewardsCollection.findOne({ reward_id: rewardId });
        const categoryReward = await rewardsCollection.findOne({ reward_id: {$ne: rewardId}, card_id: cardId, plaid_categories: transaction.personal_finance_category.detailed, activation_required: true });
        const merchantReward = await rewardsCollection.findOne({ reward_id: {$ne: rewardId}, card_id: cardId, merchants: transaction.merchant_name, activation_required: true });
        if(categoryReward){
            if(categoryReward.type === 'credit'){
                return categoryReward.reward_id;
            }
            if(categoryReward.rate > currentReward.rate){
                return categoryReward.reward_id;
            }
        }
        if(merchantReward){
            if(merchantReward.type === 'credit' || merchantReward.type === 'merchantCredit'){
                return merchantReward.reward_id;
            }
            if(merchantReward.rate > currentReward.rate){
                return merchantReward.reward_id;
            }
        }
        return null;
    } catch(err) {
        console.log("error checking for reward to activate: ", err.message);
        return null;
    }
}

module.exports = { checkForRewardToActivate };