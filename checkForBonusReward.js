require('dotenv').config();
const { connectToMongo } = require('./connectToMongo');
const { buildRewardWindowMonthYearFilter } = require('./accountsDetailed');

const quarters = {
    1: ["January", "February", "March"],
    2: ["April", "May", "June"],
    3: ["July", "August", "September"],
    4: ["October", "November", "December"],
};

const halves = {
    1: ["January", "February", "March", "April", "May", "June"],
    2: ["July", "August", "September", "October", "November", "December"],
};

const MONTHS = [
    "January","February","March","April","May","June",
    "July","August","September","October","November","December",
];

const toMonthYear = (date) => `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;

/**
 * Sums spend for the given category across an array of spend summary documents.
 * If category is "everything_else", sums all spend_by_category values for the account.
 */
function sumCategorySpend(spendSummaries, accountId, category) {
    return spendSummaries.reduce((total, summary) => {
        const bucket = summary.spend_by_account?.[accountId];
        if (!bucket) return total;
        if (category === 'everything_else') {
            const byCategory = bucket.spend_by_category || {};
            return total + Object.values(byCategory).reduce((a, b) => a + b, 0);
        }
        return total + (bucket.spend_by_category?.[category] || 0);
    }, 0);
}

async function checkForBonusReward(userId, accountId, bonusReward, spendCategory, spendAmount, now) {
    if (!bonusReward) return null;

    const mongo = await connectToMongo();
    const db = mongo.db(process.env.DATABASE_NAME);
    const spendSummariesCollection = db.collection('spend_summaries');

    const transactionDate = now instanceof Date ? now : new Date(now || Date.now());
    const thisYear = transactionDate.getFullYear().toString();
    const quarter = Math.ceil((transactionDate.getMonth() + 1) / 3);
    const half = transactionDate.getMonth() < 6 ? 1 : 2;
    const monthYear = toMonthYear(transactionDate);

    const category = bonusReward.category || spendCategory;

    let spendCap = null;
    let spendSummaries = [];

    if (bonusReward.spend_cap_monthly) {
        spendCap = bonusReward.spend_cap_monthly;
        spendSummaries = await spendSummariesCollection.find(
            { user_id: userId, month_year: monthYear },
            { _id: 0, [`spend_by_account.${accountId}`]: 1 }
        ).toArray();
    } else if (bonusReward.spend_cap_quarterly) {
        spendCap = bonusReward.spend_cap_quarterly;
        const quarterMonths = quarters[quarter].map((m) => `${m} ${thisYear}`);
        spendSummaries = await spendSummariesCollection.find(
            { user_id: userId, month_year: { $in: quarterMonths } },
            { _id: 0, [`spend_by_account.${accountId}`]: 1 }
        ).toArray();
    } else if (bonusReward.spend_cap_biannual) {
        spendCap = bonusReward.spend_cap_biannual;
        const halfMonths = halves[half].map((m) => `${m} ${thisYear}`);
        spendSummaries = await spendSummariesCollection.find(
            { user_id: userId, month_year: { $in: halfMonths } },
            { _id: 0, [`spend_by_account.${accountId}`]: 1 }
        ).toArray();
    } else if (bonusReward.spend_cap_annual) {
        spendCap = bonusReward.spend_cap_annual;
        spendSummaries = await spendSummariesCollection.find(
            { user_id: userId, month_year: { $regex: thisYear } },
            { _id: 0, [`spend_by_account.${accountId}`]: 1 }
        ).toArray();
    } else if (bonusReward.spend_cap_all_time) {
        spendCap = bonusReward.spend_cap_all_time;
        spendSummaries = await spendSummariesCollection.find(
            { user_id: userId, ...buildRewardWindowMonthYearFilter(bonusReward, transactionDate) },
            { _id: 0, [`spend_by_account.${accountId}`]: 1 }
        ).toArray();
    }

    if (spendCap === null) return null;

    const totalSpend = sumCategorySpend(spendSummaries, accountId, category);

    // Already at or over the cap — no bonus
    if (totalSpend >= spendCap) return null;

    // if (!bonusReward.increment_spend) return null;

    const increment = bonusReward.increment_spend;
    const newTotal = Math.min(totalSpend + spendAmount, spendCap);
    const prevMultiple = increment ? Math.floor(totalSpend / increment) : totalSpend;
    const newMultiple = increment ? Math.floor(newTotal / increment) : newTotal;

    if (newMultiple > prevMultiple) {
        return bonusReward.bonus_amount;
    }

    return 0;
}

module.exports = checkForBonusReward;
