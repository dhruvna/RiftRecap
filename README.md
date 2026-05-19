# Rift Recap

A Discord bot built with **Node.js**, **discord.js**, and the **Riot Games API** that lets each server register Riot IDs, view rank data, and post automated match results.

## Current feature state

### Shared (TFT + LoL)
- Account registration and server-scoped storage (`/register`, `/unregister`, `/list`)
- Rank snapshot display via `/rank` (with game filter support)
- Automated match-result posting from the polling service
- `/leaderboard`
- `/recap`
- `/recapconfig`
- Full recap-oriented helper pipeline and canonical queue helpers (`gameFromQueue`, `defaultRankedQueueForGame`, `queueLabel`, `isRankedQueue`, `queueChoicesForRecap`)
- LoL data is supported for `/rank` and automated match-result posts.

## Command reference
- `/register` — register one or more Riot IDs for this server.
- `/unregister` — remove a Riot ID from this server.
- `/list` — list currently registered accounts in this server.
- `/rank` — show stored rank snapshots (supports TFT, LoL, or both).
- `/leaderboard` — TFT leaderboard view for registered players.
- `/recap` — TFT recap output from tracked matches.
- `/recapconfig` — configure recap autopost entries by `(game queue, mode)` and view status.
- `/resetranks confirm:true` — reset TFT rank snapshots + recap history for this server.
- `/resetranks confirm:true before_date:YYYY-MM-DD` — date-scoped reset for accounts with latest tracked TFT match before that UTC date.
- `/resetranks ... clear_match_cursor:true` — optionally wipe match cursor state.

## Required env vars
Required:
- `DISCORD_BOT_TOKEN` — Discord bot token
- `RIOT_TFT_API_KEY` — Riot Games API key (TFT endpoints)
- `RIOT_LOL_API_KEY` — Riot Games API key (LoL endpoints)

Optional defaults:
- `MATCH_POLL_INTERVAL_SECONDS` (default: `60`)
- `MATCH_POLL_PER_ACCOUNT_DELAY_MS` (default: `250`)
- `RECAP_AUTOPOST_HOUR` (default: `9`)
- `RECAP_AUTOPOST_MINUTE` (default: `0`)

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
Persistent storage uses `./user_data/registrations.json`.

At a high level, data is scoped by Discord `guildId`, then by registered account, and includes:
- Riot identity fields (game name/tag)
- Platform/region routing metadata
- Rank snapshot fields (per supported game as tracked)
- Latest seen match cursor(s) used by pollers
- Recap-related aggregates/history needed for recap output
- Reset metadata (including optional date-scoped reset cutoff)

Storage behavior:
- `user_data/` and `registrations.json` are auto-created if missing.
- Writes are atomic (temp file + rename).

## Data model migration note
The data model is canonical in `registrations.json`. Migration support is a one-time script and not an ongoing runtime transform.

## Known limitations
- Some `resetranks` edge cases still need broader verification coverage.
## Planned improvements
- `/season` command for looking up WR for the season, best champs, lp history 
- track teammates played with, aka create sets of usernames, track winrate per set. then can list the best performing lineups/roles can be a further extension though it increases possibilities by a LOT. would probably need to store this in a separate file (lineups.json)
- betting!?
- X is IN GAME

Historical timeline and archived notes are in [`docs/history.md`](docs/history.md).
