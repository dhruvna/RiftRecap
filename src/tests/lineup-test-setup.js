import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LOL_QUEUE_TYPES } from '../constants/queues.js';
import { buildLineupKey, getEligibleLineupMemberSets, getGuildLineupStats, recordLolLineupResult, recordLolMemberContextResult } from '../storage/lineups.js';
import { migrateLegacyLolLineupsJson } from '../storage/migrateLolLineupsJson.js';
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

async function assertLegacyLineupMigrationCanonicalizesAndAggregates() {
    const guildId = `lineup-migration-test-${Date.now()}`;
    const canonicalKey = buildLineupKey(['a', 'b']);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'riftrecap-lineups-'));
    const legacyPath = path.join(tempDir, 'lol_lineups.json');

    await fs.writeFile(legacyPath, JSON.stringify({
        [guildId]: {
            lineups: {
                'b|a': {
                    games: 2,
                    wins: 1,
                    losses: 1,
                    firstSeenAt: 100,
                    lastSeenAt: 200,
                },
                'a|a|b': {
                    games: 3,
                    wins: 2,
                    losses: 1,
                    firstSeenAt: 50,
                    lastSeenAt: 300,
                },
                ' | b | | a | ': {
                    games: 1,
                    wins: 0,
                    losses: 1,
                    firstSeenAt: 75,
                    lastSeenAt: 250,
                },
            },
        },
    }));

    const migrationResult = await migrateLegacyLolLineupsJson({
        legacyPath,
        migrationName: `lineup-migration-test-${Date.now()}`,
    });
    const guildLineups = await getGuildLineupStats(guildId);

    assert.equal(migrationResult.didRun, true, 'legacy lineup migration should run for the fixture file');
    assert.equal(migrationResult.importedLineups, 1, 'canonical-equivalent legacy keys should insert one lineup');
    assert.deepEqual(Object.keys(guildLineups), [canonicalKey], 'legacy keys should normalize to the runtime canonical lineup key');
    assert.equal(guildLineups[canonicalKey].games, 6, 'collapsed legacy lineup keys should aggregate games before insertion');
    assert.equal(guildLineups[canonicalKey].wins, 3, 'collapsed legacy lineup keys should aggregate wins before insertion');
    assert.equal(guildLineups[canonicalKey].losses, 3, 'collapsed legacy lineup keys should aggregate losses before insertion');
    assert.equal(guildLineups[canonicalKey].firstSeenAt, 50, 'collapsed legacy lineup keys should preserve the earliest firstSeenAt');
    assert.equal(guildLineups[canonicalKey].lastSeenAt, 300, 'collapsed legacy lineup keys should preserve the latest lastSeenAt');

    const runtimeResult = await recordLolLineupResult({
        guildId,
        queueType: DEFAULT_QUEUE_TYPE,
        lineupMemberKeys: ['b', 'a'],
        didWin: true,
        matchId: `${guildId}-runtime-match`,
        gameMs: 400,
    });
    const updatedGuildLineups = await getGuildLineupStats(guildId);

    assert.equal(runtimeResult.recorded, true, 'runtime lineup recording should accept a migrated canonical lineup');
    assert.equal(runtimeResult.lineupKey, canonicalKey, 'runtime lineup key should match the migrated canonical key');
    assert.deepEqual(Object.keys(updatedGuildLineups), [canonicalKey], 'runtime recording should update the migrated row instead of creating a second key');
    assert.equal(updatedGuildLineups[canonicalKey].games, 7, 'runtime recording should increment the migrated canonical lineup');
    assert.equal(updatedGuildLineups[canonicalKey].wins, 4, 'runtime recording should increment migrated wins');
    assert.equal(updatedGuildLineups[canonicalKey].losses, 3, 'runtime recording should preserve migrated losses on a win');
}

