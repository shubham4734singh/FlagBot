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
const ROLE_PREFIX = "CTF";
const CHANNELS = {
    ANNOUNCEMENTS: "ctf-announcements"
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
        // CTF Events (multiple active)
        db.run(`CREATE TABLE IF NOT EXISTS ctfs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            url TEXT,
            format TEXT,
            start INTEGER,
            end INTEGER,
            status TEXT,
            room_channel_id TEXT,
            flags_channel_id TEXT,
            role_id TEXT
        )`);

        // Backward-compatible columns (ignore errors if they already exist)
        db.run("ALTER TABLE ctfs ADD COLUMN room_channel_id TEXT", () => {});
        db.run("ALTER TABLE ctfs ADD COLUMN flags_channel_id TEXT", () => {});
        db.run("ALTER TABLE ctfs ADD COLUMN role_id TEXT", () => {});

        // Joined Users per CTF
        db.run(`CREATE TABLE IF NOT EXISTS joined_ctf (
            user_id TEXT,
            ctf_id INTEGER,
            joined_at INTEGER,
            PRIMARY KEY (user_id, ctf_id)
        )`);

        // Flag Submissions (unique per CTF)
        db.run(`CREATE TABLE IF NOT EXISTS flags_ctf (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            challenge TEXT,
            category TEXT,
            flag TEXT,
            timestamp INTEGER,
            ctf_event_id INTEGER,
            UNIQUE (flag, ctf_event_id)
        )`);

        // OTP System per CTF
        db.run(`CREATE TABLE IF NOT EXISTS otp_ctf (
            user_id TEXT,
            ctf_id INTEGER,
            code TEXT,
            expires_at INTEGER,
            PRIMARY KEY (user_id, ctf_id)
        )`);
  });
}
initDB();

/* ================= HELPERS ================= */

// Generate 6-digit OTP
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function getCtfRoleName(ctfName) {
    const base = (ctfName || "CTF").trim();
    const name = `${ROLE_PREFIX} ${base}`.replace(/\s+/g, " ");
    return name.length > 100 ? name.slice(0, 100) : name;
}

// Get or Create Per-CTF Role
async function getOrCreateCtfRole(guild, ctfName, storedRoleId) {
    let role = storedRoleId ? guild.roles.cache.get(storedRoleId) : null;
    if (!role) {
        const roleName = getCtfRoleName(ctfName);
        role = guild.roles.cache.find(r => r.name === roleName) || null;
    }

    if (!role) {
        role = await guild.roles.create({
            name: getCtfRoleName(ctfName),
            color: Colors.Green,
            reason: "CTF Player Role"
        });
    }
    return role;
}

function sanitizeChannelSlug(name) {
    const base = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-+/g, "-");

    if (!base) return "ctf";
    return base.startsWith("ctf") ? base : `ctf-${base}`;
}

function getCtfChannelNames(ctfName) {
    const base = sanitizeChannelSlug(ctfName);
    return {
        room: base,
        flags: `${base}-flags`
    };
}

// Ensure Channels Exist
async function ensureCtfChannels(guild, role, ctfName, storedIds) {
  const channelExists = (name) => guild.channels.cache.find(c => c.name === name);
    const channelById = (id) => (id ? guild.channels.cache.get(id) : null);

  const names = getCtfChannelNames(ctfName);

  // 2. Per-CTF Room (Player+Admin Read/Write, Public Deny)
  let roomChannel = channelById(storedIds?.room_channel_id) || channelExists(names.room);
  if (!roomChannel) {
        roomChannel = await guild.channels.create({
            name: names.room,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: role.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
        });
  }

  // 3. Per-CTF Flags Log (Player Read, Bot Write)
  let flagsChannel = channelById(storedIds?.flags_channel_id) || channelExists(names.flags);
  if (!flagsChannel) {
        flagsChannel = await guild.channels.create({
            name: names.flags,
            type: ChannelType.GuildText,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: role.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
            ]
        });
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

    return { roomChannel, flagsChannel };
}

