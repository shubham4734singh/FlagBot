require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

/* 
  Deploy commands to Discord API.
  Run this script whenever command structures change.
*/

const commands = [
  /* --- ADMIN COMMANDS --- */
  new SlashCommandBuilder()
    .setName("create_ctf")
    .setDescription("Create a new CTF Event (Admin Only)")
    .addStringOption(option => 
      option.setName("name").setDescription("Event Name").setRequired(true))
    .addStringOption(option => 
      option.setName("start_datetime").setDescription("Start (YYYY-MM-DD HH:MM) or ISO").setRequired(true))
    .addStringOption(option => 
      option.setName("end_datetime").setDescription("End (YYYY-MM-DD HH:MM) or ISO").setRequired(true))
    .addStringOption(option => 
      option.setName("official_url").setDescription("CTF Website URL").setRequired(false))
    .addStringOption(option => 
        option.setName("format").setDescription("Jeopardy/Attack-Defense").setRequired(false)),

  new SlashCommandBuilder()
    .setName("end_ctf")
    .setDescription("Force end current CTF and publish results (Admin Only)"),

  new SlashCommandBuilder()
    .setName("allflags")
    .setDescription("View all submitted flags (Admin Only)"),

  /* --- USER COMMANDS --- */
  new SlashCommandBuilder()
    .setName("join_ctf")
    .setDescription("Start the join process (Sends OTP)"),

  new SlashCommandBuilder()
    .setName("verify_otp")
    .setDescription("Verify your OTP to join the CTF")
    .addStringOption(option => 
      option.setName("code").setDescription("6-digit OTP code").setRequired(true)),

  new SlashCommandBuilder()
    .setName("flag")
    .setDescription("Submit flag (Format: ==Challenge== ==Category== ==Flag==)")
    .addStringOption(option => 
      option.setName("submission")
      .setDescription("e.g. ==Login Bypass== ==Web== ==CTF{flag}==")
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName("scoreboard")
    .setDescription("View live scoreboard"),

  new SlashCommandBuilder()
    .setName("timeleft")
    .setDescription("Check CTF schedule status")
]
.map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.TOKEN);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
})();
