const normalize = (str) => (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function scoreSpendCategory(doc, normalizedQuery) {
  if (!normalizedQuery) return 0;

  let score = 0;
  const normalizedCategory = normalize(doc.category);
  if (
    normalizedCategory &&
    (normalizedCategory.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedCategory))
  ) {
    score += 3;
  }

  const plaidCategories = doc.plaid_categories;
  if (Array.isArray(plaidCategories)) {
    for (const plaidCategory of plaidCategories) {
      const normalizedPlaid = normalize(plaidCategory);
      if (
        normalizedPlaid &&
        (normalizedPlaid.includes(normalizedQuery) ||
          normalizedQuery.includes(normalizedPlaid))
      ) {
        score += 1;
      }
    }
  }

  return score;
}

function searchSpendCategories(query, categories, limit = 5) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery || !categories?.length) return [];

  return categories
    .map((doc) => ({ doc, score: scoreSpendCategory(doc, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc }) => doc);
}

module.exports = { searchSpendCategories };
