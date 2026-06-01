const { connectToMongo, closeMongo } = require('./connectToMongo');
//TO DO
// SHOW WHEN ANNUAL MEMBERSHIP FEE HITS
// SHOW WHEN ANNUAL TRAVEL CREDIT EXPIRES

const monthYearLabel = (d) => {
    const date = d instanceof Date ? d : new Date(d);
    return date.toLocaleString("default", { month: "long", year: "numeric" });
};

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

const CAP_FIELDS_MONTH_ORDER = [
    "spend_cap_monthly",
    "spend_cap_quarterly",
    "spend_cap_biannual",
    "spend_cap_annual",
];

const CAP_FIELDS_YEAR_ORDER = [
    "spend_cap_annual",
    "spend_cap_biannual",
    "spend_cap_quarterly",
    "spend_cap_monthly",
];

const allMonthYearLabelsInYear = (yearNum) =>
    Object.values(quarters)
        .flat()
        .map((month) => `${month} ${yearNum}`);

const parseMonthYear = (label) => {
    const date = new Date(label);
    return Number.isNaN(date.getTime()) ? null : date;
};

/** Calendar month immediately before `month_year` (e.g. "May 2026" → "April 2026"). */
const previousMonthYearLabel = (month_year) => {
    const anchor = parseMonthYear(month_year);
    if (!anchor) return null;
    const prev = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
    return monthYearLabel(prev);
};

/** First non-null spend cap field for this reward (month vs year priority). */
const getActiveCapField = (reward, yearMode) => {
    const order = yearMode ? CAP_FIELDS_YEAR_ORDER : CAP_FIELDS_MONTH_ORDER;
    return order.find((field) => reward[field] != null) ?? null;
};

/** month_year labels to include for a cap window anchored on a calendar month. */
const getMonthYearLabelsForCap = (anchorMonthYear, capField) => {
    const anchor = parseMonthYear(anchorMonthYear);
    if (!anchor || !capField) return [];

    const year = anchor.getFullYear();
    const monthIndex = anchor.getMonth();

    if (capField === "spend_cap_monthly") {
        return [anchorMonthYear];
    }
    if (capField === "spend_cap_quarterly") {
        const quarter = Math.floor(monthIndex / 3) + 1;
        return quarters[quarter].map((month) => `${month} ${year}`);
    }
    if (capField === "spend_cap_biannual") {
        const half = monthIndex < 6 ? 1 : 2;
        return halves[half].map((month) => `${month} ${year}`);
    }
    if (capField === "spend_cap_annual") {
        return allMonthYearLabelsInYear(year);
    }
    return [];
};

/** Year dashboard: cap period within the selected calendar year. */
const getMonthYearLabelsForYearView = (yearNum, capField) => {
    if (!capField) return [];
    // For a year-wide view, each cap level uses the full year's summaries.
    return allMonthYearLabelsInYear(yearNum);
};

const sumMerchantSpendForPeriod = (spendSummaryDocs, accountId, merchant, monthYearLabels) => {
    const labelSet = new Set(monthYearLabels);
    return spendSummaryDocs.reduce((total, doc) => {
        if (!labelSet.has(doc.month_year)) return total;
        const bucket = doc.spend_by_account?.[accountId];
        if (!bucket?.credits_by_merchant){
            if (!bucket?.spend_by_merchant) return total;
            return total + (bucket.spend_by_merchant[merchant] || 0);
        } else {
            return total + (bucket.credits_by_merchant[merchant] || 0);
        }
    }, 0);
};

/**
 * For credit rewards on each account's card, sum merchant spend for the cap window
 * that matches each reward's spend cap frequency.
 */
