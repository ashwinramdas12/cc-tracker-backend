const { calculatePointsForTransaction } = require('../calculatePointsForTransaction');
const { checkForBetterCard } = require('../checkForBetterCard');
const { checkForRewardToActivate } = require('../checkForRewardToActivate');
const { formatMonthYear } = require('../utility');
exports = async function (changeEvent) {
    const transaction = changeEvent.fullDocument
    const serviceName = "main";
    const database = "cc_tracker_main";
    const transactionsCollection = context.services.get(serviceName).db(database).collection("transactions");
    const accountsCollection = context.services.get(serviceName).db(database).collection("accounts");
    const spendSummariesCollection = context.services.get(serviceName).db(database).collection("spend_summaries");
    const now = new Date(transaction.authorized_datetime);
    const monthYear = formatMonthYear(now);
    console.log("monthYear: ", monthYear);
    if(!transaction.update_from_plaid){
        return;
    }
    try{
        const accountId = transaction.account_id;
        let originalPoints = 0;
        let originalSpendAmount = 0;
        if(transaction.type === "modified"){
            const originalTransaction = await transactionsCollection.findOne({
                transaction_id: transaction.transaction_id
            });
            originalPoints = originalTransaction.points;
            originalSpendAmount = originalTransaction.amount;
        }
        const pointsResult = await calculatePointsForTransaction(transaction);
        const updatePayload = {
            points: pointsResult.points,
            points_rate: pointsResult.points_rate,
            overage_points_rate: pointsResult.overage_points_rate,
            spend_over_cap: pointsResult.spend_over_cap,
            category: pointsResult.spend_category,
            per_transaction_minimum_met: pointsResult.per_transaction_minimum_met,
            user_id: pointsResult.user_id,
            reward_type: pointsResult.reward_type,
            is_credit_transaction: pointsResult.is_credit_transaction,
            reward_id: pointsResult.reward_id,
            update_from_plaid:false
          }

        await transactionsCollection.updateOne({
            transaction_id: transaction.transaction_id
        }, {
            $set: updatePayload
        }, {
            upsert: true
        })

        const newPoints = pointsResult.points - originalPoints;
        const newSpendAmount = parseFloat(pointsResult.spend_amount) - parseFloat(originalSpendAmount);

        const creditReward = pointsResult.is_credit_transaction ? pointsResult.credit_type : null;
        let setSpendSummaryPayload = null;
        if(newPoints > 0){
            if(creditReward){
                setSpendSummaryPayload = pointsResult.credit_type === 'merchantCredit' ? {
                    $inc: {
                        [`spend_by_account.${accountId}.spend_by_merchant.${pointsResult.merchant}`]: newSpendAmount,
                        [`spend_by_account.${accountId}.spend_by_category.${pointsResult.spend_category}`]: newSpendAmount,
                        [`spend_by_account.${accountId}.points_by_merchant.${pointsResult.merchant}`]: newPoints,
                        [`spend_by_account.${accountId}.points_by_category.${pointsResult.spend_category}`]: newPoints,
                        [`spend_by_account.${accountId}.credits_by_merchant.${pointsResult.merchant}`]: newSpendAmount
                    }
                } : {
                    $inc: {
                        [`spend_by_account.${accountId}.spend_by_category.${pointsResult.spend_category}`]: newSpendAmount,
                        [`spend_by_account.${accountId}.credits_by_category.${pointsResult.reward_id}`]: newSpendAmount,
                        [`spend_by_account.${accountId}.points_by_category.${pointsResult.spend_category}`]: newPoints,
                    }
                }
            } else if(pointsResult.is_annual_fee_transaction){
                //update the account with the next annual fee date
                const nextAnnualFeeDate = new Date(transaction.authorized_datetime);
                nextAnnualFeeDate.setFullYear(nextAnnualFeeDate.getFullYear() + 1);
                const updateAccountPayload = {
                    next_annual_fee_date: nextAnnualFeeDate
                }
                
                const originalAccount = await accountsCollection.findOne({
                    account_id: accountId
                });
                //if no opened date, set it to 2 years ago
                if(!originalAccount.opened_date){
                    const date = new Date(transaction.authorized_datetime);
                    date.setFullYear(date.getFullYear() - 2);
                    updateAccountPayload.opened_date = date;
                }
                await accountsCollection.updateOne({
                    account_id: accountId
                }, {
                    $set: updateAccountPayload
                })
            } else {
                if(pointsResult.spend_category && pointsResult.spend_category === "none"){ 
                } else {
                    setSpendSummaryPayload = pointsResult.reward_type === 'merchant' ? {
                        $inc: {
                            [`spend_by_account.${accountId}.spend_by_merchant.${pointsResult.merchant}`]: newSpendAmount,
                            [`spend_by_account.${accountId}.spend_by_category.${pointsResult.spend_category}`]: newSpendAmount,
                            [`spend_by_account.${accountId}.points_by_category.${pointsResult.spend_category}`]: newPoints,
                            [`spend_by_account.${accountId}.points_by_merchant.${pointsResult.merchant}`]: newPoints,
                        }
                    } : {
                        $inc: {
                            [`spend_by_account.${accountId}.spend_by_category.${pointsResult.spend_category}`]: newSpendAmount,
                            [`spend_by_account.${accountId}.points_by_category.${pointsResult.spend_category}`]: newPoints,
                        }
                    }
                }
            }

            await spendSummariesCollection.updateOne({
                user_id: pointsResult.user_id,
                month_year: monthYear
            }, setSpendSummaryPayload, {
                upsert: true
            })
        }
        if(transaction.type === "modified"){
            return;
        }

        //Check if a better card could have been used for this transaction
        const betterCardId = await checkForBetterCard({...transaction, ...updatePayload});
        if(betterCardId){
            await transactionsCollection.updateOne({
                transaction_id: transaction.transaction_id
            }, {
                $set: {
                    better_card_available: betterCardId
                }
            })
        }
        //check rewards to see if a certain merchant reward exists that needs to be activated for the card used
        const rewardToActivateId = await checkForRewardToActivate({...transaction, ...updatePayload});
        if(rewardToActivateId){
            await transactionsCollection.updateOne({
                transaction_id: transaction.transaction_id
            }, {
                $set: {
                    better_reward_available: rewardToActivateId
                }
            })
        }
    } catch(err) {
        console.log("error performing mongodb write: ", err.message);
    }
  };

  