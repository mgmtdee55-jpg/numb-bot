# VoiceMaster

Existing Discord.js bot for temporary voice channels and VoiceMaster controls.

## Setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and set `DISCORD_TOKEN`.
3. Enable the bot's **Message Content Intent** and **Server Members Intent** in the Discord Developer Portal.
4. Install dependencies with `npm install`, then run `npm start`.
5. Give the bot **Manage Channels**, **Manage Roles**, **Move Members**, **View Channel**, **Send Messages**, **Embed Links**, and **Read Message History** in the server and the relevant category/channels. Manage Channels is used to create/delete channels; Manage Roles is required for the permission-overwrite controls.
6. The server owner runs `-vc setup` and opens the private wizard from the response button.

Configuration, temporary-channel ownership, bans, permits, and cleanup timers persist in SQLite at `./data/vc.sqlite` by default. Set `DB_PATH` to use a different location. The command prefix defaults to `-`.

Temporary VC category overflow is based on connected members across voice channels in each configured category. `VC_CATEGORY_OVERFLOW_THRESHOLD` sets the threshold (default `99`); when one category reaches it, new VCs use the next configured category. This setting does not move existing VCs.

On startup, VoiceMaster reconciles saved temporary VCs and their interface messages without resetting SQLite history. A rotating watchdog checks a bounded batch of VCs every minute and repairs missing interfaces; Discord.js handles REST rate limits while channel operations remain independently serialized.

VC control cooldowns are per user, channel, and action, with their durations centralized in `action-cooldowns.js`. Discord.js's REST manager handles Discord rate-limit waits and safe REST retries; VoiceMaster does not add a second retry loop around non-idempotent actions such as channel creation, kicks, or interface sends.

The wizard only uses channels and categories selected by the owner. Reconfiguration is explicit; cancelling or letting a wizard expire does not change the saved configuration.

Members need **View Channel** and **Connect** to use the selected Join to Create and temporary voice channels, and **Speak** to talk. These are member permissions, not permissions the bot needs to join voice. Keep the bot's text permissions available in the temporary voice-channel chat so it can post and recover the interface.
