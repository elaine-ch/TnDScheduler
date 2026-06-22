const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} = require('discord.js');
const config = require('./config.json');

const token = process.env.DISCORD_TOKEN || config.token;
const scheduleWaitMs = Number(
  process.env.SCHEDULE_WAIT_MS ?? config.scheduleWaitMs ?? 60 * 60 * 1000,
);
const scheduleUserThreshold = Number(
  process.env.SCHEDULE_USER_THRESHOLD ?? config.scheduleUserThreshold ?? 3,
);

if (!token) {
  throw new Error('Set DISCORD_TOKEN or add "token" to config.json.');
}

if (!Number.isFinite(scheduleWaitMs) || scheduleWaitMs < 0) {
  throw new Error('SCHEDULE_WAIT_MS (or config.scheduleWaitMs) must be a non-negative number.');
}

if (!Number.isInteger(scheduleUserThreshold) || scheduleUserThreshold < 1) {
  throw new Error('SCHEDULE_USER_THRESHOLD (or config.scheduleUserThreshold) must be a positive integer.');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

const DAY_EMOJIS = {
  friday: { customName: 'fri' },
  saturday: { customName: 'sat' },
  sunday: { customName: 'sunday' },
  other: { customName: 'other' },
  notComing: { unicode: '❌' },
};

const TIME_EMOJIS = {
  seven: { unicode: '7\ufe0f\u20e3' },
  eight: { unicode: '8\ufe0f\u20e3' },
  nine: { unicode: '9\ufe0f\u20e3' },
  other: { unicode: '🇴' },
};

// In-memory only: changes made with /adduser and /removeuser reset on restart.
// Initial entries are usernames; newly added users are stored by Discord ID.
const usersList = ['arlo37', 'citrus_bear', 'bkash_', 'mo7hb4e', 'croster'];

// Active votes and their timers are intentionally in-memory only. Only the most
// recent /schedule message in each guild remains active.
const activeDayVotes = new Map();
const latestDayVotesByGuild = new Map();

function resolveCustomEmojis(guild, definitions) {
  const resolved = {};
  const missing = [];

  for (const [key, definition] of Object.entries(definitions)) {
    if (definition.unicode) {
      resolved[key] = {
        display: definition.unicode,
        reaction: definition.unicode,
        matches: (reactionEmoji) => reactionEmoji.name === definition.unicode,
      };
      continue;
    }

    const emoji = guild.emojis.cache.find((item) => item.name === definition.customName);
    if (!emoji) {
      missing.push(`:${definition.customName}:`);
      continue;
    }

    resolved[key] = {
      display: emoji.toString(),
      reaction: emoji.id,
      matches: (reactionEmoji) => reactionEmoji.id === emoji.id,
    };
  }

  if (missing.length > 0) {
    throw new Error(`Missing required server emoji${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);
  }

  return resolved;
}

async function addReactions(message, emojiOptions) {
  for (const option of Object.values(emojiOptions)) {
    try {
      await message.react(option.reaction);
    } catch (error) {
      // A missing Add Reactions permission or inaccessible emoji should not crash the bot.
      console.error(`Could not add reaction ${option.display} to message ${message.id}:`, error);
    }
  }
}

async function sendTimeVote(channel, guild, day) {
  const emojis = resolveCustomEmojis(guild, TIME_EMOJIS);
  const message = await channel.send([
    `What time on ${day}?`,
    '',
    `React with ${emojis.seven.display} for 7pm`,
    `React with ${emojis.eight.display} for 8pm`,
    `React with ${emojis.nine.display} for 9pm`,
    `React with ${emojis.other.display} for Other`,
  ].join('\n'));

  await addReactions(message, emojis);
  return message;
}

async function sendDayVote(interaction) {
  const { guild, channel } = interaction;
  const emojis = resolveCustomEmojis(guild, DAY_EMOJIS);
  const role = guild.roles.cache.find((item) => item.name.toLowerCase() === 'dndplayers');

  if (!role) {
    throw new Error('Could not find a server role named DndPlayers.');
  }

  const message = await channel.send({
    content: [
      `${role} What day should DnD be?`,
      `Note: You are REQUIRED to vote otherwise scheduling cannot proceed.`,
      '',
      `React with ${emojis.friday.display} for Friday`,
      `React with ${emojis.saturday.display} for Saturday`,
      `React with ${emojis.sunday.display} for Sunday`,
      `React with ${emojis.other.display} for Other`,
      `React with ${emojis.notComing.display} for Not Coming`,
    ].join('\n'),
    allowedMentions: { roles: [role.id] },
  });

  const previousVote = latestDayVotesByGuild.get(guild.id);
  if (previousVote) {
    clearTimeout(previousVote.initialTimer);
    clearTimeout(previousVote.updateTimer);
    activeDayVotes.delete(previousVote.message.id);
  }

  const vote = {
    message,
    emojiOptions: emojis,
    initialTimer: null,
    updateTimer: null,
    initialResolved: false,
    lastWinner: null,
    checkingVote: false,
    recheckRequested: false,
  };

  activeDayVotes.set(message.id, vote);
  latestDayVotesByGuild.set(guild.id, vote);
  await addReactions(message, emojis);
  return message;
}

function findOptionKey(reactionEmoji, emojiOptions) {
  return Object.entries(emojiOptions).find(([, option]) => option.matches(reactionEmoji))?.[0];
}

async function collectReactionData(message, emojiOptions) {
  const distinctUserIds = new Set();
  const totals = Object.fromEntries(Object.keys(emojiOptions).map((key) => [key, 0]));

  for (const reaction of message.reactions.cache.values()) {
    const optionKey = findOptionKey(reaction.emoji, emojiOptions);
    if (!optionKey) continue;

    const users = await reaction.users.fetch();
    for (const user of users.values()) {
      if (user.bot) continue;
      distinctUserIds.add(user.id);
      totals[optionKey] += 1;
    }
  }

  return { distinctUserIds, totals };
}

function determineWinningDay(totals, previousWinner = null) {
  const highestVoteCount = Math.max(...Object.values(totals));
  if (highestVoteCount === 0) return null;

  const tied = Object.keys(totals).filter((key) => totals[key] === highestVoteCount);

  // Once a result has been announced, a top tie that includes that result does
  // not count as a changed majority. This avoids replacing the previous result
  // solely because of the normal tie-breaking priority.
  if (tied.length > 1 && previousWinner && tied.includes(previousWinner)) {
    return previousWinner;
  }

  // Explicit tie rules: Other beats a day; later weekend days beat earlier ones.
  // For otherwise unspecified ties, Not Coming wins so the bot does not schedule
  // a session against an equally large unavailable group.
  const tiePriority = ['other', 'notComing', 'sunday', 'saturday', 'friday'];
  return tiePriority.find((key) => tied.includes(key)) || null;
}

async function findGuildMember(guild, entry) {
  const members = await guild.members.fetch();

  if (/^\d{17,20}$/.test(entry)) {
    return members.get(entry) || null;
  }

  const target = entry.toLowerCase();
  return members.find((member) =>
    member.user.username.toLowerCase() === target
    || member.displayName.toLowerCase() === target,
  ) || null;
}

async function selectDiscussionLeader(guild) {
  if (usersList.length === 0) return { mention: 'No discussion leader is configured' };

  const entry = usersList[Math.floor(Math.random() * usersList.length)];
  const member = await findGuildMember(guild, entry);

  // TODO: Migrate all initial username entries to Discord IDs. IDs do not change
  // when a user updates their username or server display name.
  return { mention: member ? `<@${member.id}>` : entry };
}

function isLatestDayVote(vote) {
  return latestDayVotesByGuild.get(vote.message.guild.id) === vote;
}

async function publishDayVoteResult(vote, winner, isUpdate = false) {
  if (!winner) return;

  const message = await vote.message.fetch();

  if (isUpdate) {
    const winnerLabels = {
      friday: 'Friday',
      saturday: 'Saturday',
      sunday: 'Sunday',
      other: 'Other',
      notComing: 'Not Coming',
    };
    await message.channel.send(`The votes have changed! The majority wants ${winnerLabels[winner]}.`);
  }

  if (winner === 'notComing') {
    vote.lastWinner = winner;
    return;
  }

  if (winner === 'other') {
    const leader = await selectDiscussionLeader(message.guild);
    await message.channel.send({
      content: `The majority of votes have been on 'Other.' ${leader.mention}, you are now the discussion leader! Once a day has been decided, use the /time command followed by the day D&D should take place.`,
      allowedMentions: { users: leader.mention.startsWith('<@') ? [leader.mention.slice(2, -1)] : [] },
    });
  } else {
    const day = winner.charAt(0).toUpperCase() + winner.slice(1);
    await sendTimeVote(message.channel, message.guild, day);
  }

  vote.lastWinner = winner;
}

async function resolveInitialDayVote(vote) {
  try {
    if (!isLatestDayVote(vote)) return;

    const message = await vote.message.fetch();
    const { totals } = await collectReactionData(message, vote.emojiOptions);
    const winner = determineWinningDay(totals, vote.lastWinner);

    vote.initialResolved = true;
    await publishDayVoteResult(vote, winner);
  } catch (error) {
    console.error(`Could not finish day vote ${vote.message.id}:`, error);
    await vote.message.channel.send(`Could not finish the schedule vote: ${error.message}`).catch(console.error);
  } finally {
    vote.initialTimer = null;
    if (isLatestDayVote(vote)) {
      checkDayVote(vote).catch((error) => console.error('Could not recheck the initial day vote:', error));
    }
  }
}

async function resolveUpdatedDayVote(vote) {
  try {
    if (!isLatestDayVote(vote)) return;

    const message = await vote.message.fetch();
    const { distinctUserIds, totals } = await collectReactionData(message, vote.emojiOptions);
    if (distinctUserIds.size < scheduleUserThreshold) return;

    const winner = determineWinningDay(totals, vote.lastWinner);
    if (!winner || winner === vote.lastWinner) return;

    await publishDayVoteResult(vote, winner, true);
  } catch (error) {
    console.error(`Could not update day vote ${vote.message.id}:`, error);
    await vote.message.channel.send(`Could not update the schedule vote: ${error.message}`).catch(console.error);
  } finally {
    vote.updateTimer = null;
    if (isLatestDayVote(vote)) {
      checkDayVote(vote).catch((error) => console.error('Could not recheck the updated day vote:', error));
    }
  }
}

async function evaluateDayVote(vote) {
  const message = await vote.message.fetch();
  const { distinctUserIds, totals } = await collectReactionData(message, vote.emojiOptions);
  if (distinctUserIds.size < scheduleUserThreshold) return;

  if (!vote.initialResolved) {
    if (vote.initialTimer) return;

    // The initial countdown starts once the configured number of distinct
    // non-bot users have voted.
    vote.initialTimer = setTimeout(() => resolveInitialDayVote(vote), scheduleWaitMs);
    return;
  }

  const winner = determineWinningDay(totals, vote.lastWinner);
  if (!winner || winner === vote.lastWinner || vote.updateTimer) return;

  // Set SCHEDULE_WAIT_MS to a smaller value (for example, 10000 for 10 seconds)
  // while testing. The current majority is recalculated when the timer expires,
  // so users may continue changing their reactions during the waiting period.
  vote.updateTimer = setTimeout(() => resolveUpdatedDayVote(vote), scheduleWaitMs);
}

async function checkDayVote(vote) {
  if (!isLatestDayVote(vote)) return;

  if (vote.checkingVote) {
    // Changing a selection normally emits a remove and an add event close
    // together. Never discard the second event while an API recount is active.
    vote.recheckRequested = true;
    return;
  }

  vote.checkingVote = true;

  try {
    do {
      vote.recheckRequested = false;
      await evaluateDayVote(vote);
    } while (vote.recheckRequested && isLatestDayVote(vote));
  } finally {
    vote.checkingVote = false;
  }
}

function displayUserListEntry(entry) {
  return /^\d{17,20}$/.test(entry) ? `<@${entry}>` : entry;
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inGuild()) return;

  try {
    if (interaction.commandName === 'schedule') {
      await interaction.deferReply({ ephemeral: true });
      const message = await sendDayVote(interaction);
      await interaction.editReply(`Schedule vote created: ${message.url}`);
      return;
    }

    if (interaction.commandName === 'time') {
      await interaction.deferReply({ ephemeral: true });
      const day = interaction.options.getString('day', true);
      const message = await sendTimeVote(interaction.channel, interaction.guild, day);
      await interaction.editReply(`Time vote created: ${message.url}`);
      return;
    }

    if (interaction.commandName === 'adduser') {
      const user = interaction.options.getUser('user', true);
      const duplicate = usersList.some((entry) =>
        entry === user.id || entry.toLowerCase() === user.username.toLowerCase(),
      );

      if (duplicate) {
        await interaction.reply({ content: `${user} is already in the discussion-leader list.`, ephemeral: true });
      } else {
        usersList.push(user.id);
        await interaction.reply({ content: `Added ${user} to the discussion-leader list.`, ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'removeuser') {
      const user = interaction.options.getUser('user', true);
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const names = [user.username, member?.displayName].filter(Boolean).map((name) => name.toLowerCase());
      const index = usersList.findIndex((entry) =>
        entry === user.id || names.includes(entry.toLowerCase()),
      );

      if (index === -1) {
        await interaction.reply({ content: `${user} was not found in the discussion-leader list.`, ephemeral: true });
      } else {
        const [removed] = usersList.splice(index, 1);
        await interaction.reply({ content: `Removed ${displayUserListEntry(removed)} from the discussion-leader list.`, ephemeral: true });
      }
      return;
    }

    if (interaction.commandName === 'help') {
      await interaction.reply({
        content: [
          '**D&D Scheduler commands**',
          '`/schedule` - starts the D&D day scheduling vote.',
          '`/time <day>` - manually starts a time vote for a chosen day.',
          '`/adduser <user>` - adds a user to the discussion-leader list.',
          '`/removeuser <user>` - removes a user from the discussion-leader list.',
          '`/help` - shows this command list.',
        ].join('\n'),
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error(`Command /${interaction.commandName} failed:`, error);
    const content = `Could not complete that command: ${error.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(content).catch(console.error);
    } else {
      await interaction.reply({ content, ephemeral: true }).catch(console.error);
    }
  }
});

async function handleDayVoteReactionChange(reaction, user) {
  if (user.bot) return;

  try {
    const vote = activeDayVotes.get(reaction.message.id);
    if (!vote || !findOptionKey(reaction.emoji, vote.emojiOptions)) return;
    await checkDayVote(vote);
  } catch (error) {
    console.error('Could not process a schedule reaction change:', error);
  }
}

client.on(Events.MessageReactionAdd, handleDayVoteReactionChange);
client.on(Events.MessageReactionRemove, handleDayVoteReactionChange);

client.login(token);
