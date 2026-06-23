require('dotenv').config();
const { connectToMongo, closeMongo } = require('./connectToMongo');

async function checkForBetterCard(transaction) {
    const mongo = await connectToMongo()
    const db = mongo.db(process.env.DATABASE_NAME)
    const accountsCollection = db.collection('accounts')
    const usersCollection = db.collection('users')
    const cardsCollection = db.collection('cards')
    const rewardsCollection = db.collection('rewards')
    const spendSummariesCollection = db.collection('spend_summaries')

    try{
        const accountId = transaction.account_id;
        const rewardId = transaction.reward_id;
        const merchant = transaction.merchant_name;
        const plaidCategory = transaction.personal_finance_category.detailed;
        const account = await accountsCollection.findOne({ account_id: accountId });
        const user = await usersCollection.findOne({ user_id: account.user_id });
        const userAccounts = await accountsCollection.find({ user_id: user.user_id });
        const cards = await cardsCollection.find({ card_id: {$in: userAccounts.map(account => account.card_id) } });
        const now = new Date();
        const thisMonthYear = now.toLocaleString('default', { month: 'long', year: 'numeric' });
        const quarters = {
            1: ["January", "February", "March"],
            2: ["April", "May", "June"],
            3: ["July", "August", "September"],
            4: ["October", "November", "December"],
        }
        const halves = {
            1: ["January", "February", "March", "April", "May", "June"],
            2: ["July", "August", "September", "October", "November", "December"],
        }
        const theseQuarters = Object.values(quarters).map(quarter => quarter.map(month => `${month} ${now.getFullYear()}`));
        const theseHalves = Object.values(halves).map(half => half.map(month => `${month} ${now.getFullYear()}`));
        const thisYear = now.getFullYear().toString();
        let currentReward = await rewardsCollection.findOne({ reward_id: rewardId });
        if(!currentReward){
            currentReward={
                type:"base",
                rate:transaction.points_rate
            }
        }
        if(currentReward.type === 'credit'){
            return null;
        }
        const categoryRewards = await rewardsCollection.find({ reward_id: {$ne: rewardId}, card_id: {$in: cards.map(card => card.card_id) }, plaid_categories: plaidCategory });
        let merchantRewards = [];
        if(merchant){
            merchantRewards = await rewardsCollection.find({ reward_id: {$ne: rewardId}, card_id: {$in: cards.map(card => card.card_id) }, merchants: merchant });
        }
        let betterCardReward = currentReward;
        for(const categoryReward of categoryRewards){
            if(categoryReward.type === 'credit'){
                const spendCapFrequency = categoryReward.spend_cap_monthly ? "monthly" : categoryReward.spend_cap_quarterly ? "quarterly" : categoryReward.spend_cap_biannual ? "biannual" : "annual";
                let currentSpend = 0;
                if(spendCapFrequency === "monthly"){
                    currentSpend = await spendSummariesCollection.findOne({ user_id: user.user_id, month_year: { $regex: ` ${thisMonthYear}$` } });
                    currentSpend = currentSpend.spend_by_account[accountId]?.spend_by_category[categoryReward.plaid_categories] || 0;
                } else if(spendCapFrequency === "quarterly"){
                    currentSpend = await spendSummariesCollection.find({ user_id: user.user_id, month_year: { $in: theseQuarters } });
                    currentSpend = currentSpend.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_category[categoryReward.plaid_categories] || 0;
                    },0);
                } else if(spendCapFrequency === "biannual"){
                    currentSpend = await spendSummariesCollection.find({ user_id: user.user_id, month_year: { $in: theseHalves } });
                    currentSpend = currentSpend.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_category[categoryReward.plaid_categories] || 0;
                    },0);
                } else if(spendCapFrequency === "annual"){
                    currentSpend = await spendSummariesCollection.find({ user_id: user.user_id, month_year: { $regex: ` ${thisYear}$` } });
                    currentSpend = currentSpend.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_category[categoryReward.plaid_categories] || 0;
                    },0);
                }
                if(currentSpend < categoryReward[`spend_cap_${spendCapFrequency}`]){
                    betterCardReward = categoryReward;
                    break;
                }
            } else {
                if(categoryReward.rate > betterCardReward.rate){
                    betterCardReward = categoryReward;
                }
            }
        }
        for(const merchantReward of merchantRewards){
            if(merchantReward.type === 'credit' || merchantReward.type === 'merchantCredit'){
                const spendCapFrequency = merchantReward.spend_cap_monthly ? "monthly" : merchantReward.spend_cap_quarterly ? "quarterly" : merchantReward.spend_cap_biannual ? "biannual" : "annual";
                let currentSpend = 0;
                if(spendCapFrequency === "monthly"){
                    currentSpend = await spendSummariesCollection.findOne({ user_id: user.user_id, month_year: { $regex: ` ${thisMonthYear}$` } });
                    currentSpend = currentSpend.spend_by_account[accountId]?.spend_by_merchant[merchant] || 0;
                } else if(spendCapFrequency === "quarterly"){
                    currentSpend = await spendSummariesCollection.find({ user_id: user.user_id, month_year: { $in: theseQuarters } });
                    currentSpend = currentSpend.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_merchant[merchant] || 0;
                    },0);
                } else if(spendCapFrequency === "biannual"){
                    currentSpend = await spendSummariesCollection.find({ user_id: user.user_id, month_year: { $in: theseHalves } });
                    currentSpend = currentSpend.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_merchant[merchant] || 0;
                    },0);
                } else if(spendCapFrequency === "annual"){
                    currentSpend = await spendSummariesCollection.find({ user_id: user.user_id, month_year: { $regex: ` ${thisYear}$` } });
                    currentSpend = currentSpend.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_merchant[merchant] || 0;
                    },0);
                }
                
                if(currentSpend < merchantReward[`spend_cap_${spendCapFrequency}`]){
                    betterCardReward = merchantReward;
                    break;
                }
            } else {
                if(merchantReward.rate > betterCardReward.rate){
                    betterCardReward = merchantReward;
                }
            }
        }
        if(betterCardReward.card_id === currentReward.card_id){
            return null;
        }
        return betterCardReward.card_id;
    } catch(err) {
        console.log("error checking for better card: ", err.message);
        return null;
    }
}

module.exports = { checkForBetterCard };