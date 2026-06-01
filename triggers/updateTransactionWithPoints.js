const { calculatePointsForTransaction } = require('../calculatePointsForTransaction');

exports = async function (changeEvent) {
    const transaction = changeEvent.fullDocument
    const serviceName = "mongodb-atlas";
    const database = "cc_tracker_main";
    const transactionsCollection = context.services.get(serviceName).db(database).collection("transactions");
    const accountsCollection = context.services.get(serviceName).db(database).collection("accounts");
    const usersCollection = context.services.get(serviceName).db(database).collection("users");
    const activationsCollection = context.services.get(serviceName).db(database).collection("activations");
    const rewardsCollection = context.services.get(serviceName).db(database).collection("rewards");
    const spendSummariesCollection = context.services.get(serviceName).db(database).collection("spend_summaries");
    const cardsCollection = context.services.get(serviceName).db(database).collection("cards");

    try{
        const accountId = transaction.account_id;
        const pointsResult = await calculatePointsForTransaction(transaction);
        await transactionsCollection.updateOne({
            transaction_id: transaction.transaction_id
        }, {
            $set: {
                points: pointsResult.points,
                points_rate: pointsResult.points_rate,
                overage_points_rate: pointsResult.overage_points_rate,
                spend_over_cap: pointsResult.spend_over_cap,
                category: pointsResult.spend_category,
            }
        }, {
            upsert: true
        })

        const creditReward = pointsResult.is_credit_transaction ? pointsResult.credit_type : null;
        let setSpendSummaryPayload = null;
        if(creditReward){
            setSpendSummaryPayload = creditType === 'merchantCredit' ? {
                $set:{
                    $inc: {
                        [`spend_by_account.${accountId}.spend_by_merchant.${pointsResult.merchant}`]: pointsResult.spend_amount,
                        [`spend_by_account.${accountId}.spend_by_category.${pointsResult.spend_category}`]: pointsResult.spend_amount,
                        [`spend_by_account.${accountId}.points_by_merchant.${pointsResult.merchant}`]: pointsResult.points,
                        [`spend_by_account.${accountId}.points_by_category.${pointsResult.spend_category}`]: pointsResult.points,
                        [`spend_by_account.${accountId}.credits_by_merchant.${pointsResult.merchant}`]: pointsResult.spend_amount
                    },
                }
            } : {
                $set:{
                    $inc: {
                        [`spend_by_account.${accountId}.spend_by_category.${pointsResult.spend_category}`]: pointsResult.spend_amount,
                        [`spend_by_account.${accountId}.credits_by_category.${pointsResult.reward_id}`]: pointsResult.spend_amount,
                        [`spend_by_account.${accountId}.points_by_category.${pointsResult.spend_category}`]: pointsResult.points,
                    },
                }
            }
        } else if(pointsResult.is_annual_fee_transaction){
            //update the account with the next annual fee date
            const nextAnnualFeeDate = new Date(transaction.authorized_datetime);
            nextAnnualFeeDate.setFullYear(nextAnnualFeeDate.getFullYear() + 1);
            await accountsCollection.updateOne({
                account_id: accountId
            }, {
                $set: {
                    next_annual_fee_date: nextAnnualFeeDate
                }
            })
        } else {
            if(pointsResult.spend_category && pointsResult.spend_category === "none"){ 
            } else {
                setSpendSummaryPayload = pointsResult.reward_type === 'merchant' ? {
                    $set:{
                        $inc: {
                            [`spend_by_account.${accountId}.spend_by_merchant.${pointsResult.merchant}`]: pointsResult.spend_amount,
                            [`spend_by_account.${accountId}.spend_by_category.${pointsResult.spend_category}`]: pointsResult.spend_amount,
                            [`spend_by_account.${accountId}.points_by_category.${pointsResult.spend_category}`]: pointsResult.points,
                            [`spend_by_account.${accountId}.points_by_merchant.${pointsResult.merchant}`]: pointsResult.points,
                        },
                    }
                } : {
                    $set:{
                        $inc: {
                            [`spend_by_account.${accountId}.spend_by_category.${pointsResult.spend_category}`]: pointsResult.spend_amount,
                            [`spend_by_account.${accountId}.points_by_category.${pointsResult.spend_category}`]: pointsResult.points,
                        },
                    }
                }
            }
        }

        await spendSummariesCollection.updateOne({
            user_id: user.user_id,
            month_year: monthYear
        }, setSpendSummaryPayload, {
            upsert: true
        })

        //Check if a better card could have been used for this transaction
        //check rewards to see if a certain merchant reward existed for a certain card 
        
    } catch(err) {
        console.log("error performing mongodb write: ", err.message);
    }
  };

  