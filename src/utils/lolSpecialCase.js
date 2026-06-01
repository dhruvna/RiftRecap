export function formatPentakillResultValue(participant) {
    const pentaKills = Number(participant?.pentaKills ?? 0);
    if (!Number.isFinite(pentaKills) || pentaKills <= 0) return null;

    return pentaKills === 1 ? '🔥 PENTAKILL!' : `🔥 ${pentaKills} PENTAKILLS!`;
}

const LEAGUE_ROLE_NAME = 'league';

function findLeagueRole(roles) {
    return roles?.find?.((role) =>
        role?.id && String(role?.name ?? '').trim().toLowerCase() === LEAGUE_ROLE_NAME
    ) ?? null;
}

export async function buildPentakillRoleMentionPayload(channel) {
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

    return {
        content: `<@&${role.id}>`,
        allowedMentions: { roles: [role.id] },
    };
}