const attachCreditMerchantSpend = async (db, accounts, { user_id, month_year, year }) => {
    const hasYear = year !== undefined && year !== null && String(year).trim() !== "";
    const anchorMonthYear = month_year || monthYearLabel(new Date());
    const yearNum = hasYear
        ? parseInt(String(year), 10)
        : (parseMonthYear(anchorMonthYear)?.getFullYear() ?? new Date().getFullYear());

    if (!Number.isFinite(yearNum)) {
        return accounts.map((account) => ({ ...account, credit_merchant_spend: {} }));
    }

    const cardIds = [...new Set(accounts.map((a) => a.card_id).filter(Boolean))];
    if (cardIds.length === 0) {
        return accounts.map((account) => ({ ...account, credit_merchant_spend: {} }));
    }

    const creditRewards = await db
        .collection("rewards")
        .find({ card_id: { $in: cardIds }, $or: [{ type: "merchantCredit" }, { type: "credit" }] })
        .toArray();

    const rewardsByCardId = creditRewards.reduce((byCard, reward) => {
        if (!byCard[reward.card_id]) byCard[reward.card_id] = [];
        byCard[reward.card_id].push(reward);
        return byCard;
    }, {});

    const spendSummaryDocs = await db
        .collection("spend_summaries")
        .find({
            user_id,
            month_year: { $regex: ` ${yearNum}$` },
        })
        .toArray();

    

    return accounts.map((account) => {
        const cardRewards = rewardsByCardId[account.card_id] || [];
        const credit_merchant_spend = {};
        const credit_category_spend = {};
        for (const reward of cardRewards) {
            const capField = getActiveCapField(reward, hasYear);
            if (!capField || !Array.isArray(reward.merchants)) continue;

            const monthYearLabels = hasYear
                ? getMonthYearLabelsForYearView(yearNum, capField)
                : getMonthYearLabelsForCap(anchorMonthYear, capField);

            for (const merchant of reward.merchants) {
                if (!merchant) continue;
                credit_merchant_spend[merchant] = sumMerchantSpendForPeriod(
                    spendSummaryDocs,
                    account.account_id,
                    merchant,
                    monthYearLabels
                );
            }

            credit_category_spend[reward.reward_id] = spendSummaryDocs.reduce((total, doc) => {
                if (!monthYearLabels.includes(doc.month_year)) return total;
                const bucket = doc.spend_by_account?.[account.account_id];
                if (!bucket?.credits_by_category) return total;
                return total + (bucket.credits_by_category[reward.reward_id] || 0);   
            }, 0);
        }

        return { ...account, credit_merchant_spend, credit_category_spend };
    });
};

const accountKeyLet = { uid: "$user_id", acct_id: "$account_id" };

/**
 * Fold an array of { account_spend: { [field]: { key: number } } } into one summed map for `field`.
 */
const spendSummaryLookupMonth = (monthYearTarget, asName) => ({
    $lookup: {
        from: "spend_summaries",
        let: accountKeyLet,
        pipeline: [
            {
                $match: {
                    $expr: {
                        $and: [
                            { $eq: ["$user_id", "$$uid"] },
                            { $eq: ["$month_year", monthYearTarget] },
                        ],
                    },
                },
            },
            {
                $project: {
                    month_year: 1,
                    account_spend: {
                        $ifNull: [
                            { $getField: { field: "$$acct_id", input: "$spend_by_account" } },
                            null,
                        ],
                    },
                },
            },
            { $match: { account_spend: { $ne: null } } },
        ],
        as: asName,
    },
});

const spendSummaryFromMonthRaw = (rawArrayField, outputField) => ({
    $addFields: {
        [outputField]: {
            $cond: {
                if: { $gt: [{ $size: rawArrayField }, 0] },
                then: {
                    $mergeObjects: [
                        { month_year: { $arrayElemAt: [`${rawArrayField}.month_year`, 0] } },
                        { $arrayElemAt: [`${rawArrayField}.account_spend`, 0] },
                    ],
                },
                else: null,
            },
        },
    },
});

