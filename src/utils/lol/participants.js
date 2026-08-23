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

function normalizeSelectedSkinIndex(value) {
    if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
}

/**
 * Groups spectator bans by team and preserves each team's draft sequence.
 * Spectator-v5 uses pickTurn values 1–10. The second ban phase begins with
 * red, so the team ID—not odd/even turn parity—determines the ban's side.
 */
export function buildNormalizedTeamBans(bannedChampions) {
    if (!Array.isArray(bannedChampions) || bannedChampions.length === 0) {
        return { BLUE: [], RED: [] };
    }

    const bans = bannedChampions.reduce((accumulator, ban, index) => {
        const championId = Number(ban?.championId);
        const isPlaceholder = championId === -1;
        if (!Number.isFinite(championId) || (championId <= 0 && !isPlaceholder)) return accumulator;

        const pickTurn = Number(ban?.pickTurn);
        const teamId = Number(ban?.teamId);
        const side = teamId === 100 ? 'BLUE' : (teamId === 200 ? 'RED' : null);
        if (!side) return accumulator;

        accumulator[side].push({
            championId,
            isPlaceholder,
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

/**
 * Groups spectator participants by team without changing the API's player order.
 * The live draft card uses that order to keep each pick on the same row as its
 * team's corresponding ban sequence.
 */
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
            lastSelectedSkinIndex: normalizeSelectedSkinIndex(participant?.lastSelectedSkinIndex),
            spell1Id: participant?.spell1Id ?? participant?.summoner1Id ?? null,
            spell2Id: participant?.spell2Id ?? participant?.summoner2Id ?? null,
            runeIds: getParticipantRuneIds(participant),
        };

        accumulator[side].push(entry);
        return accumulator;

    }, { BLUE: [], RED: [] });

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
