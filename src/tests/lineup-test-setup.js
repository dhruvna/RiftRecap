import assert from 'node:assert/strict';
import { LOL_QUEUE_TYPES } from '../constants/queues.js';
import { buildLineupKey, getEligibleLineupMemberSets, getGuildLineupStats, recordLolLineupResult, recordLolMemberContextResult } from '../storage/lineups.js';
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
        didWin: true,
        matchId: `${guildId}-match-1`,
        gameMs: Date.now(),
    });
    await recordLolLineupResult({
        guildId,
        queueType: DEFAULT_QUEUE_TYPE,
        lineupMemberKeys: secondLineup,
        didWin: false,
        matchId: `${guildId}-match-2`,
        gameMs: Date.now() + 1,
    });
    await recordLolMemberContextResult({
        guildId,
        memberKeys: firstLineup,
        lineupMemberMetadata: sharedMetadata,
        didWin: true,
        matchId: `${guildId}-match-1`,
        gameMs: Date.now(),
    });
    await recordLolMemberContextResult({
        guildId,
        memberKeys: secondLineup,
        lineupMemberMetadata: sharedMetadata,
        didWin: false,
        matchId: `${guildId}-match-2`,
        gameMs: Date.now() + 1,
    });

    const db = await getSqliteDb();
    for (const tableName of ['lineup_stats', 'lineup_match_seen', 'lol_member_context_counter', 'lol_member_context_match_seen']) {
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

    const basicContextCounter = db.prepare(`
        SELECT COUNT(*) AS rows
        FROM lol_member_context_counter
        WHERE guild_id = ?
          AND member_key = ?
          AND context_type IN ('role', 'champion')
    `).get(guildId, sharedMemberKey);

    assert.equal(Number(basicContextCounter.rows), 0, 'role and champion context should be inferred instead of stored separately');

    const championByRoleCounter = db.prepare(`
        SELECT COUNT(*) AS rows, SUM(games) AS games, SUM(wins) AS wins
        FROM lol_member_context_counter
        WHERE guild_id = ?
          AND member_key = ?
          AND context_type = 'champion_by_role'
          AND context_value = ?
    `).get(guildId, sharedMemberKey, JSON.stringify(['MIDDLE', 'Ahri']));

    assert.equal(Number(championByRoleCounter.rows), 1, 'same role/champion context should use one person-level row');
    assert.equal(Number(championByRoleCounter.games), 2, 'same role/champion context should aggregate across different lineups');
    assert.equal(Number(championByRoleCounter.wins), 1, 'same role/champion context should preserve wins across different lineups');

    const guildLineupsWithoutUserContext = await getGuildLineupStats(guildId);
    assert.deepEqual(
        guildLineupsWithoutUserContext[buildLineupKey(firstLineup)]?.championsByMember,
        {},
        'default lineup stats should only include lineup win/loss data'
    );
    assert.deepEqual(
        guildLineupsWithoutUserContext[buildLineupKey(firstLineup)]?.championsByRoleByMember,
        {},
        'default lineup stats should not include role/champion display context'
    );

    const guildLineups = await getGuildLineupStats(guildId, { includeMemberContextFor: sharedMemberKey });
    for (const lineupKey of [buildLineupKey(firstLineup), buildLineupKey(secondLineup)]) {
        assert.equal(
            guildLineups[lineupKey]?.championsByMember?.[sharedMemberKey]?.Ahri?.games,
            2,
            'user-filtered champion context should be inferred from champion-by-role counters'
        );
        assert.equal(
            guildLineups[lineupKey]?.championsByRoleByMember?.[sharedMemberKey]?.MIDDLE?.Ahri?.games,
            2,
            'user-filtered lineup display context should include best champion counters per role'
        );
    }
}

async function assertLineupMatchSeenDedupesLineupResults() {
    const guildId = `lineup-match-seen-test-${Date.now()}`;
    const lineup = ['seen-a', 'seen-b'];
    const matchId = `${guildId}-match`;

    const firstResult = await recordLolLineupResult({
        guildId,
        queueType: DEFAULT_QUEUE_TYPE,
        lineupMemberKeys: lineup,
        didWin: true,
        matchId,
        gameMs: Date.now(),
    });
    const duplicateResult = await recordLolLineupResult({
        guildId,
        queueType: DEFAULT_QUEUE_TYPE,
        lineupMemberKeys: [...lineup].reverse(),
        didWin: false,
        matchId,
        gameMs: Date.now() + 1,
    });

    const guildLineups = await getGuildLineupStats(guildId);
    const entry = guildLineups[buildLineupKey(lineup)];

    assert.equal(firstResult.recorded, true, 'first lineup result should record');
    assert.equal(duplicateResult.recorded, false, 'duplicate lineup/match should be skipped');
    assert.equal(Number(entry?.games), 1, 'lineup_match_seen should prevent duplicate lineup games');
    assert.equal(Number(entry?.wins), 1, 'lineup_match_seen should preserve the first win value');
    assert.equal(Number(entry?.losses), 0, 'lineup_match_seen should not add duplicate losses');
}