const spendSummaryLookupYear = (yearNum, asName) => ({
    $lookup: {
        from: "spend_summaries",
        let: accountKeyLet,
        pipeline: [
            {
                $match: {
                    $expr: {
                        $and: [
                            { $eq: ["$user_id", "$$uid"] },
                            {
                                $regexMatch: {
                                    input: "$month_year",
                                    regex: ` ${yearNum}$`,
                                },
                            },
                        ],
                    },
                },
            },
            {
                $project: {
                    month_year: 1,
                    account_spend: {
                        $ifNull: [
                            { $getField: { field: "$$acct_id", input: "$spend_by_account" } },
                            null,
                        ],
                    },
                },
            },
            { $match: { account_spend: { $ne: null } } },
        ],
        as: asName,
    },
});

const spendSummaryFromYearRaw = (rawArrayField, outputField, yearNum) => ({
    $addFields: {
        [outputField]: {
            $cond: {
                if: { $gt: [{ $size: rawArrayField }, 0] },
                then: {
                    year: { $literal: yearNum },
                    points_by_category: mergeMapsOverRaw(rawArrayField, "points_by_category"),
                    points_by_merchant: mergeMapsOverRaw(rawArrayField, "points_by_merchant"),
                    spend_by_merchant: mergeMapsOverRaw(rawArrayField, "spend_by_merchant"),
                    spend_by_category: mergeMapsOverRaw(rawArrayField, "spend_by_category"),
                },
                else: null,
            },
        },
    },
});

const mergeMapsOverRaw = (rawArrayRef, field) => ({
    $reduce: {
        input: rawArrayRef,
        initialValue: {},
        in: {
            $reduce: {
                input: {
                    $objectToArray: {
                        $ifNull: [`$$this.account_spend.${field}`, {}],
                    },
                },
                initialValue: "$$value",
                in: {
                    $mergeObjects: [
                        "$$value",
                        {
                            $arrayToObject: [
                                [
                                    {
                                        k: "$$this.k",
                                        v: {
                                            $add: [
                                                {
                                                    $ifNull: [
                                                        {
                                                            $getField: {
                                                                field: "$$this.k",
                                                                input: "$$value",
                                                            },
                                                        },
                                                        0,
                                                    ],
                                                },
                                                "$$this.v",
                                            ],
                                        },
                                    },
                                ],
                            ],
                        },
                    ],
                },
            },
        },
    },
});

/** Same sub-tracker rollup as month variant (unchanged behavior). */
const subTrackerLookupStages = () => [
    {
        $lookup: {
            from: "spend_summaries",
            let: {
                ...accountKeyLet,
                has_active_sub: {
                    $cond: {
                        if: { $gt: ["$sub_tracker.ending_date", "$$NOW"] },
                        then: true,
                        else: false,
                    },
                },
            },
            pipeline: [
                {
                    $match: {
                        $expr: {
                            $and: [
                                { $eq: ["$$has_active_sub", true] },
                                { $eq: ["$user_id", "$$uid"] },
                            ],
                        },
                    },
                },
                {
                    $project: {
                        category_total: {
                            $reduce: {
                                input: {
                                    $objectToArray: {
                                        $ifNull: [
                                            {
                                                $getField: {
                                                    field: "spend_by_category",
                                                    input: {
                                                        $getField: {
                                                            field: "$$acct_id",
                                                            input: "$spend_by_account",
                                                        },
                                                    },
                                                },
                                            },
                                            {},
                                        ],
                                    },
                                },
                                initialValue: 0,
                                in: { $add: ["$$value", "$$this.v"] },
                            },
                        },
                    },
                },
            ],
            as: "sub_spend_docs",
        },
    },
    {
        $addFields: {
            total_spend_for_sub: {
                $cond: {
                    if: { $gt: ["$sub_tracker.ending_date", "$$NOW"] },
                    then: { $sum: "$sub_spend_docs.category_total" },
                    else: "$$REMOVE",
                },
            },
        },
    },
    { $unset: ["sub_spend_docs"] },
];

