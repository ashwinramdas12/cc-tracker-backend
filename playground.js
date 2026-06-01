const { connectToMongo } = require('./connectToMongo');

const monthYearLabel = (d) => {
    const date = d instanceof Date ? d : new Date(d);
    return date.toLocaleString("default", { month: "long", year: "numeric" });
};

const accountKeyLet = { uid: "$user_id", acct_id: "$account_id" };

/**
 * Fold an array of { account_spend: { [field]: { key: number } } } into one summed map for `field`.
 */
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

const accountsDetailedAggregation = (user_id, month_year) => {
    const monthYearNow = month_year || monthYearLabel(new Date());

    return [
        { $match: { user_id } },
        {
            $lookup: {
                from: "spend_summaries",
                let: accountKeyLet,
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $eq: ["$user_id", "$$uid"] },
                                    { $eq: ["$month_year", monthYearNow] },
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
                as: "spend_summary_raw",
            },
        },
        {
            $addFields: {
                spend_summary: {
                    $cond: {
                        if: { $gt: [{ $size: "$spend_summary_raw" }, 0] },
                        then: {
                            $mergeObjects: [
                                { month_year: { $arrayElemAt: ["$spend_summary_raw.month_year", 0] } },
                                { $arrayElemAt: ["$spend_summary_raw.account_spend", 0] },
                            ],
                        },
                        else: null,
                    },
                },
            },
        },
        ...subTrackerLookupStages(),
        { $unset: ["spend_summary_raw"] },
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

    return [
        { $match: { user_id } },
        {
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
                as: "spend_summary_raw",
            },
        },
        {
            $addFields: {
                spend_summary: {
                    $cond: {
                        if: { $gt: [{ $size: "$spend_summary_raw" }, 0] },
                        then: {
                            year: { $literal: yearNum },
                            points_by_category: mergeMapsOverRaw("$spend_summary_raw", "points_by_category"),
                            points_by_merchant: mergeMapsOverRaw("$spend_summary_raw", "points_by_merchant"),
                            spend_by_merchant: mergeMapsOverRaw("$spend_summary_raw", "spend_by_merchant"),
                            spend_by_category: mergeMapsOverRaw("$spend_summary_raw", "spend_by_category"),
                        },
                        else: null,
                    },
                },
            },
        },
        ...subTrackerLookupStages(),
        { $unset: ["spend_summary_raw"] },
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
    await mongo.close();
    return accounts;
};

module.exports = {
    monthYearLabel,
    accountsDetailedAggregation,
    accountsDetailedAggregationByYear,
    accountsDetailed,
};

if (require.main === module) {
    (async () => {
        try {
            const result = await accountsDetailed({ user_id: "xxx", year: 2026 });
            console.log(JSON.stringify(result, null, 2));
        } catch (err) {
            console.error(err);
            process.exitCode = 1;
        }
    })();
}
