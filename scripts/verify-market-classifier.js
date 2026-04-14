const { MarketClassifier } = require('./packages/dashboard/dist/services/MarketClassifier.js');

const classifier = new MarketClassifier();
const samples = [
  ['Will Ethereum exceed $4,000 this week?', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)],
  ['Will MegaETH launch a token by May 31, 2026?', new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)],
  ['Will MegaETH perform an airdrop by June 30?', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)],
  ['MegaETH market cap (FDV) >$3B one day after launch?', new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)],
];

for (const [question, endDate] of samples) {
  console.log(JSON.stringify({
    question,
    type: classifier.classifyWithRegex(question, endDate),
  }));
}
