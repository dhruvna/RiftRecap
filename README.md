# Rift Recap

A Discord bot built with **Node.js**, **discord.js**, and the **Riot Games API** that lets each server register Riot IDs, view rank data, and post automated match results for TFT and League of Legends.

## Current feature state

### Shared (TFT + LoL)
- Account registration and server-scoped storage (`/register`, `/unregister`, `/list`). Registration stores both TFT and LoL identities, rank snapshots, and match cursors for each Riot ID.
- Rank snapshot display via `/rank` with a game filter (`TFT`, `LoL`, or both).
- Automated live-game and post-match announcements from the polling service for ranked TFT and ranked LoL queues.
- Queue-aware `/leaderboard`, `/recap`, and `/recapconfig` support for TFT and LoL ranked queues.
- Full recap-oriented helper pipeline and canonical queue helpers (`gameFromQueue`, `defaultRankedQueueForGame`, `queueLabel`, `isRankedQueue`, `queueChoicesForRecap`).

### LoL-specific
- LoL ranked Solo/Duo, Ranked Flex, and Ranked 5s rank snapshots, leaderboard entries, recaps, and match announcements are supported.
- `/lineups` shows top LoL registered-player lineup win rates from recorded ranked Solo/Duo duos, ranked Flex 2-, 3-, or 5-player groups, and Ranked 5s lineups according to the chosen eligibility rule.

## Command reference
- `/register gamename:<name> tagline:<tag> region:<region> [send_match_alerts]` — register a Riot ID and initialize TFT + LoL tracking. Set `send_match_alerts:false` to exclude that account from TFT and LoL live alerts, match-result announcements, recaps, and leaderboards. Re-run the same registration later with `send_match_alerts:true` or `false` to change the setting without resetting its history.
- `/unregister` — remove a Riot ID from this server.
- `/list` — list currently registered accounts in this server.
- `/rank` — show stored rank snapshots for TFT, LoL, or both.
- `/leaderboard [queue] [limit]` — show the server leaderboard for registered accounts in a selected TFT or LoL ranked queue. Defaults to Ranked TFT and shows up to 15 entries unless `limit` is provided.
- `/recap [queue] [mode]` — post an on-demand daily or weekly recap for a selected TFT or LoL ranked queue. Defaults to Ranked TFT and daily mode when options are omitted.
- `/recapconfig status:true` — show recap autopost status and the configured UTC schedule.
- `/recapconfig queue:<queue> mode:<mode> enabled:<true|false>` — enable or disable autoposting for a `(queue, mode)` pair. Supports TFT and LoL ranked queues, including LoL Solo/Duo, Ranked Flex, and Ranked 5s; `mode` may be daily, weekly, or both.
- `/lineups [user] [min_games] [size]` — show the top 10 LoL lineups by win rate for this server, tracking ranked Solo/Duo duos, ranked Flex 2-, 3-, or 5-player groups, and Ranked 5s 5-player lineups according to the chosen eligibility rule; optionally filter to a registered user, minimum games, or lineup size.
- `/setchannel channel:<channel> [queue_preset]` — set the announcement channel and choose whether ranked TFT, ranked LoL, or both are announced.
- `/resetranks confirm:true [game]` — clear stored rank snapshots and recap history for TFT, LoL, or both. Defaults to TFT when `game` is omitted and keeps match cursors by default to avoid replaying old matches.
- `/resetranks confirm:true before_date:YYYY-MM-DD [game]` — clear only accounts whose latest tracked match for the selected game scope is before `YYYY-MM-DD 00:00:00 UTC`; also saves that season cutoff for future polling.
- `/resetranks ... clear_match_cursor:true` — also clear `lastMatchId` and `lastMatchAt` for the selected game scope.

## Environment variables
`DISCORD_BOT_TOKEN` — Discord bot token.
- `DISCORD_CLIENT_ID` — Discord application/client ID used to register slash commands.
- `RIOT_TFT_API_KEY` — Riot Games API key for TFT endpoints.
- `RIOT_LOL_API_KEY` — Riot Games API key for LoL endpoints.

Optional runtime configuration:
- `DEFAULT_REGION` (default: `NA`) — fallback Riot region. Supported values are `NA`, `EUW`, `EUNE`, `KR`, `BR`, `LAN`, `LAS`, `OCE`, `JP`, `RU`, `TR`, `VN`, `SG`, `PH`, `TH`, and `TW`.
- `MATCH_POLL_INTERVAL_SECONDS` (default: `60`, min: `10`, max: `3600`) — polling loop interval.
- `RANK_REFRESH_INTERVAL_MINUTES` (default: `180`, min: `5`, max: `1440`) — minimum age before refreshing stored rank snapshots.
- `RECAP_AUTOPOST_HOUR` (default: `9`, range: `0`-`23`) — UTC hour for recap autoposts.
- `RECAP_AUTOPOST_MINUTE` (default: `0`, range: `0`-`59`) — UTC minute for recap autoposts.
- `LOL_POST_MATCH_ANNOUNCEMENT_STRATEGY` (default: `edit`) — use `edit` to update a tracked live-game post or `delete_and_send` to replace it with a completed-match post.
- `TFT_POST_MATCH_ANNOUNCEMENT_STRATEGY` (default: `edit`) — same strategy options for TFT announcements.
- `LIVE_ANNOUNCE_RANKED_ONLY` (default: `true`) — when true, live announcements are restricted to ranked queues.
- `DEBUG` (default: `false`) — when true, forces debug logging.
- `LOG_LEVEL` (default: `info`) — one of `debug`, `info`, `warn`, or `error`. Ignored when `DEBUG=true`.

Optional storage overrides:
- `DATA_DIR` (default: `./user_data`) — base directory used to derive the default SQLite database path.
- `DATABASE_PATH` (default: `./user_data/riftrecap.sqlite`) — explicit SQLite database path for all persistent bot data.

See `.env.example` for a copyable template containing only supported public configuration values.

## Setup and run
1. Install dependencies:
   ```bash
   npm install
   ```
2. Set required environment variables.
3. Register slash commands:
   ```bash
   npm run register (node src/register-commands.js)
   ```
4. Start the bot:
   ```bash
   npm run start (node src/index.js)
   ```

## Data model
Persistent storage uses SQLite only and defaults to `./user_data/riftrecap.sqlite`.

At a high level, registration data is scoped by Discord `guildId`, then by registered account, and includes:
- Riot identity fields (game name/tag) and Riot routing metadata.
- Per-game identity, rank snapshot, latest match cursor, and recap history for supported games.
- Announcement channel and queue settings.
- Recap autopost configuration and send history.
- Reset metadata such as optional season cutoffs.

Storage behavior:
- `user_data/` and the SQLite database file are auto-created if missing.
- `DATA_DIR` can change the base directory used by the default database path.
- `DATABASE_PATH` can redirect the SQLite database to an explicit file path.

## Known limitations
- Some `resetranks` edge cases still need broader verification coverage.
## Active roadmap
- `/season` command for looking up WR for the season, best champs, LP history.
- Betting features.


Historical timeline and archived notes are in [`docs/history.md`](docs/history.md).
