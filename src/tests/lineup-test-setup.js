import assert from 'node:assert/strict';
import { LOL_QUEUE_TYPES } from '../constants/queues.js';
import { buildLineupKey, getEligibleLineupMemberSets, getGuildLineupStats, recordLolLineupResult } from '../storage/lineups.js';
import { getSqliteDb } from '../storage/sqlite.js';

const TEST_GUILD_ID = '288456610366357505';
const DEFAULT_QUEUE_TYPE = LOL_QUEUE_TYPES.RANKED_FLEX;

function buildDummyAccounts() {
    return Array.from({ length: 5 }, (_, idx) => ({
        key: `dummy${idx + 5}`,
        gameName: `Dummy${idx + 5}`,
        tagLine: 'TEEHEE',
    }));
}

async function assertPersonLevelChampionCounters() {
    const guildId = `lineup-context-test-${Date.now()}`;
    const sharedMemberKey = 'shared-player';
    const firstLineup = [sharedMemberKey, 'lineup-a-partner'];
    const secondLineup = [sharedMemberKey, 'lineup-b-partner'];
    const sharedMetadata = {
        [sharedMemberKey]: { champion: 'Ahri', role: 'MIDDLE' },
        'lineup-a-partner': { champion: 'Leona', role: 'UTILITY' },
        'lineup-b-partner': { champion: 'Sejuani', role: 'JUNGLE' },
    };

    await recordLolLineupResult({
        guildId,
        queueType: DEFAULT_QUEUE_TYPE,
        lineupMemberKeys: firstLineup,
        lineupMemberMetadata: sharedMetadata,
        didWin: true,
        matchId: `${guildId}-match-1`,
        gameMs: Date.now(),
    });
    await recordLolLineupResult({
        guildId,
        queueType: DEFAULT_QUEUE_TYPE,
        lineupMemberKeys: secondLineup,
        lineupMemberMetadata: sharedMetadata,
        didWin: false,
        matchId: `${guildId}-match-2`,
        gameMs: Date.now() + 1,
    });

    const db = await getSqliteDb();
    for (const tableName of ['lineup_stats', 'lineup_match_seen', 'lol_member_context_counter']) {
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
        assert.equal(
            columns.some((column) => column.name === 'queue_type'),
            false,
            `${tableName} must not include queue_type`
        );
    }
    const memberContextColumns = db.prepare('PRAGMA table_info(lol_member_context_counter)').all();
    assert.equal(
        memberContextColumns.some((column) => column.name === 'lineup_key'),
        false,
        'person-level context counters must not include lineup_key'
    );

    const championCounter = db.prepare(`
        SELECT COUNT(*) AS rows, SUM(games) AS games, SUM(wins) AS wins
        FROM lol_member_context_counter
        WHERE guild_id = ?
          AND member_key = ?
          AND context_type = 'champion'
          AND context_value = 'Ahri'
    `).get(guildId, sharedMemberKey);

    assert.equal(Number(championCounter.rows), 1, 'same champion context should use one person-level row');
    assert.equal(Number(championCounter.games), 2, 'same champion context should aggregate across different lineups');
    assert.equal(Number(championCounter.wins), 1, 'same champion context should preserve wins across different lineups');

    const guildLineups = await getGuildLineupStats(guildId);
    for (const lineupKey of [buildLineupKey(firstLineup), buildLineupKey(secondLineup)]) {
        assert.equal(
            guildLineups[lineupKey]?.championsByMember?.[sharedMemberKey]?.Ahri?.games,
            2,
            'lineup display context should be attached from the shared person-level champion counter'
        );
    }
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

    await assertPersonLevelChampionCounters();
    const guildLineups = await getGuildLineupStats(TEST_GUILD_ID);

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
