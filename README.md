# TnD Scheduler

A Discord.js v14 bot that schedules D&D sessions with slash commands and reaction votes.

## Configuration

The existing `config.json` token is supported locally but the file is optional. For local slash-command registration, add the bot application ID as `clientId`. Add a test server ID as `guildId` for immediate guild-only command updates. Keep the real `config.json` private because it is ignored by Git; Heroku uses environment config vars instead.

```json
{
  "token": "existing-token",
  "clientId": "application-id",
  "guildId": "test-server-id",
  "scheduleWaitMs": 3600000,
  "scheduleUserThreshold": 3
}
```

Every value can instead be supplied through `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `SCHEDULE_WAIT_MS`, and `SCHEDULE_USER_THRESHOLD`. Environment variables take precedence. If `guildId` is omitted, registration creates global commands, which can take longer to appear. The user threshold defaults to three.

## Run locally

Install dependencies with `npm install`, register slash commands once with `npm run register`, and start the bot with `npm start`.

The server must contain custom emojis named `fri`, `sat`, `sunday`, and `other`, plus a role named `DndPlayers`. Time votes use Discord's built-in `7️⃣`, `8️⃣`, `9️⃣`, and `🇴` emojis.

## Test the schedule flow

1. Set `SCHEDULE_WAIT_MS` to a short value such as `10000` (10 seconds), or set `scheduleWaitMs` in `config.json`.
2. Restart the bot after changing the wait value.
3. Run `/schedule` in a channel where the bot can send messages, mention `DndPlayers`, read history, and add reactions.
4. Have three distinct non-bot users select one or more valid reactions. Each user counts once toward the threshold, while each selected option counts as a vote. Override this with `SCHEDULE_USER_THRESHOLD` if needed.
5. After the configured delay, verify that a Friday/Saturday/Sunday result starts a time vote, `Other` appoints a discussion leader, and `Not Coming` produces no follow-up.
6. After the first result, change reactions on the latest `/schedule` message so a different option wins. After another configured delay, the bot recalculates the live votes, announces that the majority changed, and then sends the corresponding updated time vote or `Other` message.
7. If a changed vote produces a top tie that includes the previously announced result, the previous result remains active and no change message is sent.

Only the newest `/schedule` message in each server is monitored for changed votes. It remains active through any number of majority changes, regardless of other time-vote or discussion messages sent afterward. The discussion-leader list and active vote timers are in memory and reset whenever the bot restarts.

## Heroku

The included `Procfile` runs `worker: npm start`. On Heroku, configure `DISCORD_TOKEN` and optionally `SCHEDULE_WAIT_MS` as config vars. Deploy this as a **worker dyno**, not a web dyno; the bot does not expose an HTTP server. Run command registration during deployment or from a trusted local machine with the production application ID. Do not commit production tokens.

To deploy from the Heroku CLI in Windows PowerShell:

```
$APP_NAME = "tnd-scheduler"
heroku git:remote --app $APP_NAME
git push heroku HEAD:main
heroku run --app $APP_NAME -- node register-commands.js
heroku ps:scale web=0 worker=1 --app $APP_NAME
heroku logs --tail --app $APP_NAME
```

You do not need to register commands if none of the slash commands have changed.

To stop or restart the bot, run:

```
heroku ps:scale web=0 worker=0 --app $APP_NAME
heroku ps:scale web=0 worker=1 --app $APP_NAME
heroku ps:restart worker --app $APP_NAME
```

For faster testing on the deployed app, run:
`heroku config:set SCHEDULE_WAIT_MS="10000" SCHEDULE_USER_THRESHOLD="3" --app $APP_NAME`

## Discord setup

In the Developer Portal, enable the privileged **Server Members Intent** because username/display-name lookup is used for discussion leaders. **Message Content Intent is not needed** because interaction is through slash commands and reactions.

Build the invite URL with these scopes:

- `bot`
- `applications.commands`

Grant these bot permissions:

- View Channels
- Send Messages
- Read Message History
- Add Reactions
- Use External Emojis, if the configured custom emojis are not native to the server
- Mention Everyone (this permission also controls mentioning roles)

Slash/application command support comes from the `applications.commands` scope rather than a separate channel permission. In the Discord server, also ensure the bot's role and the target channel allow these actions. To ping `DndPlayers`, either grant the bot **Mention Everyone** or make the `DndPlayers` role mentionable. Place the bot's role appropriately if server role restrictions require it.
