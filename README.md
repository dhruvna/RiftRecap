# Rift Recap

A Discord bot built with **Node.js**, **discord.js**, and the **Riot Games API** that lets each server register Riot IDs, view rank data, and post automated match results.

## What the bot does now

### Shared (TFT + LoL)
- Account registration and server-scoped storage (`/register`, `/unregister`, `/list`)
- Rank snapshot display via `/rank` (with game filter support)
- Automated match-result posting from the polling service

### TFT-only today
- `/leaderboard`
- `/recap`
- `/recapconfig`
- Full recap-oriented helper pipeline and constants

### LoL boundaries today
- LoL data is supported for `/rank` and automated match-result posts.
- LoL does **not** yet have parity for leaderboard/recap command output.

## Command reference
- `/register` — register one or more Riot IDs for this server.
- `/unregister` — remove a Riot ID from this server.
- `/list` — list currently registered accounts in this server.
- `/rank` — show stored rank snapshots (supports TFT, LoL, or both).
- `/leaderboard` — TFT leaderboard view for registered players.
- `/recap` — TFT recap output from tracked matches.
- `/recapconfig` — configure recap behavior/autopost settings.
- `/resetranks confirm:true` — reset TFT rank snapshots + recap history for this server.
- `/resetranks confirm:true before_date:YYYY-MM-DD` — date-scoped reset for accounts with latest tracked TFT match before that UTC date.
- `/resetranks ... clear_match_cursor:true` — optionally wipe match cursor state.

## Required env vars
Required:
- `DISCORD_BOT_TOKEN` — Discord bot token
- `RIOT_TFT_API_KEY` — Riot Games API key (TFT endpoints)
- `RIOT_LOL_API_KEY` — Riot Games API key (LoL endpoints)

Optional:
- `MATCH_POLL_INTERVAL_SECONDS` (default: 60)
- `MATCH_POLL_PER_ACCOUNT_DELAY_MS` (default: 250)
- `RECAP_AUTOPOST_HOUR` (default: 9)
- `RECAP_AUTOPOST_MINUTE` (default: 0)

## Startup / deploy instructions
1. Install dependencies:
   ```bash
   npm install
   ```
2. Set required environment variables.
3. Register slash commands (when command definitions change):
   ```bash
   npm run register (node src/register-commands.js)
   ```
4. Start the bot:
   ```bash
   npm run start (node src/index.js)
   ```

## Data schema summary
Persistent storage uses `./user_data/registrations.json`.

At a high level, data is scoped by Discord `guildId`, then by registered account, and includes:
- Riot identity fields (game name/tag)
- platform/region routing metadata
- rank snapshot fields (per supported game as tracked)
- latest seen match cursor(s) used by pollers
- recap-related aggregates/history needed for recap output
- reset metadata (including optional date-scoped reset cutoff)

Storage behavior:
- `user_data/` and `registrations.json` are auto-created if missing.
- Writes are atomic (temp file + rename).

## Maintenance operations
- `resetranks` supports:
  - full server TFT snapshot/recap reset,
  - date-scoped reset via `before_date` cutoff,
  - optional cursor wipe via `clear_match_cursor:true`.
- Recap behavior:
  - recap data is generated from tracked matches,
  - autopost scheduling is configurable via `/recapconfig`.

## Known limitations
- Hosting/runtime operations are environment-specific and not bundled in this repo.
- Some `resetranks` edge cases still need broader verification coverage.

## Planned improvements
- `/lastmatch` command for quick latest-match lookup.

Historical timeline and archived TODO notes moved to [`docs/history.md`](docs/history.md).
