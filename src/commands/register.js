import { SlashCommandBuilder } from "discord.js";

import {
    getTFTMatch,
    getTFTRankByPuuid,
    getTFTMatchIdsByPuuid,
    getLolRankByPuuid,
    getLolMatchIdsByPuuid,
    getLolMatch,
    resolveRegion,
} from '../riot.js';

import { REGION_CHOICES } from '../constants/regions.js';

import {
    makeAccountKey,
    upsertGuildAccountInStore,
} from '../storage.js';
import { LOL_QUEUE_TYPES, TFT_QUEUE_TYPES } from "../constants/queues.js";
import { getRegistrationSnapshot } from "../services/registrationSnapshot.js";

export default {
    data: new SlashCommandBuilder()
        .setName("register")
        .setDescription("Register Riot ID in this server for future lookup")
        .addStringOption((opt) =>
            opt.setName('gamename').setDescription('Riot ID Gamename (before #)').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('tagline').setDescription('Riot ID Tagline (after #)').setRequired(true)
        )
        .addStringOption((opt) =>
            opt.setName('region').setDescription('Region like NA, EUW, KR').setRequired(true).addChoices(...REGION_CHOICES)
        ),

    async execute(interaction) {
        // 1. Ensure command is run in a server only
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({content: "This command can only be used in a server (not DMs).", ephemeral: true});
            return;
        }

        // 2. Pull user inputs from disc command
        const gameName = interaction.options.getString("gamename", true);
        const tagLine = interaction.options.getString("tagline", true);
        const regionInput = interaction.options.getString("region", true);

        // 3. Normalize platform + get regional routing 
        const { platform, regional, region } = resolveRegion(regionInput);
        
        // 4. Defer reply in case of Riot API delay
        await interaction.deferReply({ ephemeral: true });

        // 5. Gather TFT + LoL registration snapshots via shared helper
        let tftSnapshot;
        let lolSnapshot;
        try {
            tftSnapshot = await getRegistrationSnapshot({
                gameType: 'TFT',
                regional,
                platform,
                gameName,
                tagLine,
                rankFetcher: getTFTRankByPuuid,
                matchIdsFetcher: getTFTMatchIdsByPuuid,
                matchFetcher: getTFTMatch,
                rankedQueues: new Set([
                    TFT_QUEUE_TYPES.RANKED,
                    TFT_QUEUE_TYPES.RANKED_DOUBLE_UP,
                ]),
                getMatchTimestamp: (match) => match?.info?.game_datetime ?? 0,
            });
            lolSnapshot = await getRegistrationSnapshot({
                gameType: 'LOL',
                regional,
                platform,
                gameName,
                tagLine,
                rankFetcher: getLolRankByPuuid,
                matchIdsFetcher: getLolMatchIdsByPuuid,
                matchFetcher: getLolMatch,
                rankedQueues: new Set([
                    LOL_QUEUE_TYPES.RANKED_SOLO_DUO,
                    LOL_QUEUE_TYPES.RANKED_FLEX,
                ]),
                getMatchTimestamp: (match) => {
                    const gameEndTimestamp = Number(match?.info?.gameEndTimestamp ?? 0);
                    if (Number.isFinite(gameEndTimestamp) && gameEndTimestamp > 0) return gameEndTimestamp;
                    return Number(match?.info?.gameCreation ?? 0);
                },
            });
        } catch (err) {
            const status = err?.status;
            console.error(
                `[register] getAccountByRiotId failed status=${status ?? 'unknown'} endpoint=${err?.endpoint ?? 'unknown'} gameName=${gameName} tagLine=${tagLine} region=${region}`,
                err?.responseText ? { responseText: err.responseText } : err
            );

            if (status === 404) {
                await interaction.editReply("Couldn't find that Riot ID. Please double-check spelling and try again.");
                return;
            }

            if (status === 401 || status === 403) {
                await interaction.editReply('Riot API key/config issue. Please try again later.');
                return;
            }

            if (status === 429) {
                await interaction.editReply('Riot API rate limited, try again shortly.');
                return;
            }

            await interaction.editReply('Temporary Riot API failure. Please try again shortly.');
            return;
        }
        const { account: tftAccount, ...tftState } = tftSnapshot;
        const { account: lolAccount, ...lolState } = lolSnapshot;

        // 9. Build stored record
        const stored = {
            key: makeAccountKey({ gameName: tftAccount.gameName, tagLine: tftAccount.tagLine, platform }),
            gameName: tftAccount.gameName,
            tagLine: tftAccount.tagLine,
            region,
            platform,
            regional,
            identity: {
                tft: { puuid: tftAccount.puuid ?? null },
                lol: { puuid: lolAccount?.puuid ?? null },
            },
            trackedGames: {
                tft: {
                    enabled: true,
                    liveState: 'idle',
                    liveGameId: null,
                    liveDetectedAt: null,
                    awaitingSince: null,
                    lastMatchId: tftState.lastMatchId,
                    lastMatchAt: tftState.lastMatchAt,
                    lastRankByQueue: tftState.lastRankByQueue,
                    recapEvents: [],
                },
                lol: {
                    enabled: true,
                    liveState: 'idle',
                    liveGameId: null,
                    liveDetectedAt: null,
                    awaitingSince: null,
                    lastMatchId: lolState.lastMatchId,
                    lastMatchAt: lolState.lastMatchAt,
                    lastRankByQueue: lolState.lastRankByQueue,
                    recapEvents: [],
                },
            },
        };

        // 10. Upsert into storage
        const { existed } = await upsertGuildAccountInStore(guildId, stored);

        // 11. Confirm to user
        if (existed) {
            await interaction.editReply(`**${stored.gameName}#${stored.tagLine}** is already registered in this server.`);
            return;
        }
    
        await interaction.editReply(`Successfully registered **${stored.gameName}#${stored.tagLine}** for this server.`);
    },
};