async function assertMemberContextMatchesAreDedupedAcrossLineups() {
    const guildId = `lineup-context-dedupe-test-${Date.now()}`;
    const memberKeys = ['dedupe-a', 'dedupe-b', 'dedupe-c'];
    const metadata = Object.fromEntries(memberKeys.map((memberKey, index) => [
        memberKey,
        { champion: `Champion${index}`, role: index === 0 ? 'MIDDLE' : 'UTILITY' },
    ]));
    const matchId = `${guildId}-match`;

    await recordLolMemberContextResult({
        guildId,
        memberKeys,
        lineupMemberMetadata: metadata,
        didWin: true,
        matchId,
        gameMs: Date.now(),
    });
    await recordLolMemberContextResult({
        guildId,
        memberKeys,
        lineupMemberMetadata: metadata,
        didWin: true,
        matchId,
        gameMs: Date.now() + 1,
    });

    const db = await getSqliteDb();
    const championByRoleCounter = db.prepare(`
        SELECT SUM(games) AS games, SUM(wins) AS wins
        FROM lol_member_context_counter
        WHERE guild_id = ?
          AND member_key = ?
          AND context_type = 'champion_by_role'
          AND context_value = ?
    `).get(guildId, memberKeys[0], JSON.stringify(['MIDDLE', 'Champion0']));

    assert.equal(Number(championByRoleCounter.games), 1, 'same user/match champion-by-role context should only count once');
    assert.equal(Number(championByRoleCounter.wins), 1, 'same user/match champion-by-role wins should only count once');
}

async function assertFiveStackLineupPermutationsDoNotDuplicateMemberContext() {
    const guildId = `lineup-five-stack-dedupe-test-${Date.now()}`;
    const memberKeys = ['five-a', 'five-b', 'five-c', 'five-d', 'five-e'];
    const matchId = `${guildId}-match`;
    const metadata = Object.fromEntries(memberKeys.map((memberKey, index) => [
        memberKey,
        { champion: `Champion${index}`, role: index === 0 ? 'TOP' : 'BOTTOM' },
    ]));

    await recordLolMemberContextResult({
        guildId,
        memberKeys,
        lineupMemberMetadata: metadata,
        didWin: true,
        matchId,
        gameMs: Date.now(),
    });

    const lineupSets = getEligibleLineupMemberSets(LOL_QUEUE_TYPES.RANKED_FLEX, memberKeys);
    for (const lineupMemberKeys of lineupSets) {
        await recordLolLineupResult({
            guildId,
            queueType: LOL_QUEUE_TYPES.RANKED_FLEX,
            lineupMemberKeys,
            didWin: true,
            matchId,
            gameMs: Date.now(),
        });
    }

    const db = await getSqliteDb();
    const lineupCounter = db.prepare(`
        SELECT COUNT(*) AS rows, SUM(games) AS games, SUM(wins) AS wins
        FROM lineup_stats
        WHERE guild_id = ?
    `).get(guildId);
    const championByRoleCounter = db.prepare(`
        SELECT games, wins
        FROM lol_member_context_counter
        WHERE guild_id = ?
          AND member_key = ?
          AND context_type = 'champion_by_role'
          AND context_value = ?
    `).get(guildId, memberKeys[0], JSON.stringify(['TOP', 'Champion0']));
    const basicContextCounter = db.prepare(`
        SELECT COUNT(*) AS rows
        FROM lol_member_context_counter
        WHERE guild_id = ?
          AND member_key = ?
          AND context_type IN ('role', 'champion')
    `).get(guildId, memberKeys[0]);

    assert.equal(Number(lineupCounter.rows), 21, 'five stack flex match should record every 2/3/5-player lineup permutation');
    assert.equal(Number(lineupCounter.games), 21, 'each eligible lineup permutation should receive one game');
    assert.equal(Number(lineupCounter.wins), 21, 'each eligible lineup permutation should receive one win');
    assert.equal(Number(championByRoleCounter?.games), 1, 'champion-by-role stats should only count the member once for the match');
    assert.equal(Number(championByRoleCounter?.wins), 1, 'champion-by-role wins should only count the member once for the match');
    assert.equal(Number(basicContextCounter?.rows), 0, 'role and champion stats should not be stored separately');
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
    await assertLineupMatchSeenDedupesLineupResults();
    await assertMemberContextMatchesAreDedupedAcrossLineups();
    await assertFiveStackLineupPermutationsDoNotDuplicateMemberContext();
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
