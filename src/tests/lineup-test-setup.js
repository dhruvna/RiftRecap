import fs from 'node:fs/promises';
import path from 'node:path';
import { buildLineupKey, getEligibleLineupMemberSets, recordLolLineupResult } from '../storage/lineups.js';

const TEST_GUILD_ID = '288456610366357505';
const DEFAULT_QUEUE_TYPE = 'RANKED_FLEX_SR';

function buildDummyAccounts() {
    return Array.from({ length: 5 }, (_, idx) => ({
        key: `dummy${idx + 5}`,
        gameName: `Dummy${idx + 5}`,
        tagLine: 'TEEHEE',
    }));
}

async function main() {
    const dummyAccounts = buildDummyAccounts();
    const lineupMemberKeys = dummyAccounts.map((account) => account.key);
    const lineupSets = getEligibleLineupMemberSets(DEFAULT_QUEUE_TYPE, lineupMemberKeys);

    const matchId = `TEST_MATCH_${Date.now()}`;
    const gameMs = Date.now();

    for (const lineup of lineupSets) {
        await recordLolLineupResult({
            guildId: TEST_GUILD_ID,
            queueType: DEFAULT_QUEUE_TYPE,
            lineupMemberKeys: lineup,
            didWin: false,
            matchId,
            gameMs,
        });
    }

    const outputPath = process.env.LOL_LINEUPS_DATA_PATH
        ? path.resolve(process.env.LOL_LINEUPS_DATA_PATH)
        : path.join(process.cwd(), 'user_data', 'lol_lineups.json');

    const raw = await fs.readFile(outputPath, 'utf8');
    const parsed = JSON.parse(raw);
    const guildLineups = parsed?.[TEST_GUILD_ID]?.lineups ?? {};

    console.log('Dummy accounts:', dummyAccounts.map((a) => `${a.gameName}#${a.tagLine}`).join(', '));
    console.log('Primary lineup key:', buildLineupKey(lineupMemberKeys));
    console.log('Eligible lineup combinations recorded:', lineupSets.length);
    console.log('Stored lineup key count for test guild:', Object.keys(guildLineups).length);
    console.log('Sample entries:');

    for (const key of Object.keys(guildLineups).slice(0, 5)) {
        const entry = guildLineups[key];
        console.log(`- ${key}: ${entry.wins}W-${entry.losses}L (${entry.games} games)`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