/** Join cards collection on account.card_id === card.card_id */
const cardDetailsLookupStages = () => [
    {
        $lookup: {
            from: "cards",
            localField: "card_id",
            foreignField: "card_id",
            as: "_cardDetailsArr",
        },
    },
    {
        $addFields: {
            cardDetails: { $arrayElemAt: ["$_cardDetailsArr", 0] },
        },
    },
    { $unset: ["_cardDetailsArr"] },
];

const accountsDetailedAggregation = (user_id, month_year) => {
    const monthYearNow = month_year || monthYearLabel(new Date());
    const monthYearPrevious = previousMonthYearLabel(monthYearNow);

    return [
        { $match: { user_id } },
        spendSummaryLookupMonth(monthYearNow, "spend_summary_raw"),
        spendSummaryLookupMonth(monthYearPrevious, "spend_summary_previous_raw"),
        spendSummaryFromMonthRaw("$spend_summary_raw", "spend_summary"),
        spendSummaryFromMonthRaw("$spend_summary_previous_raw", "spend_summary_previous_period"),
        ...subTrackerLookupStages(),
        { $unset: ["spend_summary_raw", "spend_summary_previous_raw"] },
        // ...cardDetailsLookupStages(),
    ];
};

/**
 * Same as month mode, but spend_summary rolls up all months in `year`:
 * sums numeric values per key for spend_by_category, spend_by_merchant, points_by_category, points_by_merchant.
 */
const accountsDetailedAggregationByYear = (user_id, year) => {
    const yearNum = typeof year === "number" ? year : parseInt(String(year), 10);
    if (!Number.isFinite(yearNum)) {
        throw new Error("year must be a number or numeric string");
    }

    const yearPrevious = yearNum - 1;

    return [
        { $match: { user_id } },
        spendSummaryLookupYear(yearNum, "spend_summary_raw"),
        spendSummaryLookupYear(yearPrevious, "spend_summary_previous_raw"),
        spendSummaryFromYearRaw("$spend_summary_raw", "spend_summary", yearNum),
        spendSummaryFromYearRaw(
            "$spend_summary_previous_raw",
            "spend_summary_previous_period",
            yearPrevious
        ),
        ...subTrackerLookupStages(),
        { $unset: ["spend_summary_raw", "spend_summary_previous_raw"] },
        // ...cardDetailsLookupStages(),
    ];
};

const accountsDetailed = async ({ user_id, month_year, year } = {}) => {
    if (!user_id || typeof user_id !== "string") {
        throw new Error("user_id is required");
    }

    const hasYear = year !== undefined && year !== null && String(year).trim() !== "";
    const hasMonthYear =
        month_year !== undefined && month_year !== null && String(month_year).trim() !== "";

    if (hasYear && hasMonthYear) {
        throw new Error("Pass only one of month_year or year");
    }

    const mongo = await connectToMongo();
    const db = mongo.db(process.env.DATABASE_NAME);

    const aggregation = hasYear
        ? accountsDetailedAggregationByYear(user_id, year)
        : accountsDetailedAggregation(user_id, hasMonthYear ? month_year : undefined);

    const accounts = await db.collection("accounts").aggregate(aggregation).toArray();
    return attachCreditMerchantSpend(db, accounts, { user_id, month_year, year });
};

module.exports = {
    monthYearLabel,
    previousMonthYearLabel,
    accountsDetailedAggregation,
    accountsDetailedAggregationByYear,
    accountsDetailed,
    attachCreditMerchantSpend,
    getActiveCapField,
    getMonthYearLabelsForCap,
};

if (require.main === module) {
    (async () => {
        try {
            const result = await accountsDetailed({ user_id: "Cp2xlHyEtdp8MKfs", month_year: "May 2026" });
            console.log(JSON.stringify(result, null, 2));
        } catch (err) {
            console.error(err);
            process.exitCode = 1;
        } finally {
            await closeMongo();
        }
    })();
}