async function ensureAnnouncementsChannel(guild) {
    const channelExists = (name) => guild.channels.cache.find(c => c.name === name);
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
}

// Parse Date String (Basic ISO attempt or YYYY-MM-DD HH:MM)
function parseDate(input) {
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.getTime();
}

function getCtfByName(name, callback) {
    db.get(
        "SELECT * FROM ctfs WHERE lower(name)=lower(?) ORDER BY id DESC LIMIT 1",
        [name],
        callback
    );
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

    await interaction.deferReply();

    db.run(
        `INSERT INTO ctfs (name, url, format, start, end, status, room_channel_id, flags_channel_id, role_id)
         VALUES (?, ?, ?, ?, ?, 'scheduled', NULL, NULL, NULL)`,
        [name, url, format, start, end],
        async function(err) {
            if (err) {
                console.error(err);
                return interaction.editReply({ content: "❌ Database Error." });
            }

            const annChannel = interaction.guild.channels.cache.find(c => c.name === CHANNELS.ANNOUNCEMENTS);

            const embed = new EmbedBuilder()
                .setTitle(`📢 CTF Announcement – ${name}`)
                .setColor(Colors.Blue)
                .setDescription(`------------------------------------------------------------------\n🔹 **Format**: ${format}\n🔹 **Official URL**: ${url}\n\n🕒 **Schedule**:\n📆 Start: <t:${Math.floor(start/1000)}:F> (<t:${Math.floor(start/1000)}:R>)\n📆 End: <t:${Math.floor(end/1000)}:F> (<t:${Math.floor(end/1000)}:R>)\n------------------------------------------------------------------`)
                .addFields(
                    { name: "Join Team", value: `🔗 [Click here to join team](${url})` }
                )
                .setFooter({ text: "Make sure to join now! Use /join_ctf to access bot channels." });

            if (annChannel) {
                await annChannel.send({ content: "@everyone", embeds: [embed] });
            } else {
                await interaction.channel?.send({ content: "@everyone", embeds: [embed] });
            }

                        interaction.editReply(`✅ **${name}** Created & Announced!`);
        }
    );
  }

  /* ------------------ CTF ADMIN: END ------------------ */
  if (commandName === "end_ctf") {
    if (interaction.user.id !== ADMIN_ID) {
        return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
    }

    const ctfName = interaction.options.getString("name");
    if (!ctfName) {
        return interaction.reply({ content: "❌ CTF name is required. Update commands and run /end_ctf name:CTF_NAME", ephemeral: true });
    }

    getCtfByName(ctfName, async (err, ctf) => {
        if (!ctf) return interaction.reply({ content: "CTF not found.", ephemeral: true });

        const eventId = ctf.id;
        db.run("UPDATE ctfs SET status='ended' WHERE id=?", [ctf.id]);
        await interaction.deferReply();

        // Generate Final Scoreboard
        db.all(
          `SELECT user_id, COUNT(*) as score FROM flags_ctf WHERE ctf_event_id=? GROUP BY user_id ORDER BY score DESC, timestamp ASC LIMIT 10`,
          [eventId],
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

              // Count total solvers and flags for this CTF
              db.get("SELECT COUNT(DISTINCT user_id) as count FROM flags_ctf WHERE ctf_event_id=?", [eventId], async (e, rJ) => {
                  db.get("SELECT COUNT(*) as count FROM flags_ctf WHERE ctf_event_id=?", [eventId], async (e, rF) => {

                      const embed = new EmbedBuilder()
                          .setTitle(`🏁 CTF ENDED: ${ctf.name}`)
                          .setColor(Colors.Gold)
                          .setDescription(desc)
                          .addFields(
                              { name: "Stats", value: `👥 Solvers: ${rJ?.count || 0}\n🚩 Total Flags: ${rF?.count || 0}` }
                          )
                          .setTimestamp();

                      // Send to Announcements instead of Results
                      const resultsChannel = interaction.guild.channels.cache.find(c => c.name === CHANNELS.ANNOUNCEMENTS);
                      if (resultsChannel) {
                          await resultsChannel.send({ embeds: [embed] });
                      }

                      const flagsChannel = ctf.flags_channel_id
                          ? interaction.guild.channels.cache.get(ctf.flags_channel_id)
                          : null;
                      if (flagsChannel && ctf.role_id) {
                          await flagsChannel.permissionOverwrites.edit(ctf.role_id, {
                              ViewChannel: true,
                              SendMessages: false,
                              AddReactions: true
                          });
                      }

                      interaction.editReply("✅ CTF Ended. Results published to Announcements.");
                  });
              });
          }
        );
    });
  }

  /* ------------------ CTF ADMIN: ALL FLAGS ------------------ */
  if (commandName === "allflags") {
      if (interaction.user.id !== ADMIN_ID) {
          return interaction.reply({ content: "⛔ Admin only.", ephemeral: true });
      }

      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "❌ CTF name is required. Update commands and run /allflags name:CTF_NAME", ephemeral: true });
      }

      getCtfByName(ctfName, (err, ctf) => {
          if (!ctf) {
              return interaction.reply({ content: "CTF not found.", ephemeral: true });
          }

          db.all("SELECT * FROM flags_ctf WHERE ctf_event_id=? ORDER BY timestamp DESC", [ctf.id], (err, rows) => {
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
      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "❌ CTF name is required. Update commands and run /join_ctf name:CTF_NAME", ephemeral: true });
      }

      getCtfByName(ctfName, (err, ctf) => {
        if (!ctf || ctf.status === 'ended') {
             return interaction.reply({ content: "🚫 CTF not found or already ended.", ephemeral: true });
        }

        db.get("SELECT * FROM joined_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id], (err, row) => {
            if (row) {
                return interaction.reply({ content: "✅ You have already joined!", ephemeral: true });
            }

            const otp = generateOTP();
            const expires = Date.now() + 5 * 60 * 1000; // 5 mins

            db.run(
              "INSERT OR REPLACE INTO otp_ctf (user_id, ctf_id, code, expires_at) VALUES (?, ?, ?, ?)",
              [interaction.user.id, ctf.id, otp, expires],
              (err) => {
                  if (err) console.error(err);
                  
                  const msg = `🏆 **${ctf.name}**\n🔐 **Verification Required**\nYour OTP is: \`${otp}\``;
                  
                  interaction.reply({ 
                      content: `${msg}\n\nRun command: \`/verify_otp code:${otp}\`\n(Valid for 5 minutes)`,
                      ephemeral: true 
                  });
              }
            );
        });
      });
  }

  /* ------------------ USER: VERIFY OTP ------------------ */
  if (commandName === "verify_otp") {
      await interaction.deferReply({ ephemeral: true }); // Prevent timeout
      const code = interaction.options.getString("code");

      db.get("SELECT * FROM otp_ctf WHERE user_id=? AND code=?", [interaction.user.id, code.trim()], (err, otpRow) => {
          if (!otpRow) return interaction.editReply({ content: "❌ No OTP found. Run `/join_ctf` first." });

          if (Date.now() > otpRow.expires_at) {
              db.run("DELETE FROM otp_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, otpRow.ctf_id]);
              return interaction.editReply({ content: "❌ OTP Expired. Run `/join_ctf` again." });
          }

          db.get("SELECT * FROM ctfs WHERE id=?", [otpRow.ctf_id], async (err, ctf) => {
              if (!ctf || ctf.status === 'ended') {
                  return interaction.editReply({ content: "🚫 CTF not found or already ended." });
              }

              db.get("SELECT * FROM joined_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id], async (err, joinedRow) => {
                  if (joinedRow) {
                      return interaction.editReply({ content: "✅ You are already a player." });
                  }

                  // OTP Valid -> Join
                  db.run(
                    "INSERT OR REPLACE INTO joined_ctf (user_id, ctf_id, joined_at) VALUES (?, ?, ?)",
                    [interaction.user.id, ctf.id, Date.now()]
                  );
                  db.run("DELETE FROM otp_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id]);

                  try {
                      const role = await getOrCreateCtfRole(interaction.guild, ctf.name, ctf.role_id);
                      const member = await interaction.guild.members.fetch(interaction.user.id);
                      await member.roles.add(role);

                      const storedIds = ctf;
                      const { roomChannel, flagsChannel } = await ensureCtfChannels(interaction.guild, role, ctf.name, storedIds);
                      db.run(
                        "UPDATE ctfs SET room_channel_id=?, flags_channel_id=?, role_id=? WHERE id=?",
                        [roomChannel?.id || null, flagsChannel?.id || null, role?.id || null, ctf.id]
                      );

                      interaction.editReply({ content: "🎉 **Verification Successful!** You have joined the CTF. Access granted." });
                  } catch (e) {
                      console.error(e);
                      interaction.editReply({ content: "⚠ Joined database, but failed to assign Role/Channels. Check bot perms." });
                  }
              });
          });
      });
  }

  /* ------------------ USER: SUBMIT FLAG ------------------ */
  if (commandName === "flag") {
      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "❌ CTF name is required. Update commands and run /flag name:CTF_NAME ...", ephemeral: true });
      }
      getCtfByName(ctfName, (err, ctf) => {
          if (!ctf) return interaction.reply({ content: "CTF not found.", ephemeral: true });
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
          db.get("SELECT * FROM joined_ctf WHERE user_id=? AND ctf_id=?", [interaction.user.id, ctf.id], (err, joined) => {
              if (!joined) {
                  return interaction.reply({ content: "❌ You must `/join_ctf` & verify first.", ephemeral: true });
              }

              // Check Duplicate
              db.get("SELECT * FROM flags_ctf WHERE flag=? AND ctf_event_id=?", [flag, ctf.id], (err, exists) => {
                  if (exists) return interaction.reply({ content: "❌ Flag already submitted (by someone).", ephemeral: true });

                                    const eventId = ctf.id;
                  db.run("INSERT INTO flags_ctf (user_id, challenge, category, flag, timestamp, ctf_event_id) VALUES (?, ?, ?, ?, ?, ?)",
                    [interaction.user.id, challenge, category, flag, Date.now(), eventId],
                    async (err) => {
                        if (err) return interaction.reply({ content: "❌ Database Error (Unique constraint?).", ephemeral: true });

                        // Log to current CTF flags channel
                        const fallbackNames = getCtfChannelNames(ctf.name || "ctf");
                        const logChannel = ctf.flags_channel_id
                          ? interaction.guild.channels.cache.get(ctf.flags_channel_id)
                          : interaction.guild.channels.cache.find(c => c.name === fallbackNames.flags);
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
      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "❌ CTF name is required. Update commands and run /scoreboard name:CTF_NAME", ephemeral: true });
      }
      getCtfByName(ctfName, (err, ctf) => {
          if (!ctf) return interaction.reply({ content: "CTF not found.", ephemeral: true });

          db.all(
              `SELECT user_id, COUNT(*) as score FROM flags_ctf WHERE ctf_event_id=? GROUP BY user_id ORDER BY score DESC LIMIT 15`,
              [ctf.id],
              (err, rows) => {
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
      const ctfName = interaction.options.getString("name");
      if (!ctfName) {
          return interaction.reply({ content: "❌ CTF name is required. Update commands and run /timeleft name:CTF_NAME", ephemeral: true });
      }
      getCtfByName(ctfName, (err, ctf) => {
          if (!ctf) return interaction.reply("CTF not found.");

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
