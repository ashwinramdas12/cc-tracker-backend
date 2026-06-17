const normalize = (str) => (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function scoreReward(reward, normalizedQuery) {
  if (!normalizedQuery) return 0;

  let score = 0;
  const fields = [
    reward.reward_id,
    reward.card_id,
    reward.notes,
    reward.category,
    reward.type,
  ];

  for (const field of fields) {
    const normalizedField = normalize(field);
    if (
      normalizedField &&
      (normalizedField.includes(normalizedQuery) ||
        normalizedQuery.includes(normalizedField))
    ) {
      score += 2;
    }
  }

  return score;
}

function searchRewards(query, rewards, limit = 5) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery || !rewards?.length) return [];

  return rewards
    .map((reward) => ({ reward, score: scoreReward(reward, normalizedQuery) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ reward }) => reward);
}

module.exports = { searchRewards };
