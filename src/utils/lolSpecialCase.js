function getPentakillCount(participant) {
    const pentaKills = Number(participant?.pentaKills ?? 0);
    return Number.isFinite(pentaKills) && pentaKills > 0 ? pentaKills : 0;
}

export function formatPentakillResultValue(participant) {
    const pentaKills = getPentakillCount(participant);
    if (pentaKills <= 0) return null;

    return pentaKills === 1 ? 'PENTAKILL' : `${pentaKills} PENTAKILLS`;
}

const LEAGUE_ROLE_NAME = 'league';

function findLeagueRole(roles) {
    return roles?.find?.((role) =>
        role?.id && String(role?.name ?? '').trim().toLowerCase() === LEAGUE_ROLE_NAME
    ) ?? null;
}

function resolvePentakillSummonerName({ participant, summonerName }) {
    const explicitName = String(summonerName ?? '').trim();
    if (explicitName) return explicitName;

    const riotId = String(participant?.riotId ?? '').trim();
    if (riotId) return riotId;

    const participantSummonerName = String(participant?.summonerName ?? '').trim();
    if (participantSummonerName) return participantSummonerName;

    const gameName = String(participant?.riotIdGameName ?? '').trim();
    const tagLine = String(participant?.riotIdTagline ?? participant?.riotIdTagLine ?? '').trim();
    if (gameName && tagLine) return `${gameName}#${tagLine}`;
    if (gameName) return gameName;

    return 'Unknown summoner';
}

export async function buildPentakillRoleMentionPayload(channel, { participant, summonerName } = {}) {
    const pentakillValue = formatPentakillResultValue(participant);
    if (!pentakillValue) return {};

    const guild = channel?.guild;
    if (!guild?.roles) return {};
    let role = findLeagueRole(guild.roles.cache);

    if (!role && typeof guild.roles.fetch === 'function') {
        try {
            role = findLeagueRole(await guild.roles.fetch());
        } catch {
            role = null;
        }
    }
    if (!role) return {};

    const resolvedSummonerName = resolvePentakillSummonerName({ participant, summonerName });

    return {
        content: `<@&${role.id}> ${pentakillValue} for  ${resolvedSummonerName}🔥`,
        allowedMentions: { roles: [role.id] },
    };
}
