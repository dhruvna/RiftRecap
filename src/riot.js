export {
    resolveRegion,
    getAccountByRiotId,
    getTFTRankByPuuid,
    getTFTMatchIdsByPuuid,
    getTFTMatch,
    getLolRankByPuuid,
    getLolMatchIdsByPuuid,
    getLolMatch,
    getLolActiveGameByPuuid,
    getTftActiveGameByPuuid,
    getProfileUrl,
    getMatchUrl,
} from './riot/api.js';

export {
    getLatestDDragonVersion,
    loadTFTRegalia,
    loadTFTChampions,
    loadTFTItems,
    loadTFTTraits,
    loadLolChampions,
    getTftRegaliaThumbnailUrl,
} from './riot/ddragon.js';

export {
    getTftChampionNameById,
    getTftChampionImageById,
    getTftItemNameById,
    getTftItemImageById,
    getTftTraitNameById,
    getTftTraitImageById,
    getLolChampionImageKeyById,
    getLolChampionImageById,
} from './riot/ddragonIndexes.js';
