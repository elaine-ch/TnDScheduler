const { REST, Routes, SlashCommandBuilder } = require('discord.js');

let config = {};
try {
  // config.json is convenient locally but intentionally not deployed to Heroku.
  config = require('./config.json');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const token = process.env.DISCORD_TOKEN || config.token;
const clientId = process.env.DISCORD_CLIENT_ID || config.clientId;
const guildId = process.env.DISCORD_GUILD_ID || config.guildId;

if (!token || !clientId) {
  throw new Error('Command registration requires a token and DISCORD_CLIENT_ID (or config.json clientId).');
}

const dayChoices = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
].map((day) => ({ name: day, value: day }));

const commands = [
  new SlashCommandBuilder()
    .setName('schedule')
    .setDescription('Start a D&D day scheduling vote.'),
  new SlashCommandBuilder()
    .setName('time')
    .setDescription('Start a D&D time vote for a chosen day.')
    .addStringOption((option) => option
      .setName('day')
      .setDescription('The day D&D will take place.')
      .setRequired(true)
      .addChoices(...dayChoices)),
  new SlashCommandBuilder()
    .setName('adduser')
    .setDescription('Add a user to the discussion-leader list.')
    .addUserOption((option) => option
      .setName('user')
      .setDescription('The Discord user to add.')
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName('removeuser')
    .setDescription('Remove a user from the discussion-leader list.')
    .addUserOption((option) => option
      .setName('user')
      .setDescription('The Discord user to remove.')
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show the D&D Scheduler command list.'),
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

async function registerCommands() {
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Registered ${commands.length} guild commands in ${guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`Registered ${commands.length} global commands.`);
  }
}

registerCommands().catch((error) => {
  console.error('Slash-command registration failed:', error);
  process.exitCode = 1;
});
