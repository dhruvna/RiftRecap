export function normalizeUnitCost(rarity) {
    const value = Number(rarity ?? 0);
    if (!Number.isFinite(value)) return 1;
    return Math.min(5, Math.max(1, Math.floor(value) + 1));
}

export function getUnitCost(unit) {
    const dataDragonCost = Number(unit?.cost);
    if (Number.isFinite(dataDragonCost) && dataDragonCost > 0) {
        return Math.min(5, Math.floor(dataDragonCost));
    }
    return normalizeUnitCost(unit?.rarity);
}

export function normalizeUnits(units, maxUnits) {
    if (!Array.isArray(units)) return [];
    const sortedUnits = [...units].sort((a, b) => {
        const costA = getUnitCost(a);
        const costB = getUnitCost(b);
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
