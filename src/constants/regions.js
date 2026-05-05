// === Riot routing overview ===
// Riot uses two routing models:
// - Platform routing targets shard-specific endpoints (e.g., na1, euw1) for League/TFT data.
// - Regional routing targets broader clusters (e.g., americas, europe, asia, sea) for account/match APIs.

// === Discord dropdown choices ===
// Keep the display list in a single place so commands can reuse it consistently.
export const REGION_CHOICES = [
    { name: "NA", value: "NA" },
    { name: "EUW", value: "EUW" },
    { name: "EUNE", value: "EUNE" },
    { name: "KR", value: "KR" },
    { name: "BR", value: "BR" },
    { name: "LAN", value: "LAN" },
    { name: "LAS", value: "LAS" },
    { name: "OCE", value: "OCE" },
    { name: "JP", value: "JP" },
    { name: "RU", value: "RU" },
    { name: "TR", value: "TR" },
    { name: "VN", value: "VN" },
    { name: "SG", value: "SG" },
    { name: "PH", value: "PH" },
    { name: "TH", value: "TH" },
    { name: "TW", value: "TW" },
];

// === Routing map ===
// Maps user-facing region -> Riot routing values used by API requests.
export const REGION_TO_ROUTES = {
    NA:  { platform: 'na1', regional: 'americas' },
    BR:  { platform: 'br1', regional: 'americas' },
    LAN: { platform: 'la1', regional: 'americas' },
    LAS: { platform: 'la2', regional: 'americas' },

    EUW: { platform: 'euw1', regional: 'europe' },
    EUNE:{ platform: 'eun1', regional: 'europe' },
    TR:  { platform: 'tr1', regional: 'europe' },
    RU:  { platform: 'ru', regional: 'europe' },

    KR:  { platform: 'kr', regional: 'asia' },
    JP:  { platform: 'jp1', regional: 'asia' },

    OCE: { platform: 'oc1', regional: 'sea' },
    SG:  { platform: 'sg2', regional: 'sea' },
    PH:  { platform: 'ph2', regional: 'sea' },
    TH:  { platform: 'th2', regional: 'sea' },
    TW:  { platform: 'tw2', regional: 'sea' },
    VN:  { platform: 'vn2', regional: 'sea' },
};