async function assertLegacyChampionByRoleMigrationHydratesMemberContext() {
    const guildId = `lineup-role-champion-migration-test-${Date.now()}`;
    const memberKey = 'legacy-shared-player';
    const lineupKey = buildLineupKey([memberKey, 'legacy-partner']);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'riftrecap-lineups-'));
    const legacyPath = path.join(tempDir, 'lol_lineups.json');

    await fs.writeFile(legacyPath, JSON.stringify({
        [guildId]: {
            lineups: {
                [`legacy-partner|${memberKey}`]: {
                    games: 4,
                    wins: 3,
                    losses: 1,
                    firstSeenAt: 100,
                    lastSeenAt: 200,
                    championsByRoleByMember: {
                        [` ${memberKey} `]: {
                            ' MIDDLE ': {
                                ' Ahri ': { games: 2, wins: 2 },
                                ' Lux ': { count: 1, wins: 0 },
                            },
                            UTILITY: {
                                Morgana: { losses: 1, wins: 0 },
                            },
                            '   ': {
                                IgnoredChampion: { games: 5, wins: 5 },
                            },
                        },
                    },
                },
            },
        },
    }));

    const migrationResult = await migrateLegacyLolLineupsJson({
        legacyPath,
        migrationName: `lineup-role-champion-migration-test-${Date.now()}`,
    });

    const db = await getSqliteDb();
    const championByRoleCounter = db.prepare(`
        SELECT games, wins
        FROM lol_member_context_counter
        WHERE guild_id = ?
          AND member_key = ?
          AND context_type = 'champion_by_role'
          AND context_value = ?
    `).get(guildId, memberKey, JSON.stringify(['MIDDLE', 'Ahri']));

    assert.equal(migrationResult.didRun, true, 'legacy champion-by-role migration should run for the fixture file');
    assert.equal(migrationResult.importedContextRows, 3, 'valid legacy role/champion counters should be migrated');
    assert.equal(Number(championByRoleCounter?.games), 2, 'migrated champion-by-role context should use runtime JSON array context_value');
    assert.equal(Number(championByRoleCounter?.wins), 2, 'migrated champion-by-role context should preserve wins');

    const guildLineups = await getGuildLineupStats(guildId, { includeMemberContextFor: ` ${memberKey} ` });
    assert.equal(
        guildLineups[lineupKey]?.championsByRoleByMember?.[memberKey]?.MIDDLE?.Ahri?.games,
        2,
        'migrated champion-by-role context should hydrate getGuildLineupStats display context'
    );
    assert.equal(
        guildLineups[lineupKey]?.championsByRoleByMember?.[memberKey]?.MIDDLE?.Lux?.games,
        1,
        'migrated count-style legacy counters should hydrate under normalized roles and champions'
    );
    assert.equal(
        guildLineups[lineupKey]?.championsByRoleByMember?.[memberKey]?.UTILITY?.Morgana?.games,
        1,
        'migrated wins/losses-style legacy counters should hydrate under normalized roles and champions'
    );
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
            'user-filtered lineup display context should be attached from the shared person-level champion counter'
        );
        assert.equal(
            guildLineups[lineupKey]?.championsByRoleByMember?.[sharedMemberKey]?.MIDDLE?.Ahri?.games,
            2,
            'user-filtered lineup display context should include best champion counters per role'
        );
    }
}

async function assertLegacyContextMigrationDedupesCombinationCopies() {
    const guildId = `lineup-context-combo-dedupe-test-${Date.now()}`;
    const memberKey = 'combo-shared-player';
    const firstPartner = 'combo-partner-a';
    const secondPartner = 'combo-partner-b';
    const firstLineupKey = buildLineupKey([memberKey, firstPartner]);
    const secondLineupKey = buildLineupKey([memberKey, secondPartner]);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'riftrecap-lineups-'));
    const legacyPath = path.join(tempDir, 'lol_lineups.json');

    const duplicatedContext = {
        games: 1,
        wins: 1,
        losses: 0,
        firstSeenAt: 100,
        lastSeenAt: 200,
        seenMatchIds: ['NA1_duplicated_match'],
        rolesByMember: {
            [memberKey]: {
                MIDDLE: { games: 1, wins: 1 },
            },
        },
        championsByMember: {
            [memberKey]: {
                Ahri: { games: 1, wins: 1 },
            },
        },
    };

    await fs.writeFile(legacyPath, JSON.stringify({
        [guildId]: {
            lineups: {
                [`${memberKey}|${firstPartner}`]: duplicatedContext,
                [`${memberKey}|${secondPartner}`]: duplicatedContext,
            },
        },
    }));

    const db = await getSqliteDb();
    db.prepare(`
        INSERT INTO lol_member_context_counter (
            guild_id,
            member_key,
            context_type,
            context_value,
            games,
            wins
        ) VALUES (?, ?, 'champion', 'Ahri', 11, 11)
    `).run(guildId, memberKey);

    await migrateLegacyLolLineupsJson({
        legacyPath,
        migrationName: `lineup-context-combo-dedupe-test-${Date.now()}`,
    });

    const championCounter = db.prepare(`
        SELECT SUM(games) AS games, SUM(wins) AS wins
        FROM lol_member_context_counter
        WHERE guild_id = ?
          AND member_key = ?
          AND context_type = 'champion'
          AND context_value = 'Ahri'
    `).get(guildId, memberKey);
    const seenRows = db.prepare(`
        SELECT lineup_key AS lineupKey, COUNT(*) AS rows
        FROM lineup_match_seen
        WHERE guild_id = ?
        GROUP BY lineup_key
    `).all(guildId);

    assert.equal(Number(championCounter.games), 1, 'same legacy match context copied onto multiple lineup combinations should count once per member');
    assert.equal(Number(championCounter.wins), 1, 'deduped legacy context should preserve the win once');
    assert.deepEqual(
        Object.fromEntries(seenRows.map((row) => [row.lineupKey, Number(row.rows)])),
        { [firstLineupKey]: 1, [secondLineupKey]: 1 },
        'legacy seenMatchIds should hydrate lineup_match_seen for migrated lineups'
    );
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
    const championCounter = db.prepare(`
        SELECT SUM(games) AS games, SUM(wins) AS wins
        FROM lol_member_context_counter
        WHERE guild_id = ?
          AND member_key = ?
          AND context_type = 'champion'
          AND context_value = 'Champion0'
    `).get(guildId, memberKeys[0]);

    assert.equal(Number(championCounter.games), 1, 'same user/match champion context should only count once');
    assert.equal(Number(championCounter.wins), 1, 'same user/match champion wins should only count once');
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
    await assertLegacyLineupMigrationCanonicalizesAndAggregates();
    await assertLegacyChampionByRoleMigrationHydratesMemberContext();
    await assertLegacyContextMigrationDedupesCombinationCopies();
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
