require("dotenv").config();
const { 
  Client, 
  GatewayIntentBits, 
  PermissionFlagsBits, 
  EmbedBuilder, 
  Colors, 
  ChannelType,
  MessageFlags,
  Events
} = require("discord.js");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");

/* ================= CONFIGURATION ================= */
const ADMIN_ID = process.env.ADMIN_ID || "843351441664901121"; 
const ROLE_NAME = "CTF_PLAYER";
const CHANNELS = {
  ANNOUNCEMENTS: "ctf-announcements",
  SHARED_ROOM: "ctf-room",
  FLAGS_LOG: "ctf-flags"
};


/* ================= CLIENT SETUP ================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, // Optional if we only use interactions, but good for caching
    // GatewayIntentBits.MessageContent // NOT REQUIRED for Slash Commands
  ]
});

/* ================= DATABASE SETUP ================= */
const db = new sqlite3.Database("ctf.db");

function initDB() {
  db.serialize(() => {
    // Current CTF Event State
    db.run(`CREATE TABLE IF NOT EXISTS ctf (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT,
      url TEXT,
      format TEXT,
      start INTEGER,
      end INTEGER,
      status TEXT
    )`);

    // Joined Users
    db.run(`CREATE TABLE IF NOT EXISTS joined (
      user_id TEXT PRIMARY KEY,
      joined_at INTEGER
    )`);

    // Flag Submissions
    db.run(`CREATE TABLE IF NOT EXISTS flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      challenge TEXT,
      category TEXT,
      flag TEXT UNIQUE,
      timestamp INTEGER
    )`);

    // OTP System
    db.run(`CREATE TABLE IF NOT EXISTS otp (
      user_id TEXT PRIMARY KEY,
      code TEXT,
      expires_at INTEGER
    )`);
  });
}
initDB();

/* ================= HELPERS ================= */

// Generate 6-digit OTP
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

// Get or Create Role
async function getOrCreateRole(guild) {
  let role = guild.roles.cache.find(r => r.name === ROLE_NAME);
  if (!role) {
    role = await guild.roles.create({
      name: ROLE_NAME,
      color: Colors.Green,
      reason: "CTF Player Role"
    });
  }
  return role;
}

