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

/**
 * For account_open_date annual rewards: returns month_year labels from the most
 * recent anniversary of `openedDate` that falls on or before `anchorMonthYear`,
 * through `anchorMonthYear` inclusive.
 *
 * E.g. openedDate = March 2022, anchor = "June 2026"
 *   → window start = March 2026  → ["March 2026", "April 2026", "May 2026", "June 2026"]
 *
 * E.g. openedDate = March 2022, anchor = "February 2026"
 *   → window start = March 2025  → ["March 2025", ..., "February 2026"]
 */
const getMonthYearLabelsForAccountOpenDateWindow = (openedDate, anchorMonthYear) => {
    const raw = openedDate?.$date ?? openedDate;
    const opened = raw instanceof Date ? raw : new Date(raw);
    if (!opened || isNaN(opened.getTime())) return [];

    const anchor = parseMonthYear(anchorMonthYear);
    if (!anchor) return [];

    // 0-indexed month the account was opened (the anniversary month)
    const anniversaryMonth = opened.getMonth();

    // Find the year of the most recent anniversary that is <= anchor
    let anniversaryYear = anchor.getFullYear();
    if (anniversaryMonth > anchor.getMonth()) {
        // This year's anniversary is still in the future relative to anchor
        anniversaryYear -= 1;
    }

    const windowStart = new Date(anniversaryYear, anniversaryMonth, 1);
    const windowEnd   = new Date(anchor.getFullYear(), anchor.getMonth(), 1);

    const labels = [];
    let current = windowStart;
    while (current <= windowEnd) {
        labels.push(monthYearLabel(current));
        current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
    }
    return labels;
};

/**
 * For year-view + account_open_date: the end anchor is the lesser of
 * "December of yearNum" and "the current calendar month", so we never
 * sum months that haven't happened yet.
 */
const getYearViewEndAnchor = (yearNum) => {
    const now = new Date();
    if (yearNum >= now.getFullYear()) {
        return monthYearLabel(now);
    }
    return `December ${yearNum}`;
};

/** Inclusive month_year labels from reward start through end ("May 2026" format). */
const getMonthYearLabelsForRewardWindow = (startDate, endDate, referenceDate = new Date()) => {
    if (!startDate && !endDate) {
        return null;
    }

    const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
    const rangeStart = startDate
        ? new Date(new Date(startDate).getFullYear(), new Date(startDate).getMonth(), 1)
        : new Date(1970, 0, 1);
    const end = endDate ? new Date(endDate) : ref;
    const rangeEnd = new Date(end.getFullYear(), end.getMonth(), 1);

    if (rangeStart > rangeEnd) {
        return [];
    }

    const labels = [];
    let current = rangeStart;
    while (current <= rangeEnd) {
        labels.push(monthYearLabel(current));
        current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
    }
    return labels;
};

/** Mongo filter for spend summaries within a reward's active month_year window. */
const buildRewardWindowMonthYearFilter = (reward, referenceDate = new Date()) => {
    const labels = getMonthYearLabelsForRewardWindow(
        reward?.start_date,
        reward?.end_date,
        referenceDate
    );
    if (labels === null) {
        return {};
    }
    return { month_year: { $in: labels } };
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

    // account_open_date windows can span into the previous year (e.g. March 2025 – Feb 2026
    // when viewing Feb 2026). Fetch the previous year's docs too when any such reward exists.
    const hasAccountOpenDateReward = creditRewards.some(
        (r) => r.spend_cap_annual != null && r.renewal_date_type === "account_open_date"
    );

    let spendSummaryDocs = await db
        .collection("spend_summaries")
        .find({
            user_id,
            month_year: { $regex: ` ${yearNum}$` },
        })
        .toArray();

    if (hasAccountOpenDateReward) {
        const prevYearDocs = await db
            .collection("spend_summaries")
            .find({
                user_id,
                month_year: { $regex: ` ${yearNum - 1}$` },
            })
            .toArray();
        spendSummaryDocs = [...spendSummaryDocs, ...prevYearDocs];
    }

    return accounts.map((account) => {
        const cardRewards = rewardsByCardId[account.card_id] || [];
        const credit_merchant_spend = {};
        const credit_category_spend = {};
        for (const reward of cardRewards) {
            const capField = getActiveCapField(reward, hasYear);
            if (!capField || !Array.isArray(reward.merchants)) continue;

            let monthYearLabels;
            const isAccountOpenDate =
                capField === "spend_cap_annual" &&
                (reward.renewal_date_type === "account_open_date") &&
                account.opened_date;

            if (isAccountOpenDate) {
                // For year view, anchor to current month (not December) so future months are excluded.
                // For month view, anchor to the requested month.
                const anchor = hasYear
                    ? getYearViewEndAnchor(yearNum)
                    : anchorMonthYear;
                monthYearLabels = getMonthYearLabelsForAccountOpenDateWindow(
                    account.opened_date,
                    anchor
                );
            } else {
                monthYearLabels = hasYear
                    ? getMonthYearLabelsForYearView(yearNum, capField)
                    : getMonthYearLabelsForCap(anchorMonthYear, capField);
            }

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
                if (!bucket?.credit_by_reward) return total;
                return total + (bucket.credit_by_reward[reward.reward_id] || 0);
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

const accountsDetailedAggregation = (user_id, account_id, month_year) => {
    const monthYearNow = month_year || monthYearLabel(new Date());
    const monthYearPrevious = previousMonthYearLabel(monthYearNow);

    const match = { user_id };
    if (account_id) match.account_id = account_id;

    return [
        { $match: match },
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
const accountsDetailedAggregationByYear = (user_id, account_id, year) => {
    const yearNum = typeof year === "number" ? year : parseInt(String(year), 10);
    if (!Number.isFinite(yearNum)) {
        throw new Error("year must be a number or numeric string");
    }

    const yearPrevious = yearNum - 1;

    const match = { user_id };
    if (account_id) match.account_id = account_id;

    return [
        { $match: match },
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

const accountsDetailed = async ({ user_id, account_id, month_year, year } = {}) => {
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
        ? accountsDetailedAggregationByYear(user_id, account_id, year)
        : accountsDetailedAggregation(user_id, account_id, hasMonthYear ? month_year : undefined);

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
    getMonthYearLabelsForRewardWindow,
    buildRewardWindowMonthYearFilter,
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
