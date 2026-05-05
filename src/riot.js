export {
    resolveRegion,
    getAccountByRiotId,
    getTFTRankByPuuid,
    getTFTMatchIdsByPuuid,
    getTFTMatch,
    getLolRankByPuuid,
    getLolMatchIdsByPuuid,
    getLolMatch,
    getProfileUrl,
    getMatchUrl,
} from './riot/api.js';

export {
    getLatestDDragonVersion,
    loadTFTRegalia,
    loadTFTChampions,
    loadTFTItems,
    loadTFTTraits,
    getTftRegaliaThumbnailUrl,
} from './riot/ddragon.js';

export {
    getTftChampionNameById,
    getTftChampionImageById,
    getTftItemNameById,
    getTftItemImageById,
    getTftTraitNameById,
    getTftTraitImageById,
} from './riot/ddragonIndexes.js';
