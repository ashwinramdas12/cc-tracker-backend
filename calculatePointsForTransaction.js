require('dotenv').config();
const { connectToMongo, closeMongo } = require('./connectToMongo');
const { buildRewardWindowMonthYearFilter } = require('./accountsDetailed');
const { formatMonthYear } = require('./utility');
//TO DO:
// IDENTIFY CREDITS, SHOULD WE ADD TO SPEND SUMMARY?
// NEED TO TAG WITH UNCLASSIFIED IF WE CANT PROPERLY CATEGORIZE THE TRANSACTION
// RECOMMEND A CARD IF A BETTER ONE COULD HAVE BEEN USED FOR THIS CATEGORY

async function calculatePointsForTransaction(transaction) {
    const mongo = await connectToMongo()
    const db = mongo.db(process.env.DATABASE_NAME)
    const transactionsCollection = db.collection('transactions')
    const accountsCollection = db.collection('accounts')
    const usersCollection = db.collection('users')
    const cardsCollection = db.collection('cards')
    const rewardsCollection = db.collection('rewards')
    const spendSummariesCollection = db.collection('spend_summaries')
    const spendCategoriesCollection = db.collection('spend_categories')
    const activationsCollection = db.collection('activations')
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
    let points = 0;
    let pointsRate = 0;
    let userActivated = true;
    let exceededSpendLimit = false;
    let spendOverCap = 0;
    let overagePointsRate = 0;
    try {
        const now = new Date(transaction.authorized_datetime);
        const thisYear = now.getFullYear().toString();
        console.log("thisYear: ", thisYear);
        const monthYear = formatMonthYear(now);
        console.log("monthYear: ", monthYear);
        const quarter = Math.ceil(now.getMonth() / 3);
        const half = Math.ceil(now.getMonth() / 6);
        const accountId = transaction.account_id;
        const account = await accountsCollection.findOne({ account_id: accountId });
        const user = await usersCollection.findOne({ user_id: account.user_id });
        console.log("user: ", user);
        const card = await cardsCollection.findOne({ card_id: account.card_id });
        overagePointsRate = card.default_point_rate;
        const spendAmount = transaction.amount;
        const merchant = transaction.merchant_name
        const plaidSpendCategory = transaction.personal_finance_category.detailed;
        console.log("plaidSpendCategory: ", plaidSpendCategory);
        var spendCategoryDocument = await spendCategoriesCollection.findOne({ plaid_categories: plaidSpendCategory });
        if(!spendCategoryDocument){
            spendCategoryDocument = await spendCategoriesCollection.findOne({ category: "everything_else" });
        }
        const spendCategory = spendCategoryDocument.category;
        console.log("spendCategory: ", spendCategory);

        //ADD LOGIC HERE TO SEE IF THIS IS A REBATABLE TRANSACTION 
        const transactionDescription = transaction.original_description;
        const creditReward = await rewardsCollection.findOne({
            card_id: card.card_id,
            description_on_statement: transactionDescription,
        });
        console.log("creditReward: ", creditReward);
        //IF CREDIT REWARD IS FOUND, THEN THIS MEANS THEY GOT MONEY BACK AUTOMATICALLY ON THEIR STATEMENT, SO NOT EARNING POINTS BUT MAY EVEN DEDUCT POINTS
        if(creditReward){
            if(creditReward.deducts_from_points){
                pointsRate = creditReward.rate;
                points = spendAmount * pointsRate
            }
            //UPDATE THE SPEND SUMMARY WITH THE CREDITS
            const creditType = creditReward.type;
            //NOTE: CREDITS THRU SPECIFIC TRAVEL PORTALS ARE TREATED AS MERCHANT CREDITS
            
            return {
                success: true,
                transaction_id: transaction.transaction_id,
                points: Math.round(points),
                points_rate: pointsRate,
                overage_points_rate: overagePointsRate,
                spend_over_cap: spendOverCap,
                is_credit_transaction: true,
                credit_type: creditType,
                spend_amount: spendAmount,
                spend_category: creditReward.category,
                reward_id: creditReward.reward_id,
                user_id: user.user_id
            }
        }
        console.log("spendAmount: ", spendAmount);
        if(spendAmount < 0){
            if("LOAN_DISBURSEMENTS" in plaidSpendCategory || "INCOME" in plaidSpendCategory || "LOAN_PAYMENTS" in plaidSpendCategory || "TRANSFER_IN" in plaidSpendCategory){
                return {
                    success: true,
                    transaction_id: transaction.transaction_id,
                    points: 0,
                    points_rate: 0,
                    overage_points_rate: 0,
                    spend_over_cap: 0,
                    spend_amount: spendAmount,
                    spend_category: "none",
                    reward_id: "none", 
                    user_id: user.user_id
                }
            }
            return {
                success: true,
                transaction_id: transaction.transaction_id,
                points: 0,
                points_rate: 0,
                overage_points_rate: 0,
                spend_over_cap: 0,
                is_credit_transaction: true,
                credit_type: "other",
                spend_amount: spendAmount,
                spend_category: spendCategory,
                reward_id: "other", 
                user_id: user.user_id
            }
        }
        //NEED TO CHECK IF IT'S AN ANNUAL FEE
        const annualFeeTransaction = await cardsCollection.findOne({
            card_id: card.card_id,
            annual_fee_statement_description: transactionDescription,
        });
        console.log("1")
        if(annualFeeTransaction){
            return {
                success: true,
                transaction_id: transaction.transaction_id,
                points: 0,
                points_rate: 0,
                overage_points_rate: 0,
                spend_over_cap: 0,
                is_annual_fee_transaction: true,
                spend_amount: spendAmount,
                spend_category: "annual_fee",
                user_id: user.user_id,
                reward_id: "none"
            }
        }
        console.log("2")
        let merchantReward = await rewardsCollection.findOne({ 
            card_id: card.card_id,
            merchants: merchant, 
            $or:[
                {start_date: {$lte: now}},
                {start_date: null}
            ],
            $or:[
                {end_date: {$gte: now}},
                {end_date: null}
            ],
        });

        let categoryReward = await rewardsCollection.findOne({ 
            card_id: card.card_id,
            plaid_categories: plaidSpendCategory,
            $or:[
                {start_date: {$lte: now}},
                {start_date: null}
            ],
            $or:[
                {end_date: {$gte: now}},
                {end_date: null}
            ],
        });

        let isMerchantReward = merchantReward !== null;
        let reward = merchantReward || categoryReward;
        let perTransactionMinimumMet = true;

        if (reward) {
            //CHECK IF USER ACTIVATED REWARD IF NECESSARY
            if(reward.activation_required){
                const activation = await activationsCollection.findOne({
                    reward_id: reward.reward_id,
                    user_id: user.user_id,
                    activated: true
                })
                userActivated = activation !== null;
            }
            //IF REQUIRED ACTIVATION IS NOT MET, WE NEED TO CHECK IF THERE'S A NO ACTIVATION REWARD
            if(!userActivated){
                merchantReward = await rewardsCollection.findOne({ 
                    card_id: card.card_id,
                    merchants: merchant, 
                    activation_required: false,
                    $or:[
                        {start_date: {$lte: now}},
                        {start_date: null}
                    ],
                    $or:[
                        {end_date: {$gte: now}},
                        {end_date: null}
                    ],
                });
        
                categoryReward = await rewardsCollection.findOne({ 
                    card_id: card.card_id,
                    plaid_categories: plaidSpendCategory,
                    activation_required: false,
                    $or:[
                        {start_date: {$lte: now}},
                        {start_date: null}
                    ],
                    $or:[
                        {end_date: {$gte: now}},
                        {end_date: null}
                    ],
                });
                isMerchantReward = merchantReward !== null;
                reward = merchantReward || categoryReward;
                if(!reward){
                    return {
                        success: true,
                        transaction_id: transaction.transaction_id,
                        points: card.default_point_rate * spendAmount,
                        points_rate: card.default_point_rate,
                        overage_points_rate: card.default_point_rate,
                        spend_over_cap: 0,
                        spend_amount: spendAmount,
                        spend_category: spendCategory,
                        reward_id: "none",
                        user_id: user.user_id
                    }
                }
            }
            console.log("3")
            console.log("reward: ", JSON.stringify(reward));
            if(reward.per_transaction_minimum && spendAmount < reward.per_transaction_minimum){
                reward = isMerchantReward ? categoryReward : {rate: card.default_point_rate}
                perTransactionMinimumMet = false;
            }
            console.log("4")
            //CHECK IF THERE'S A MONTHLY SPEND CAP
            if(reward.spend_cap_monthly){
                const spendSummary = await spendSummariesCollection.findOne({
                        user_id: user.user_id,
                        month_year: monthYear,
                    },
                    {
                        _id: 0, // Exclude the _id field if not needed
                        [`spend_by_account.${accountId}`]: 1 // Include only the nested data for account "aaa"
                    }
                )
                let totalSpend = spendSummary ? 
                    (isMerchantReward ? 
                        spendSummary.spend_by_account[accountId]?.spend_by_merchant[merchant] || 0 
                        : spendSummary.spend_by_account[accountId]?.spend_by_category[spendCategory] || 0)
                    : 0;
                if(totalSpend > reward.spend_cap_monthly){
                    if(isMerchantReward){
                        //if it's a merchant reward that we exceeded, 
                        //we need to check if the category reward is available
                        totalSpend = spendSummary.spend_by_account[accountId]?.spend_by_category[spendCategory] || 0
                        reward = categoryReward;
                        if(reward){
                            if(totalSpend > reward.spend_cap_monthly){
                                exceededSpendLimit = true;
                            } else {
                                //we are under the category cap, so just need to see if there's any overage
                                if((totalSpend + spendAmount) > reward.spend_cap_monthly){
                                    spendOverCap = spendAmount + totalSpend - reward.spend_cap_monthly;
                                }
                            }
                        } else {
                            //no category reward, so we exceed the spend limit
                            exceededSpendLimit = true;
                        }
                    } else {
                        exceededSpendLimit = true;
                    }
                } else {
                    //previous total spend is less than the cap, 
                    // so we need to check if the new total is over the cap
                    //besides that, exceededSpendLimit is false since we're not over the cap
                    if((totalSpend + spendAmount) > reward.spend_cap_monthly){
                        spendOverCap = spendAmount + totalSpend - reward.spend_cap_monthly;
                        if(categoryReward){
                            overagePointsRate = categoryReward.rate;
                        }
                    }
                }
            }
            console.log("5")
            //CHECK IF THERE'S A QUARTERLY SPEND CAP
            if(!exceededSpendLimit && reward.spend_cap_quarterly){
                const spendSummaries = await spendSummariesCollection.find({
                        user_id: user.user_id,
                        month_year: {$in: quarters[quarter]},
                    },
                    {
                        _id: 0, // Exclude the _id field if not needed
                        [`spend_by_account.${accountId}`]: 1 // Include only the nested data for account "aaa"
                    }
                ).toArray();
                let totalSpend = 0
                if(isMerchantReward){
                    totalSpend = spendSummaries.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_merchant[merchant] || 0
                    },0)
                    if(totalSpend > reward.spend_cap_quarterly){
                        reward = categoryReward;
                        if(reward){
                            totalSpend = spendSummaries.reduce((acc, summary) => {
                                return acc + summary.spend_by_account[accountId]?.spend_by_category[spendCategory] || 0
                            },0)
                            if(totalSpend > reward.spend_cap_quarterly){
                                exceededSpendLimit = true;
                            } else {
                                if((totalSpend + spendAmount) > reward.spend_cap_quarterly){
                                    spendOverCap = spendAmount + totalSpend - reward.spend_cap_quarterly;
                                }
                            }
                        }
                    } else {
                        if((totalSpend + spendAmount) > reward.spend_cap_quarterly){
                            spendOverCap = spendAmount + totalSpend - reward.spend_cap_quarterly;
                            if(categoryReward){
                                overagePointsRate = categoryReward.rate;
                            }
                        }
                    }
                } else {
                    totalSpend = spendSummaries.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_category[spendCategory] || 0
                    },0)
                    if(totalSpend > reward.spend_cap_quarterly){
                        exceededSpendLimit = true;
                    } else {
                        if((totalSpend + spendAmount) > reward.spend_cap_quarterly){
                            spendOverCap = spendAmount + totalSpend - reward.spend_cap_quarterly;
                        }
                    }
                }
            }
            console.log("6")
            //CHECK IF THERE'S A HALF YEARLY SPEND CAP
            if(!exceededSpendLimit && reward.spend_cap_biannual){
                const spendSummaries = await spendSummariesCollection.find({
                        user_id: user.user_id,
                        month_year: {$in: halves[half]},
                    },
                    {
                        _id: 0, // Exclude the _id field if not needed
                        [`spend_by_account.${accountId}`]: 1 // Include only the nested data for account "aaa"
                    }
                ).toArray();
                let totalSpend = 0
                if(isMerchantReward){
                    totalSpend = spendSummaries.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_merchant[merchant] || 0
                    },0)
                    if(totalSpend > reward.spend_cap_biannual){
                        reward = categoryReward;
                        if(reward){
                            totalSpend = spendSummaries.reduce((acc, summary) => {
                                return acc + summary.spend_by_account[accountId]?.spend_by_category[spendCategory] || 0
                            },0)
                            if(totalSpend > reward.spend_cap_biannual){
                                exceededSpendLimit = true;
                            } else {
                                if((totalSpend + spendAmount) > reward.spend_cap_biannual){
                                    spendOverCap = spendAmount + totalSpend - reward.spend_cap_biannual;
                                }
                            }
                        }
                    } else {
                        if((totalSpend + spendAmount) > reward.spend_cap_biannual){
                            spendOverCap = spendAmount + totalSpend - reward.spend_cap_biannual;
                            if(categoryReward){
                                overagePointsRate = categoryReward.rate;
                            }
                        }
                    }
                } else {
                    totalSpend = spendSummaries.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_category[spendCategory] || 0
                    },0)
                    if(totalSpend > reward.spend_cap_biannual){
                        exceededSpendLimit = true;
                    } else {
                        if((totalSpend + spendAmount) > reward.spend_cap_biannual){
                            spendOverCap = spendAmount + totalSpend - reward.spend_cap_biannual;
                        }
                    }
                }
            }
            console.log("7")
            //CHECK IF THERE'S A ANNUAL SPEND CAP
            if(!exceededSpendLimit && reward.spend_cap_annual){
                console.log("thisYear: ", thisYear);
                const spendSummaries = await spendSummariesCollection.find({
                        user_id: user.user_id,
                        month_year: {$regex: `${thisYear}`},
                    },
                    {
                        _id: 0, // Exclude the _id field if not needed
                        [`spend_by_account.${accountId}`]: 1 // Include only the nested data for account "aaa"
                    }
                ).toArray();
                console.log("spendSummaries: ", spendSummaries);
                let totalSpend = 0
                if(isMerchantReward){
                    totalSpend = spendSummaries.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_merchant[merchant] || 0
                    },0)
                    if(totalSpend > reward.spend_cap_annual){
                        reward = categoryReward;
                        if(reward){
                            totalSpend = spendSummaries.reduce((acc, summary) => {
                                return acc + summary.spend_by_account[accountId]?.spend_by_category[spendCategory] || 0
                            },0)
                            if(totalSpend > reward.spend_cap_annual){
                                exceededSpendLimit = true;
                            } else {
                                if((totalSpend + spendAmount) > reward.spend_cap_annual){
                                    spendOverCap = spendAmount + totalSpend - reward.spend_cap_annual;
                                }
                            }
                        }
                    } else {
                        if((totalSpend + spendAmount) > reward.spend_cap_annual){
                            spendOverCap = spendAmount + totalSpend - reward.spend_cap_annual;
                            if(categoryReward){
                                overagePointsRate = categoryReward.rate;
                            }
                        }
                    }
                } else {
                    totalSpend = spendSummaries.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_category[spendCategory] || 0
                    },0)
                    if(totalSpend > reward.spend_cap_annual){
                        exceededSpendLimit = true;
                    } else {
                        if((totalSpend + spendAmount) > reward.spend_cap_annual){
                            spendOverCap = spendAmount + totalSpend - reward.spend_cap_annual;
                        }
                    }
                }
            }
            console.log("8")
            //CHECK IF THERE'S A ALL-TIME SPEND CAP (within reward start/end window)
            if(!exceededSpendLimit && reward.spend_cap_all_time){
                const spendSummaries = await spendSummariesCollection.find({
                        user_id: user.user_id,
                        ...buildRewardWindowMonthYearFilter(reward, now),
                    },
                    {
                        _id: 0, // Exclude the _id field if not needed
                        [`spend_by_account.${accountId}`]: 1 // Include only the nested data for account "aaa"
                    }
                ).toArray();
                console.log("spendSummaries: ", spendSummaries);
                let totalSpend = 0
                if(isMerchantReward){
                    totalSpend = spendSummaries.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_merchant[merchant] || 0
                    },0)
                    if(totalSpend > reward.spend_cap_all_time){
                        reward = categoryReward;
                        if(reward){
                            totalSpend = spendSummaries.reduce((acc, summary) => {
                                return acc + summary.spend_by_account[accountId]?.spend_by_category[spendCategory] || 0
                            },0)
                            if(totalSpend > reward.spend_cap_all_time){
                                exceededSpendLimit = true;
                            } else {
                                if((totalSpend + spendAmount) > reward.spend_cap_all_time){
                                    spendOverCap = spendAmount + totalSpend - reward.spend_cap_all_time;
                                }
                            }
                        }
                    } else {
                        if((totalSpend + spendAmount) > reward.spend_cap_all_time){
                            spendOverCap = spendAmount + totalSpend - reward.spend_cap_all_time;
                            if(categoryReward){
                                overagePointsRate = categoryReward.rate;
                            }
                        }
                    }
                } else {
                    totalSpend = spendSummaries.reduce((acc, summary) => {
                        return acc + summary.spend_by_account[accountId]?.spend_by_category[spendCategory] || 0
                    },0)
                    if(totalSpend > reward.spend_cap_all_time){
                        exceededSpendLimit = true;
                    } else {
                        if((totalSpend + spendAmount) > reward.spend_cap_all_time){
                            spendOverCap = spendAmount + totalSpend - reward.spend_cap_all_time;
                        }
                    }
                }
            }
            console.log("9")
            pointsRate = exceededSpendLimit ? card.default_point_rate : reward.rate

            points = spendOverCap > 0 ? spendOverCap * overagePointsRate + (spendAmount - spendOverCap) * pointsRate : pointsRate * spendAmount;
            

        } else {
            pointsRate = card.default_point_rate;
            points = pointsRate * spendAmount;
        }

        await mongo.close();
        return {
            success: true,
            transaction_id: transaction.transaction_id,
            points: Math.round(points),
            points_rate: pointsRate,
            overage_points_rate: overagePointsRate,
            spend_over_cap: spendOverCap,
            reward_type: isMerchantReward ? 'merchant' : 'category',
            spend_amount: spendAmount,
            spend_category: spendCategory ? spendCategory : 'everything_else',
            per_transaction_minimum_met: perTransactionMinimumMet,
            user_id: user.user_id,
            reward_id: reward ? reward.reward_id : "none"
        }
        
    } catch(err) {
        console.log("error updating transaction with points: ", err.message);
        return {
            error: err.message,
        };
    }
}


if (require.main === module) {
    const transaction = {
        transaction_id: "123",
        authorized_datetime: "2026-05-15T00:00:00Z",
        account_id: "aaa",
        amount: 74,
        merchant_name: "Natural Grocers",
        personal_finance_category: {detailed: "FOOD_AND_DRINK_GROCERIES"},
    };

    (async () => {
        try {
            const result = await calculatePointsForTransaction(transaction);
            console.log(result);
        } catch (err) {
            console.error(err);
            process.exitCode = 1;
        }
    })();
}



module.exports = calculatePointsForTransaction;