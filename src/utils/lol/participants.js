function normalizeText(value) {
    return String(value ?? '').trim().toLowerCase();
}

function normalizeNumericIds(ids) {
    return (Array.isArray(ids) ? ids : [])
        .map((id) => Number(id))
        .filter(Number.isFinite);
}

export function getParticipantRuneIds(participant) {
    if (Array.isArray(participant?.runeIds)) {
        return normalizeNumericIds(participant.runeIds);
    }

    const flatPerkIds = Array.isArray(participant?.perks?.perkIds)
        ? participant.perks.perkIds
        : [];
    const styleSelections = Array.isArray(participant?.perks?.styles)
        ? participant.perks.styles.flatMap((style) => Array.isArray(style?.selections) ? style.selections : [])
        : [];
    const stylePerkIds = styleSelections.map((selection) => selection?.perk);

    return normalizeNumericIds([...flatPerkIds, ...stylePerkIds]);
}

function normalizeParticipantSpellId(value) {
    if (value == null || value === '') return null;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
}

function resolveParticipantSpellId(participant, primaryKey, fallbackKey) {
    const primaryValue = normalizeParticipantSpellId(participant?.[primaryKey]);
    if (primaryValue != null) return primaryValue;

    return normalizeParticipantSpellId(participant?.[fallbackKey]);
}

export function getParticipantSpellIds(participant) {
    return [
        resolveParticipantSpellId(participant, 'spell1Id', 'summoner1Id'),
        resolveParticipantSpellId(participant, 'spell2Id', 'summoner2Id'),
    ].filter(Number.isFinite);
}

function normalizeTeamSide(teamId) {
    return Number(teamId) === 200 ? 'RED' : 'BLUE';
}

/**
 * Groups spectator bans by team and preserves each team's draft sequence.
 * Spectator-v5 uses pickTurn values 1–10: blue bans on odd turns and red bans
 * on even turns, including the second ban phase.
 */
export function buildNormalizedTeamBans(bannedChampions) {
    if (!Array.isArray(bannedChampions) || bannedChampions.length === 0) {
        return { BLUE: [], RED: [] };
    }

    const bans = bannedChampions.reduce((accumulator, ban, index) => {
        const championId = Number(ban?.championId);
        if (!Number.isFinite(championId) || championId <= 0) return accumulator;

        const pickTurn = Number(ban?.pickTurn);
        accumulator[normalizeTeamSide(ban?.teamId)].push({
            championId,
            pickTurn: Number.isFinite(pickTurn) ? pickTurn : null,
            originalIndex: index,
        });
        return accumulator;
    }, { BLUE: [], RED: [] });

    for (const side of ['BLUE', 'RED']) {
        bans[side].sort((left, right) => {
            if (left.pickTurn == null && right.pickTurn == null) return left.originalIndex - right.originalIndex;
            if (left.pickTurn == null) return 1;
            if (right.pickTurn == null) return -1;
            return left.pickTurn - right.pickTurn || left.originalIndex - right.originalIndex;
        });
    }

    return bans;
}

export function buildNormalizedTeamRosters(participants) {
    if (!Array.isArray(participants) || participants.length === 0) {
        return { BLUE: [], RED: [] };
    }

    const rosters = participants.reduce((accumulator, participant) => {
        const side = normalizeTeamSide(participant?.teamId);
        const entry = {
            puuid: participant?.puuid ?? null,
            summonerName: participant?.summonerName ?? null,
            riotId: participant?.riotId ?? null,
            championId: participant?.championId ?? null,
            championName: participant?.championName ?? null,
            spell1Id: participant?.spell1Id ?? participant?.summoner1Id ?? null,
            spell2Id: participant?.spell2Id ?? participant?.summoner2Id ?? null,
            runeIds: getParticipantRuneIds(participant),
        };

        accumulator[side].push(entry);
        return accumulator;

    }, { BLUE: [], RED: [] });

    const stableSort = (left, right) =>
        String(left?.summonerName ?? left?.riotId ?? left?.puuid ?? '')
            .localeCompare(String(right?.summonerName ?? right?.riotId ?? right?.puuid ?? ''), undefined, { sensitivity: 'base' });
    rosters.BLUE.sort(stableSort);
    rosters.RED.sort(stableSort);

    return rosters;
}

export function resolveTrackedParticipant({ account, identity, participants }) {
    if (!Array.isArray(participants) || participants.length === 0) return null;

    const myPuuid = identity?.puuid ?? null;
    if (myPuuid) {
        const byPuuid = participants.find((p) => p?.puuid && String(p.puuid) === String(myPuuid));
        if (byPuuid) return byPuuid;
    }

    const gameName = normalizeText(account?.gameName);
    const tagLine = normalizeText(account?.tagLine);
    const riotId = `${gameName}#${tagLine}`;

    return participants.find((p) => {
        const participantRiotId = normalizeText(p?.riotId);
        if (participantRiotId && participantRiotId === riotId) return true;

        const participantGameName = normalizeText(p?.riotIdGameName);
        const participantTagLine = normalizeText(p?.riotIdTagline ?? p?.riotIdTagLine);
        if (participantGameName && participantTagLine && participantGameName === gameName && participantTagLine === tagLine) {
            return true;
        }

        const summonerName = normalizeText(p?.summonerName);
        return Boolean(summonerName && summonerName === gameName);
    }) ?? null;
}
