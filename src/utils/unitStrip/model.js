export function normalizeUnitCost(rarity) {
    const value = Number(rarity ?? 0);
    if (!Number.isFinite(value)) return 1;

    if (value >= 6) return 5;  // 6 and 7 both mean 5 cost
    if (value === 4) return 4; // 4 means 4 cost
    if (value === 2) return 3; // 2 means 3 cost
    if (value === 1) return 2; // 1 means 2 cost
    return 1; // 0 means 1 cost
}

export function normalizeUnits(units, maxUnits) {
    if (!Array.isArray(units)) return [];
    const sortedUnits = [...units].sort((a, b) => {
        const costA = Number(a?.rarity ?? 0);
        const costB = Number(b?.rarity ?? 0);
        if (costB !== costA) return costB - costA; // highest cost first

        const tierA = Number(a?.tier ?? 0);
        const tierB = Number(b?.tier ?? 0);
        if (tierB !== tierA) return tierB - tierA; // higher star tiers first

        const idA = String(a?.character_id ?? '');
        const idB = String(b?.character_id ?? '');
        return idA.localeCompare(idB); // deterministic L->R order on ties
    });
    return sortedUnits.slice(0, maxUnits);
}

export function normalizeTraits(traits, maxTraits = 8) {
    if (!Array.isArray(traits)) return [];
    const activeTraits = traits
        .filter((trait) => Number(trait?.tier_current ?? 0) > 0)
        .sort((a, b) => {
            const tierA = Number(a?.tier_current ?? 0);
            const tierB = Number(b?.tier_current ?? 0);
            if (tierB !== tierA) return tierB - tierA;
            const styleA = Number(a?.style ?? 0);
            const styleB = Number(b?.style ?? 0);
            if (styleB !== styleA) return styleB - styleA;
            const nameA = String(a?.name ?? '');
            const nameB = String(b?.name ?? '');
            return nameA.localeCompare(nameB);
        });
    return activeTraits.slice(0, maxTraits);
}