// Ensure Channels Exist
async function ensureChannels(guild, role) {
  const channelExists = (name) => guild.channels.cache.find(c => c.name === name);

  // 1. Announcements (Public Read, Admin Write)
  if (!channelExists(CHANNELS.ANNOUNCEMENTS)) {
      await guild.channels.create({
          name: CHANNELS.ANNOUNCEMENTS,
          type: ChannelType.GuildText,
          permissionOverwrites: [
              { id: guild.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
              { id: client.user.id, allow: [PermissionFlagsBits.SendMessages] }
          ]
      });
  }

  // 2. Shared Room (Player+Admin Read/Write, Public Deny)
  // 3. Flags Log (Player Read-Only/Deny?, Admin Read)
  const secureChannels = [CHANNELS.SHARED_ROOM, CHANNELS.FLAGS_LOG];

  for (const name of secureChannels) {
      if (!channelExists(name)) {
          await guild.channels.create({
              name: name,
              type: ChannelType.GuildText,
              permissionOverwrites: [
                  { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, // Hide from public
                  { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }, // Allow players
                  { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
              ]
          });
      }
  }

  // FORCE UPDATES: Ensure CTF_PLAYER role cannot send messages in Announcement
  const readOnlyChannels = [CHANNELS.ANNOUNCEMENTS];
  for (const name of readOnlyChannels) {
      const ch = guild.channels.cache.find(c => c.name === name);
      if (ch) {
          await ch.permissionOverwrites.edit(role.id, { 
              SendMessages: false,
              CreatePublicThreads: false,
              CreatePrivateThreads: false,
              AddReactions: true // Allow reactions
          });
      }
  }
}

// Parse Date String (Basic ISO attempt or YYYY-MM-DD HH:MM)
function parseDate(input) {
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

/* ================= INTERACTION HANDLER ================= */

client.once(Events.ClientReady, () => {
    console.log(`✅ ${client.user.tag} Online & Ready.`);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  /* ------------------ CTF ADMIN: CREATE ------------------ */
  if (commandName === "create_ctf") {
    if (interaction.user.id !== ADMIN_ID) {
        return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
    }

    const name = interaction.options.getString("name");
    const startStr = interaction.options.getString("start_datetime");
    const endStr = interaction.options.getString("end_datetime");
    const url = interaction.options.getString("official_url") || "N/A";
    const format = interaction.options.getString("format") || "Jeopardy";

    const start = parseDate(startStr);
    const end = parseDate(endStr);

    if (!start || !end) {
        return interaction.reply({ content: "❌ Invalid Date Format. Use ISO 8601 (e.g. 2026-02-09T10:00:00)", ephemeral: true });
    }

    if (end <= start) {
        return interaction.reply({ content: "❌ End time must be after Start time.", ephemeral: true });
    }

    // Insert or Update Single Row (ID=1)
    db.run(`INSERT OR REPLACE INTO ctf (id, name, url, format, start, end, status)
            VALUES (1, ?, ?, ?, ?, ?, 'scheduled')`, 
            [name, url, format, start, end], 
            async function(err) {
                if (err) {
                    console.error(err);
                    return interaction.reply({ content: "❌ Database Error.", ephemeral: true });
                }

                await interaction.deferReply();

                // Announce
                const role = await getOrCreateRole(interaction.guild);
                await ensureChannels(interaction.guild, role);
                
                const annChannel = interaction.guild.channels.cache.find(c => c.name === CHANNELS.ANNOUNCEMENTS);
                
                if (annChannel) {
                    const embed = new EmbedBuilder()
                        .setTitle(`📢 CTF Announcement – ${name}`)
                        .setColor(Colors.Blue)
                        .setDescription(`------------------------------------------------------------------\n🔹 **Format**: ${format}\n🔹 **Official URL**: ${url}\n\n🕒 **Schedule**:\n📆 Start: <t:${Math.floor(start/1000)}:F> (<t:${Math.floor(start/1000)}:R>)\n📆 End: <t:${Math.floor(end/1000)}:F> (<t:${Math.floor(end/1000)}:R>)\n------------------------------------------------------------------`)
                        .addFields(
                            { name: "Join Team", value: `🔗 [Click here to join team](${url})` }
                        )
                        .setFooter({ text: "Make sure to join now! Use /join_ctf to access bot channels." });
                    
                    await annChannel.send({ content: "@everyone", embeds: [embed] });
                }

                interaction.editReply(`✅ **${name}** Created & Announced!`);
            });
  }

  /* ------------------ CTF ADMIN: END ------------------ */
  if (commandName === "end_ctf") {
    if (interaction.user.id !== ADMIN_ID) {
        return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
    }

    db.get("SELECT * FROM ctf WHERE id=1", async (err, ctf) => {
        if (!ctf) return interaction.reply({ content: "No CTF running.", ephemeral: true });

        db.run("UPDATE ctf SET status='ended' WHERE id=1");
        await interaction.deferReply();

        // Generate Final Scoreboard
        db.all(`SELECT user_id, COUNT(*) as score FROM flags GROUP BY user_id ORDER BY score DESC, timestamp ASC LIMIT 10`, 
        async (err, rows) => {
            let desc = "";
            let medals = ["🥇", "🥈", "🥉"];
            
            if (rows.length === 0) desc = "No solves recorded.";
            else {
                rows.forEach((r, i) => {
                    let prefix = medals[i] || `**${i+1}.**`;
                    desc += `${prefix} <@${r.user_id}> — **${r.score} flags**\n`;
                });
            }

            // Count total participants
            db.get("SELECT COUNT(DISTINCT user_id) as count FROM joined", async (e, rJ) => {
                 // Count total flags
                 db.get("SELECT COUNT(*) as count FROM flags", async (e, rF) => {
                     
                     const embed = new EmbedBuilder()
                        .setTitle(`🏁 CTF ENDED: ${ctf.name}`)
                        .setColor(Colors.Gold)
                        .setDescription(desc)
                        .addFields(
                            { name: "Stats", value: `👥 Participants: ${rJ?.count || 0}\n🚩 Total Flags: ${rF?.count || 0}` }
                        )
                        .setTimestamp();

                    // Send to Announcements instead of Results
                    const resultsChannel = interaction.guild.channels.cache.find(c => c.name === CHANNELS.ANNOUNCEMENTS);
                    if (resultsChannel) {
                        await resultsChannel.send({ embeds: [embed] });
                    }

                    interaction.editReply("✅ CTF Ended. Results published to Announcements.");
                 });
            });
        });
    });
  }

  /* ------------------ CTF ADMIN: ALL FLAGS ------------------ */
  if (commandName === "allflags") {
      if (interaction.user.id !== ADMIN_ID) {
          return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
      }

      db.get("SELECT * FROM ctf WHERE id=1", (err, ctf) => {
          if (!ctf || ctf.status === 'ended') {
               return interaction.reply({ content: "🚫 No active CTF at the moment.", ephemeral: true });
          }

          db.all("SELECT * FROM flags ORDER BY timestamp DESC", (err, rows) => {
              if (!rows || rows.length === 0) return interaction.reply({ content: "No flags submitted yet.", ephemeral: true });

              let output = "**🚩 All Submitted Flags**\n\n";
              rows.forEach((r, i) => {
                  const line = `${i+1}. <@${r.user_id}> | **${r.challenge}** (${r.category}) | \`${r.flag}\`\n`;
                  if (output.length + line.length < 2000) {
                      output += line;
                  }
              });

              if (rows.length > 20 && output.length >= 1900) {
                  output += `\n... ${rows.length - 20} more flags hidden (limit reached).`;
              }

              interaction.reply({ content: output, ephemeral: true });
          });
      });
  }


  /* ------------------ USER: JOIN (OTP GEN) ------------------ */
  if (commandName === "join_ctf") {
      // Check for active CTF first
      db.get("SELECT * FROM ctf WHERE id=1", (err, ctf) => {
        if (!ctf || ctf.status === 'ended') {
             return interaction.reply({ content: "🚫 No active CTF at the moment.", ephemeral: true });
        }

        db.get("SELECT * FROM joined WHERE user_id=?", [interaction.user.id], (err, row) => {
            if (row) return interaction.reply({ content: "✅ You have already joined!", ephemeral: true });
  
            const otp = generateOTP();
            const expires = Date.now() + 5 * 60 * 1000; // 5 mins
  
            db.run(`INSERT OR REPLACE INTO otp (user_id, code, expires_at) VALUES (?, ?, ?)`,
              [interaction.user.id, otp, expires], 
              (err) => {
                  if (err) console.error(err);
                  
                  let msg = `🔐 **Verification Required**\nYour OTP is: \`${otp}\``;
                  if (ctf) {
                      msg = `🏆 **${ctf.name}**\n` + msg;
                  }
                  
                  interaction.reply({ 
                      content: `${msg}\n\nRun command: \`/verify_otp code:${otp}\`\n(Valid for 5 minutes)`,
                      ephemeral: true 
                  });
              });
        });
      });
  }

  /* ------------------ USER: VERIFY OTP ------------------ */
  if (commandName === "verify_otp") {
      await interaction.deferReply({ ephemeral: true }); // Prevent timeout
      const code = interaction.options.getString("code");

      db.get("SELECT * FROM joined WHERE user_id=?", [interaction.user.id], (err, row) => {
          if (row) return interaction.editReply({ content: "✅ You are already a player." });

          db.get("SELECT * FROM otp WHERE user_id=?", [interaction.user.id], async (err, row) => {
              if (!row) return interaction.editReply({ content: "❌ No OTP found. Run `/join_ctf` first." });
              
              if (Date.now() > row.expires_at) {
                  return interaction.editReply({ content: "❌ OTP Expired. Run `/join_ctf` again." });
              }

              if (row.code !== code.trim()) {
                  return interaction.editReply({ content: "❌ Invalid OTP." });
              }

              // OTP Valid -> Join
              db.run("INSERT INTO joined (user_id, joined_at) VALUES (?, ?)", [interaction.user.id, Date.now()]);
              db.run("DELETE FROM otp WHERE user_id=?", [interaction.user.id]); // Cleanup

              try {
                  const role = await getOrCreateRole(interaction.guild);
                  const member = await interaction.guild.members.fetch(interaction.user.id);
                  await member.roles.add(role);
                  await ensureChannels(interaction.guild, role);

                  interaction.editReply({ content: "🎉 **Verification Successful!** You have joined the CTF. Standard user permissions granted." });
              } catch (e) {
                  console.error(e);
                  interaction.editReply({ content: "⚠ Joined database, but failed to assign Role/Channels. Check bot perms." });
              }
          });
      });
  }

  /* ------------------ USER: SUBMIT FLAG ------------------ */
  if (commandName === "flag") {
      db.get("SELECT * FROM ctf WHERE id=1", (err, ctf) => {
          if (!ctf) return interaction.reply({ content: "No CTF Active.", ephemeral: true });
          if (ctf.status === 'ended' || Date.now() > ctf.end) {
              return interaction.reply({ content: "🚫 CTF has ended. Submissions closed.", ephemeral: true });
          }
          if (Date.now() < ctf.start) {
              return interaction.reply({ content: "⏳ CTF hasn't started yet.", ephemeral: true });
          }

          const rawInput = interaction.options.getString("submission");
          const parts = rawInput.match(/==([^=]+)==/g);

          if (!parts || parts.length !== 3) {
              return interaction.reply({ 
                  content: "⚠️ **Format Error!**\nUse strict format:\n`==Challenge== ==Category== ==Flag==`\n\nExample:\n`==Web 1== ==Web== ==CTF{123}==`", 
                  ephemeral: true 
              });
          }

          const challenge = parts[0].replace(/==/g, "").trim();
          const category = parts[1].replace(/==/g, "").trim();
          const flag = parts[2].replace(/==/g, "").trim();

          // Check if joined
          db.get("SELECT * FROM joined WHERE user_id=?", [interaction.user.id], (err, joined) => {
              if (!joined) return interaction.reply({ content: "❌ You must `/join_ctf` & verify first.", ephemeral: true });

              // Check Duplicate
              db.get("SELECT * FROM flags WHERE flag=?", [flag], (err, exists) => {
                  if (exists) return interaction.reply({ content: "❌ Flag already submitted (by someone).", ephemeral: true });

                  db.run("INSERT INTO flags (user_id, challenge, category, flag, timestamp) VALUES (?, ?, ?, ?, ?)",
                    [interaction.user.id, challenge, category, flag, Date.now()],
                    async (err) => {
                        if (err) return interaction.reply({ content: "❌ Database Error (Unique constraint?).", ephemeral: true });

                        // Log to #ctf-flags
                        const logChannel = interaction.guild.channels.cache.find(c => c.name === CHANNELS.FLAGS_LOG);
                        if (logChannel) {
                            const embed = new EmbedBuilder()
                                .setTitle("🚩 New Flag Submitted")
                                .setColor(Colors.Green)
                                .addFields(
                                    { name: "Solver", value: `<@${interaction.user.id}>`, inline: true },
                                    { name: "Challenge", value: challenge, inline: true },
                                    { name: "Category", value: category, inline: true }
                                )
                                .setTimestamp();
                            logChannel.send({ embeds: [embed] });
                        }

                        interaction.reply({ content: `✅ Correct! Flag accepted for **${challenge}**.`, ephemeral: true });
                    });
              });
          });
      });
  }

  /* ------------------ USER: SCOREBOARD ------------------ */
  if (commandName === "scoreboard") {
      db.get("SELECT * FROM ctf WHERE id=1", (err, ctf) => {
        if (!ctf) return interaction.reply({ content: "🚫 No active CTF at the moment.", ephemeral: true });

        db.all(`SELECT user_id, COUNT(*) as score FROM flags GROUP BY user_id ORDER BY score DESC LIMIT 15`, (err, rows) => {
            if (!rows || rows.length === 0) return interaction.reply("📉 No solves yet.");

            let desc = "";
            rows.forEach((r, i) => {
                desc += `**${i+1}.** <@${r.user_id}> : \`${r.score}\` 🚩\n`;
            });

            const embed = new EmbedBuilder()
                .setTitle("🏆 Live Scoreboard")
                .setColor(Colors.Purple)
                .setDescription(desc)
                .setTimestamp();
            
            interaction.reply({ embeds: [embed] });
        });
      });
  }

  /* ------------------ USER: TIMELEFT ------------------ */
  if (commandName === "timeleft") {
      db.get("SELECT * FROM ctf WHERE id=1", (err, ctf) => {
          if (!ctf) return interaction.reply("No CTF Scheduled.");

          const now = Date.now();
          let msg = "";

          if (ctf.status === 'ended') {
              msg = "🏁 CTF has officially ended.";
          } else if (now < ctf.start) {
              msg = `⏳ Starts <t:${Math.floor(ctf.start/1000)}:R>`;
          } else if (now > ctf.end) {
              msg = "🏁 Time is up! Waiting for Admin to finalize.";
          } else {
              msg = `🕒 Remaining: <t:${Math.floor(ctf.end/1000)}:R>`;
          }

          interaction.reply({ content: msg, ephemeral: true });
      });
  }

});

/* ================= LOGIN ================= */
client.login(process.env.TOKEN);
